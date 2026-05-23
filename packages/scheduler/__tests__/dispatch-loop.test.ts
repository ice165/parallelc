import { dispatchTick, reapTick, wakeTick } from '../src/dispatch-loop';
import { WorkerPool } from '../src/worker-pool';
import Database from 'better-sqlite3';
import { initializeSchema, createTask, casUpdateStatus, queryTasksByStatus, getLockedFiles } from '@parallelc/taskboard';
import { EXIT_SUCCESS, EXIT_RATE_LIMIT, EXIT_TIMEOUT } from '@parallelc/shared';

// Mock @parallelc/keypool
jest.mock('@parallelc/keypool', () => ({
  KeyPool: jest.fn().mockImplementation((keys: string[]) => ({
    nextKey: jest.fn().mockReturnValue(keys[0]),
    markSuccess: jest.fn(),
    markRateLimited: jest.fn(),
    markDead: jest.fn(),
    allPaused: jest.fn().mockReturnValue(false),
    earliestRecovery: jest.fn().mockReturnValue(null),
    status: jest.fn().mockReturnValue([]),
  })),
  handleGlobalBackoff: jest.fn().mockReturnValue({ paused: false, resumeAt: null }),
}));

// Mock @parallelc/worker，避免 dispatchTick 内 spawn() 执行真实 git 命令
jest.mock('@parallelc/worker', () => ({
  spawnWorker: jest.fn().mockResolvedValue({
    workerId: 'worker-test-001',
    readonlyRoot: '/tmp/worker-test-001-readonly',
    writeRoot: '/tmp/worker-test-001-write',
    spawnedAt: new Date().toISOString(),
  }),
  spawnMcpWorker: jest.fn().mockReturnValue({
    pid: 99999,
    on: jest.fn(),
    kill: jest.fn(),
  } as unknown as import('child_process').ChildProcess),
  routeExitCode: jest.fn(),
  runWorker: jest.fn(),
  cleanupWorktrees: jest.fn().mockResolvedValue(undefined),
  // startup 相关导出也需要 mock，避免导入链失败
  verifySnapshotVersion: jest.fn(),
  parseProjectContextHeader: jest.fn(),
  collectModifiedFiles: jest.fn(),
  calculateRateLimitBackoff: jest.fn(),
}));

let db: Database.Database;
let pool: WorkerPool;

beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
  pool = new WorkerPool(['sk-test'], 4);
});

afterEach(() => {
  db.close();
});

describe('dispatchTick', () => {
  test('派发无冲突的 READY 任务', () => {
    createTask(db, {
      id: 't1',
      title: 'Task 1',
      expected_touch_files: ['src/a.ts'],
      level: 'L2',
    });
    casUpdateStatus(db, 't1', 0, 'PENDING', 'READY');

    const result = dispatchTick(db, pool, '/repo', 4);
    expect(result.dispatched).toBe(1);
    expect(result.delayed).toBe(0);

    const running = queryTasksByStatus(db, 'RUNNING');
    expect(running).toHaveLength(1);
  });

  test('文件冲突时延迟任务', () => {
    createTask(db, {
      id: 't1',
      title: 'Task 1',
      expected_touch_files: ['src/a.ts'],
      level: 'L2',
    });
    createTask(db, {
      id: 't2',
      title: 'Task 2',
      expected_touch_files: ['src/a.ts', 'src/b.ts'],
      level: 'L2',
    });

    casUpdateStatus(db, 't1', 0, 'PENDING', 'READY');
    casUpdateStatus(db, 't2', 0, 'PENDING', 'READY');

    const result = dispatchTick(db, pool, '/repo', 4);
    expect(result.dispatched).toBe(1);
    expect(result.delayed).toBe(1);

    const locked = getLockedFiles(db);
    expect(locked).toContain('src/a.ts');
  });

  test('等待超 300s 触发饥饿保护', () => {
    createTask(db, {
      id: 't1',
      title: 'Task 1',
      expected_touch_files: ['src/x.ts'],
      level: 'L2',
    });
    casUpdateStatus(db, 't1', 0, 'PENDING', 'READY');

    dispatchTick(db, pool, '/repo', 4);

    createTask(db, {
      id: 't2',
      title: 'Task 2',
      expected_touch_files: ['src/x.ts'],
      level: 'L2',
    });
    casUpdateStatus(db, 't2', 0, 'PENDING', 'READY');

    db.prepare("UPDATE tasks SET ready_at = datetime('now', '-301 seconds') WHERE id = 't2'").run();

    const result2 = dispatchTick(db, pool, '/repo', 4);
    expect(result2.starvation).toBe(1);
    expect(result2.dispatched).toBe(1);
  });

  test('池满时停止派发', () => {
    const smallPool = new WorkerPool(['sk-test'], 1);

    createTask(db, {
      id: 't1',
      title: 'T1',
      expected_touch_files: ['src/a.ts'],
      level: 'L2',
    });
    createTask(db, {
      id: 't2',
      title: 'T2',
      expected_touch_files: ['src/b.ts'],
      level: 'L2',
    });
    casUpdateStatus(db, 't1', 0, 'PENDING', 'READY');
    casUpdateStatus(db, 't2', 0, 'PENDING', 'READY');

    const result = dispatchTick(db, smallPool, '/repo', 1);
    expect(result.dispatched).toBe(1);

    const stillReady = queryTasksByStatus(db, 'READY');
    expect(stillReady).toHaveLength(1);
  });
});

