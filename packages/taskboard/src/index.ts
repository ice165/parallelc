export { TASK_TABLE_DDL, VALID_STATUSES, ALLOWED_TRANSITIONS } from './schema.js';
export { getDb, initializeSchema, closeDb } from './db.js';
export {
  createTask,
  casUpdateStatus,
  queryTasksByStatus,
  getLockedFiles,
  wakeSleepingTasks,
  updateTask,
  propagateDagFailure,
} from './repository.js';
export {
  detectGhosts,
  isPidAlive,
  getPidStatus,
  GhostDetector,
} from './ghost-detector.js';
export type { GhostTask, GhostReason, DetectGhostsOptions } from './ghost-detector.js';
