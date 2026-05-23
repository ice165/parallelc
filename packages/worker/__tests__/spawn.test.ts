import { spawnWorker, cleanupWorktrees } from '../src/spawn';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

let repoRoot: string;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallelc-spawn-'));
  // 显式使用 -b main 确保分支名与 spawnWorker 默认值一致
  execSync('git init -b main', { cwd: repoRoot });
  execSync('git config user.email "test@test.com"', { cwd: repoRoot });
  execSync('git config user.name "Test"', { cwd: repoRoot });
  // 创建文件结构
  fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'src', 'models'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'src', 'utils'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'user.ts'), 'export const user = 1;');
  fs.writeFileSync(path.join(repoRoot, 'src', 'models', 'user.ts'), 'export class User {}');
  fs.writeFileSync(path.join(repoRoot, 'src', 'utils', 'helper.ts'), 'export const helper = 1;');
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Test');
  execSync('git add -A && git commit -m "init"', { cwd: repoRoot });
});

afterEach(() => {
  // 清理 worktrees
  try {
    const list = execSync('git worktree list', { cwd: repoRoot, encoding: 'utf-8' });
    for (const line of list.split('\n')) {
      const match = line.match(/^(.+?)\s/);
      if (match && match[1] && match[1] !== repoRoot) {
        execSync(`git worktree remove --force "${match[1]}"`, { cwd: repoRoot });
      }
    }
  } catch { /* 忽略清理错误 */ }
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('spawnWorker', () => {
  test('创建双 Worktree 并返回正确路径', async () => {
    const result = await spawnWorker({
      workerId: 'test-w1',
      expectedTouchFiles: ['src/api/user.ts', 'src/models/user.ts'],
      repoRoot,
      apiKey: 'sk-test-key',
    });

    expect(result.workerId).toBe('test-w1');
    expect(result.readonlyRoot).toContain('test-w1-readonly');
    expect(result.writeRoot).toContain('test-w1-write');
    expect(result.spawnedAt).toBeDefined();

    // 验证只读区完整检出
    expect(fs.existsSync(path.join(result.readonlyRoot, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(result.readonlyRoot, 'src', 'utils', 'helper.ts'))).toBe(true);

    // 验证写区存在预测目录
    expect(fs.existsSync(path.join(result.writeRoot, 'src', 'api', 'user.ts'))).toBe(true);
    expect(fs.existsSync(path.join(result.writeRoot, 'src', 'models', 'user.ts'))).toBe(true);
  });

  test('写区不包含未预测目录', async () => {
    const result = await spawnWorker({
      workerId: 'test-w2',
      expectedTouchFiles: ['src/api/user.ts'],
      repoRoot,
      apiKey: 'sk-test-key',
    });

    // 未预测目录中的文件不应出现
    expect(fs.existsSync(path.join(result.writeRoot, 'src', 'utils', 'helper.ts'))).toBe(false);
    expect(fs.existsSync(path.join(result.writeRoot, 'src', 'models', 'user.ts'))).toBe(false);
  });
});

describe('cleanupWorktrees', () => {
  test('清理后 worktree 目录不存在', async () => {
    const result = await spawnWorker({
      workerId: 'test-w3',
      expectedTouchFiles: ['src/api/user.ts'],
      repoRoot,
      apiKey: 'sk-test-key',
    });

    await cleanupWorktrees('test-w3', repoRoot);

    expect(fs.existsSync(result.readonlyRoot)).toBe(false);
    expect(fs.existsSync(result.writeRoot)).toBe(false);
  });
});
