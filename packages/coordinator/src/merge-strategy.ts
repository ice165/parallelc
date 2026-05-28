import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import fs from 'fs';
import { getConflictFiles } from '@parallelc/shared';

export interface ConflictDetail {
  file: string;
  lines: string;
  taskA: { taskId: string; starvationOverride: boolean; diff: string };
  taskB: { taskId: string; starvationOverride: boolean; diff: string };
}

export interface MergeResult {
  success: boolean;
  strategy: 'AUTO' | 'STRUCTURED' | 'BLOCKED';
  mergedFiles: string[];
  conflicts: ConflictDetail[];
  reportPath: string | null;
}

export async function mergeTask(
  db: Database.Database,
  taskId: string,
  repoRoot: string,
  writeRoot?: string,
): Promise<MergeResult> {
  // Worker 的 Worktree 路径：{repoRoot}/worktrees/{workerId}-write
  const workerWorktree = writeRoot ?? `${repoRoot}/worktrees/worker-${taskId}-write`;

  if (!fs.existsSync(workerWorktree)) {
    return {
      success: false, strategy: 'BLOCKED', mergedFiles: [],
      conflicts: [], reportPath: null,
    };
  }

  try {
    // Phase 1: AUTO — 从 Worker 的 write worktree 合并到主仓库
    const workerHead = execFileSync('git', ['-C', workerWorktree, 'rev-parse', 'HEAD'], {
      stdio: 'pipe', timeout: 10_000,
    }).toString().trim();
    execFileSync('git', ['merge', '--no-ff', '--no-edit', workerHead], {
      cwd: repoRoot, stdio: 'pipe', timeout: 30_000,
    });
    const taskRow = db.prepare('SELECT modified_files FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
    const modFiles = taskRow?.['modified_files'] ? JSON.parse(taskRow['modified_files'] as string) : [];
    return {
      success: true,
      strategy: 'AUTO',
      mergedFiles: modFiles as string[],
      conflicts: [],
      reportPath: null,
    };
  } catch (_mergeErr) {
    const conflictFiles = getConflictFiles(repoRoot);

    if (conflictFiles.length === 0) {
      // git merge 失败但无冲突文件 → 其他错误
      try { execFileSync('git', ['merge', '--abort'], { cwd: repoRoot, stdio: 'pipe' }); } catch { /* 无 merge 可 abort */ }
      return {
        success: false, strategy: 'BLOCKED', mergedFiles: [], conflicts: [], reportPath: null,
      };
    }

    // Phase 2: STRUCTURED — 分析冲突是否可以安全拼接
    const conflicts: ConflictDetail[] = conflictFiles.map(file => {
      return {
        file,
        lines: detectConflictLines(repoRoot, file),
        taskA: { taskId, starvationOverride: false, diff: '' },
        taskB: { taskId: 'current-main', starvationOverride: false, diff: '' },
      };
    });

    // 非重叠区域 → 安全拼接
    const canResolve = conflicts.every(c => {
      const content = fs.readFileSync(`${repoRoot}/${c.file}`, 'utf-8');
      return !content.includes('<<<<<<<') || canAutoResolveConflict(content);
    });

    if (canResolve) {
      for (const c of conflicts) {
        resolveConflictFile(`${repoRoot}/${c.file}`);
      }
      try {
        const safeTaskId = taskId.replace(/[^a-zA-Z0-9\-_.]/g, '');
        execFileSync('git', ['add', '-A'], { cwd: repoRoot, stdio: 'pipe', timeout: 10_000 });
        execFileSync('git', ['commit', '-m', `STRUCTURED merge: ${safeTaskId}`], { cwd: repoRoot, stdio: 'pipe', timeout: 10_000 });
        return {
          success: true, strategy: 'STRUCTURED',
          mergedFiles: conflictFiles, conflicts, reportPath: null,
        };
      } catch {
        execFileSync('git', ['merge', '--abort'], { cwd: repoRoot, stdio: 'pipe' });
      }
    }

    // Phase 3: BLOCKED
    execFileSync('git', ['merge', '--abort'], { cwd: repoRoot, stdio: 'pipe' });
    return {
      success: false, strategy: 'BLOCKED', mergedFiles: [], conflicts, reportPath: null,
    };
  }
}

function detectConflictLines(repoRoot: string, file: string): string {
  try {
    const out = execFileSync('git', ['diff', '--unified=0', file], {
      cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe',
    });
    const matches = out.match(/@@\s+[-+]\d+(?:,\d+)?\s+[-+]\d+(?:,\d+)?\s+@@/g);
    if (matches) return matches.join(', ');
  } catch {}
  return 'unknown';
}

function canAutoResolveConflict(content: string): boolean {
  const ours = (content.match(/<<<<<<< HEAD\n([\s\S]*?)=======/g) ?? []).map(m =>
    m.replace(/<<<<<<< HEAD\n/, '').replace(/=======/, '').trim()
  );
  const theirs = (content.match(/=======\n([\s\S]*?)>>>>>>>/g) ?? []).map(m =>
    m.replace(/=======\n/, '').replace(/>>>>>>>.*/, '').trim()
  );
  if (ours.length !== theirs.length || ours.length === 0) return false;
  return ours.every((o, i) => !hasOverlap(o!, theirs[i]!));
}

function hasOverlap(a: string, b: string): boolean {
  const aLines = new Set(a.split('\n').map(l => l.trim()).filter(Boolean));
  return b.split('\n').map(l => l.trim()).filter(Boolean).some(l => aLines.has(l));
}

function resolveConflictFile(filePath: string): void {
  let content = fs.readFileSync(filePath, 'utf-8');
  content = content
    .replace(/<<<<<<< .*\n/g, '')
    .replace(/=======\n/g, '')
    .replace(/>>>>>>> .*\n/g, '');
  fs.writeFileSync(filePath, content);
}
