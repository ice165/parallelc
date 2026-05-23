# ParallelC Phase 2 — 通信总线与调度左移 设计文档

**项目代号**：ParallelC
**文档版本**：v1.1
**日期**：2026-05-23
**基于**：Phase 1 交付版 + claude code并行Agentv1.5.docx §5 Phase 2
**审查版本**：v1.1（2026-05-23 代码审查修订）

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
  cwd: string;
  readonlyRoot: string;
  maxRounds?: number;             // 默认 30，触发 EXIT_CHECKPOINT
  timeoutMs?: number;             // 默认 600_000（10分钟），触发 EXIT_TIMEOUT
}

export interface McpTaskContext {
  taskId: string;
  snapshotVersion: string;
  dependencies: string[] | null;
}

/**
 * 启动 MCP stdio 子进程连接 Claude Code。
 * 返回 ChildProcess，设置了 timeoutMs 的 Watchdog。
 *
 * Watchdog 超时机制：
 *   内部 setTimeout(timeoutMs) 监控子进程。
 *   - 正常退出：clearTimeout，exitCode 由子进程设置
 *   - 超时：SIGTERM（5s 宽限期）→ SIGKILL
 *     reapTick 检测到 exitCode === null → 视为 EXIT_TIMEOUT → FAILED
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
  apiKeys: string[];              // API Key 池，Worker 轮询使用
  maxWorkers?: number;            // 默认 4
  starvationThresholdMs?: number; // 默认 300_000
  tickIntervalMs?: number;        // 默认 2_000
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

**reapTick 退出码处理完整映射**：

```
reapTick(db, pool):
  for entry in pool.reap():
    exitCode = entry.process.exitCode
    if exitCode === null:
      // Watchdog 杀死的进程，exitCode 尚未被设置
      exitCode = EXIT_TIMEOUT
    task = queryTaskById(db, entry.taskId)
    action = routeExitCode({
      taskId: task.id,
      exitCode,
      writeRoot: entry.writeRoot,
      rateLimitCount: task.rate_limit_count,
    })

    switch action.type:
      'MARK_DONE':
        updateTask(db, task.id, task.version, {
          modified_files: action.modifiedFiles
        })
        casUpdateStatus(RUNNING → DONE)
        cleanupWorktrees(entry.workerId, repoRoot)
        done++

      'CHECKPOINT':
        casUpdateStatus(RUNNING → CHECKPOINT_PENDING)
        checkpointed++
        // Phase 2: CHECKPOINT_PENDING 在 nextTick 由 Scheduler
        // 重新注入上下文后转为 READY 重派

      'FAILED':
        casUpdateStatus(RUNNING → FAILED)
        propagateDagFailure(db, task.id)
        cleanupWorktrees(entry.workerId, repoRoot)
        failed++
        // 重试决策：
        //   - EXIT_TIMEOUT (11): 自动重试一次（Scheduler 创建新 READY 任务）
        //   - rate_limit_exhausted: 永久 FAILED，不重试
        //   - HOOK_BLOCKED (12): 永久 FAILED，需人工审查

      'RATE_LIMIT_SLEEP':
        updateTask(db, task.id, task.version, {
          rate_limit_count: action.attempt,
          sleep_until: action.wakeAt.toISOString(),
        })
        casUpdateStatus(RUNNING → SLEEP_PENDING)
        cleanupWorktrees(entry.workerId, repoRoot)
        sleeping++

      'HOOK_BLOCKED':
        casUpdateStatus(RUNNING → FAILED)
        cleanupWorktrees(entry.workerId, repoRoot)
        failed++
```

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
  private apiKeys: string[];
  private keyIndex: number = 0;

  constructor(apiKeys: string[], maxWorkers: number = 4);

  get activeCount(): number;
  hasCapacity(): boolean;

  /**
   * 轮询获取下一个 API Key。
   * nextKey() 循环递增 keyIndex，到达末尾回绕。
   */
  private nextKey(): string;

  /**
   * 启动 Worker。完整流程：
   *
   *   1. workerId = `worker-${task.id}`
   *   2. result = spawnWorker({ workerId, expectedTouchFiles, repoRoot, apiKey })
   *      → 创建双 Worktree，返回 readonlyRoot / writeRoot
   *   3. 构建环境变量（注入给子进程）：
   *        WORKER_ID=workerId
   *        WORKER_WRITE_ROOT=result.writeRoot
   *        WORKER_READONLY_ROOT=result.readonlyRoot
   *        ANTHROPIC_API_KEY=apiKey
   *        TASK_ID=task.id
   *        SNAPSHOT_VERSION=task.snapshot_version
   *     这些环境变量是 validateWriteHook（Phase 1）正常工作的前提：
   *     hook.ts 从 process.env 读取 WORKER_ID 和 WORKER_WRITE_ROOT，
   *     缺失时直接放行（非 Worker 环境），必须注入才能激活写保护。
   *   4. process = spawnMcpWorker({ apiKey, cwd, readonlyRoot, maxRounds, timeoutMs }, context)
   *      → 启动 MCP 子进程，继承上述环境变量
   *   5. 注册 Map: workerId → { workerId, taskId, process, startedAt, writeRoot }
   */
  spawn(task: Task, repoRoot: string): WorkerEntry;

  /** 返回已退出进程列表，从 Map 中移除 */
  reap(): WorkerEntry[];

  /** 强制终止 */
  kill(workerId: string): void;

  /** 优雅关闭 */
  shutdownAll(): Promise<void>;
}
```

### 4.5 context-generator

```typescript
// context-generator.ts

