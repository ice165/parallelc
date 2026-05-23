import { buildDAG } from '../src/dag-builder';
import type { DecompositionInput } from '../src/decompose/prompt-builder';
import { getDb, initializeSchema, queryTasksByStatus } from '@parallelc/taskboard';
import fs from 'fs';
import path from 'path';
import os from 'os';

jest.mock('../src/decompose/mcp-decomposer', () => ({
  decomposeViaClaude: jest.fn().mockResolvedValue({
    raw: '{}',
    parsed: [
      { title: 'Task A', level: 'L2', expected_touch_files: ['src/a.ts'], dependencies: [], reasoning: 'test' },
      { title: 'Task B', level: 'L2', expected_touch_files: ['src/b.ts'], dependencies: ['Task A'], reasoning: 'test' },
    ],
    tokensUsed: 500,
    cached: false,
  }),
}));

jest.mock('@parallelc/worker', () => ({
  spawnMcpWorker: jest.fn().mockReturnValue({
    on: jest.fn(),
    stdin: { write: jest.fn(), end: jest.fn() },
    stdout: { on: jest.fn() },
  }),
}));

let repoRoot: string;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallelc-orch-dag-'));
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'a.ts'), 'export const a = 1;');
  fs.writeFileSync(path.join(repoRoot, 'src', 'b.ts'), 'export const b = 2;');
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('buildDAG', () => {
  test('end-to-end: user request -> TaskBoard', async () => {
    const dbPath = path.join(repoRoot, 'test.db');
    const db = getDb(dbPath);
    initializeSchema(db);

    const input: DecompositionInput = {
      userRequest: 'Add feature X',
      repoContext: {
        fileTree: ['src/a.ts', 'src/b.ts'],
        moduleDirs: ['src'],
        packageJson: null,
        existingTasks: [],
      },
      moduleMap: [],
    };

    const result = await buildDAG(input, { repoRoot, dbPath, apiKey: 'sk-test' });

    expect(result.tasksCreated).toBe(2);
    expect(result.dagId).toBeDefined();

    const tasks = queryTasksByStatus(db, 'PENDING');
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.title).toBe('Task A');

    db.close();
  });

  test('retry on failure', async () => {
    const { decomposeViaClaude } = require('../src/decompose/mcp-decomposer');
    const onRetry = jest.fn();

    decomposeViaClaude
      .mockRejectedValueOnce(new Error('API error'))
      .mockResolvedValueOnce({
        raw: '{}',
        parsed: [{ title: 'Solo', level: 'L2', expected_touch_files: ['src/a.ts'], dependencies: [], reasoning: '' }],
        tokensUsed: 200,
        cached: false,
      });

    const dbPath = path.join(repoRoot, 'test2.db');
    const input: DecompositionInput = {
      userRequest: 'Test',
      repoContext: { fileTree: ['src/a.ts'], moduleDirs: ['src'], packageJson: null, existingTasks: [] },
      moduleMap: [],
    };

    const result = await buildDAG(input, {
      repoRoot, dbPath, apiKey: 'sk-test', maxRetries: 2, onRetry,
    });

    expect(result.retries).toBe(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(String));
    expect(result.tasksCreated).toBe(1);
  });
});
