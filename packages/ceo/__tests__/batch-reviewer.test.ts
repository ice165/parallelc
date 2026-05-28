import Database from 'better-sqlite3';
import { initializeSchema, createTask } from '@parallelc/taskboard';
import { ceoBatchReview } from '../src/batch-reviewer';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
});

afterEach(() => db.close());

describe('ceoBatchReview', () => {
  test('空 REVIEW_PENDING 队列 → 全部为 0', async () => {
    const result = await ceoBatchReview(db, '/tmp', 'sk-test', 70, 0.6, 10, 'test request');
    expect(result.reviewed).toBe(0);
    expect(result.skipped).toBe(0);
  });
});
