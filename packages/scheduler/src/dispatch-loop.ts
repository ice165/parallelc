import Database from 'better-sqlite3';
import { EXIT_TIMEOUT } from '@parallelc/shared';
import type { Task } from '@parallelc/shared';
import { execSync } from 'child_process';
import {
  getLockedFiles,
  queryTasksByStatus,
  casUpdateStatus,
  updateTask,
  wakeSleepingTasks,
  propagateDagFailure,
  GhostDetector,
  createTask,
} from '@parallelc/taskboard';
import { routeExitCode, cleanupWorktrees } from '@parallelc/worker';
import { coordinateMerge } from '@parallelc/coordinator';
import { ceoBatchReview } from '@parallelc/ceo';
import { handleGlobalBackoff } from '@parallelc/keypool';
import { detectStalled, CostTracker, generateRepro } from '@parallelc/orchestrator';
import { WorkerPool } from './worker-pool.js';
import { F1BetaTracker } from './f1-beta-tracker.js';
import { AuditLogger } from './audit-logger.js';

export interface SchedulerConfig {
  dbPath: string;
  repoRoot: string;
  apiKeys: string[];
  maxWorkers?: number;
  starvationThresholdMs?: number;
  tickIntervalMs?: number;
}

export interface DispatchResult {
  dispatched: number;
  delayed: number;
  starvation: number;
}

export interface ReapResult {
  done: number;
  failed: number;
  sleeping: number;
  checkpointed: number;
}

export interface TickStats {
  tick: number;
  dispatch: DispatchResult;
  reap: ReapResult;
  wake: number;
  poolSize: number;
}

const DEFAULT_MAX_WORKERS = 4;
const DEFAULT_STARVATION_MS = 300_000;
const DEFAULT_TICK_MS = 2_000;
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 5;

let f1Tracker: F1BetaTracker | null = null;
let costTracker: CostTracker | null = null;
let auditLogger: AuditLogger | null = null;

