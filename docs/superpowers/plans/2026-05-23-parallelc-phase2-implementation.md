# ParallelC Phase 2 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Scheduler dispatch_loop + Worker Pool + MCP 通信层，使任务从创建到自动派发到 Worker 进程执行形成闭环。

**Architecture:** 在 Phase 1 基础上新增 @parallelc/scheduler 包，更新 @parallelc/worker 补充 MCP 客户端。Scheduler 单进程三阶段 tick 循环（dispatch/reap/wake），WorkerPool 管理 ChildProcess 生命周期，CLI 提供 start/status 入口。

**Tech Stack:** TypeScript (strict), pnpm workspaces, better-sqlite3, child_process, Jest + ts-jest

**基于规范:** `docs/superpowers/specs/2026-05-23-parallelc-phase2-design.md`

---

### Task 1: @parallelc/worker — MCP 客户端（spawnMcpWorker + Watchdog + SystemPrompt）

**Files:**
- Create: `packages/worker/src/mcp-client.ts`
- Create: `packages/worker/__tests__/mcp-client.test.ts`
- Modify: `packages/worker/src/index.ts`（追加 export）

- [ ] **Step 1: 编写测试**

Create `packages/worker/__tests__/mcp-client.test.ts`:

```typescript
import { spawnMcpWorker, buildWorkerSystemPrompt } from '../src/mcp-client';
import { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

// Mock child_process.spawn
const mockProcess = new EventEmitter() as unknown as ChildProcess;
mockProcess.stdin = { write: jest.fn() } as unknown as NodeJS.WriteStream;
mockProcess.stdout = new EventEmitter() as unknown as NodeJS.ReadStream;
mockProcess.stderr = new EventEmitter() as unknown as NodeJS.ReadStream;
mockProcess.kill = jest.fn();
(mockProcess as Record<string, unknown>)['pid'] = 12345;

jest.mock('child_process', () => ({
  spawn: jest.fn(() => mockProcess),
}));

describe('buildWorkerSystemPrompt', () => {
  test('包含 snapshot_version 校验指令', () => {
    const prompt = buildWorkerSystemPrompt({
      taskId: 'task-001',
      snapshotVersion: 'dag1-20260701T100000Z',
      dependencies: ['task-000'],
    });
    expect(prompt).toContain('project_context.md');
    expect(prompt).toContain('snapshot_version');
    expect(prompt).toContain('dag1-20260701T100000Z');
    expect(prompt).toContain('task-001');
    expect(prompt).toContain('WORKER_READONLY_ROOT');
    expect(prompt).toContain('WORKER_WRITE_ROOT');
  });

  test('无依赖时仍正常生成', () => {
    const prompt = buildWorkerSystemPrompt({
      taskId: 'task-002',
      snapshotVersion: 'dag1-20260702',
      dependencies: null,
    });
    expect(prompt).toContain('task-002');
    expect(prompt).not.toContain('前置任务');
  });
});

describe('spawnMcpWorker', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('返回 ChildProcess 实例', () => {
    const process = spawnMcpWorker(
      { apiKey: 'sk-test', cwd: '/tmp/w1-write', readonlyRoot: '/tmp/w1-readonly' },
      { taskId: 't1', snapshotVersion: 'dag1', dependencies: null },
    );
    expect(process).toBeDefined();
    expect(process).toBe(mockProcess);
  });

  test('spawn 参数正确传递', () => {
    const { spawn } = require('child_process');
    spawnMcpWorker(
      { apiKey: 'sk-test', cwd: '/tmp/w1-write', readonlyRoot: '/tmp/w1-readonly' },
      { taskId: 't1', snapshotVersion: 'dag1', dependencies: null },
    );
    expect(spawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--mcp']),
      expect.objectContaining({
        cwd: '/tmp/w1-write',
        env: expect.objectContaining({
          ANTHROPIC_API_KEY: 'sk-test',
        }),
      }),
    );
  });

  test('Watchdog 超时后 SIGTERM → SIGKILL', () => {
    jest.useRealTimers();
    jest.useFakeTimers();

    const process = spawnMcpWorker(
      {
        apiKey: 'sk-test',
        cwd: '/tmp/w1-write',
        readonlyRoot: '/tmp/w1-readonly',
        timeoutMs: 1000,
      },
      { taskId: 't1', snapshotVersion: 'dag1', dependencies: null },
    );

    // 未触发超时前不 kill
    jest.advanceTimersByTime(500);
    expect(mockProcess.kill).not.toHaveBeenCalled();

    // 超时后 SIGTERM
    jest.advanceTimersByTime(600);
    expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');

    // 5s 后 SIGKILL
    jest.advanceTimersByTime(5000);
    expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL');

    jest.useRealTimers();
  });

  test('正常退出时清除 Watchdog', () => {
    const process = spawnMcpWorker(
      {
        apiKey: 'sk-test',
        cwd: '/tmp/w1-write',
        readonlyRoot: '/tmp/w1-readonly',
        timeoutMs: 1000,
      },
      { taskId: 't1', snapshotVersion: 'dag1', dependencies: null },
    );

    // 子进程正常退出
    (mockProcess as EventEmitter).emit('exit', 0, null);
    jest.advanceTimersByTime(1100);
    // Watchdog 已被清除，不应触发 kill
    expect(mockProcess.kill).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 验证测试失败**

Run: `cd packages/worker && npx jest --testPathPattern="mcp-client"`
Expected: FAIL

- [ ] **Step 3: 实现 mcp-client.ts**

Create `packages/worker/src/mcp-client.ts`:

```typescript
import { spawn, ChildProcess } from 'child_process';
import type { McpTaskContext as _McpTaskContext } from './types.js';

export interface McpClientOptions {
  apiKey: string;
  model?: 'haiku' | 'sonnet' | 'opus';
  cwd: string;
  readonlyRoot: string;
  maxRounds?: number;
  timeoutMs?: number;
}

export interface McpTaskContext {
  taskId: string;
  snapshotVersion: string;
  dependencies: string[] | null;
}

const DEFAULT_MAX_ROUNDS = 30;
const DEFAULT_TIMEOUT_MS = 600_000; // 10 分钟
const SIGKILL_DELAY_MS = 5_000;

