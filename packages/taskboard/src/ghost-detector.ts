import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { queryTasksByStatus, casUpdateStatus, propagateDagFailure } from './repository.js';

export type GhostReason = 'PID_DEAD' | 'PID_NOT_FOUND' | 'PID_NO_PID_INFO';

export interface GhostTask {
  taskId: string;
  reason: GhostReason;
}

/**
 * Check if a PID corresponds to a live (non-zombie) process.
 * On Linux: reads /proc/<pid>/status, returns false if State contains 'Z' (zombie).
 * On Windows: uses tasklist.exe to verify PID exists.
 * On unsupported platforms: assumes alive.
 */
export function isPidAlive(pid: number): boolean {
  try {
    if (process.platform === 'linux') {
      const status = readFileSync(`/proc/${pid}/status`, 'utf-8');
      const stateLine = status.split('\n').find((line) => line.startsWith('State:'));
      if (stateLine) {
        // State line format: "State:\t<letter> (<description>)"
        // 'Z' indicates zombie — process technically exists but is defunct
        return !stateLine.includes('\tZ');
      }
      return true;
    } else if (process.platform === 'win32') {
      const output = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true,
      });
      return output.includes(String(pid));
    }
    // On unsupported platforms, assume alive to avoid false positives
    return true;
  } catch {
    // Process does not exist or cannot be checked
    return false;
  }
}

/**
 * Get detailed PID status.
 * - 'alive': process exists and is not a zombie
 * - 'zombie': process exists but is in zombie state (Linux only)
 * - 'dead': process does not exist
 */
export function getPidStatus(pid: number): 'alive' | 'zombie' | 'dead' {
  try {
    if (process.platform === 'linux') {
      const status = readFileSync(`/proc/${pid}/status`, 'utf-8');
      const stateLine = status.split('\n').find((line) => line.startsWith('State:'));
      if (stateLine) {
        if (stateLine.includes('\tZ')) return 'zombie';
        return 'alive';
      }
      return 'alive';
    } else if (process.platform === 'win32') {
      const output = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true,
      });
      return output.includes(String(pid)) ? 'alive' : 'dead';
    }
    // Unsupported platform — assume alive
    return 'alive';
  } catch {
    return 'dead';
  }
}

export interface DetectGhostsOptions {
  /** Map of taskId → PID for tasks whose worker PID is known.
   *  When a PID is provided, the detector checks the actual OS process status
   *  before declaring a ghost. */
  pids?: Map<string, number>;
}

/**
 * Detect ghost tasks — RUNNING tasks whose worker process has died or is untraceable.
 *
 * Logic:
 * 1. If a RUNNING task is in the WorkerPool (by workerId), it is NOT a ghost.
 * 2. If not in pool but PID is known and process is alive → log warning (pool tracking bug).
 * 3. If PID is dead or zombie → ghost with reason 'PID_DEAD'.
 * 4. If no PID info available → ghost with reason 'PID_NO_PID_INFO'.
 */
export function detectGhosts(
  db: Database.Database,
  poolWorkerIds: Set<string>,
  options?: DetectGhostsOptions,
): GhostTask[] {
  const running = queryTasksByStatus(db, 'RUNNING');
  const ghosts: GhostTask[] = [];
  const taskPids = options?.pids ?? new Map<string, number>();

  for (const task of running) {
    // In pool → actively managed, skip
    if (poolWorkerIds.has(`worker-${task.id}`)) continue;

    const pid = taskPids.get(task.id);
    if (pid !== undefined) {
      const status = getPidStatus(pid);
      if (status === 'alive') {
        // Process is alive but not tracked in pool — possible pool tracking bug
        console.warn(
          `[GhostDetector] Task ${task.id} PID ${pid} is alive but not in WorkerPool — possible pool tracking bug`,
        );
        continue;
      }
      // zombie or dead process
      ghosts.push({
        taskId: task.id,
        reason: 'PID_DEAD',
      });
    } else {
      // No PID info — cannot verify, mark as ghost
      ghosts.push({
        taskId: task.id,
        reason: 'PID_NO_PID_INFO',
      });
    }
  }

  return ghosts;
}

/**
 * GhostDetector class wraps detectGhosts with DAG-aware cancellation logic.
 *
 * When a ghost task is found, it checks whether the task's upstream dependencies
 * are FAILED or CANCELLED. If so, the task is CANCELLED (not reset to READY)
 * and propagateDagFailure cascades to downstream tasks.
 */
export class GhostDetector {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Detect ghost tasks with upstream dependency awareness.
   *
   * For each ghost candidate:
   * - If upstream dependencies are FAILED/CANCELLED → cancel the task + propagate.
   * - Otherwise → return in the ghost list for resetting to READY.
   */
  detect(
    poolWorkerIds: Set<string>,
    options?: DetectGhostsOptions,
  ): GhostTask[] {
    const running = queryTasksByStatus(this.db, 'RUNNING');
    const taskPids = options?.pids ?? new Map<string, number>();

    // Find all FAILED/CANCELLED tasks for upstream checking
    const failedUpstreamTasks = queryTasksByStatus(this.db, ['FAILED', 'CANCELLED']);
    const failedIds = new Set(failedUpstreamTasks.map((t) => t.id));

    const ghosts: GhostTask[] = [];

    for (const task of running) {
      if (poolWorkerIds.has(`worker-${task.id}`)) continue;

      // Check upstream: if any dependency is FAILED/CANCELLED,
      // cancel this task instead of ghosting it
      if (task.dependencies && task.dependencies.length > 0) {
        const hasFailedUpstream = task.dependencies.some((depId) => failedIds.has(depId));
        if (hasFailedUpstream) {
          casUpdateStatus(this.db, task.id, task.version, 'RUNNING', 'CANCELLED');
          propagateDagFailure(this.db, task.id);
          console.log(
            `[GhostDetector] Task ${task.id} CANCELLED — upstream dependency FAILED/CANCELLED`,
          );
          continue;
        }
      }

      const pid = taskPids.get(task.id);
      if (pid !== undefined) {
        const status = getPidStatus(pid);
        if (status === 'alive') {
          console.warn(
            `[GhostDetector] Task ${task.id} PID ${pid} is alive but not in WorkerPool — possible pool tracking bug`,
          );
          continue;
        }
        ghosts.push({ taskId: task.id, reason: 'PID_DEAD' });
      } else {
        ghosts.push({ taskId: task.id, reason: 'PID_NO_PID_INFO' });
      }
    }

    return ghosts;
  }
}
