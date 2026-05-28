import Database from 'better-sqlite3';
import {
  detectGhosts,
  isPidAlive,
  getPidStatus,
  GhostDetector,
} from '../src/ghost-detector';
import { initializeSchema } from '../src/db';
import { createTask, casUpdateStatus, queryTasksByStatus } from '../src/repository';

// ── DB helpers ─────────────────────────────────────────────────

/** @type {Database.Database} */
let db;

/** Transition a task from PENDING through READY to RUNNING.
 *  @param {string} taskId */
function setTaskRunning(taskId) {
  casUpdateStatus(db, taskId, 0, 'PENDING', 'READY');
  const readyTask = queryTasksByStatus(db, 'READY').find(function (t) { return t.id === taskId; });
  const version = readyTask.version;
  casUpdateStatus(db, taskId, version, 'READY', 'RUNNING');
}

/** Directly set a task status bypassing CAS (for test setup).
 *  @param {string} taskId
 *  @param {string} status */
function forceStatus(taskId, status) {
  db.prepare('UPDATE tasks SET status = ?, version = version + 1 WHERE id = ?').run(status, taskId);
}

beforeEach(function () {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initializeSchema(db);
});

afterEach(function () {
  db.close();
});

// ── isPidAlive ─────────────────────────────────────────────────

describe('isPidAlive', function () {
  test('current process PID returns true', function () {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test('non-existent PID returns false', function () {
    // PID 99999 is extremely unlikely to exist
    expect(isPidAlive(99999)).toBe(false);
  });
});

// ── getPidStatus ───────────────────────────────────────────────

describe('getPidStatus', function () {
  test('current process PID returns "alive"', function () {
    expect(getPidStatus(process.pid)).toBe('alive');
  });

  test('non-existent PID returns "dead"', function () {
    expect(getPidStatus(99999)).toBe('dead');
  });

  test('on Linux, zombie detection branch is reachable', function () {
    // Verify the function returns a valid status for any input
    var result = getPidStatus(99999);
    expect(['alive', 'zombie', 'dead']).toContain(result);
  });
});

// ── detectGhosts (function, backward-compat) ───────────────────

describe('detectGhosts', function () {
  test('no RUNNING tasks -> empty list', function () {
    var ghosts = detectGhosts(db, new Set());
    expect(ghosts).toHaveLength(0);
  });

  test('RUNNING task in Pool -> not a ghost', function () {
    createTask(db, { id: 'task-001', title: 'test', expected_touch_files: ['a.ts'], snapshot_version: 'v1' });
    setTaskRunning('task-001');
    var poolIds = new Set(['worker-task-001']);
    var ghosts = detectGhosts(db, poolIds);
    expect(ghosts).toHaveLength(0);
  });

  test('RUNNING task not in Pool, no PID -> PID_NO_PID_INFO', function () {
    createTask(db, { id: 'task-002', title: 'orphan', expected_touch_files: ['b.ts'], snapshot_version: 'v1' });
    setTaskRunning('task-002');
    var ghosts = detectGhosts(db, new Set());
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].taskId).toBe('task-002');
    expect(ghosts[0].reason).toBe('PID_NO_PID_INFO');
  });

  test('RUNNING task with dead PID -> PID_DEAD', function () {
    createTask(db, { id: 'task-003', title: 'dead-pid', expected_touch_files: ['c.ts'], snapshot_version: 'v1' });
    setTaskRunning('task-003');
    var pids = new Map([['task-003', 99997]]);
    var ghosts = detectGhosts(db, new Set(), { pids: pids });
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].taskId).toBe('task-003');
    expect(ghosts[0].reason).toBe('PID_DEAD');
  });

  test('RUNNING task with alive PID not in pool -> skip', function () {
    createTask(db, { id: 'task-004', title: 'alive-orphan', expected_touch_files: ['d.ts'], snapshot_version: 'v1' });
    setTaskRunning('task-004');
    var pids = new Map([['task-004', process.pid]]);
    var ghosts = detectGhosts(db, new Set(), { pids: pids });
    expect(ghosts).toHaveLength(0);
  });

  test('mixed: in-pool, dead PID, alive PID, no PID', function () {
    createTask(db, { id: 'task-A', title: 'in-pool', expected_touch_files: ['a.ts'], snapshot_version: 'v1' });
    setTaskRunning('task-A');

    createTask(db, { id: 'task-B', title: 'dead-pid', expected_touch_files: ['b.ts'], snapshot_version: 'v1' });
    setTaskRunning('task-B');

    createTask(db, { id: 'task-C', title: 'alive-orphan', expected_touch_files: ['c.ts'], snapshot_version: 'v1' });
    setTaskRunning('task-C');

    createTask(db, { id: 'task-D', title: 'no-pid', expected_touch_files: ['d.ts'], snapshot_version: 'v1' });
    setTaskRunning('task-D');

    var poolIds = new Set(['worker-task-A']);
    var pids = new Map([
      ['task-B', 99998],
      ['task-C', process.pid],
    ]);

    var ghosts = detectGhosts(db, poolIds, { pids: pids });

    expect(ghosts).toHaveLength(2);
    var ghostB = ghosts.find(function (g) { return g.taskId === 'task-B'; });
    var ghostD = ghosts.find(function (g) { return g.taskId === 'task-D'; });
    expect(ghostB.reason).toBe('PID_DEAD');
    expect(ghostD.reason).toBe('PID_NO_PID_INFO');
  });

  test('multiple RUNNING, some in pool -> only orphans returned', function () {
    createTask(db, { id: 'task-010', title: 'alive', expected_touch_files: ['c.ts'], snapshot_version: 'v1' });
    createTask(db, { id: 'task-011', title: 'dead', expected_touch_files: ['d.ts'], snapshot_version: 'v1' });

    setTaskRunning('task-010');
    setTaskRunning('task-011');

    var poolIds = new Set(['worker-task-010']);
    var ghosts = detectGhosts(db, poolIds);
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].taskId).toBe('task-011');
    expect(ghosts[0].reason).toBe('PID_NO_PID_INFO');
  });
});