export function spawnMcpWorker(
  opts: McpClientOptions,
  context: McpTaskContext,
): ChildProcess {
  const {
    apiKey,
    model = 'sonnet',
    cwd,
    readonlyRoot,
    maxRounds = DEFAULT_MAX_ROUNDS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts;

  const env = {
    ...process.env,
    ANTHROPIC_API_KEY: apiKey,
    CLAUDE_MODEL: model,
    WORKER_READONLY_ROOT: readonlyRoot,
    WORKER_WRITE_ROOT: cwd,
  };

  const child = spawn(
    'claude',
    [
      '--mcp',
      '--model', model,
      '--max-turns', String(maxRounds),
      '--system-prompt', buildWorkerSystemPrompt(context),
    ],
    {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  // Watchdog: 超时 → SIGTERM → SIGKILL
  const watchdog = setTimeout(() => {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }, SIGKILL_DELAY_MS);
  }, timeoutMs);

  child.on('exit', () => {
    clearTimeout(watchdog);
  });

  return child;
}

export function buildWorkerSystemPrompt(context: McpTaskContext): string {
  const depText = context.dependencies?.length
    ? `\n前置任务已完成（供上下文参考）：${context.dependencies.join(', ')}`
    : '';

  return `你是 ParallelC Worker Agent，在隔离的 Worktree 环境中执行开发任务。

## 环境信息
- 只读完整代码区：$WORKER_READONLY_ROOT（可读取项目全部源码，禁止写入）
- 稀疏写区：$WORKER_WRITE_ROOT（仅包含你负责的目录，可在此写入）
- 任务 ID：${context.taskId}
- 快照版本：${context.snapshotVersion}
${depText}

## 启动检查清单
1. 读取 \$WORKER_READONLY_ROOT/.parallelc/project_context.md
2. 对比 snapshot_version 字段是否等于 "${context.snapshotVersion}"
3. 若不一致，继续执行但标记 context_mismatch=true

## 写保护警告
禁止写入 WORKER_READONLY_ROOT 下的任何路径。
越权写入将被 validate_write hook 拦截（退出码 12）。
所有写入操作限定在 WORKER_WRITE_ROOT 内。

## 退出协议
- 任务完成：process.exit(0)
- 达到 ${DEFAULT_MAX_ROUNDS} 轮上限：process.exit(10)
- 上述退出码将由 Scheduler 统一路由处理`;
}
```

- [ ] **Step 4: 验证测试通过**

Run: `cd packages/worker && npx jest --testPathPattern="mcp-client"`
Expected: PASS

- [ ] **Step 5: 更新 index.ts**

Append to `packages/worker/src/index.ts`:
```typescript
export { spawnMcpWorker, buildWorkerSystemPrompt } from './mcp-client.js';
export type { McpClientOptions, McpTaskContext } from './mcp-client.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/worker/
git commit -m "feat(worker): add MCP client with Watchdog and system prompt builder"
```

---

### Task 2: @parallelc/worker — run-worker（Worker 入口）

**Files:**
- Create: `packages/worker/src/run-worker.ts`
- Create: `packages/worker/__tests__/run-worker.test.ts`
- Modify: `packages/worker/src/index.ts`（追加 export）

- [ ] **Step 1: 编写测试**

Create `packages/worker/__tests__/run-worker.test.ts`:

```typescript
// runWorker 主要依赖环境变量和 spawnMcpWorker，通过 mock 验证调用链
jest.mock('../src/mcp-client', () => ({
  spawnMcpWorker: jest.fn(),
  buildWorkerSystemPrompt: jest.fn(() => 'mock-prompt'),
}));

jest.mock('../src/startup', () => ({
  verifySnapshotVersion: jest.fn(() => ({
    versionMatch: true,
    contextMismatch: false,
    actualVersion: 'dag1-20260701T100000Z',
    warnings: [],
  })),
}));

describe('runWorker', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      WORKER_ID: 'worker-task-001',
      WORKER_WRITE_ROOT: '/tmp/w1-write',
      WORKER_READONLY_ROOT: '/tmp/w1-readonly',
      ANTHROPIC_API_KEY: 'sk-test',
      TASK_ID: 'task-001',
      SNAPSHOT_VERSION: 'dag1-20260701T100000Z',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  test('runWorker 调用 spawnMcpWorker 并传递正确参数', async () => {
    const { runWorker } = require('../src/run-worker');
    const { spawnMcpWorker } = require('../src/mcp-client');

    runWorker();

    expect(spawnMcpWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-test',
        cwd: '/tmp/w1-write',
        readonlyRoot: '/tmp/w1-readonly',
      }),
      expect.objectContaining({
        taskId: 'task-001',
        snapshotVersion: 'dag1-20260701T100000Z',
      }),
    );
  });

  test('runWorker 校验 snapshot_version', () => {
    const { runWorker } = require('../src/run-worker');
    const { verifySnapshotVersion } = require('../src/startup');

    runWorker();

    expect(verifySnapshotVersion).toHaveBeenCalledWith({
      taskId: 'task-001',
      snapshotVersion: 'dag1-20260701T100000Z',
      projectContextPath: '/tmp/w1-readonly/.parallelc/project_context.md',
    });
  });

  test('缺少必要环境变量时退出码 12', () => {
    delete process.env.WORKER_WRITE_ROOT;
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const { runWorker } = require('../src/run-worker');
    runWorker();

    expect(mockExit).toHaveBeenCalledWith(12);
    mockExit.mockRestore();
  });
});
```

- [ ] **Step 2: 验证测试失败**

Run: `cd packages/worker && npx jest --testPathPattern="run-worker"`
Expected: FAIL

- [ ] **Step 3: 实现 run-worker.ts**

Create `packages/worker/src/run-worker.ts`:

```typescript
import { verifySnapshotVersion } from './startup.js';
import { spawnMcpWorker } from './mcp-client.js';
import { EXIT_HOOK_BLOCKED } from '@parallelc/shared';