describe('reapTick', () => {
  test('退出码 0 → MARK_DONE', async () => {
    const { routeExitCode, cleanupWorktrees } = require('@parallelc/worker');
    routeExitCode.mockReturnValue({
      type: 'MARK_DONE',
      modifiedFiles: ['src/a.ts'],
    });
    cleanupWorktrees.mockResolvedValue(undefined);

    createTask(db, {
      id: 't1',
      title: 'Task 1',
      expected_touch_files: ['src/a.ts'],
      level: 'L2',
    });
    casUpdateStatus(db, 't1', 0, 'PENDING', 'READY');

    const t1v = queryTasksByStatus(db, 'READY')[0]!.version;
    casUpdateStatus(db, 't1', t1v, 'READY', 'RUNNING');

    const workerEntry = {
      workerId: 'worker-t1',
      taskId: 't1',
      process: { exitCode: EXIT_SUCCESS } as unknown as import('child_process').ChildProcess,
      startedAt: new Date(),
      writeRoot: '/tmp/test',
      apiKey: 'sk-test',
    };
    (pool as unknown as Record<string, Map<string, unknown>>)['workers'].set('worker-t1', workerEntry);

    const result = reapTick(db, pool, '/repo');
    expect(result.done).toBe(1);

    const tasks = queryTasksByStatus(db, 'DONE');
    expect(tasks).toHaveLength(1);
  });

  test('退出码 null → 视为 EXIT_TIMEOUT', () => {
    const { routeExitCode, cleanupWorktrees } = require('@parallelc/worker');
    routeExitCode.mockReturnValue({
      type: 'FAILED',
      reason: 'Task timed out',
    });
    cleanupWorktrees.mockResolvedValue(undefined);

    createTask(db, {
      id: 't1',
      title: 'Task 1',
      expected_touch_files: ['src/a.ts'],
      level: 'L2',
    });
    casUpdateStatus(db, 't1', 0, 'PENDING', 'READY');
    const t1v = queryTasksByStatus(db, 'READY')[0]!.version;
    casUpdateStatus(db, 't1', t1v, 'READY', 'RUNNING');

    const workerEntry = {
      workerId: 'worker-t1',
      taskId: 't1',
      process: { exitCode: null } as unknown as import('child_process').ChildProcess,
      startedAt: new Date(),
      writeRoot: '/tmp/test',
      apiKey: 'sk-test',
    };
    (pool as unknown as Record<string, Map<string, unknown>>)['workers'].set('worker-t1', workerEntry);

    const result = reapTick(db, pool, '/repo');
    expect(result.failed).toBe(1);

    const tasks = queryTasksByStatus(db, 'FAILED');
    expect(tasks).toHaveLength(1);
  });
});

describe('wakeTick', () => {
  test('唤醒到期的 SLEEP_PENDING 任务', () => {
    createTask(db, {
      id: 't1',
      title: 'T1',
      expected_touch_files: ['src/a.ts'],
      level: 'L2',
    });
    casUpdateStatus(db, 't1', 0, 'PENDING', 'READY');
    const v1 = queryTasksByStatus(db, 'READY')[0]!.version;
    casUpdateStatus(db, 't1', v1, 'READY', 'RUNNING');
    const v2 = queryTasksByStatus(db, 'RUNNING')[0]!.version;
    casUpdateStatus(db, 't1', v2, 'RUNNING', 'SLEEP_PENDING', {
      sleep_until: new Date(Date.now() - 60000).toISOString(),
    });

    const count = wakeTick(db);
    expect(count).toBe(1);

    const ready = queryTasksByStatus(db, 'READY');
    expect(ready).toHaveLength(1);
  });

  test('不到期的任务不唤醒', () => {
    createTask(db, {
      id: 't1',
      title: 'T1',
      expected_touch_files: ['src/a.ts'],
      level: 'L2',
    });
    casUpdateStatus(db, 't1', 0, 'PENDING', 'READY');
    const v1 = queryTasksByStatus(db, 'READY')[0]!.version;
    casUpdateStatus(db, 't1', v1, 'READY', 'RUNNING');
    const v2 = queryTasksByStatus(db, 'RUNNING')[0]!.version;
    casUpdateStatus(db, 't1', v2, 'RUNNING', 'SLEEP_PENDING', {
      sleep_until: new Date(Date.now() + 3600000).toISOString(),
    });

    const count = wakeTick(db);
    expect(count).toBe(0);
  });
});
