import Database from 'better-sqlite3';
import { queryTasksByStatus, casUpdateStatus } from '@parallelc/taskboard';

export interface L3Confirmation {
  taskId: string;
  taskTitle: string;
  reason: string;
  files: string[];
}

export function confirmL3Tasks(
  db: Database.Database,
  dagId: string,
  taskIds: string[],
): number {
  let count = 0;
  for (const taskId of taskIds) {
    const tasks = queryTasksByStatus(db, 'PENDING');
    const task = tasks.find(t => t.id === taskId && t.level === 'L3');
    if (task) {
      const ok = casUpdateStatus(db, task.id, task.version, 'PENDING', 'READY');
      if (ok) count++;
    }
  }
  return count;
}
