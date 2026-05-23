import Database from 'better-sqlite3';

/**
 * 连接 Merge Coordinator 和预测准确率采集。
 * Jaccard 相似度: accuracy = |expected ∩ actual| / |expected ∪ actual|
 * Phase 3B 的 Orchestrator 已通过 recordPrediction 写入 expected_files。
 * 这里回填 actual_files 并计算准确率。
 */
export function bridgeAccuracy(
  db: Database.Database,
  taskId: string,
  warnThreshold: number = 0.70,
): { accuracy: number | null; updated: boolean; shouldWarn: boolean } {
  const task = db.prepare('SELECT modified_files FROM tasks WHERE id = ?')
    .get(taskId) as Record<string, unknown> | undefined;
  if (!task?.['modified_files']) return { accuracy: null, updated: false, shouldWarn: false };

  const actualFiles: string[] = JSON.parse(task['modified_files'] as string);

  const predRow = db.prepare('SELECT expected_files FROM prediction_records WHERE task_id = ?')
    .get(taskId) as Record<string, string> | undefined;
  if (!predRow) return { accuracy: null, updated: false, shouldWarn: false };

  const expected: string[] = JSON.parse(predRow['expected_files']);
  const intersect = expected.filter(f => actualFiles.includes(f)).length;
  const union = new Set([...expected, ...actualFiles]).size;
  const accuracy = union > 0 ? intersect / union : 1;

  db.prepare('UPDATE prediction_records SET actual_files = ?, accuracy = ? WHERE task_id = ?')
    .run(JSON.stringify(actualFiles), accuracy, taskId);

  const global = db.prepare(
    'SELECT AVG(accuracy) as overall FROM prediction_records WHERE accuracy IS NOT NULL',
  ).get() as Record<string, number>;
  const shouldWarn = (global['overall'] ?? 1) < warnThreshold;

  return { accuracy, updated: true, shouldWarn };
}
