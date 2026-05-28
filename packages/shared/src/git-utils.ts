import { execFileSync } from 'child_process';

export function collectModifiedFiles(writeRoot: string): string[] {
  try {
    const tracked = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
      cwd: writeRoot, encoding: 'utf-8', timeout: 10_000,
    }).trim().split('\n').filter(f => f.length > 0);

    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: writeRoot, encoding: 'utf-8', timeout: 10_000,
    }).trim().split('\n').filter(f => f.length > 0);

    return [...new Set([...tracked, ...untracked])];
  } catch (err) {
    console.warn(`[git-utils] collectModifiedFiles failed in ${writeRoot}:`, err instanceof Error ? err.message : err);
    return [];
  }
}

export function getConflictFiles(repoRoot: string): string[] {
  try {
    const out = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], {
      cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe',
    });
    return out.trim().split('\n').filter(Boolean);
  } catch { return []; }
}
