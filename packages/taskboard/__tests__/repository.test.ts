import Database from 'better-sqlite3';
import { initializeSchema } from '../src/db';
import {
  createTask,
  casUpdateStatus,
  queryTasksByStatus,
  getLockedFiles,
  updateTask,
} from '../src/repository';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

describe('createTask', () => {
  test('创建任务并返回完整记录', () => {
    const task = createTask(db, {
      id: 't1',
      title: 'Add login page',
      expected_touch_files: ['src/login.ts', 'src/auth.ts'],
      dependencies: ['t0'],
      snapshot_version: 'dag1-20260701',
      level: 'L2',
    });

    expect(task.id).toBe('t1');
    expect(task.status).toBe('PENDING');
    expect(task.version).toBe(0);
    expect(task.level).toBe('L2');
    expect(task.expected_touch_files).toEqual(['src/login.ts', 'src/auth.ts']);
  });
});

describe('casUpdateStatus', () => {
  test('CAS 成功更新状态', () => {
    createTask(db, { id: 't1', title: 'Test', level: 'L2' });
    const ok = casUpdateStatus(db, 't1', 0, 'PENDING', 'READY');
    expect(ok).toBe(true);
    const tasks = queryTasksByStatus(db, 'READY');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.version).toBe(1);
  });

  test('CAS 版本冲突返回 false', () => {
    createTask(db, { id: 't1', title: 'Test', level: 'L2' });
    const ok = casUpdateStatus(db, 't1', 999, 'PENDING', 'READY');
    expect(ok).toBe(false);
  });

  test('CAS 状态不匹配返回 false', () => {
    createTask(db, { id: 't1', title: 'Test', level: 'L2' });
    const ok = casUpdateStatus(db, 't1', 0, 'RUNNING', 'READY');
    expect(ok).toBe(false);
  });

  test('非法状态转换返回 false', () => {
    createTask(db, { id: 't1', title: 'Test', level: 'L2' });
    const ok = casUpdateStatus(db, 't1', 0, 'PENDING', 'DONE');
    expect(ok).toBe(false);
  });
});

describe('getLockedFiles', () => {
  test('返回 RUNNING 和 SLEEP_PENDING 任务的文件集合', () => {
    createTask(db, { id: 't1', title: 'Task 1', expected_touch_files: ['src/a.ts', 'src/b.ts'], level: 'L2' });
    createTask(db, { id: 't2', title: 'Task 2', expected_touch_files: ['src/b.ts', 'src/c.ts'], level: 'L2' });

    casUpdateStatus(db, 't1', 0, 'PENDING', 'READY');
    const t1v = queryTasksByStatus(db, 'READY')[0]!.version;
    casUpdateStatus(db, 't1', t1v, 'READY', 'RUNNING');

    casUpdateStatus(db, 't2', 0, 'PENDING', 'READY');
    const t2v = queryTasksByStatus(db, 'READY')[0]!.version;
    casUpdateStatus(db, 't2', t2v, 'READY', 'RUNNING');
    db.prepare('UPDATE tasks SET status = ?, sleep_until = ? WHERE id = ?')
      .run('SLEEP_PENDING', new Date().toISOString(), 't2');

    const lockedFiles = getLockedFiles(db);
    expect(lockedFiles).toContain('src/a.ts');
    expect(lockedFiles).toContain('src/b.ts');
    expect(lockedFiles).toContain('src/c.ts');
  });

  test('空任务时返回空集合', () => {
    expect(getLockedFiles(db).size).toBe(0);
  });
});

describe('queryTasksByStatus', () => {
  test('按单个状态查询', () => {
    createTask(db, { id: 't1', title: 'T1', level: 'L2' });
    createTask(db, { id: 't2', title: 'T2', level: 'L2' });
    casUpdateStatus(db, 't1', 0, 'PENDING', 'READY');
    expect(queryTasksByStatus(db, 'PENDING')).toHaveLength(1);
    expect(queryTasksByStatus(db, 'READY')).toHaveLength(1);
  });

  test('按多个状态查询', () => {
    createTask(db, { id: 't1', title: 'T1', level: 'L2' });
    createTask(db, { id: 't2', title: 'T2', level: 'L2' });
    const tasks = queryTasksByStatus(db, ['PENDING', 'READY']);
    expect(tasks).toHaveLength(2);
  });

  test('非法 orderBy 使用默认排序', () => {
    createTask(db, { id: 't1', title: 'T1', level: 'L2' });
    createTask(db, { id: 't2', title: 'T2', level: 'L2' });
    const tasks = queryTasksByStatus(db, 'PENDING', "1; DROP TABLE tasks;--");
    expect(tasks).toHaveLength(2);
  });
});

describe('updateTask', () => {
  test('更新任务字段', () => {
    createTask(db, { id: 't1', title: 'Test', level: 'L2' });
    const ok = updateTask(db, 't1', 0, { modified_files: ['src/a.ts'], context_mismatch: true });
    expect(ok).toBe(true);
    const tasks = queryTasksByStatus(db, 'PENDING');
    expect(tasks[0]!.modified_files).toEqual(['src/a.ts']);
    expect(tasks[0]!.context_mismatch).toBe(true);
  });
});