export function startScheduler(config: SchedulerConfig): void {
  const {
    dbPath,
    repoRoot,
    apiKeys,
    maxWorkers = DEFAULT_MAX_WORKERS,
    starvationThresholdMs = DEFAULT_STARVATION_MS,
    tickIntervalMs = DEFAULT_TICK_MS,
  } = config;

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  const pool = new WorkerPool(apiKeys, maxWorkers);
  let tick = 0;

  console.log(`[Scheduler] 启动 | DB: ${dbPath} | Max Workers: ${maxWorkers} | Repo: ${repoRoot}`);

  // Initialize F1-beta sliding window tracker
  f1Tracker = new F1BetaTracker(10);

  // Initialize cost tracker
  costTracker = new CostTracker({
    maxCostPerTask: 3.0,
    maxCostPerSession: 20.0,
  });

  // Initialize audit logger
  auditLogger = new AuditLogger('.parallelc/audit.log');

  // Ghost recovery on startup (includes upstream dependency check)
  const ghostDetector = new GhostDetector(db);
  const ghosts = ghostDetector.detect(new Set(pool.workerIds()));
  for (const ghost of ghosts) {
    console.log(`[Scheduler] Ghost worker detected: ${ghost.taskId} (${ghost.reason}), resetting to READY`);
    casUpdateStatus(db, ghost.taskId, 0, 'RUNNING', 'READY');
  }

  const loop = setInterval(() => {
    tick++;
    const dispatch = dispatchTick(db, pool, repoRoot, maxWorkers, starvationThresholdMs);
    const reap = reapTick(db, pool, repoRoot, dbPath);
    const ceoReview = ceoReviewTick(db, pool, repoRoot, dbPath, apiKeys[0] ?? '').catch(err => {
      console.error('[CEO] Review tick error:', err.message);
    });
    const woken = wakeTick(db);

    if (dispatch.dispatched > 0 || reap.done + reap.failed + reap.sleeping > 0 || woken > 0) {
      console.log(
        `[DISPATCH] tick=${tick} 派发=${dispatch.dispatched} 延后=${dispatch.delayed} 饥饿=${dispatch.starvation} | pool=${pool.activeCount}/${maxWorkers}`,
      );
      if (reap.done + reap.failed + reap.sleeping + reap.checkpointed > 0) {
        console.log(
          `[REAP]    tick=${tick} 完成=${reap.done} 失败=${reap.failed} 休眠=${reap.sleeping} 检查点=${reap.checkpointed}`,
        );
      }
      if (woken > 0) {
        console.log(`[WAKE]    tick=${tick} 唤醒=${woken}`);
      }
    }
  }, tickIntervalMs);

  const shutdown = async () => {
    clearInterval(loop);
    console.log('[Scheduler] 正在关闭...');
    await pool.shutdownAll();
    db.close();
    console.log('[Scheduler] 已关闭');
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

export function dispatchTick(
  db: Database.Database,
  pool: WorkerPool,
  repoRoot: string,
  maxWorkers: number,
  starvationThresholdMs: number = DEFAULT_STARVATION_MS,
): DispatchResult {
  const backoff = handleGlobalBackoff(pool.getKeyPool());
  if (backoff.paused) {
    console.log(`[Scheduler] All keys paused, resuming at ${backoff.resumeAt?.toISOString()}`);
    return { dispatched: 0, delayed: 0, starvation: 0 };
  }

  // F1-beta degradation check
  let effectiveMax = maxWorkers;
  if (f1Tracker) {
    if (f1Tracker.shouldDegrade()) {
      console.log(`[Scheduler] F1-beta degraded (avg=${f1Tracker.getAverageScore().toFixed(2)}), limiting concurrency`);
      effectiveMax = 1;
    } else if (f1Tracker.isColdStart()) {
      effectiveMax = Math.ceil(maxWorkers * f1Tracker.getColdStartMultiplier());
    }
  }

  // Cost budget check
  if (costTracker && !costTracker.canDispatch()) {
    const summary = costTracker.getSummary();
    console.log(`[Scheduler] Cost budget exceeded (session=$${summary.sessionCost.toFixed(2)}), pausing dispatch`);
    auditLogger?.log('COST_BUDGET_EXCEEDED', { sessionCost: summary.sessionCost });
    return { dispatched: 0, delayed: 0, starvation: 0 };
  }

  // Stall detection
  const stalled = detectStalled(db);
  for (const s of stalled) {
    if (s.action === 'CANCEL') {
      console.log(`[Scheduler] Stalled task detected: ${s.taskId} — ${s.reason}, cancelling`);
      const task = queryTaskById(db, s.taskId);
      if (task) {
        casUpdateStatus(db, s.taskId, task.version, 'READY', 'CANCELLED');
        propagateDagFailure(db, s.taskId);
      }
    } else {
      console.log(`[Scheduler] Stall warning: ${s.taskId} — ${s.reason}`);
    }
  }

  // 跨轮保护：每轮从 DB 重建锁集合
  const lockedFiles = getLockedFiles(db);
  const readyTasks = queryTasksByStatus(db, 'READY');

  let dispatched = 0;
  let delayed = 0;
  let starvation = 0;

  for (const task of readyTasks) {
    if (!pool.hasCapacity()) break;
    if (dispatched >= effectiveMax) break;

    const taskExpected = new Set(task.expected_touch_files ?? []);
    const conflicting = [...taskExpected].filter((f) => lockedFiles.has(f));

    if (conflicting.length > 0) {
      const waited = task.ready_at
        ? Date.now() - new Date(task.ready_at).getTime()
        : 0;

      if (waited > starvationThresholdMs) {
        starvation++;
      } else {
        delayed++;
        continue;
      }
    }

    // CAS 乐观锁派发
    const ok = casUpdateStatus(
      db,
      task.id,
      task.version,
      'READY',
      'RUNNING',
      { starvation_override: conflicting.length > 0 },
    );

    if (ok) {
      pool.spawn(task, repoRoot).catch((err: Error) => {
        console.error(`[Scheduler] Failed to spawn worker for ${task.id}:`, err.message);
        casUpdateStatus(db, task.id, task.version + 1, 'RUNNING', 'FAILED');
        auditLogger?.log('TASK_FAILED', { taskId: task.id, reason: err.message });
      });

      auditLogger?.log('TASK_STARTED', { taskId: task.id, title: task.title });

      // 本轮保护：立即更新内存锁集合
      for (const f of taskExpected) lockedFiles.add(f);
      dispatched++;
    }
  }

  return { dispatched, delayed, starvation };
}

export function reapTick(
  db: Database.Database,
  pool: WorkerPool,
  repoRoot: string,
  dbPath: string,
): ReapResult {
  const result: ReapResult = { done: 0, failed: 0, sleeping: 0, checkpointed: 0 };
  const exited = pool.reap();

  for (const entry of exited) {
    let exitCode = entry.process.exitCode;
    if (exitCode === null) {
      exitCode = EXIT_TIMEOUT; // Watchdog 杀死 → 超时
    }

    const task = queryTaskById(db, entry.taskId);
    if (!task) continue;

    const action = routeExitCode({
      taskId: task.id,
      exitCode,
      writeRoot: entry.writeRoot,
      rateLimitCount: task.rate_limit_count,
      maxRateLimitRetries: DEFAULT_MAX_RATE_LIMIT_RETRIES,
    });

    switch (action.type) {
      case 'MARK_DONE': {
        updateTask(db, task.id, task.version, { modified_files: action.modifiedFiles });
        casUpdateStatus(db, task.id, task.version + 1, 'RUNNING', 'REVIEW_PENDING');
        pool.getKeyPool().markSuccess(entry.apiKey);
        auditLogger?.log('TASK_COMPLETED', { taskId: task.id, modifiedFiles: action.modifiedFiles });
        // Feed prediction accuracy to F1-beta sliding window tracker
        if (f1Tracker && task.expected_touch_files && action.modifiedFiles) {
          f1Tracker.record({
            expected: task.expected_touch_files ?? [],
            actual: action.modifiedFiles,
          });
        }
        // 合并必须在清理 Worktree 之前，因为 mergeTask 需读取 write worktree
        const workerId = entry.workerId;
        const writeRoot = entry.writeRoot;
        coordinateMerge(
          { repoRoot, dbPath, writeRoot },
          task.id,
        ).then(result => {
          // 合并完成后清理 Worktree
          cleanupWorktrees(workerId, repoRoot).catch(() => {});
          console.log(`[Scheduler] Merge ${task.id}: ${result.mergeResult.strategy}`);
          if (result.accuracyUpdated) {
            console.log(`[Scheduler] Accuracy recorded for ${task.id}`);
          }
          if (result.downstreamTriggered.length > 0) {
            console.log(`[Scheduler] Downstream merges triggered: ${result.downstreamTriggered.join(', ')}`);
          }
        }).catch(err => {
          // 合并失败也要清理 Worktree
          cleanupWorktrees(workerId, repoRoot).catch(() => {});
          console.error(`[Scheduler] Merge failed for ${task.id}:`, err.message);
        });
        costTracker?.resetTask();
        result.done++;
        break;
      }

      case 'CHECKPOINT':
        casUpdateStatus(db, task.id, task.version, 'RUNNING', 'CHECKPOINT_PENDING');
        costTracker?.resetTask();
        result.checkpointed++;
        break;

      case 'FAILED':
        casUpdateStatus(db, task.id, task.version, 'RUNNING', 'FAILED');
        propagateDagFailure(db, task.id);
        cleanupWorktrees(entry.workerId, repoRoot).catch(() => {});
        auditLogger?.log('TASK_FAILED', { taskId: task.id, reason: action.reason });
        // Generate reproduction script (best-effort)
        try {
          const gitHead = execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf-8' }).trim();
          generateRepro({
            taskId: task.id,
            outputDir: '.parallelc/reproduce',
            gitHead,
            snapshotVersion: task.snapshot_version ?? 'unknown',
            stdout: action.reason ?? '',
            exitCode: exitCode ?? 1,
          });
        } catch { /* repro generation is best-effort */ }
        costTracker?.resetTask();
        result.failed++;
        break;

      case 'RATE_LIMIT_SLEEP':
        updateTask(db, task.id, task.version, {
          rate_limit_count: action.attempt,
          sleep_until: action.wakeAt.toISOString(),
        });
        casUpdateStatus(db, task.id, task.version, 'RUNNING', 'SLEEP_PENDING');
        pool.getKeyPool().markRateLimited(entry.apiKey);
        cleanupWorktrees(entry.workerId, repoRoot).catch(() => {});
        costTracker?.resetTask();
        result.sleeping++;
        break;

      case 'HOOK_BLOCKED':
        casUpdateStatus(db, task.id, task.version, 'RUNNING', 'FAILED');
        cleanupWorktrees(entry.workerId, repoRoot).catch(() => {});
        costTracker?.resetTask();
        result.failed++;
        break;
    }
  }

  return result;
}

async function ceoReviewTick(
  db: Database.Database,
  pool: WorkerPool,
  repoRoot: string,
  dbPath: string,
  apiKey: string,
): Promise<void> {
  const reviewTasks = queryTasksByStatus(db, 'REVIEW_PENDING');
  if (reviewTasks.length === 0) return;

  const f1Avg = f1Tracker?.getAverageScore() ?? 1.0;
  const ceoBudget = (costTracker?.getSummary().sessionCost ?? 0) < 5.0 ? 5.0 : 0;

  const result = await ceoBatchReview(
    db, repoRoot, apiKey, 80, f1Avg, ceoBudget, '',
  );

  for (const r of result.results) {
    const task = queryTaskById(db, r.taskId);
    if (!task) continue;

    switch (r.feedback.verdict) {
      case 'PASS': {
        casUpdateStatus(db, r.taskId, task.version, 'REVIEW_PENDING', 'DONE');
        auditLogger?.log('MERGE_CONFIRMED', { taskId: r.taskId, ceoScore: r.feedback.score });
        const workerId = `worker-${r.taskId}`;
        const writeRoot = repoRoot;
        coordinateMerge(
          { repoRoot, dbPath, writeRoot },
          r.taskId,
        ).catch(err => console.error(`[CEO] Merge failed for ${r.taskId}:`, err.message));
        break;
      }
      case 'REVISION': {
        casUpdateStatus(db, r.taskId, task.version, 'REVIEW_PENDING', 'REVISION_NEEDED');
        const childId = `${r.taskId}-r${(task.ceo_iteration ?? 0) + 1}`;
        createTask(db, {
          id: childId,
          title: `${task.title} (Revision ${(task.ceo_iteration ?? 0) + 1})`,
          expected_touch_files: task.modified_files ?? task.expected_touch_files ?? [],
          level: task.level,
          snapshot_version: task.snapshot_version ?? 'unknown',
          dependencies: null,
        });
        db.prepare(`UPDATE tasks SET ceo_feedback = ?, ceo_iteration = ?, parent_task_id = ? WHERE id = ?`)
          .run(JSON.stringify(r.feedback), (task.ceo_iteration ?? 0) + 1, r.taskId, childId);
        break;
      }
      case 'ESCALATE': {
        casUpdateStatus(db, r.taskId, task.version, 'REVIEW_PENDING', 'CEO_ESCALATED');
        db.prepare(`UPDATE tasks SET ceo_feedback = ?, ceo_score = ? WHERE id = ?`)
          .run(JSON.stringify(r.feedback), r.feedback.score, r.taskId);
        auditLogger?.log('MERGE_BLOCKED', { taskId: r.taskId, ceoScore: r.feedback.score });
        break;
      }
    }
  }

  if (result.reviewed > 0) {
    console.log(`[CEO] Review: ${result.passed} passed, ${result.revision} revision, ${result.escalated} escalated, ${result.skipped} skipped | cost=$${result.totalCost.toFixed(4)}`);
  }
}

export function wakeTick(db: Database.Database): number {
  return wakeSleepingTasks(db);
}

/** 从 DB 按 ID 查询任务 */
function queryTaskById(db: Database.Database, id: string): Task | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return row as unknown as Task;
}
