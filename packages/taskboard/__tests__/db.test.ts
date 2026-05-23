import Database from 'better-sqlite3';
import { getDb, initializeSchema, closeDb } from '../src/db';
import path from 'path';
import fs from 'fs';
import { tmpdir } from 'os';

let dbPath: string;
let dbPath2: string;

beforeEach(() => {
  const tmpDir = fs.mkdtempSync(path.join(tmpdir(), 'parallelc-db-'));
  dbPath = path.join(tmpDir, 'test.db');
  dbPath2 = path.join(tmpDir, 'test2.db');
});

afterEach(() => {
  closeDb();
});

describe('getDb', () => {
  test('返回 Database 实例', () => {
    const db = getDb(dbPath);
    expect(db).toBeInstanceOf(Database);
  });

  test('相同 dbPath 返回同一实例', () => {
    const db1 = getDb(dbPath);
    const db2 = getDb(dbPath);
    expect(db1).toBe(db2);
  });

  test('不同 dbPath 返回不同实例', () => {
    const db1 = getDb(dbPath);
    const db2 = getDb(dbPath2);
    expect(db1).not.toBe(db2);
  });
});

describe('initializeSchema', () => {
  test('幂等创建表结构', () => {
    const db = getDb(dbPath);
    initializeSchema(db);
    expect(() => initializeSchema(db)).not.toThrow();
  });

  test('创建后可插入任务', () => {
    const db = getDb(dbPath);
    initializeSchema(db);
    db.prepare('INSERT INTO tasks (id, title, level) VALUES (?, ?, ?)').run('t1', 'Test', 'L2');
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get('t1') as Record<string, unknown>;
    expect(row['title']).toBe('Test');
    expect(row['level']).toBe('L2');
  });

  test('WAL 模式已启用', () => {
    const db = getDb(dbPath);
    initializeSchema(db);
    const journalMode = db.prepare('PRAGMA journal_mode').get() as Record<string, string>;
    expect(journalMode['journal_mode']).toBe('wal');
  });
});
