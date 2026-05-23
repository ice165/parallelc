import Database from 'better-sqlite3';
import { EXIT_TIMEOUT } from '@parallelc/shared';
import type { Task } from '@parallelc/shared';
import {
  getLockedFiles,
  queryTasksByStatus,
  casUpdateStatus,
  updateTask,
  wakeSleepingTasks,
  propagateDagFailure,
} from '@parallelc/taskboard';
import { routeExitCode, cleanupWorktrees } from '@parallelc/worker';
import { coordinateMerge } from '@parallelc/coordinator';
import { handleGlobalBackoff } from '@parallelc/keypool';
import { WorkerPool } from './worker-pool.js';

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

  const loop = setInterval(() => {
    tick++;
    const dispatch = dispatchTick(db, pool, repoRoot, maxWorkers, starvationThresholdMs);
    const reap = reapTick(db, pool, repoRoot, dbPath);
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

  // 跨轮保护：每轮从 DB 重建锁集合
  const lockedFiles = getLockedFiles(db);
  const readyTasks = queryTasksByStatus(db, 'READY');

  let dispatched = 0;
  let delayed = 0;
  let starvation = 0;

  for (const task of readyTasks) {
    if (!pool.hasCapacity()) break;
    if (dispatched >= maxWorkers) break;

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
      });

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
      case 'MARK_DONE':
        updateTask(db, task.id, task.version, { modified_files: action.modifiedFiles });
        casUpdateStatus(db, task.id, task.version, 'RUNNING', 'DONE');
        pool.getKeyPool().markSuccess(entry.apiKey);
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
        result.done++;
        break;

      case 'CHECKPOINT':
        casUpdateStatus(db, task.id, task.version, 'RUNNING', 'CHECKPOINT_PENDING');
        result.checkpointed++;
        break;

      case 'FAILED':
        casUpdateStatus(db, task.id, task.version, 'RUNNING', 'FAILED');
        propagateDagFailure(db, task.id);
        cleanupWorktrees(entry.workerId, repoRoot).catch(() => {});
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
        result.sleeping++;
        break;

      case 'HOOK_BLOCKED':
        casUpdateStatus(db, task.id, task.version, 'RUNNING', 'FAILED');
        cleanupWorktrees(entry.workerId, repoRoot).catch(() => {});
        result.failed++;
        break;
    }
  }

  return result;
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
