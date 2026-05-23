import Database from 'better-sqlite3';
import { TASK_TABLE_DDL } from './schema.js';

const instances = new Map<string, Database.Database>();

export function getDb(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? '.parallelc/taskboard.db';

  let db = instances.get(resolvedPath);
  if (!db) {
    db = new Database(resolvedPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    instances.set(resolvedPath, db);
  }
  return db;
}

export function initializeSchema(db: Database.Database): void {
  db.exec(TASK_TABLE_DDL);
}

export function closeDb(dbPath?: string): void {
  if (dbPath) {
    const db = instances.get(dbPath);
    if (db) {
      db.close();
      instances.delete(dbPath);
    }
  } else {
    for (const [, db] of instances) {
      db.close();
    }
    instances.clear();
  }
}
