import Database from 'better-sqlite3';
import { detectStalled } from '../src/post-validate/stall-detector';
import { initializeSchema, createTask, casUpdateStatus } from '@parallelc/taskboard';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
});

afterEach(() => db.close());

describe('detectStalled', () => {
  test('no READY tasks -> returns empty list', () => {
    const stalled = detectStalled(db);
    expect(stalled).toHaveLength(0);
  });

  test('READY task depends on FAILED -> detects stall', () => {
    createTask(db, { id: 'task-dep', title: 'Dep', expected_touch_files: ['d.ts'], snapshot_version: 'v1' });
    createTask(db, { id: 'task-main', title: 'Main', expected_touch_files: ['m.ts'],
      dependencies: JSON.stringify(['task-dep']), snapshot_version: 'v1' });
    casUpdateStatus(db, 'task-dep', 0, 'PENDING', 'READY');
    casUpdateStatus(db, 'task-dep', 1, 'READY', 'RUNNING');
    casUpdateStatus(db, 'task-dep', 2, 'RUNNING', 'FAILED');
    casUpdateStatus(db, 'task-main', 0, 'PENDING', 'READY');

    const stalled = detectStalled(db);
    const main = stalled.find(s => s.taskId === 'task-main');
    expect(main).toBeDefined();
    expect(main!.action).toBe('CANCEL');
  });

  test('READY task depends on CANCELLED -> detects stall', () => {
    createTask(db, { id: 'task-dep', title: 'Dep', expected_touch_files: ['d.ts'], snapshot_version: 'v1' });
    createTask(db, { id: 'task-main', title: 'Main', expected_touch_files: ['m.ts'],
      dependencies: JSON.stringify(['task-dep']), snapshot_version: 'v1' });
    casUpdateStatus(db, 'task-dep', 0, 'PENDING', 'READY');
    casUpdateStatus(db, 'task-dep', 1, 'READY', 'RUNNING');
    casUpdateStatus(db, 'task-dep', 2, 'RUNNING', 'CANCELLED');
    casUpdateStatus(db, 'task-main', 0, 'PENDING', 'READY');

    const stalled = detectStalled(db);
    expect(stalled.length).toBeGreaterThan(0);
  });
});
