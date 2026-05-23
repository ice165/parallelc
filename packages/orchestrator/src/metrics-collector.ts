import Database from 'better-sqlite3';

export interface PredictionRecord {
  taskId: string;
  expectedFiles: string[];
  actualFiles: string[] | null;
  accuracy: number | null;
  recordedAt: string;
}

export function recordPrediction(
  db: Database.Database,
  taskId: string,
  expectedFiles: string[],
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS prediction_records (
      task_id TEXT PRIMARY KEY,
      expected_files TEXT,
      actual_files TEXT,
      accuracy REAL,
      recorded_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.prepare(`
    INSERT INTO prediction_records (task_id, expected_files, recorded_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(task_id) DO UPDATE SET expected_files = excluded.expected_files
  `).run(taskId, JSON.stringify(expectedFiles));
}

export function updatePredictionRecord(
  db: Database.Database,
  taskId: string,
  actualFiles: string[],
): void {
  const row = db.prepare(
    'SELECT expected_files FROM prediction_records WHERE task_id = ?',
  ).get(taskId) as Record<string,string> | undefined;

  if (!row) return;

  const expected: string[] = JSON.parse(row['expected_files']!);
  const intersect = expected.filter(f => actualFiles.includes(f)).length;
  const union = new Set([...expected, ...actualFiles]).size;
  const accuracy = union > 0 ? intersect / union : 1;

  db.prepare(`
    UPDATE prediction_records
    SET actual_files = ?, accuracy = ?
    WHERE task_id = ?
  `).run(JSON.stringify(actualFiles), accuracy, taskId);
}

export function getPredictionAccuracy(
  db: Database.Database,
): { overall: number; details: PredictionRecord[] } {
  const rows = db.prepare(`
    SELECT task_id, expected_files, actual_files, accuracy, recorded_at
    FROM prediction_records
    ORDER BY recorded_at DESC
  `).all() as Record<string,string>[];

  const details = rows.map(r => ({
    taskId: r['task_id']!,
    expectedFiles: JSON.parse(r['expected_files'] ?? '[]'),
    actualFiles: r['actual_files'] ? JSON.parse(r['actual_files']) : null,
    accuracy: r['accuracy'] ? Number(r['accuracy']) : null,
    recordedAt: r['recorded_at']!,
  }));

  const withAccuracy = details.filter(d => d.accuracy !== null);
  const overall = withAccuracy.length > 0
    ? withAccuracy.reduce((sum, d) => sum + d.accuracy!, 0) / withAccuracy.length
    : 0;

  return { overall, details };
}