export interface ContextSnapshot {
  dagId: string;
  timestamp: string;
  status: 'FROZEN';
  files: string[];
  taskIds: string[];
  architecture: string;  // Phase 3: 接入 LLM 生成架构摘要，当前填充项目 README 首段
}

/**
 * 扫描仓库根目录，收集结构信息以生成 project_context.md。
 * 递归遍历，跳过 node_modules、.git、dist、.parallelc。
 */
function scanRepoFiles(repoRoot: string): string[];

/**
 * 生成 project_context.md 快照。
 *
 * 完整代码路径：
 *
 *   // 1. BEGIN IMMEDIATE 事务 —— 文件级写互斥
 *   db.prepare('BEGIN IMMEDIATE').run();
 *   try {
 *     // 2. 构造快照内容
 *     const header = `snapshot_version: ${dagId}-${timestamp}
 * generated_at: ${new Date().toISOString()}
 * status: FROZEN`;
 *     const body = scanRepoFiles(repoRoot).map(f => `- ${f}`).join('\n');
 *     const content = `${header}\n\n## Files\n${body}`;
 *
 *     // 3. 写入文件（fs.writeFileSync）
 *     fs.writeFileSync(`${repoRoot}/.parallelc/project_context.md`, content);
 *
 *     // 4. 提交事务
 *     db.prepare('COMMIT').run();
 *   } catch (err) {
 *     // 5. 回滚 + WARNING
 *     db.prepare('ROLLBACK').run();
 *     log.warn('Failed to write project_context.md', err);
 *     return null;
 *   }
 *
 * 获取失败策略：放弃本次更新，记录 WARNING 告警，返回 null。
 * 上一个版本快照保持有效，Worker 启动时校验会检测到版本偏差。
 */
export function generateContextSnapshot(
  db: Database.Database,
  dagId: string,
  tasks: Task[],
  repoRoot: string,
): ContextSnapshot | null;
```

### 4.6 CLI

```typescript
// cli.ts — bin 入口

/**
 * 命令行：
 *   npx parallelc-scheduler start --repo /repo --api-keys sk-xxx,sk-yyy
 *   npx parallelc-scheduler status --db .parallelc/taskboard.db
 *
 * status 输出格式：
 *
 *   Tick: 42 | Pool: 3/4 | Ready: 2 | Running: 3 | Sleep: 1 | Done: 12 | Failed: 0
 *   ──────────────────────────────────────────────────────────────────────────────
 *   RUNNING
 *     worker-task-001  task-001   32s  MCP 活跃
 *     worker-task-003  task-003   15s  MCP 活跃
 *     worker-task-005  task-005   98s  MCP 活跃
 *   SLEEP_PENDING
 *     task-004  429 rate-limit  唤醒: 2026-07-01T10:02:00Z
 *   READY（待派发: 2）
 *     task-006  等待: 45s  (被 task-005 锁: src/api/user.ts)
 *     task-007  等待: 12s  (被 task-005 锁: src/models/db.ts)
 *   FAILED（最近 3 条）
 *     task-002  rate_limit_exhausted  2026-07-01T09:58:00Z
 */
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
