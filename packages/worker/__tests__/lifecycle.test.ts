import { routeExitCode, calculateRateLimitBackoff } from '../src/lifecycle';
import { collectModifiedFiles, EXIT_SUCCESS, EXIT_CHECKPOINT, EXIT_TIMEOUT, EXIT_HOOK_BLOCKED, EXIT_RATE_LIMIT } from '@parallelc/shared';
import { ExitAction } from '@parallelc/shared';
import path from 'path';
import fs from 'fs';
import os from 'os';

describe('routeExitCode', () => {
  test('退出码 0 → MARK_DONE', () => {
    const action = routeExitCode({
      taskId: 't1',
      exitCode: EXIT_SUCCESS,
      writeRoot: '/tmp/w1-write',
      rateLimitCount: 0,
    });
    expect(action.type).toBe('MARK_DONE');
  });

  test('退出码 10 → CHECKPOINT', () => {
    const action = routeExitCode({
      taskId: 't1',
      exitCode: EXIT_CHECKPOINT,
      writeRoot: '/tmp/w1-write',
      rateLimitCount: 0,
    });
    expect(action.type).toBe('CHECKPOINT');
  });

  test('退出码 11 → FAILED（进程超时）', () => {
    const action = routeExitCode({
      taskId: 't1',
      exitCode: EXIT_TIMEOUT,
      writeRoot: '/tmp/w1-write',
      rateLimitCount: 0,
    });
    expect(action.type).toBe('FAILED');
    expect((action as ExitAction & { reason: string }).reason).toContain('timed out');
  });

  test('退出码 12 → HOOK_BLOCKED', () => {
    const action = routeExitCode({
      taskId: 't1',
      exitCode: EXIT_HOOK_BLOCKED,
      writeRoot: '/tmp/w1-write',
      rateLimitCount: 0,
    });
    expect(action.type).toBe('HOOK_BLOCKED');
  });

  test('退出码 13 → RATE_LIMIT_SLEEP（rateLimitCount + 1）', () => {
    const action = routeExitCode({
      taskId: 't1',
      exitCode: EXIT_RATE_LIMIT,
      writeRoot: '/tmp/w1-write',
      rateLimitCount: 2,
    });
    expect(action.type).toBe('RATE_LIMIT_SLEEP');
    expect((action as ExitAction & { attempt: number }).attempt).toBe(3);
  });

  test('退出码 13 超出上限 → FAILED', () => {
    const action = routeExitCode({
      taskId: 't1',
      exitCode: EXIT_RATE_LIMIT,
      writeRoot: '/tmp/w1-write',
      rateLimitCount: 5,
      maxRateLimitRetries: 5,
    });
    expect(action.type).toBe('FAILED');
    expect((action as ExitAction & { reason: string }).reason).toContain('rate_limit_exhausted');
  });

  test('未知退出码 → FAILED', () => {
    const action = routeExitCode({
      taskId: 't1',
      exitCode: 99,
      writeRoot: '/tmp/w1-write',
      rateLimitCount: 0,
    });
    expect(action.type).toBe('FAILED');
    expect((action as ExitAction & { reason: string }).reason).toContain('Unknown');
  });
});

describe('calculateRateLimitBackoff', () => {
  test('第 1 次退避 ≈ 1 分钟', () => {
    const result = calculateRateLimitBackoff(1);
    expect(result.exceeded).toBe(false);
    const diffMs = result.wakeAt.getTime() - Date.now();
    expect(diffMs).toBeGreaterThan(30_000);
    expect(diffMs).toBeLessThan(90_000);
  });

  test('第 6 次超出上限', () => {
    const result = calculateRateLimitBackoff(6);
    expect(result.exceeded).toBe(true);
  });

  test('第 5 次退避 ≈ 16 分钟', () => {
    const result = calculateRateLimitBackoff(5);
    expect(result.exceeded).toBe(false);
    const diffMs = result.wakeAt.getTime() - Date.now();
    expect(diffMs).toBeGreaterThan(15.5 * 60_000);
    expect(diffMs).toBeLessThan(17 * 60_000);
  });
});

describe('collectModifiedFiles', () => {
  test('无 git 仓库时返回空数组', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallelc-collect-'));
    const res = collectModifiedFiles(tmpDir);
    expect(Array.isArray(res)).toBe(true);
  });
});
