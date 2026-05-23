import Database from 'better-sqlite3';
import { mergeTask, type MergeResult } from './merge-strategy.js';
import { generateBlockedReport } from './report-generator.js';
import { bridgeAccuracy } from './accuracy-bridge.js';
import type { Task } from '@parallelc/shared';
import { getDb, casUpdateStatus } from '@parallelc/taskboard';

export interface CoordinatorConfig {
  repoRoot: string;
  dbPath: string;
  writeRoot?: string;             // Worker 写区路径，用于 mergeTask 定位 worktree
  accuracyWarnThreshold?: number;
}

export interface CoordinatorResult {
  taskId: string;
  mergeResult: MergeResult;
  accuracyUpdated: boolean;
  downstreamTriggered: string[];
}

export async function coordinateMerge(
  config: CoordinatorConfig,
  taskId: string,
): Promise<CoordinatorResult> {
  const db = getDb(config.dbPath);
  const mergeResult = await mergeTask(db, taskId, config.repoRoot, config.writeRoot);
  let accuracyUpdated = false;
  let shouldWarn = false;
  const downstreamTriggered: string[] = [];

  if (mergeResult.success) {
    const bridge = bridgeAccuracy(db, taskId, config.accuracyWarnThreshold);
    accuracyUpdated = bridge.updated;
    shouldWarn = bridge.shouldWarn;

    if (shouldWarn) {
      console.warn(
        `[coordinator] Prediction accuracy < ${(config.accuracyWarnThreshold ?? 0.70) * 100}%! Review Orchestrator Prompt.`,
      );
    }

    // DAG 传播: 查找依赖此任务的直接下游
    // JSON 解析过滤替代 LIKE 子串匹配，防止 task-1 误匹配 task-10
    const pending = db.prepare(
      `SELECT id, dependencies FROM tasks WHERE dependencies IS NOT NULL AND status = 'PENDING'`,
    ).all() as Record<string, string>[];
    const downstream = pending.filter(row => {
      try {
        const deps = JSON.parse(row['dependencies'] ?? '[]') as string[];
        return Array.isArray(deps) && deps.includes(taskId);
      } catch { return false; }
    });

    for (const ds of downstream) {
      const deps: string[] = JSON.parse(ds['dependencies'] ?? '[]');
      const allDone = deps.every((depId: string) => {
        const dep = db.prepare('SELECT status FROM tasks WHERE id = ?')
          .get(depId) as Record<string, string> | undefined;
        return dep?.['status'] === 'DONE';
      });

      if (allDone) {
        const dsId = ds['id']!;
        downstreamTriggered.push(dsId);
        // 触发下游合并（fire-and-forget，错误由外层处理）
        coordinateMerge(config, dsId).catch((err: Error) => {
          console.error(`[coordinator] Failed to cascade merge for ${dsId}:`, err.message);
        });
      }
    }
  } else if (mergeResult.strategy === 'BLOCKED' && mergeResult.conflicts.length > 0) {
    const taskA = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as unknown as Task | undefined;
    if (taskA) {
      const otherId = mergeResult.conflicts[0]!.taskB.taskId;
      const taskB = db.prepare('SELECT * FROM tasks WHERE id = ?').get(otherId) as unknown as Task | undefined;
      if (taskB) {
        generateBlockedReport(db, taskA, taskB, mergeResult.conflicts[0]!, config.repoRoot);
      }
    }
    casUpdateStatus(db, taskId, 0, 'DONE', 'MERGE_BLOCKED');
  }

  return { taskId, mergeResult, accuracyUpdated, downstreamTriggered };
}
