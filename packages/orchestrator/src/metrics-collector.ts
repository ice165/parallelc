import Database from 'better-sqlite3';

export interface PredictionRecord {
  taskId: string;
  expectedFiles: string[];
  actualFiles: string[] | null;
  accuracy: number | null;
  recordedAt: string;
}

export function recordPrediction(db: Database.Database, taskId: string, expectedFiles: string[]): void {
  // Phase 3B skeleton — full implementation in Task 7
  db.exec(`
    CREATE TABLE IF NOT EXISTS prediction_records (
      task_id TEXT PRIMARY KEY,
      expected_files TEXT,
      actual_files TEXT,
      accuracy REAL,
      recorded_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.prepare('INSERT OR REPLACE INTO prediction_records (task_id, expected_files) VALUES (?, ?)')
    .run(taskId, JSON.stringify(expectedFiles));
}

export function updatePredictionRecord(db: Database.Database, taskId: string, actualFiles: string[]): void {
  // Phase 3A fills this in
}

export function getPredictionAccuracy(db: Database.Database): { overall: number; details: PredictionRecord[] } {
  return { overall: 0, details: [] };
}
