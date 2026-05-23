import Database from 'better-sqlite3';
import type { Task } from '@parallelc/shared';
import fs from 'fs';
import path from 'path';

export interface ContextSnapshot {
  dagId: string;
  timestamp: string;
  status: 'FROZEN';
  files: string[];
  taskIds: string[];
  architecture: string; // Phase 3: 接入 LLM 生成架构摘要
}

function scanRepoFiles(repoRoot: string): string[] {
  const files: string[] = [];
  const skip = new Set(['node_modules', '.git', 'dist', '.parallelc']);

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        files.push(path.relative(repoRoot, full).replace(/\\/g, '/'));
      }
    }
  }

  walk(repoRoot);
  return files;
}

export function generateContextSnapshot(
  db: Database.Database,
  dagId: string,
  tasks: Task[],
  repoRoot: string,
): ContextSnapshot | null {
  const ctxPath = path.join(repoRoot, '.parallelc', 'project_context.md');

  // 检查是否已有 FROZEN 快照
  if (fs.existsSync(ctxPath)) {
    const existing = fs.readFileSync(ctxPath, 'utf-8');
    if (/^status:\s*FROZEN/m.test(existing)) {
      console.warn('[context-generator] Existing FROZEN snapshot found, skipping');
      return null;
    }
  }

  // BEGIN IMMEDIATE 事务保护写入
  try {
    db.prepare('BEGIN IMMEDIATE').run();
  } catch {
    console.warn('[context-generator] BEGIN IMMEDIATE failed, another writer is active');
    return null;
  }

  try {
    const timestamp = new Date().toISOString();
    const files = scanRepoFiles(repoRoot);
    const taskIds = tasks.map((t) => t.id);

    const architecture = 'Phase 3: 接入 LLM 生成架构摘要';

    const content = [
      `snapshot_version: ${dagId}-${timestamp}`,
      `generated_at: ${timestamp}`,
      `status: FROZEN`,
      '',
      `## Files (${files.length} total)`,
      ...files.map((f) => `- ${f}`),
      '',
      `## Tasks (${taskIds.length} total)`,
      ...taskIds.map((id) => `- ${id}`),
      '',
      `## Architecture`,
      architecture,
      '',
      `⚠️ 此文件在 DAG 执行期间为 FROZEN（只读）。禁止覆盖写。`,
    ].join('\n');

    // 确保 .parallelc 目录存在
    fs.mkdirSync(path.dirname(ctxPath), { recursive: true });
    fs.writeFileSync(ctxPath, content);
    db.prepare('COMMIT').run();

    return {
      dagId,
      timestamp,
      status: 'FROZEN',
      files,
      taskIds,
      architecture,
    };
  } catch (err) {
    db.prepare('ROLLBACK').run();
    console.warn('[context-generator] Failed to write project_context.md:', err);
    return null;
  }
}
