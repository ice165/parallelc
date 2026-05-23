export const TASK_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    version INTEGER NOT NULL DEFAULT 0,
    level TEXT NOT NULL DEFAULT 'L2',
    expected_touch_files TEXT,
    modified_files TEXT,
    rate_limit_count INTEGER DEFAULT 0,
    sleep_until TEXT,
    starvation_override INTEGER DEFAULT 0,
    snapshot_version TEXT,
    context_mismatch INTEGER DEFAULT 0,
    merge_blocked_at TEXT,
    merge_report_path TEXT,
    dependencies TEXT,
    ready_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_sleep_until ON tasks(sleep_until)
    WHERE status = 'SLEEP_PENDING';
CREATE INDEX IF NOT EXISTS idx_tasks_merge_blocked ON tasks(merge_blocked_at)
    WHERE status = 'MERGE_BLOCKED';
`;

export const VALID_STATUSES = [
  'PENDING',
  'READY',
  'RUNNING',
  'SLEEP_PENDING',
  'CHECKPOINT_PENDING',
  'DONE',
  'FAILED',
  'CANCELLED',
  'MERGE_BLOCKED',
] as const;

export const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  PENDING:              ['READY', 'CANCELLED'],
  READY:                ['RUNNING', 'CANCELLED'],
  RUNNING:              ['DONE', 'SLEEP_PENDING', 'CHECKPOINT_PENDING', 'FAILED'],
  SLEEP_PENDING:        ['READY', 'FAILED'],
  CHECKPOINT_PENDING:   ['READY', 'FAILED'],
  DONE:                 [],
  FAILED:               [],
  CANCELLED:            [],
  MERGE_BLOCKED:        ['DONE'],
};