export function runWorker(): void {
  const workerId = process.env['WORKER_ID'];
  const writeRoot = process.env['WORKER_WRITE_ROOT'];
  const readonlyRoot = process.env['WORKER_READONLY_ROOT'];
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  const taskId = process.env['TASK_ID'];
  const snapshotVersion = process.env['SNAPSHOT_VERSION'];

  if (!workerId || !writeRoot || !readonlyRoot || !taskId || !snapshotVersion) {
    console.error('[runWorker] Missing required environment variables');
    console.error(`  WORKER_ID=${workerId}`);
    console.error(`  WORKER_WRITE_ROOT=${writeRoot}`);
    console.error(`  WORKER_READONLY_ROOT=${readonlyRoot}`);
    console.error(`  TASK_ID=${taskId}`);
    console.error(`  SNAPSHOT_VERSION=${snapshotVersion}`);
    process.exit(EXIT_HOOK_BLOCKED);
  }

  // 1. 快照版本校验
  const check = verifySnapshotVersion({
    taskId,
    snapshotVersion,
    projectContextPath: `${readonlyRoot}/.parallelc/project_context.md`,
  });

  if (check.warnings.length > 0) {
    console.warn(`[runWorker] ${check.warnings.join('\n')}`);
  }

  // 2. 启动 MCP Worker（阻塞直到子进程退出）
  const child = spawnMcpWorker(
    {
      apiKey: apiKey ?? '',
      cwd: writeRoot,
      readonlyRoot,
    },
    {
      taskId,
      snapshotVersion,
      dependencies: null, // Phase 2 从任务记录注入
    },
  );

  // 3. 等待子进程退出，传递退出码
  child.on('exit', (code) => {
    const exitCode = code ?? 1;
    console.log(`[runWorker] Worker ${workerId} exited with code ${exitCode}`);
    process.exit(exitCode);
  });
}
```

- [ ] **Step 4: 验证测试通过**

Run: `cd packages/worker && npx jest --testPathPattern="run-worker"`
Expected: PASS

- [ ] **Step 5: 更新 index.ts**

Append to `packages/worker/src/index.ts`:
```typescript
export { runWorker } from './run-worker.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/worker/
git commit -m "feat(worker): add runWorker entry point with env validation"
```

---

### Task 3: @parallelc/scheduler — 包骨架

**Files:**
- Create: `packages/scheduler/package.json`
- Create: `packages/scheduler/tsconfig.json`
- Create: `packages/scheduler/jest.config.ts`
- Create: `packages/scheduler/src/index.ts`

- [ ] **Step 1: 创建配置文件**

`packages/scheduler/package.json`:
```json
{
  "name": "@parallelc/scheduler",
  "version": "0.1.0",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "bin": {
    "parallelc-scheduler": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsup src/index.ts src/cli.ts --format cjs,esm --dts --clean",
    "typecheck": "tsc --noEmit",
    "test": "jest",
    "test:ci": "jest --ci --coverage"
  },
  "dependencies": {
    "@parallelc/shared": "workspace:*",
    "@parallelc/taskboard": "workspace:*",
    "@parallelc/worker": "workspace:*",
    "better-sqlite3": "^11.7.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "@types/jest": "^29.5.14",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.5"
  }
}
```

`packages/scheduler/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`packages/scheduler/jest.config.ts`:
```typescript
import baseConfig from '../../jest.config.base';
export default baseConfig;
```

`packages/scheduler/src/index.ts`:
```typescript
export { WorkerPool } from './worker-pool.js';
export type { WorkerEntry } from './worker-pool.js';
export { startScheduler } from './dispatch-loop.js';
export type { SchedulerConfig, TickStats } from './dispatch-loop.js';
export { generateContextSnapshot } from './context-generator.js';
export type { ContextSnapshot } from './context-generator.js';
```

- [ ] **Step 2: 验证包结构**

Run: `cd packages/scheduler && pnpm typecheck`（如 Node.js 不可用则跳过）
Expected: 因模块未创建而失败（预期行为，后续 Task 逐步消除）

- [ ] **Step 3: Commit**

```bash
git add packages/scheduler/
git commit -m "feat(scheduler): add package skeleton with bin and deps"
```

---

### Task 4: @parallelc/scheduler — WorkerPool（进程池 + 环境变量注入 + API Key 轮询）

**Files:**
- Create: `packages/scheduler/src/worker-pool.ts`
- Create: `packages/scheduler/__tests__/worker-pool.test.ts`

- [ ] **Step 1: 编写测试**

Create `packages/scheduler/__tests__/worker-pool.test.ts`:

```typescript
import { WorkerPool } from '../src/worker-pool';
import type { Task } from '@parallelc/shared';

// Mock spawnWorker 和 spawnMcpWorker
jest.mock('@parallelc/worker', () => ({
  spawnWorker: jest.fn().mockResolvedValue({
    workerId: 'worker-test-001',
    readonlyRoot: '/tmp/worker-test-001-readonly',
    writeRoot: '/tmp/worker-test-001-write',
    spawnedAt: new Date().toISOString(),
  }),
  cleanupWorktrees: jest.fn().mockResolvedValue(undefined),
  spawnMcpWorker: jest.fn().mockReturnValue({
    pid: 99999,
    on: jest.fn(),
    kill: jest.fn(),
  } as unknown as import('child_process').ChildProcess),
}));

const makeTask = (id: string, files: string[]): Task => ({
  id,
  title: `Task ${id}`,
  status: 'READY',
  version: 0,
  level: 'L2',
  expected_touch_files: files,
  modified_files: null,
  rate_limit_count: 0,
  sleep_until: null,
  starvation_override: false,
  snapshot_version: 'dag1-20260701',
  context_mismatch: false,
  merge_blocked_at: null,
  merge_report_path: null,
  dependencies: null,
  ready_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

describe('WorkerPool', () => {
  test('hasCapacity 在未达上限时返回 true', () => {
    const pool = new WorkerPool(['sk-a', 'sk-b'], 4);
    expect(pool.hasCapacity()).toBe(true);
  });

  test('worker 达到上限后 hasCapacity 返回 false', async () => {
    const pool = new WorkerPool(['sk-a', 'sk-b'], 1);
    await pool.spawn(makeTask('t1', ['src/a.ts']), '/repo');
    expect(pool.hasCapacity()).toBe(false);
  });

  test('activeCount 正确计数', async () => {
    const pool = new WorkerPool(['sk-a'], 3);
    expect(pool.activeCount).toBe(0);
    await pool.spawn(makeTask('t1', ['src/a.ts']), '/repo');
    expect(pool.activeCount).toBe(1);
  });

  test('reap 返回已退出进程并移除', async () => {
    const pool = new WorkerPool(['sk-a'], 3);
    await pool.spawn(makeTask('t1', ['src/a.ts']), '/repo');

    // 模拟进程退出
    const entries = Array.from((pool as unknown as Record<string, Map<string, unknown>>)['workers'].values());
    (entries[0] as Record<string, unknown>)['process'] = {
      exitCode: 0,
      pid: 99999,
    };

    const reaped = pool.reap();
    expect(reaped).toHaveLength(1);
    expect(pool.activeCount).toBe(0);
  });

  test('nextKey 循环轮转', () => {
    const pool = new WorkerPool(['sk-a', 'sk-b', 'sk-c'], 4);
    const keys = new Set<string>();
    for (let i = 0; i < 6; i++) {
      keys.add((pool as unknown as Record<string, () => string>)['nextKey']());
    }
    // 3 个不同 key，且命中了全部
    expect(keys).toContain('sk-a');
    expect(keys).toContain('sk-b');
    expect(keys).toContain('sk-c');
  });

  test('spawn 注入正确的环境变量', async () => {
    const pool = new WorkerPool(['sk-test'], 4);
    const { spawnMcpWorker } = require('@parallelc/worker');
    const { spawnWorker } = require('@parallelc/worker');

    await pool.spawn(
      makeTask('task-env-001', ['src/api/user.ts']),
      '/repo',
    );

    // 验证 spawnWorker 被调用
    expect(spawnWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        workerId: 'worker-task-env-001',
        expectedTouchFiles: ['src/api/user.ts'],
        repoRoot: '/repo',
        apiKey: 'sk-test',
      }),
    );

    // 验证 MCP Worker 被调用
    expect(spawnMcpWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-test',
        cwd: '/tmp/worker-task-env-001-write',
        readonlyRoot: '/tmp/worker-task-env-001-readonly',
      }),
      expect.objectContaining({
        taskId: 'task-env-001',
        snapshotVersion: 'dag1-20260701',
      }),
    );
  });
});
```

