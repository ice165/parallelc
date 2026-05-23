export type TaskStatus =
  | 'PENDING'
  | 'READY'
  | 'RUNNING'
  | 'SLEEP_PENDING'
  | 'CHECKPOINT_PENDING'
  | 'DONE'
  | 'FAILED'
  | 'CANCELLED'
  | 'MERGE_BLOCKED';

export type TaskLevel = 'L1' | 'L2' | 'L3';

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  version: number;
  level: TaskLevel;
  expected_touch_files: string[] | null;
  modified_files: string[] | null;
  rate_limit_count: number;
  sleep_until: string | null;
  starvation_override: boolean;
  snapshot_version: string | null;
  context_mismatch: boolean;
  merge_blocked_at: string | null;
  merge_report_path: string | null;
  dependencies: string[] | null;
  ready_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkerContext {
  workerId: string;
  readonlyRoot: string;
  writeRoot: string;
  taskId: string;
  apiKey: string;
}

export interface SnapshotVersion {
  dagId: string;
  timestamp: string;
  status: 'FROZEN' | 'ACTIVE';
}

export interface SpawnWorkerOptions {
  workerId: string;
  expectedTouchFiles: string[];
  repoRoot: string;
  apiKey: string;
  baseBranch?: string;
}

export interface SpawnWorkerResult {
  workerId: string;
  readonlyRoot: string;
  writeRoot: string;
  spawnedAt: string;
}

export interface StartupCheckOptions {
  taskId: string;
  snapshotVersion: string;
  projectContextPath: string;
}

export interface StartupCheckResult {
  versionMatch: boolean;
  contextMismatch: boolean;
  actualVersion: string | null;
  warnings: string[];
}

export type ExitAction =
  | { type: 'MARK_DONE'; modifiedFiles: string[] }
  | { type: 'CHECKPOINT'; message: string }
  | { type: 'FAILED'; reason: string }
  | { type: 'RATE_LIMIT_SLEEP'; attempt: number; wakeAt: Date }
  | { type: 'HOOK_BLOCKED'; filePath: string };

export interface OnWorkerExitOptions {
  taskId: string;
  exitCode: number;
  writeRoot: string;
  rateLimitCount: number;
  maxRateLimitRetries?: number;
}

export interface RateLimitBackoffResult {
  wakeAt: Date;
  exceeded: boolean;
}
