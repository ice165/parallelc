import { recordPrediction, updatePredictionRecord, getPredictionAccuracy } from '../src/metrics-collector';
import Database from 'better-sqlite3';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS prediction_records (
      task_id TEXT PRIMARY KEY,
      expected_files TEXT,
      actual_files TEXT,
      accuracy REAL,
      recorded_at TEXT
    )
  `);
});

afterEach(() => db.close());

describe('metrics-collector', () => {
  test('recordPrediction writes expected files', () => {
    recordPrediction(db, 't1', ['src/a.ts', 'src/b.ts']);
    const result = getPredictionAccuracy(db);
    expect(result.details).toHaveLength(1);
    expect(result.details[0]!.expectedFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(result.details[0]!.accuracy).toBeNull();
  });

  test('updatePredictionRecord backfills actual files and calculates accuracy', () => {
    recordPrediction(db, 't1', ['src/a.ts', 'src/b.ts']);
    updatePredictionRecord(db, 't1', ['src/a.ts']);
    const result = getPredictionAccuracy(db);
    expect(result.details[0]!.actualFiles).toEqual(['src/a.ts']);
    expect(result.details[0]!.accuracy).toBe(0.5);
  });

  test('perfect match accuracy is 1', () => {
    recordPrediction(db, 't1', ['src/a.ts']);
    updatePredictionRecord(db, 't1', ['src/a.ts']);
    const result = getPredictionAccuracy(db);
    expect(result.details[0]!.accuracy).toBe(1);
  });

  test('overall accuracy aggregates correctly', () => {
    recordPrediction(db, 't1', ['src/a.ts', 'src/b.ts']);
    updatePredictionRecord(db, 't1', ['src/a.ts']); // 0.5
    recordPrediction(db, 't2', ['src/c.ts']);
    updatePredictionRecord(db, 't2', ['src/c.ts']); // 1.0
    const result = getPredictionAccuracy(db);
    expect(result.details).toHaveLength(2);
    expect(result.overall).toBe(0.75);
  });
});
