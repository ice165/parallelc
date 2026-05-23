import { WorkerPool } from '../src/worker-pool';
import type { Task } from '@parallelc/shared';

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
}));

const makeTask = (id: string, files: string[]): Task => ({
  id,
  title: `Task ${id}`,
  status: 'READY',
  version: 0,
  level: 'L2',
  expected_touch_files: files,
  modified_files: null,
  rate_limit_count: 0,
  sleep_until: null,
  starvation_override: false,
  snapshot_version: 'dag1-20260701',
  context_mismatch: false,
  merge_blocked_at: null,
  merge_report_path: null,
  dependencies: null,
  ready_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

describe('WorkerPool', () => {
  test('hasCapacity 在未达上限时返回 true', () => {
    const pool = new WorkerPool(['sk-a', 'sk-b'], 4);
    expect(pool.hasCapacity()).toBe(true);
  });

  test('worker 达到上限后 hasCapacity 返回 false', async () => {
    const pool = new WorkerPool(['sk-a', 'sk-b'], 1);
    await pool.spawn(makeTask('t1', ['src/a.ts']), '/repo');
    expect(pool.hasCapacity()).toBe(false);
  });

  test('activeCount 正确计数', async () => {
    const pool = new WorkerPool(['sk-a'], 3);
    expect(pool.activeCount).toBe(0);
    await pool.spawn(makeTask('t1', ['src/a.ts']), '/repo');
    expect(pool.activeCount).toBe(1);
  });

  test('reap 返回已退出进程并移除', async () => {
    const pool = new WorkerPool(['sk-a'], 3);
    await pool.spawn(makeTask('t1', ['src/a.ts']), '/repo');

    const entries = Array.from((pool as unknown as Record<string, Map<string, unknown>>)['workers'].values());
    (entries[0] as Record<string, unknown>)['process'] = {
      exitCode: 0,
      pid: 99999,
    };

    const reaped = pool.reap();
    expect(reaped).toHaveLength(1);
    expect(pool.activeCount).toBe(0);
  });

  test('KeyPool 循环返回所有 Key', () => {
    const pool = new WorkerPool(['sk-a', 'sk-b', 'sk-c'], 4);
    const keyPool = pool.getKeyPool();
    const keys = new Set<string>();
    for (let i = 0; i < 6; i++) {
      keys.add(keyPool.nextKey());
    }
    expect(keys).toContain('sk-a');
    expect(keys).toContain('sk-b');
    expect(keys).toContain('sk-c');
  });

  test('spawn 注入正确的环境变量', async () => {
    const pool = new WorkerPool(['sk-test'], 4);
    const { spawnMcpWorker } = require('@parallelc/worker');
    const { spawnWorker } = require('@parallelc/worker');

    await pool.spawn(
      makeTask('task-env-001', ['src/api/user.ts']),
      '/repo',
    );

    expect(spawnWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        workerId: 'worker-task-env-001',
        expectedTouchFiles: ['src/api/user.ts'],
        repoRoot: '/repo',
        apiKey: 'sk-test',
      }),
    );

    expect(spawnMcpWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-test',
        cwd: '/tmp/worker-task-env-001-write',
        readonlyRoot: '/tmp/worker-task-env-001-readonly',
      }),
      expect.objectContaining({
        taskId: 'task-env-001',
        snapshotVersion: 'dag1-20260701',
      }),
    );
  });
});
