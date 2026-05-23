import { execSync } from 'child_process';
import path from 'path';
import type { SpawnWorkerOptions, SpawnWorkerResult } from '@parallelc/shared';

export async function spawnWorker(
  opts: SpawnWorkerOptions,
): Promise<SpawnWorkerResult> {
  const {
    workerId,
    expectedTouchFiles,
    repoRoot,
    baseBranch = 'main',
  } = opts;

  const readonlyRoot = path.join(repoRoot, 'worktrees', `${workerId}-readonly`);
  const writeRoot = path.join(repoRoot, 'worktrees', `${workerId}-write`);

  try {
    // 1. 只读完整 Worktree（detached HEAD，避免分支名冲突）
    execSync(`git worktree add --detach "${readonlyRoot}" ${baseBranch}`, {
      cwd: repoRoot,
      stdio: 'pipe',
      timeout: 30_000,
    });

    // 2. 稀疏写区 Worktree（不检出，稀疏模式仅填充预测目录）
    execSync(
      `git worktree add --no-checkout --detach "${writeRoot}" ${baseBranch}`,
      {
        cwd: repoRoot,
        stdio: 'pipe',
        timeout: 30_000,
      },
    );

    // 3. 从 expectedTouchFiles 提取唯一目录名
    const dirnames = [
      ...new Set(expectedTouchFiles.map((f) => path.dirname(f))),
    ];

    // 4. Sparse checkout init
    execSync('git sparse-checkout init --cone', {
      cwd: writeRoot,
      stdio: 'pipe',
      timeout: 10_000,
    });

    // 5. 设置稀疏检出目录
    execSync(`git sparse-checkout set ${dirnames.join(' ')}`, {
      cwd: writeRoot,
      stdio: 'pipe',
      timeout: 10_000,
    });

    // 6. 从 HEAD 树对象读入索引与工作区（遵循 sparse-checkout 规则）
    execSync('git read-tree -mu HEAD', {
      cwd: writeRoot,
      stdio: 'pipe',
      timeout: 30_000,
    });

    return {
      workerId,
      readonlyRoot,
      writeRoot,
      spawnedAt: new Date().toISOString(),
    };
  } catch (error) {
    await cleanupWorktrees(workerId, repoRoot);
    throw error;
  }
}

export async function cleanupWorktrees(
  workerId: string,
  repoRoot: string,
): Promise<void> {
  const readonlyRoot = path.join(repoRoot, 'worktrees', `${workerId}-readonly`);
  const writeRoot = path.join(repoRoot, 'worktrees', `${workerId}-write`);

  try {
    execSync(`git worktree remove --force "${readonlyRoot}"`, {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  } catch { /* 目录可能不存在 */ }

  try {
    execSync(`git worktree remove --force "${writeRoot}"`, {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  } catch { /* 目录可能不存在 */ }
}
