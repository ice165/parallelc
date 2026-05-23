import { mergeTask } from '../src/merge-strategy';
import { getDb, initializeSchema, createTask, casUpdateStatus, queryTasksByStatus, closeDb } from '@parallelc/taskboard';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

let repoRoot: string;
let dbPath: string;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallelc-merge-'));
  execSync('git init -b main', { cwd: repoRoot });
  execSync('git config user.email test@test.com', { cwd: repoRoot });
  execSync('git config user.name Test', { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, 'main.ts'), 'export const VERSION = 1;');
  execSync('git add -A && git commit -m init', { cwd: repoRoot });

  // 模拟 Worker Worktree（写区）
  const worktreePath = path.join(repoRoot, 'worktrees', 'worker-t1-write');
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execSync(`git worktree add --detach "${worktreePath}"`, { cwd: repoRoot });
  fs.writeFileSync(path.join(worktreePath, 'new.ts'), 'export const NEW = true;');
  execSync('git add -A && git commit -m worker', { cwd: worktreePath });

  dbPath = path.join(repoRoot, 'test.db');
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('mergeTask', () => {
  test('AUTO merge — 无冲突合并', async () => {
    const db = getDb(dbPath);
    initializeSchema(db);
    createTask(db, { id: 't1', title: 'Test', expected_touch_files: ['new.ts'], level: 'L2' });
    casUpdateStatus(db, 't1', 0, 'PENDING', 'READY');
    const v1 = queryTasksByStatus(db, 'READY')[0]!.version;
    casUpdateStatus(db, 't1', v1, 'READY', 'RUNNING');
    const v2 = queryTasksByStatus(db, 'RUNNING')[0]!.version;
    casUpdateStatus(db, 't1', v2, 'RUNNING', 'DONE');
    db.prepare("UPDATE tasks SET modified_files = ? WHERE id = ?").run('["new.ts"]', 't1');

    const result = await mergeTask(db, 't1', repoRoot);
    expect(result.success).toBe(true);
    expect(result.strategy).toBe('AUTO');
    expect(fs.existsSync(path.join(repoRoot, 'new.ts'))).toBe(true);
    closeDb(dbPath);
    db.close();
  });
});
