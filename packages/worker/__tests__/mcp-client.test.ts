import { spawnMcpWorker, buildWorkerSystemPrompt } from '../src/mcp-client';
import { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

// Mock child_process.spawn
const mockProcess = new EventEmitter() as unknown as ChildProcess;
mockProcess.stdin = { write: jest.fn() } as unknown as NodeJS.WriteStream;
mockProcess.stdout = new EventEmitter() as unknown as NodeJS.ReadStream;
mockProcess.stderr = new EventEmitter() as unknown as NodeJS.ReadStream;
mockProcess.kill = jest.fn();
(mockProcess as Record<string, unknown>)['pid'] = 12345;
(mockProcess as Record<string, unknown>)['exitCode'] = null;

jest.mock('child_process', () => ({
  spawn: jest.fn(() => mockProcess),
}));

describe('buildWorkerSystemPrompt', () => {
  test('包含 snapshot_version 校验指令', () => {
    const prompt = buildWorkerSystemPrompt({
      taskId: 'task-001',
      snapshotVersion: 'dag1-20260701T100000Z',
      dependencies: ['task-000'],
    });
    expect(prompt).toContain('project_context.md');
    expect(prompt).toContain('snapshot_version');
    expect(prompt).toContain('dag1-20260701T100000Z');
    expect(prompt).toContain('task-001');
    expect(prompt).toContain('WORKER_READONLY_ROOT');
    expect(prompt).toContain('WORKER_WRITE_ROOT');
  });

  test('无依赖时仍正常生成', () => {
    const prompt = buildWorkerSystemPrompt({
      taskId: 'task-002',
      snapshotVersion: 'dag1-20260702',
      dependencies: null,
    });
    expect(prompt).toContain('task-002');
    expect(prompt).not.toContain('前置任务');
  });
});

describe('spawnMcpWorker', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockProcess.kill.mockClear();
    mockProcess.removeAllListeners();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('返回 ChildProcess 实例', () => {
    const process = spawnMcpWorker(
      { apiKey: 'sk-test', cwd: '/tmp/w1-write', readonlyRoot: '/tmp/w1-readonly' },
      { taskId: 't1', snapshotVersion: 'dag1', dependencies: null },
    );
    expect(process).toBeDefined();
    expect(process).toBe(mockProcess);
  });

  test('spawn 参数正确传递', () => {
    const { spawn } = require('child_process');
    spawnMcpWorker(
      { apiKey: 'sk-test', cwd: '/tmp/w1-write', readonlyRoot: '/tmp/w1-readonly' },
      { taskId: 't1', snapshotVersion: 'dag1', dependencies: null },
    );
    expect(spawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--mcp']),
      expect.objectContaining({
        cwd: '/tmp/w1-write',
        env: expect.objectContaining({
          ANTHROPIC_API_KEY: 'sk-test',
        }),
      }),
    );
  });

  test('Watchdog 超时后 SIGTERM → SIGKILL', () => {
    spawnMcpWorker(
      {
        apiKey: 'sk-test',
        cwd: '/tmp/w1-write',
        readonlyRoot: '/tmp/w1-readonly',
        timeoutMs: 1000,
      },
      { taskId: 't1', snapshotVersion: 'dag1', dependencies: null },
    );

    jest.advanceTimersByTime(500);
    expect(mockProcess.kill).not.toHaveBeenCalled();

    jest.advanceTimersByTime(600);
    expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');

    jest.advanceTimersByTime(5000);
    expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL');
  });

  test('正常退出时清除 Watchdog', () => {
    spawnMcpWorker(
      {
        apiKey: 'sk-test',
        cwd: '/tmp/w1-write',
        readonlyRoot: '/tmp/w1-readonly',
        timeoutMs: 1000,
      },
      { taskId: 't1', snapshotVersion: 'dag1', dependencies: null },
    );

    (mockProcess as EventEmitter).emit('exit', 0, null);
    jest.advanceTimersByTime(1100);
    expect(mockProcess.kill).not.toHaveBeenCalled();
  });
});