- [ ] **Step 2: 验证测试失败**

Run: `cd packages/scheduler && npx jest --testPathPattern="worker-pool"`
Expected: FAIL

- [ ] **Step 3: 实现 worker-pool.ts**

Create `packages/scheduler/src/worker-pool.ts`:

```typescript
import type { ChildProcess } from 'child_process';
import type { Task } from '@parallelc/shared';
import { spawnWorker, cleanupWorktrees, spawnMcpWorker } from '@parallelc/worker';

export interface WorkerEntry {
  workerId: string;
  taskId: string;
  process: ChildProcess;
  startedAt: Date;
  writeRoot: string;
}

export class WorkerPool {
  private workers = new Map<string, WorkerEntry>();
  private apiKeys: string[];
  private keyIndex = 0;

  constructor(apiKeys: string[], private maxWorkers: number = 4) {
    this.apiKeys = apiKeys;
  }

  get activeCount(): number {
    return this.workers.size;
  }

  hasCapacity(): boolean {
    return this.workers.size < this.maxWorkers;
  }

  private nextKey(): string {
    const key = this.apiKeys[this.keyIndex % this.apiKeys.length]!;
    this.keyIndex++;
    return key;
  }

  async spawn(task: Task, repoRoot: string): Promise<WorkerEntry> {
    if (!this.hasCapacity()) {
      throw new Error(`Worker pool full (${this.workers.size}/${this.maxWorkers})`);
    }

    const workerId = `worker-${task.id}`;
    const apiKey = this.nextKey();

    // 1. 创建双 Worktree
    const result = await spawnWorker({
      workerId,
      expectedTouchFiles: task.expected_touch_files ?? [],
      repoRoot,
      apiKey,
    });

    // 2. 启动 MCP 子进程（环境变量注入 validateWriteHook 所需上下文）
    const process = spawnMcpWorker(
      {
        apiKey,
        cwd: result.writeRoot,
        readonlyRoot: result.readonlyRoot,
      },
      {
        taskId: task.id,
        snapshotVersion: task.snapshot_version ?? 'unknown',
        dependencies: task.dependencies,
      },
    );

    const entry: WorkerEntry = {
      workerId,
      taskId: task.id,
      process,
      startedAt: new Date(),
      writeRoot: result.writeRoot,
    };

    this.workers.set(workerId, entry);
    return entry;
  }

  reap(): WorkerEntry[] {
    const exited: WorkerEntry[] = [];
    for (const [workerId, entry] of this.workers) {
      if (entry.process.exitCode !== null) {
        exited.push(entry);
        this.workers.delete(workerId);
      }
    }
    return exited;
  }

  kill(workerId: string): void {
    const entry = this.workers.get(workerId);
    if (entry) {
      entry.process.kill('SIGTERM');
      setTimeout(() => {
        if (entry.process.exitCode === null) {
          entry.process.kill('SIGKILL');
        }
      }, 5000);
    }
  }

  async shutdownAll(): Promise<void> {
    for (const [workerId] of this.workers) {
      this.kill(workerId);
    }
  }
}
```

- [ ] **Step 4: 验证测试通过**

Run: `cd packages/scheduler && npx jest --testPathPattern="worker-pool"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/scheduler/
git commit -m "feat(scheduler): add WorkerPool with env injection and API key rotation"
```

---

### Task 5: @parallelc/scheduler — context-generator（project_context.md 生成）

**Files:**
- Create: `packages/scheduler/src/context-generator.ts`
- Create: `packages/scheduler/__tests__/context-generator.test.ts`

- [ ] **Step 1: 编写测试**

Create `packages/scheduler/__tests__/context-generator.test.ts`:

```typescript
import { generateContextSnapshot } from '../src/context-generator';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';

let repoRoot: string;
let db: Database.Database;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallelc-ctx-'));
  fs.mkdirSync(path.join(repoRoot, '.parallelc'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'index.ts'), 'export {}');
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Test Project\nDescription');

  db = new Database(':memory:');
});

afterEach(() => {
  db.close();
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('generateContextSnapshot', () => {
  const tasks = [{
    id: 'task-001',
    title: 'Test',
    status: 'READY' as const,
    version: 0,
    level: 'L2' as const,
    expected_touch_files: ['src/index.ts'],
    modified_files: null,
    rate_limit_count: 0,
    sleep_until: null,
    starvation_override: false,
    snapshot_version: 'dag1-20260701',
    context_mismatch: false,
    merge_blocked_at: null,
    merge_report_path: null,
    dependencies: null,
    ready_at: null,
    created_at: '',
    updated_at: '',
  }];

  test('生成快照文件并返回 ContextSnapshot', () => {
    const result = generateContextSnapshot(db, 'dag-test', tasks, repoRoot);
    expect(result).not.toBeNull();
    expect(result!.dagId).toBe('dag-test');
    expect(result!.status).toBe('FROZEN');
    expect(result!.taskIds).toContain('task-001');

    // 验证文件写入
    const ctxPath = path.join(repoRoot, '.parallelc', 'project_context.md');
    expect(fs.existsSync(ctxPath)).toBe(true);

    const content = fs.readFileSync(ctxPath, 'utf-8');
    expect(content).toContain('snapshot_version: dag-test');
    expect(content).toContain('status: FROZEN');
    expect(content).toContain('src/index.ts');
  });

  test('已有 FROZEN 快照时跳过并返回 null', () => {
    // 先生成一个快照
    generateContextSnapshot(db, 'dag-test', tasks, repoRoot);

    // 再次生成，应该跳过
    const result = generateContextSnapshot(db, 'dag-test-2', tasks, repoRoot);
    expect(result).toBeNull();
  });

  test('事务冲突时返回 null（BEGIN IMMEDIATE 被占用）', () => {
    // 模拟事务冲突：先开一个写事务
    db.prepare('BEGIN IMMEDIATE').run();

    const result = generateContextSnapshot(db, 'dag-test', tasks, repoRoot);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: 验证测试失败**

Run: `cd packages/scheduler && npx jest --testPathPattern="context-generator"`
Expected: FAIL

- [ ] **Step 3: 实现 context-generator.ts**

Create `packages/scheduler/src/context-generator.ts`:

```typescript
import Database from 'better-sqlite3';
import type { Task } from '@parallelc/shared';
import fs from 'fs';
import path from 'path';

