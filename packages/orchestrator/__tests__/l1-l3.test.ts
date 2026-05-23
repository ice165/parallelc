import { executeL1Directly } from '../src/post-validate/l1-executor';
import { confirmL3Tasks } from '../src/post-validate/l3-confirm';
import type { TaskDraft } from '../src/decompose/response-parser';
import { getDb, initializeSchema, createTask, queryTasksByStatus } from '@parallelc/taskboard';

jest.mock('@parallelc/worker', () => ({
  spawnMcpWorker: jest.fn().mockReturnValue({
    on: jest.fn(),
    stdin: { write: jest.fn(), end: jest.fn() },
    stdout: { on: jest.fn() },
  }),
}));

describe('executeL1Directly', () => {
  test('file lock conflict returns success=false', async () => {
    const locked = new Set(['src/api/auth.ts']);
    const draft: TaskDraft = {
      title: 'Fix', level: 'L1',
      expected_touch_files: ['src/api/auth.ts'], dependencies: [], reasoning: '',
    };
    const result = await executeL1Directly(draft, '/tmp', 'sk-test', locked);
    expect(result.success).toBe(false);
  });
});

describe('confirmL3Tasks', () => {
  test('converts L3 PENDING task to READY', () => {
    const db = getDb(':memory:');
    initializeSchema(db);
    createTask(db, {
      id: 'task-dag1-004', title: 'DB migration',
      expected_touch_files: ['migration/001.sql'],
      dependencies: null, snapshot_version: 'dag1', level: 'L3',
    });

    const count = confirmL3Tasks(db, 'dag1', ['task-dag1-004']);
    expect(count).toBe(1);

    const ready = queryTasksByStatus(db, 'READY');
    expect(ready).toHaveLength(1);
  });
});
