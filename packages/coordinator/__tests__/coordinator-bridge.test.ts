import { bridgeAccuracy } from '../src/accuracy-bridge';
import Database from 'better-sqlite3';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT, modified_files TEXT
    );
    CREATE TABLE IF NOT EXISTS prediction_records (
      task_id TEXT PRIMARY KEY, expected_files TEXT, actual_files TEXT, accuracy REAL
    );
  `);
});

afterEach(() => db.close());

describe('bridgeAccuracy', () => {
  test('Jaccard 准确率计算: 1/2 = 0.5', () => {
    db.prepare('INSERT INTO tasks (id, modified_files) VALUES (?, ?)').run('t1', '["src/a.ts"]');
    db.prepare('INSERT INTO prediction_records (task_id, expected_files) VALUES (?, ?)')
      .run('t1', '["src/a.ts","src/b.ts"]');

    const result = bridgeAccuracy(db, 't1');
    expect(result.accuracy).toBe(0.5);
    expect(result.updated).toBe(true);
  });

  test('完全匹配准确率为 1', () => {
    db.prepare('INSERT INTO tasks (id, modified_files) VALUES (?, ?)').run('t2', '["src/a.ts"]');
    db.prepare('INSERT INTO prediction_records (task_id, expected_files) VALUES (?, ?)')
      .run('t2', '["src/a.ts"]');

    const result = bridgeAccuracy(db, 't2');
    expect(result.accuracy).toBe(1);
  });

  test('无 prediction_record 返回 null', () => {
    db.prepare('INSERT INTO tasks (id, modified_files) VALUES (?, ?)').run('t3', '["src/a.ts"]');
    const result = bridgeAccuracy(db, 't3');
    expect(result.accuracy).toBeNull();
    expect(result.updated).toBe(false);
  });

  test('全局准确率低于阈值触发 shouldWarn', () => {
    // t1: 0.5
    db.prepare('INSERT INTO tasks (id, modified_files) VALUES (?, ?)').run('t1', '["src/a.ts"]');
    db.prepare('INSERT INTO prediction_records (task_id, expected_files) VALUES (?, ?)')
      .run('t1', '["src/a.ts","src/b.ts"]');

    const result = bridgeAccuracy(db, 't1', 0.70);
    expect(result.shouldWarn).toBe(true);
  });
});