export interface ContextSnapshot {
  dagId: string;
  timestamp: string;
  status: 'FROZEN';
  files: string[];
  taskIds: string[];
  architecture: string; // Phase 3: 接入 LLM 生成架构摘要
}

function scanRepoFiles(repoRoot: string): string[] {
  const files: string[] = [];
  const skip = new Set(['node_modules', '.git', 'dist', '.parallelc']);

  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        files.push(path.relative(repoRoot, full).replace(/\\/g, '/'));
      }
    }
  }

  walk(repoRoot);
  return files;
}

export function generateContextSnapshot(
  db: Database.Database,
  dagId: string,
  tasks: Task[],
  repoRoot: string,
): ContextSnapshot | null {
  const ctxPath = path.join(repoRoot, '.parallelc', 'project_context.md');

  // 检查是否已有 FROZEN 快照
  if (fs.existsSync(ctxPath)) {
    const existing = fs.readFileSync(ctxPath, 'utf-8');
    if (/^status:\s*FROZEN/m.test(existing)) {
      console.warn('[context-generator] Existing FROZEN snapshot found, skipping');
      return null;
    }
  }

  // BEGIN IMMEDIATE 事务保护写入
  try {
    db.prepare('BEGIN IMMEDIATE').run();
  } catch {
    console.warn('[context-generator] BEGIN IMMEDIATE failed, another writer is active');
    return null;
  }

  try {
    const timestamp = new Date().toISOString();
    const files = scanRepoFiles(repoRoot);
    const taskIds = tasks.map((t) => t.id);

    const architecture = 'Phase 3: 接入 LLM 生成架构摘要';

    const content = [
      `snapshot_version: ${dagId}-${timestamp}`,
      `generated_at: ${timestamp}`,
      `status: FROZEN`,
      '',
      `## Files (${files.length} total)`,
      ...files.map((f) => `- ${f}`),
      '',
      `## Tasks (${taskIds.length} total)`,
      ...taskIds.map((id) => `- ${id}`),
      '',
      `## Architecture`,
      architecture,
      '',
      `⚠️ 此文件在 DAG 执行期间为 FROZEN（只读）。禁止覆盖写。`,
    ].join('\n');

    fs.writeFileSync(ctxPath, content);
    db.prepare('COMMIT').run();

    return {
      dagId,
      timestamp,
      status: 'FROZEN',
      files,
      taskIds,
      architecture,
    };
  } catch (err) {
    db.prepare('ROLLBACK').run();
    console.warn('[context-generator] Failed to write project_context.md:', err);
    return null;
  }
}
```

- [ ] **Step 4: 验证测试通过**

Run: `cd packages/scheduler && npx jest --testPathPattern="context-generator"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/scheduler/
git commit -m "feat(scheduler): add context-generator with BEGIN IMMEDIATE transaction"
```

---

### Task 6: @parallelc/scheduler — dispatch-loop（三阶段主循环）

**Files:**
- Create: `packages/scheduler/src/dispatch-loop.ts`
- Create: `packages/scheduler/__tests__/dispatch-loop.test.ts`

- [ ] **Step 1: 编写测试**

Create `packages/scheduler/__tests__/dispatch-loop.test.ts`:

```typescript
import { dispatchTick, reapTick, wakeTick } from '../src/dispatch-loop';
import { WorkerPool } from '../src/worker-pool';
import Database from 'better-sqlite3';
import { initializeSchema, createTask, casUpdateStatus, queryTasksByStatus, getLockedFiles } from '@parallelc/taskboard';
import { EXIT_SUCCESS, EXIT_RATE_LIMIT, EXIT_TIMEOUT } from '@parallelc/shared';

let db: Database.Database;
let pool: WorkerPool;

beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
  pool = new WorkerPool(['sk-test'], 4);
});

afterEach(() => {
  db.close();
});

