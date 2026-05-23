import Database from 'better-sqlite3';
import type { Task, TaskStatus, TaskLevel } from '@parallelc/shared';
import { ALLOWED_TRANSITIONS } from './schema.js';

interface CreateTaskInput {
  id: string;
  title: string;
  expected_touch_files?: string[] | null;
  dependencies?: string[] | null;
  snapshot_version?: string | null;
  level?: TaskLevel;
}

const ALLOWED_ORDER_BY = new Set([
  'created_at ASC',
  'created_at DESC',
  'updated_at ASC',
  'updated_at DESC',
  'ready_at ASC',
]);

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row['id'] as string,
    title: row['title'] as string,
    status: row['status'] as TaskStatus,
    version: (row['version'] as number) ?? 0,
    level: (row['level'] as TaskLevel) ?? 'L2',
    expected_touch_files: row['expected_touch_files']
      ? JSON.parse(row['expected_touch_files'] as string)
      : null,
    modified_files: row['modified_files']
      ? JSON.parse(row['modified_files'] as string)
      : null,
    rate_limit_count: (row['rate_limit_count'] as number) ?? 0,
    sleep_until: (row['sleep_until'] as string) ?? null,
    starvation_override: Boolean(row['starvation_override']),
    snapshot_version: (row['snapshot_version'] as string) ?? null,
    context_mismatch: Boolean(row['context_mismatch']),
    merge_blocked_at: (row['merge_blocked_at'] as string) ?? null,
    merge_report_path: (row['merge_report_path'] as string) ?? null,
    dependencies: row['dependencies']
      ? JSON.parse(row['dependencies'] as string)
      : null,
    ready_at: (row['ready_at'] as string) ?? null,
    created_at: row['created_at'] as string,
    updated_at: row['updated_at'] as string,
  };
}

export function createTask(db: Database.Database, input: CreateTaskInput): Task {
  const stmt = db.prepare(`
    INSERT INTO tasks (id, title, level, expected_touch_files, dependencies, snapshot_version)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    input.id,
    input.title,
    input.level ?? 'L2',
    input.expected_touch_files ? JSON.stringify(input.expected_touch_files) : null,
    input.dependencies ? JSON.stringify(input.dependencies) : null,
    input.snapshot_version ?? null,
  );
  return queryTaskById(db, input.id)!;
}

function queryTaskById(db: Database.Database, id: string): Task | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToTask(row);
}

export function casUpdateStatus(
  db: Database.Database,
  taskId: string,
  expectedVersion: number,
  fromStatus: string,
  toStatus: string,
  extra?: Partial<Pick<Task, 'starvation_override' | 'context_mismatch' | 'rate_limit_count' | 'sleep_until'>>,
): boolean {
  const allowed = ALLOWED_TRANSITIONS[fromStatus];
  if (!allowed || !allowed.includes(toStatus)) {
    return false;
  }

  const updateFields = ['status = ?', 'version = version + 1', "updated_at = datetime('now')"];
  const params: unknown[] = [toStatus];

  if (extra?.starvation_override !== undefined) {
    updateFields.push('starvation_override = ?');
    params.push(extra.starvation_override ? 1 : 0);
  }
  if (extra?.context_mismatch !== undefined) {
    updateFields.push('context_mismatch = ?');
    params.push(extra.context_mismatch ? 1 : 0);
  }
  if (extra?.rate_limit_count !== undefined) {
    updateFields.push('rate_limit_count = ?');
    params.push(extra.rate_limit_count);
  }
  if (extra?.sleep_until !== undefined) {
    updateFields.push('sleep_until = ?');
    params.push(extra.sleep_until);
  }

  if (toStatus === 'READY') {
    updateFields.push("ready_at = datetime('now')");
  }

  const stmt = db.prepare(`
    UPDATE tasks
    SET ${updateFields.join(', ')}
    WHERE id = ? AND status = ? AND version = ?
  `);
  params.push(taskId, fromStatus, expectedVersion);

  const result = stmt.run(...params);
  return result.changes > 0;
}

export function queryTasksByStatus(
  db: Database.Database,
  status: TaskStatus | TaskStatus[],
  orderBy: string = 'created_at ASC',
): Task[] {
  const safeOrderBy = ALLOWED_ORDER_BY.has(orderBy) ? orderBy : 'created_at ASC';
  const statuses = Array.isArray(status) ? status : [status];
  const placeholders = statuses.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT * FROM tasks WHERE status IN (${placeholders}) ORDER BY ${safeOrderBy}`,
  ).all(...statuses) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function getLockedFiles(db: Database.Database): Set<string> {
  const rows = db.prepare(`
    SELECT expected_touch_files FROM tasks
    WHERE status IN ('RUNNING', 'SLEEP_PENDING')
  `).all() as Record<string, unknown>[];

  const files = new Set<string>();
  for (const row of rows) {
    const parsed = row['expected_touch_files']
      ? (JSON.parse(row['expected_touch_files'] as string) as string[])
      : [];
    for (const f of parsed) files.add(f);
  }
  return files;
}

export function wakeSleepingTasks(db: Database.Database): number {
  const result = db.prepare(`
    UPDATE tasks
    SET status = 'READY', version = version + 1, updated_at = datetime('now'),
        ready_at = datetime('now'), sleep_until = NULL
    WHERE status = 'SLEEP_PENDING'
      AND sleep_until IS NOT NULL
      AND datetime(sleep_until) <= datetime('now')
  `).run();
  return result.changes;
}

export function updateTask(
  db: Database.Database,
  taskId: string,
  expectedVersion: number,
  fields: Partial<Task>,
): boolean {
  const setClauses: string[] = ["updated_at = datetime('now')"];
  const params: unknown[] = [];

  if (fields.modified_files !== undefined) {
    setClauses.push('modified_files = ?');
    params.push(JSON.stringify(fields.modified_files));
  }
  if (fields.context_mismatch !== undefined) {
    setClauses.push('context_mismatch = ?');
    params.push(fields.context_mismatch ? 1 : 0);
  }
  if (fields.rate_limit_count !== undefined) {
    setClauses.push('rate_limit_count = ?');
    params.push(fields.rate_limit_count);
  }
  if (fields.sleep_until !== undefined) {
    setClauses.push('sleep_until = ?');
    params.push(fields.sleep_until);
  }
  if (fields.starvation_override !== undefined) {
    setClauses.push('starvation_override = ?');
    params.push(fields.starvation_override ? 1 : 0);
  }

  if (setClauses.length === 1) return false;

  const stmt = db.prepare(`
    UPDATE tasks
    SET ${setClauses.join(', ')}, version = version + 1
    WHERE id = ? AND version = ?
  `);
  params.push(taskId, expectedVersion);

  const result = stmt.run(...params);
  return result.changes > 0;
}

export function propagateDagFailure(
  db: Database.Database,
  failedTaskId: string,
): number {
  const rows = db.prepare(
    `SELECT id FROM tasks WHERE dependencies LIKE ? AND status NOT IN ('DONE', 'FAILED', 'CANCELLED')`,
  ).all(`%"${failedTaskId}"%`) as Record<string, unknown>[];

  let count = 0;
  for (const row of rows) {
    db.prepare(
      `UPDATE tasks SET status = 'CANCELLED', version = version + 1, updated_at = datetime('now') WHERE id = ?`,
    ).run(row['id']);
    count++;
  }
  return count;
}
