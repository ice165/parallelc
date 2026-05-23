# ParallelC Phase 2 — 通信总线与调度左移 设计文档

**项目代号**：ParallelC
**文档版本**：v1.0
**日期**：2026-05-23
**基于**：Phase 1 交付版 + claude code并行Agentv1.5.docx §5 Phase 2

---

## 1. 概述

Phase 2 在 Phase 1 的基础上新增 **Scheduler（调度器）** 和 **MCP 通信层**，使任务从手动创建到自动派发再到 Worker 进程执行形成闭环。

核心新增能力：
1. **Scheduler dispatch_loop** — 三层 tick 循环（派发/回收/唤醒）
2. **MCP Worker 通信** — stdio 协议连接 Claude Code 执行任务
3. **Worker Pool 进程管理** — 生命周期、并发控制、优雅退出
4. **CLI 入口** — `npx parallelc-scheduler start` 一键启动
5. **project_context.md 骨架** — BEGIN IMMEDIATE 事务保护写入

---

## 2. 技术选型

| 项目 | 选择 | 原因 |
|------|------|------|
| 语言 | TypeScript (strict) | 与 Phase 1 统一 |
| MCP 通信 | stdio (child_process.spawn) | 标准协议，零额外依赖 |
| Worker 启动 | `claude` CLI 子进程 | 每个 Worker 独立会话，环境变量隔离 |
| 调度循环 | setInterval / sleep | 单实例单线程，与 SQLite WAL 模型一致 |
| CLI | package.json `bin` 字段 | `npx` 直接调用 |

---

## 3. 包结构

```
packages/
├── shared/                   # 不变
├── validate/                 # 不变
├── taskboard/                # 不变
│
├── worker/                   # 更新
│   └── src/
│       ├── startup.ts        # 不变
│       ├── lifecycle.ts      # 不变
│       ├── spawn.ts          # 不变
│       ├── mcp-client.ts     # [新增] MCP stdio 通信客户端
│       └── run-worker.ts     # [新增] Worker 入口
│
└── scheduler/                # [新包] @parallelc/scheduler
    └── src/
        ├── dispatch-loop.ts  # 主循环：tick/reap/wake 三阶段
        ├── worker-pool.ts    # Map<workerId, WorkerEntry>
        ├── context-generator.ts  # project_context.md 骨架
        ├── cli.ts            # CLI 入口 + status 查询
        ├── cli-status.ts     # 调度状态查询格式化
        └── index.ts
```

**依赖**：
```
@parallelc/scheduler
  ├── @parallelc/shared
  ├── @parallelc/taskboard
  └── @parallelc/worker
```

---

## 4. 模块 API 设计

### 4.1 @parallelc/worker — MCP 客户端

```typescript
// mcp-client.ts

export interface McpClientOptions {
  apiKey: string;
  model?: 'haiku' | 'sonnet' | 'opus';
  cwd: string;                    // Worker 写区路径
  readonlyRoot: string;           // 只读区路径
  maxRounds?: number;             // 默认 30
}

export interface McpTaskContext {
  taskId: string;
  snapshotVersion: string;
  dependencies: string[] | null;
}

/**
 * 启动 MCP stdio 子进程连接 Claude Code。
 * 返回 ChildProcess，Scheduler 在 reap 阶段检查退出状态。
 */
export function spawnMcpWorker(
  opts: McpClientOptions,
  context: McpTaskContext,
): ChildProcess;

/**
 * 构建 Worker 的 system prompt。
 * 强制注入：读取 project_context.md、校验 snapshot_version、
 * 只读区路径提示、写保护警告。
 */
export function buildWorkerSystemPrompt(context: McpTaskContext): string;
```

### 4.2 @parallelc/worker — 入口

```typescript
// run-worker.ts

/**
 * Worker 进程完整入口。
 *   1. verifySnapshotVersion() — 快照校验
 *   2. buildWorkerSystemPrompt() — 构建 prompt
 *   3. spawnMcpWorker() — 启 MCP 连接
 *   4. 等待 process.exit（setTimeout Watchdog 触发 11）
 *
 * 环境变量：WORKER_ID, WORKER_WRITE_ROOT, WORKER_READONLY_ROOT,
 *           ANTHROPIC_API_KEY, TASK_ID, SNAPSHOT_VERSION
 */
export function runWorker(): void;
```

### 4.3 @parallelc/scheduler — dispatch-loop.ts