describe('dispatchTick', () => {
  test('派发无冲突的 READY 任务', () => {
    createTask(db, {
      id: 't1', title: 'Task 1',
      expected_touch_files: ['src/a.ts'],
      level: 'L2',
    });
    casUpdateStatus(db, 't1', 0, 'PENDING', 'READY');

    const result = dispatchTick(db, pool, '/repo', 4);
    expect(result.dispatched).toBe(1);
    expect(result.delayed).toBe(0);

    // 验证 DB 状态变为 RUNNING
    const running = queryTasksByStatus(db, 'RUNNING');
    expect(running).toHaveLength(1);
  });

  test('文件冲突时延迟任务', () => {
    createTask(db, {
      id: 't1', title: 'Task 1',
      expected_touch_files: ['src/a.ts'],
      level: 'L2',
    });
    createTask(db, {
      id: 't2', title: 'Task 2',
      expected_touch_files: ['src/a.ts', 'src/b.ts'],
      level: 'L2',
    });

    casUpdateStatus(db, 't1', 0, 'PENDING', 'READY');
    casUpdateStatus(db, 't2', 0, 'PENDING', 'READY');

    // t1 先被派发
    const result = dispatchTick(db, pool, '/repo', 4);
    expect(result.dispatched).toBe(1);
    expect(result.delayed).toBe(1); // t2 和 t1 冲突，被延迟

    // 验证 lockedFiles 包含 t1 的文件
    const locked = getLockedFiles(db);
    expect(locked).toContain('src/a.ts');
  });

  test('等待超 300s 触发饥饿保护', () => {
    createTask(db, { id: 't1', title: 'Task 1', expected_touch_files: ['src/x.ts'], level: 'L2' });
    casUpdateStatus(db, 't1', 0, 'PENDING', 'READY');

    // 第一轮：派发 t1
    dispatchTick(db, pool, '/repo', 4);

    // 创建 t2，与 t1 冲突
    createTask(db, { id: 't2', title: 'Task 2', expected_touch_files: ['src/x.ts'], level: 'L2' });
    casUpdateStatus(db, 't2', 0, 'PENDING', 'READY');

    // 手动将 t2 的 ready_at 设为 301s 前
    db.prepare("UPDATE tasks SET ready_at = datetime('now', '-301 seconds') WHERE id = 't2'").run();

    const result2 = dispatchTick(db, pool, '/repo', 4);
    expect(result2.starvation).toBe(1);
    expect(result2.dispatched).toBe(1); // t2 强制派发
  });

  test('池满时停止派发', () => {
    const smallPool = new WorkerPool(['sk-test'], 1);

    createTask(db, { id: 't1', title: 'T1', expected_touch_files: ['src/a.ts'], level: 'L2' });
    createTask(db, { id: 't2', title: 'T2', expected_touch_files: ['src/b.ts'], level: 'L2' });
    casUpdateStatus(db, 't1', 0, 'PENDING', 'READY');
    casUpdateStatus(db, 't2', 0, 'PENDING', 'READY');

    const result = dispatchTick(db, smallPool, '/repo', 1);
    expect(result.dispatched).toBe(1);
    // 第二个因池满未派发
    const stillReady = queryTasksByStatus(db, 'READY');
    expect(stillReady).toHaveLength(1);
  });
});

describe('reapTick', () => {
  test('退出码 0 → MARK_DONE', async () => {
    createTask(db, { id: 't1', title: 'Task 1', expected_touch_files: ['src/a.ts'], level: 'L2' });
    casUpdateStatus(db, 't1', 0, 'PENDING', 'READY');
    dispatchTick(db, pool, '/repo', 4);

    // 模拟进程正常退出
    const proc = (pool as unknown as Record<string, Map<string, unknown>>)['workers'].get('worker-t1');
    if (proc) {
      (proc['process'] as Record<string, unknown>)['exitCode'] = EXIT_SUCCESS;
    }

    const result = reapTick(db, pool);
    expect(result.done).toBe(1);

    const tasks = queryTasksByStatus(db, 'DONE');
    expect(tasks).toHaveLength(1);
  });

  test('退出码 null → 视为 EXIT_TIMEOUT', () => {
    // 使用 memory db 测试 reap 阶段逻辑
    createTask(db, { id: 't1', title: 'Task 1', expected_touch_files: ['src/a.ts'], level: 'L2' });
    casUpdateStatus(db, 't1', 0, 'PENDING', 'READY');
    casUpdateStatus(db, 't1', 1, 'READY', 'RUNNING');

    // 模拟 exitCode 为 null（Watchdog 杀死）
    const workerEntry = {
      workerId: 'worker-t1',
      taskId: 't1',
      process: { exitCode: null } as unknown as import('child_process').ChildProcess,
      startedAt: new Date(),
      writeRoot: '/tmp/test',
    };
    (pool as unknown as Record<string, Map<string, unknown>>)['workers'].set('worker-t1', workerEntry);

    const result = reapTick(db, pool);
    expect(result.failed).toBe(1);

    const tasks = queryTasksByStatus(db, 'FAILED');
    expect(tasks).toHaveLength(1);
  });
});

describe('wakeTick', () => {
  test('唤醒到期的 SLEEP_PENDING 任务', () => {
    createTask(db, { id: 't1', title: 'T1', expected_touch_files: ['src/a.ts'], level: 'L2' });
    casUpdateStatus(db, 't1', 0, 'PENDING', 'READY');
    const v1 = queryTasksByStatus(db, 'READY')[0]!.version;
    casUpdateStatus(db, 't1', v1, 'READY', 'RUNNING');
    const v2 = queryTasksByStatus(db, 'RUNNING')[0]!.version;
    casUpdateStatus(db, 't1', v2, 'RUNNING', 'SLEEP_PENDING', {
      sleep_until: new Date(Date.now() - 60000).toISOString(), // 1 分钟前
    });

    const count = wakeTick(db);
    expect(count).toBe(1);

    const ready = queryTasksByStatus(db, 'READY');
    expect(ready).toHaveLength(1);
  });

  test('不到期的任务不唤醒', () => {
    createTask(db, { id: 't1', title: 'T1', expected_touch_files: ['src/a.ts'], level: 'L2' });
    casUpdateStatus(db, 't1', 0, 'PENDING', 'READY');
    const v1 = queryTasksByStatus(db, 'READY')[0]!.version;
    casUpdateStatus(db, 't1', v1, 'READY', 'RUNNING');
    const v2 = queryTasksByStatus(db, 'RUNNING')[0]!.version;
    casUpdateStatus(db, 't1', v2, 'RUNNING', 'SLEEP_PENDING', {
      sleep_until: new Date(Date.now() + 3600000).toISOString(), // 1 小时后
    });

    const count = wakeTick(db);
    expect(count).toBe(0);
  });
});
```

- [ ] **Step 2: 验证测试失败**

Run: `cd packages/scheduler && npx jest --testPathPattern="dispatch-loop"`
Expected: FAIL

- [ ] **Step 3: 实现 dispatch-loop.ts**

Create `packages/scheduler/src/dispatch-loop.ts`:

```typescript
import Database from 'better-sqlite3';
import { EXIT_TIMEOUT, EXIT_SUCCESS } from '@parallelc/shared';
import type { Task } from '@parallelc/shared';
import {
  getLockedFiles,
  queryTasksByStatus,
  casUpdateStatus,
  updateTask,
  wakeSleepingTasks,
  propagateDagFailure,
  queryTaskById,
} from '@parallelc/taskboard';
import { routeExitCode, cleanupWorktrees } from '@parallelc/worker';
import { WorkerPool } from './worker-pool.js';

export interface SchedulerConfig {
  dbPath: string;
  repoRoot: string;
  apiKeys: string[];
  maxWorkers?: number;
  starvationThresholdMs?: number;
  tickIntervalMs?: number;
}

