import Database from 'better-sqlite3';
import { queryTasksByStatus } from './repository.js';

export interface GhostTask {
  taskId: string;
  reason: 'PID_NOT_FOUND';
}

export function detectGhosts(
  db: Database.Database,
  poolWorkerIds: Set<string>,
): GhostTask[] {
  const running = queryTasksByStatus(db, 'RUNNING');
  const ghosts: GhostTask[] = [];

  for (const task of running) {
    if (poolWorkerIds.has(`worker-${task.id}`)) continue;
    ghosts.push({
      taskId: task.id,
      reason: 'PID_NOT_FOUND',
    });
  }

  return ghosts;
}
