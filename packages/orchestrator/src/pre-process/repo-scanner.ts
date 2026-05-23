import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { queryTasksByStatus } from '@parallelc/taskboard';

export interface RepoContext {
  fileTree: string[];
  moduleDirs: string[];
  packageJson: { name: string; scripts: Record<string,string>; dependencies: Record<string,string> } | null;
  existingTasks: string[];
}

export function scanRepoContext(repoRoot: string, db: Database.Database): RepoContext {
  const skip = new Set(['node_modules', '.git', 'dist', '.parallelc', 'worktrees']);
  const fileTree: string[] = [];
  const dirSet = new Set<string>();

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else {
        const rel = path.relative(repoRoot, full).replace(/\\/g, '/');
        fileTree.push(rel);
        dirSet.add(path.dirname(rel));
      }
    }
  }

  walk(repoRoot);

  let packageJson = null;
  try {
    packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
  } catch {}

  const existing = queryTasksByStatus(db, ['PENDING','READY','RUNNING','SLEEP_PENDING','CHECKPOINT_PENDING']);
  const existingTasks = existing.map(t => t.title);

  return {
    fileTree: fileTree.sort(),
    moduleDirs: [...dirSet].sort(),
    packageJson,
    existingTasks,
  };
}
