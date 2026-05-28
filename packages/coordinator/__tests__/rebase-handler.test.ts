import { rebaseHandler } from '../src/rebase-handler';
import { detectAstConflicts } from '../src/ast-conflict-detector';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

let repoRoot: string;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallelc-rebase-'));
  execSync('git init', { cwd: repoRoot });
  execSync('git config user.email "test@test.com" && git config user.name "Test"', { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, 'test.ts'), 'export const x = 1;');
  execSync('git add -A && git commit -m "initial"', { cwd: repoRoot });
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('rebaseHandler', () => {
  test('getRetryLimit returns 2', () => {
    expect(rebaseHandler.getRetryLimit()).toBe(2);
  });
});

describe('detectAstConflicts', () => {
  test('无冲突文件返回空', () => {
    const conflicts = detectAstConflicts(['test.ts'], repoRoot);
    expect(conflicts).toHaveLength(0);
  });

  test('检测到冲突标记', () => {
    fs.writeFileSync(path.join(repoRoot, 'conflict.ts'), '<<<<<<< HEAD\nexport const a = 1;\n=======\nexport const a = 2;\n>>>>>>>');
    const conflicts = detectAstConflicts(['conflict.ts'], repoRoot);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0]!.message).toContain('conflict marker');
  });
});
