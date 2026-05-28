import { execSync } from 'child_process';
import { detectAstConflicts } from './ast-conflict-detector.js';

export interface RebaseResult {
  status: 'REBASE_SUCCESS' | 'REBASE_BLOCKED';
  modifiedFiles: string[];
  conflictFiles: string[];
  astConflicts: { file: string; line: number; message: string }[];
  retriesUsed: number;
}

const MAX_RETRIES = 2;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export const rebaseHandler = {
  getRetryLimit(): number {
    return MAX_RETRIES;
  },

  async attemptRebase(taskId: string, repoRoot: string, retryCount: number = 0): Promise<RebaseResult> {
    try {
      // 1. Fetch latest main
      try {
        execSync('git fetch origin main 2>/dev/null || true', {
          cwd: repoRoot, encoding: 'utf-8', timeout: 30_000,
        });
      } catch { /* network issue, try to rebase anyway */ }

      // 2. Attempt rebase
      try {
        execSync('git rebase origin/main 2>/dev/null || git rebase main 2>/dev/null || true', {
          cwd: repoRoot, encoding: 'utf-8', timeout: 30_000,
        });
      } catch {
        if (retryCount < MAX_RETRIES) {
          this.abortRebase(repoRoot);
          await sleep(5000 * (retryCount + 1));
          return this.attemptRebase(taskId, repoRoot, retryCount + 1);
        }
        this.abortRebase(repoRoot);
        return {
          status: 'REBASE_BLOCKED',
          modifiedFiles: [],
          conflictFiles: this.getConflictFiles(repoRoot),
          astConflicts: [],
          retriesUsed: retryCount,
        };
      }

      // 3. Check for leftover conflict markers
      const conflictFiles = this.getConflictFiles(repoRoot);
      if (conflictFiles.length > 0) {
        if (retryCount < MAX_RETRIES) {
          this.abortRebase(repoRoot);
          await sleep(5000 * (retryCount + 1));
          return this.attemptRebase(taskId, repoRoot, retryCount + 1);
        }
        this.abortRebase(repoRoot);
        const astConflicts = detectAstConflicts(conflictFiles, repoRoot);
        return {
          status: 'REBASE_BLOCKED',
          modifiedFiles: [],
          conflictFiles,
          astConflicts,
          retriesUsed: retryCount,
        };
      }

      return {
        status: 'REBASE_SUCCESS',
        modifiedFiles: this.collectModifiedFiles(repoRoot),
        conflictFiles: [],
        astConflicts: [],
        retriesUsed: retryCount,
      };
    } catch (err) {
      this.abortRebase(repoRoot);
      return {
        status: 'REBASE_BLOCKED',
        modifiedFiles: [],
        conflictFiles: [],
        astConflicts: [],
        retriesUsed: retryCount,
      };
    }
  },

  abortRebase(repoRoot: string): void {
    try {
      execSync('git rebase --abort 2>/dev/null || true', {
        cwd: repoRoot, encoding: 'utf-8', timeout: 10_000,
      });
    } catch { /* already clean */ }
  },

  getConflictFiles(repoRoot: string): string[] {
    try {
      const result = execSync('git diff --name-only --diff-filter=U', {
        cwd: repoRoot, encoding: 'utf-8', timeout: 5000,
      }).trim();
      return result ? result.split('\n') : [];
    } catch {
      return [];
    }
  },

  collectModifiedFiles(repoRoot: string): string[] {
    try {
      const tracked = execSync('git diff --name-only HEAD', {
        cwd: repoRoot, encoding: 'utf-8', timeout: 10_000,
      }).trim().split('\n').filter(f => f.length > 0);
      const untracked = execSync('git ls-files --others --exclude-standard', {
        cwd: repoRoot, encoding: 'utf-8', timeout: 10_000,
      }).trim().split('\n').filter(f => f.length > 0);
      return [...new Set([...tracked, ...untracked])];
    } catch {
      return [];
    }
  },
};