```typescript
// dispatch-loop.ts

const TICK_INTERVAL_MS = 2000;
const STARVATION_THRESHOLD_MS = 300_000;

export interface SchedulerConfig {
  dbPath: string;
  repoRoot: string;
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

/**
 * 启动 Scheduler 主循环。永不返回。
 *
 * 每轮三阶段：
 *   1. dispatchTick — 派发 READY 任务（两层保护）
 *   2. reapTick    — 回收已退出 Worker
 *   3. wakeTick    — 唤醒到期 SLEEP_PENDING
 */
export function startScheduler(config: SchedulerConfig): void;

function dispatchTick(
  db: Database.Database,
  pool: WorkerPool,
  repoRoot: string,
  maxWorkers: number,
): DispatchResult;

function reapTick(
  db: Database.Database,
  pool: WorkerPool,
): ReapResult;

function wakeTick(db: Database.Database): number;
```

**dispatchTick 伪代码**：
```
lockedFiles = getLockedFiles(db)           ← 跨轮保护：DB 重建
for task in queryTasksByStatus(db, 'READY'):
  conflicting = task.files ∩ lockedFiles
  if conflicting and waited < 300s:
    delayed++; continue
  if conflicting and waited >= 300s:
    starvation++; starvation_override = true
  if pool.hasCapacity():
    if casUpdateStatus(READY → RUNNING):
      pool.spawn(task, apiKey, repoRoot)
      lockedFiles.update(task.files)       ← 本轮保护：同轮可见
      dispatched++
```

**两层保护总结**：

| 保护层 | 实现方式 | 保护范围 | 崩溃安全 |
|--------|---------|---------|---------|
| 跨轮保护 | 每轮头部 `getLockedFiles(db)` | 跨调度周期 | 是 |
| 本轮保护 | CAS 成功后 `lockedFiles.add()` | 同轮竞态窗口 | 是（跨轮兜底） |

### 4.4 @parallelc/scheduler — worker-pool.ts

```typescript
// worker-pool.ts

export interface WorkerEntry {
  workerId: string;
  taskId: string;
  process: ChildProcess;
  startedAt: Date;
  writeRoot: string;
}

export class WorkerPool {
  constructor(maxWorkers: number = 4);

  get activeCount(): number;
  hasCapacity(): boolean;

  /**
   * 启动 Worker：
   *   spawnWorker() → spawnMcpWorker() → 注册 Map
   */
  spawn(task: Task, apiKey: string, repoRoot: string): WorkerEntry;

  /** 返回已退出进程列表，从 Map 中移除 */
  reap(): WorkerEntry[];

  /** 强制终止 */
  kill(workerId: string): void;

  /** 优雅关闭 */
  shutdownAll(): Promise<void>;
}
```

### 4.5 CLI + context-generator

```typescript
// context-generator.ts

export interface ContextSnapshot {
  dagId: string;
  timestamp: string;
  status: 'FROZEN';
  files: string[];
  taskIds: string[];
  architecture: string;
}

/**
 * 生成 project_context.md。
 * 使用 BEGIN IMMEDIATE 事务保护写入，获取失败则放弃并 WARNING。
 */
export function generateContextSnapshot(
  db: Database.Database,
  dagId: string,
  tasks: Task[],
  repoRoot: string,
): ContextSnapshot | null;
```

---

## 5. Phase 2 验收对照

| # | 原文档要求 | 组件 | 状态 |
|---|-----------|------|------|
| 1 | 派发期互斥排队 | dispatchTick 两层保护 | 实现 |
| 2 | 同轮竞态修复 | CAS 后 lockedFiles.update() | 实现 |
| 3 | 饥饿保护 | 300s 阈值 + starvation_override | 实现 |
| 4 | SLEEP_PENDING 纳入锁 | Phase 1 getLockedFiles 已含 | 已实现 |
| 5 | 崩溃重启状态一致 | 跨轮 DB 重建 lockedFiles | 实现 |
| 6 | MERGE_BLOCKED 仲裁 | Merge Coordinator（Phase 3） | Phase 3 |
| 7 | 数据采集与 Prompt 反哺 | context-generator 骨架 | 骨架 |

---

## 6. 不在 Phase 2 范围内

- Merge Coordinator 自动/结构化/仲裁合并（Phase 3）
- API Key 池轮转与健康检查（Phase 3）
- validate_write hook 的实际 Claude Code 集成（Phase 3）
- Orchestrator Agent L1/L2/L3 自动分级（Phase 3）
- `expected_touch_files` 预测 Prompt 迭代优化（持续）

---

*基于 ParallelC v1.5 项目计划书 §5 Phase 2 | 2026-05-23*
