import Database from 'better-sqlite3';
import { detectGhosts } from '../src/ghost-detector';
import { initializeSchema } from '../src/db';
import { createTask, casUpdateStatus, queryTasksByStatus } from '../src/repository';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

describe('detectGhosts', () => {
  test('无 RUNNING 任务 → 返回空列表', () => {
    const ghosts = detectGhosts(db, new Set());
    expect(ghosts).toHaveLength(0);
  });

  test('RUNNING 任务在 Pool 中 → 不视为幽灵', () => {
    createTask(db, {
      id: 'task-001',
      title: 'test',
      expected_touch_files: ['a.ts'],
      snapshot_version: 'v1',
    });
    casUpdateStatus(db, 'task-001', 0, 'PENDING', 'READY');
    const version = queryTasksByStatus(db, 'READY')[0]!.version;
    casUpdateStatus(db, 'task-001', version, 'READY', 'RUNNING');
    const poolPids = new Set(['worker-task-001']);
    const ghosts = detectGhosts(db, poolPids);
    expect(ghosts).toHaveLength(0);
  });

  test('RUNNING 任务不在 Pool → 返回幽灵列表', () => {
    createTask(db, {
      id: 'task-002',
      title: 'orphan',
      expected_touch_files: ['b.ts'],
      snapshot_version: 'v1',
    });
    casUpdateStatus(db, 'task-002', 0, 'PENDING', 'READY');
    const version = queryTasksByStatus(db, 'READY')[0]!.version;
    casUpdateStatus(db, 'task-002', version, 'READY', 'RUNNING');
    const ghosts = detectGhosts(db, new Set());
    expect(ghosts.length).toBeGreaterThan(0);
    expect(ghosts[0]!.taskId).toBe('task-002');
  });

  test('多个 RUNNING 任务，部分在 Pool → 仅返回不在 Pool 中的', () => {
    createTask(db, {
      id: 'task-003',
      title: 'alive',
      expected_touch_files: ['c.ts'],
      snapshot_version: 'v1',
    });
    createTask(db, {
      id: 'task-004',
      title: 'dead',
      expected_touch_files: ['d.ts'],
      snapshot_version: 'v1',
    });

    casUpdateStatus(db, 'task-003', 0, 'PENDING', 'READY');
    let version = queryTasksByStatus(db, 'READY')[0]!.version;
    casUpdateStatus(db, 'task-003', version, 'READY', 'RUNNING');

    casUpdateStatus(db, 'task-004', 0, 'PENDING', 'READY');
    version = queryTasksByStatus(db, 'READY')[0]!.version;
    casUpdateStatus(db, 'task-004', version, 'READY', 'RUNNING');

    const poolPids = new Set(['worker-task-003']);
    const ghosts = detectGhosts(db, poolPids);
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0]!.taskId).toBe('task-004');
  });
});