export interface DispatchResult {
  dispatched: number;
  delayed: number;
  starvation: number;
}

export interface ReapResult {
  done: number;
  failed: number;
  sleeping: number;
  checkpointed: number;
}

export interface TickStats {
  tick: number;
  dispatch: DispatchResult;
  reap: ReapResult;
  wake: number;
  poolSize: number;
}

const DEFAULT_MAX_WORKERS = 4;
const DEFAULT_STARVATION_MS = 300_000;
const DEFAULT_TICK_MS = 2_000;
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 5;

export function startScheduler(config: SchedulerConfig): void {
  const {
    dbPath,
    repoRoot,
    apiKeys,
    maxWorkers = DEFAULT_MAX_WORKERS,
    starvationThresholdMs = DEFAULT_STARVATION_MS,
    tickIntervalMs = DEFAULT_TICK_MS,
  } = config;

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  const pool = new WorkerPool(apiKeys, maxWorkers);
  let tick = 0;

  console.log(`[Scheduler] 启动 | DB: ${dbPath} | Max Workers: ${maxWorkers} | Repo: ${repoRoot}`);

  const loop = setInterval(() => {
    tick++;
    const dispatch = dispatchTick(db, pool, repoRoot, maxWorkers, starvationThresholdMs);
    const reap = reapTick(db, pool, repoRoot);
    const wake = wakeTick(db);

    if (dispatch.dispatched > 0 || reap.done + reap.failed + reap.sleeping > 0 || wake > 0) {
      console.log(
        `[DISPATCH] tick=${tick} 派发=${dispatch.dispatched} 延后=${dispatch.delayed} 饥饿=${dispatch.starvation} | pool=${pool.activeCount}/${maxWorkers}`,
      );
      if (reap.done + reap.failed + reap.sleeping + reap.checkpointed > 0) {
        console.log(
          `[REAP]    tick=${tick} 完成=${reap.done} 失败=${reap.failed} 休眠=${reap.sleeping} 检查点=${reap.checkpointed}`,
        );
      }
      if (wake > 0) {
        console.log(`[WAKE]    tick=${tick} 唤醒=${wake}`);
      }
    }
  }, tickIntervalMs);

  // 优雅退出
  const shutdown = async () => {
    clearInterval(loop);
    console.log('[Scheduler] 正在关闭...');
    await pool.shutdownAll();
    db.close();
    console.log('[Scheduler] 已关闭');
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

export function dispatchTick(
  db: Database.Database,
  pool: WorkerPool,
  repoRoot: string,
  maxWorkers: number,
  starvationThresholdMs: number = DEFAULT_STARVATION_MS,
): DispatchResult {
  // ═══ 跨轮保护：每轮从 DB 重建锁集合 ═══
  const lockedFiles = getLockedFiles(db);
  const readyTasks = queryTasksByStatus(db, 'READY');

  let dispatched = 0;
  let delayed = 0;
  let starvation = 0;

  for (const task of readyTasks) {
    if (!pool.hasCapacity()) break;
    if (dispatched >= maxWorkers) break;

    const taskExpected = new Set(task.expected_touch_files ?? []);
    const conflicting = [...taskExpected].filter((f) => lockedFiles.has(f));

    if (conflicting.length > 0) {
      const waited = task.ready_at
        ? Date.now() - new Date(task.ready_at).getTime()
        : 0;

      if (waited > starvationThresholdMs) {
        starvation++;
      } else {
        delayed++;
        continue;
      }
    }

    // CAS 乐观锁派发
    const ok = casUpdateStatus(
      db,
      task.id,
      task.version,
      'READY',
      'RUNNING',
      { starvation_override: conflicting.length > 0 },
    );

    if (ok) {
      pool.spawn(task, repoRoot).catch((err: Error) => {
        console.error(`[Scheduler] Failed to spawn worker for ${task.id}:`, err.message);
        casUpdateStatus(db, task.id, task.version + 1, 'RUNNING', 'FAILED');
      });

      // ═══ 本轮保护：立即更新内存锁集合 ═══
      for (const f of taskExpected) lockedFiles.add(f);
      dispatched++;
    }
  }

  return { dispatched, delayed, starvation };
}

export function reapTick(
  db: Database.Database,
  pool: WorkerPool,
  repoRoot: string,
): ReapResult {
  const result: ReapResult = { done: 0, failed: 0, sleeping: 0, checkpointed: 0 };
  const exited = pool.reap();

  for (const entry of exited) {
    let exitCode = entry.process.exitCode;
    if (exitCode === null) {
      exitCode = EXIT_TIMEOUT; // Watchdog 杀死 → 超时
    }

    const task = queryTaskById(db, entry.taskId);
    if (!task) continue;

    const action = routeExitCode({
      taskId: task.id,
      exitCode,
      writeRoot: entry.writeRoot,
      rateLimitCount: task.rate_limit_count,
      maxRateLimitRetries: DEFAULT_MAX_RATE_LIMIT_RETRIES,
    });

    switch (action.type) {
      case 'MARK_DONE':
        updateTask(db, task.id, task.version, { modified_files: action.modifiedFiles });
        casUpdateStatus(db, task.id, task.version, 'RUNNING', 'DONE');
        cleanupWorktrees(entry.workerId, repoRoot).catch(() => {});
        result.done++;
        break;

      case 'CHECKPOINT':
        casUpdateStatus(db, task.id, task.version, 'RUNNING', 'CHECKPOINT_PENDING');
        result.checkpointed++;
        break;

      case 'FAILED':
        casUpdateStatus(db, task.id, task.version, 'RUNNING', 'FAILED');
        propagateDagFailure(db, task.id);
        cleanupWorktrees(entry.workerId, repoRoot).catch(() => {});
        result.failed++;
        break;

      case 'RATE_LIMIT_SLEEP':
        updateTask(db, task.id, task.version, {
          rate_limit_count: action.attempt,
          sleep_until: action.wakeAt.toISOString(),
        });
        casUpdateStatus(db, task.id, task.version, 'RUNNING', 'SLEEP_PENDING');
        cleanupWorktrees(entry.workerId, repoRoot).catch(() => {});
        result.sleeping++;
        break;

      case 'HOOK_BLOCKED':
        casUpdateStatus(db, task.id, task.version, 'RUNNING', 'FAILED');
        cleanupWorktrees(entry.workerId, repoRoot).catch(() => {});
        result.failed++;
        break;
    }
  }

  return result;
}

export function wakeTick(db: Database.Database): number {
  return wakeSleepingTasks(db);
}

// 辅助：从 db 按 ID 查询任务（避免循环依赖）
function queryTaskById(db: Database.Database, id: string): Task | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return row as unknown as Task;
}
```

- [ ] **Step 4: 验证测试通过**

Run: `cd packages/scheduler && npx jest --testPathPattern="dispatch-loop"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/scheduler/
git commit -m "feat(scheduler): add dispatch-loop with three-phase tick cycle"
```

---

### Task 7: @parallelc/scheduler — CLI（start/status 入口）

**Files:**
- Create: `packages/scheduler/src/cli.ts`

- [ ] **Step 1: 实现 cli.ts**

Create `packages/scheduler/src/cli.ts`:

```typescript
#!/usr/bin/env node

import Database from 'better-sqlite3';
import { queryTasksByStatus } from '@parallelc/taskboard';
import { startScheduler } from './dispatch-loop.js';

const command = process.argv[2];

if (command === 'start') {
  const args = process.argv.slice(3);
  const getArg = (name: string) => {
    const idx = args.indexOf(name);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const dbPath = getArg('--db') ?? '.parallelc/taskboard.db';
  const repoRoot = getArg('--repo');
  const apiKeysStr = getArg('--api-keys');
  const maxWorkers = parseInt(getArg('--max-workers') ?? '4', 10);

  if (!repoRoot) {
    console.error('Usage: parallelc-scheduler start --repo <path> [--db <path>] [--api-keys <keys>] [--max-workers <n>]');
    process.exit(1);
  }

  if (!apiKeysStr) {
    console.error('Error: --api-keys is required (comma-separated Anthropic API keys)');
    process.exit(1);
  }

  const apiKeys = apiKeysStr.split(',').map((k) => k.trim());

  startScheduler({ dbPath, repoRoot, apiKeys, maxWorkers });

} else if (command === 'status') {
  const dbPath = process.argv.slice(3).find((a) => a.startsWith('--db='))
    ?.split('=')[1] ?? '.parallelc/taskboard.db';

  try {
    const db = new Database(dbPath, { readonly: true });
    db.pragma('journal_mode = WAL');

    const statuses = [
      'RUNNING' as const, 'SLEEP_PENDING' as const,
      'READY' as const, 'PENDING' as const,
      'DONE' as const, 'FAILED' as const,
    ];

    const counts: Record<string, number> = {};
    for (const s of statuses) {
      counts[s] = queryTasksByStatus(db, s).length;
    }

    console.log(`Tick: - | Pool: -/${counts['RUNNING']} | Ready: ${counts['READY']} | Running: ${counts['RUNNING']} | Sleep: ${counts['SLEEP_PENDING']} | Done: ${counts['DONE']} | Failed: ${counts['FAILED']}`);
    console.log('─'.repeat(80));

    // RUNNING 任务明细
    const running = queryTasksByStatus(db, 'RUNNING');
    if (running.length > 0) {
      console.log('RUNNING');
      for (const t of running) {
        const elapsed = Math.floor((Date.now() - new Date(t.updated_at).getTime()) / 1000);
        console.log(`  worker-${t.id.padEnd(20)} ${t.id.padEnd(20)} ${elapsed}s`);
      }
    }

    // SLEEP_PENDING 明细
    const sleeping = queryTasksByStatus(db, 'SLEEP_PENDING');
    if (sleeping.length > 0) {
      console.log('SLEEP_PENDING');
      for (const t of sleeping) {
        console.log(`  ${t.id.padEnd(20)} 429 rate-limit  唤醒: ${t.sleep_until ?? 'unknown'}`);
      }
    }

    // READY 明细
    const ready = queryTasksByStatus(db, 'READY');
    if (ready.length > 0) {
      console.log(`READY（待派发: ${ready.length}）`);
      for (const t of ready) {
        const waited = t.ready_at
          ? Math.floor((Date.now() - new Date(t.ready_at).getTime()) / 1000)
          : 0;
        console.log(`  ${t.id.padEnd(20)} 等待: ${waited}s`);
      }
    }

    // 最近 FAILED
    const failed = queryTasksByStatus(db, 'FAILED', 'updated_at DESC');
    if (failed.length > 0) {
      console.log('FAILED（最近 3 条）');
      for (const t of failed.slice(0, 3)) {
        console.log(`  ${t.id.padEnd(20)} ${t.updated_at}`);
      }
    }

    db.close();
  } catch (err) {
    console.error('Error reading taskboard:', (err as Error).message);
    process.exit(1);
  }

} else {
  console.log('ParallelC Scheduler v0.1.0');
  console.log('  start  --repo <path> --api-keys <keys> [--db <path>] [--max-workers <n>]');
  console.log('  status [--db <path>]');
  process.exit(0);
}
```

- [ ] **Step 2: 验证 TypeScript 编译**

Run: `cd packages/scheduler && pnpm typecheck`（如 Node.js 可用）
Expected: 无类型错误

- [ ] **Step 3: Commit**

```bash
git add packages/scheduler/
git commit -m "feat(scheduler): add CLI with start and status commands"
```

---

## 依赖顺序

```
Task 1 (mcp-client)
  └─ Task 2 (run-worker)
       └─ Task 3 (scheduler skeleton)
            ├─ Task 4 (worker-pool)
            ├─ Task 5 (context-generator)
            └─ Task 6 (dispatch-loop) ← 依赖 Task 4
                 └─ Task 7 (CLI)
```

---

## Phase 2 验收对照

| # | 验收项 | 对应 Task |
|---|--------|---------|
| 1 | 派发期互斥排队（基础场景） | Task 6 — dispatchTick 测试 |
| 2 | 同轮竞态修复（v1.5 核心验证） | Task 6 — lockedFiles.update 本轮保护 |
| 3 | 饥饿保护（300s 强制派发） | Task 6 — starvation 测试 |
| 4 | SLEEP_PENDING 纳入锁集合 | Phase 1 已实现 + Task 6 wakeTick |
| 5 | Scheduler 崩溃重启后状态一致 | Task 6 — 跨轮 DB 重建 lockedFiles |
| 6 | MERGE_BLOCKED 仲裁触发 | Phase 3 |
| 7 | 数据采集与预测 Prompt 反哺 | Task 5 — context-generator 骨架 |

---

## 不在本计划范围内

- Merge Coordinator（Phase 3）
- API Key 池健康检查（Phase 3）
- Claude Code hook 实际集成（Phase 3）
- Orchestrator Agent 自动分级（Phase 3）