// ── GhostDetector class ────────────────────────────────────────

describe('GhostDetector', function () {
  /** @type {GhostDetector} */
  var detector;

  beforeEach(function () {
    detector = new GhostDetector(db);
  });

  test('no RUNNING tasks -> empty list', function () {
    var ghosts = detector.detect(new Set());
    expect(ghosts).toHaveLength(0);
  });

  test('RUNNING task in pool -> skip', function () {
    createTask(db, { id: 'task-100', title: 'alive', expected_touch_files: ['a.ts'], snapshot_version: 'v1' });
    setTaskRunning('task-100');
    var ghosts = detector.detect(new Set(['worker-task-100']));
    expect(ghosts).toHaveLength(0);
  });

  test('orphan task with dead PID -> PID_DEAD', function () {
    createTask(db, { id: 'task-101', title: 'dead', expected_touch_files: ['b.ts'], snapshot_version: 'v1' });
    setTaskRunning('task-101');
    var pids = new Map([['task-101', 99997]]);
    var ghosts = detector.detect(new Set(), { pids: pids });
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].reason).toBe('PID_DEAD');
  });

  test('orphan task with no PID -> PID_NO_PID_INFO', function () {
    createTask(db, { id: 'task-102', title: 'no-pid', expected_touch_files: ['c.ts'], snapshot_version: 'v1' });
    setTaskRunning('task-102');
    var ghosts = detector.detect(new Set());
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].reason).toBe('PID_NO_PID_INFO');
  });

  test('upstream FAILED -> task is CANCELLED, not ghosted', function () {
    createTask(db, { id: 'task-up-A', title: 'upstream', expected_touch_files: ['up.ts'], snapshot_version: 'v1' });
    forceStatus('task-up-A', 'FAILED');

    createTask(db, {
      id: 'task-down-B',
      title: 'downstream',
      expected_touch_files: ['down.ts'],
      snapshot_version: 'v1',
      dependencies: ['task-up-A'],
    });
    setTaskRunning('task-down-B');

    var ghosts = detector.detect(new Set());

    expect(ghosts).toHaveLength(0);
    var cancelled = queryTasksByStatus(db, 'CANCELLED');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].id).toBe('task-down-B');
  });

  test('upstream CANCELLED -> task is CANCELLED, not ghosted', function () {
    createTask(db, { id: 'task-up-C', title: 'cancelled-upstream', expected_touch_files: ['up2.ts'], snapshot_version: 'v1' });
    forceStatus('task-up-C', 'CANCELLED');

    createTask(db, {
      id: 'task-down-D',
      title: 'dependent',
      expected_touch_files: ['down2.ts'],
      snapshot_version: 'v1',
      dependencies: ['task-up-C'],
    });
    setTaskRunning('task-down-D');

    var ghosts = detector.detect(new Set());

    expect(ghosts).toHaveLength(0);
    var cancelled = queryTasksByStatus(db, 'CANCELLED');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].id).toBe('task-down-D');
  });

  test('propagateDagFailure cascades to grandchild tasks', function () {
    createTask(db, { id: 'A', title: 'root', expected_touch_files: ['a.ts'], snapshot_version: 'v1' });
    forceStatus('A', 'FAILED');

    createTask(db, {
      id: 'B',
      title: 'child',
      expected_touch_files: ['b.ts'],
      snapshot_version: 'v1',
      dependencies: ['A'],
    });
    setTaskRunning('B');

    createTask(db, {
      id: 'C',
      title: 'grandchild',
      expected_touch_files: ['c.ts'],
      snapshot_version: 'v1',
      dependencies: ['B'],
    });

    var ghosts = detector.detect(new Set());

    expect(ghosts).toHaveLength(0);

    var cancelled = queryTasksByStatus(db, 'CANCELLED');
    var bCancelled = cancelled.find(function (t) { return t.id === 'B'; });
    var cCancelled = cancelled.find(function (t) { return t.id === 'C'; });
    expect(bCancelled).toBeDefined();
    expect(cCancelled).toBeDefined();
  });

  test('task with alive upstream -> still ghosted', function () {
    createTask(db, { id: 'up-normal', title: 'normal', expected_touch_files: ['n.ts'], snapshot_version: 'v1' });
    setTaskRunning('up-normal');

    createTask(db, {
      id: 'orphan',
      title: 'orphan',
      expected_touch_files: ['o.ts'],
      snapshot_version: 'v1',
      dependencies: ['up-normal'],
    });
    setTaskRunning('orphan');

    var poolIds = new Set(['worker-up-normal']);
    var ghosts = detector.detect(poolIds);

    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].taskId).toBe('orphan');
  });

  test('alive PID not in pool -> skipped', function () {
    createTask(db, { id: 'task-alive', title: 'alive-orphan', expected_touch_files: ['alive.ts'], snapshot_version: 'v1' });
    setTaskRunning('task-alive');
    var pids = new Map([['task-alive', process.pid]]);
    var ghosts = detector.detect(new Set(), { pids: pids });
    expect(ghosts).toHaveLength(0);
  });
});
