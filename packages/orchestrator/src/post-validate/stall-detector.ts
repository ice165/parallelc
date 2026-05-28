import Database from 'better-sqlite3';
import { queryTasksByStatus } from '@parallelc/taskboard';

export interface StalledTask {
  taskId: string;
  reason: string;
  action: 'CANCEL' | 'WARN';
}

export function detectStalled(db: Database.Database): StalledTask[] {
  const readyTasks = queryTasksByStatus(db, 'READY');
  const allTasks = [
    ...queryTasksByStatus(db, 'RUNNING'),
    ...queryTasksByStatus(db, 'DONE'),
    ...queryTasksByStatus(db, 'FAILED'),
    ...queryTasksByStatus(db, 'CANCELLED'),
  ];
  const allMap = new Map(allTasks.map(t => [t.id, t]));

  const stalled: StalledTask[] = [];

  for (const task of readyTasks) {
    const deps = parseDependencies(task.dependencies);
    if (deps.length === 0) continue;

    for (const depId of deps) {
      const dep = allMap.get(depId);
      if (!dep) {
        stalled.push({ taskId: task.id, reason: `Dependency ${depId} not found`, action: 'CANCEL' });
        break;
      }
      if (dep.status === 'FAILED' || dep.status === 'CANCELLED') {
        stalled.push({
          taskId: task.id,
          reason: `Dependency ${depId} is ${dep.status}`,
          action: 'CANCEL',
        });
        break;
      }
    }
  }

  return stalled;
}

function parseDependencies(deps: string | string[] | null): string[] {
  if (!deps) return [];
  if (Array.isArray(deps)) return deps;
  try {
    return JSON.parse(deps) as string[];
  } catch {
    return [];
  }
}
