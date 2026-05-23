# ParallelC Phase 1 — 隔离与安全基础验证 设计文档

**项目代号**：ParallelC
**文档版本**：v1.0
**日期**：2026-05-23
**基于**：claude code并行Agentv1.5.docx
**审查版本**：v1.1（2026-05-23 代码审查修订）

---

## 1. 概述

Phase 1 的目标是搭建 ParallelC 的 TypeScript monorepo 骨架，并实现三个核心安全组件：

1. **写保护 + 路径穿越防御**（对应原 `validate_write.py`）
2. **双 Worktree 创建与管理**（对应原 `spawn_worker.sh`）
3. **快照版本校验 + 退出码处理路由**（对应原 `worker_startup.py` + `on_worker_exit.py`）
4. **TaskBoard SQLite 数据层**（Schema + CAS 乐观锁 CRUD）

---

## 2. 技术选型

| 项目 | 选择 | 原因 |
|------|------|------|
| 语言 | TypeScript (strict) | 与 Claude Code MCP 生态一致，全栈统一 |
| 包管理 | pnpm workspaces | Monorepo，组件独立 package，边界清晰 |
| 数据库 | better-sqlite3 | 同步 API，与 Scheduler 单实例单线程模型一致；WAL 模式 |
| 文件锁 | better-sqlite3 `BEGIN IMMEDIATE` | `project_context.md` 写入保护：利用已有 DB 层实现文件级互斥，不引入新的 native 依赖。获取失败则放弃本次更新并记录 WARNING 告警 |
| 测试 | Jest + ts-jest | 成熟生态，mock 能力强 |
| 运行 | tsx (dev) / tsup (build) | 开发期直接运行 TS，生产构建用 esbuild |
| 构建 | tsup | 每个包独立构建为 CJS + ESM |

---

## 3. 项目结构

```
parallelc/
├── pnpm-workspace.yaml
├── package.json              # root: scripts, devDeps
├── tsconfig.base.json        # 共享 TS 配置
├── jest.config.base.ts       # 共享 Jest 配置
├── .env.example
│
├── packages/
│   ├── shared/               # @parallelc/shared
│   │   ├── src/
│   │   │   ├── types.ts           # Task, TaskStatus, WorkerContext, etc.
│   │   │   ├── constants.ts       # EXIT_SUCCESS/CHECKPOINT/TIMEOUT/...
│   │   │   ├── errors.ts          # ParallelCError 基类
│   │   │   └── index.ts
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── jest.config.ts
│   │
│   ├── validate/             # @parallelc/validate
│   │   ├── src/
│   │   │   ├── validate-write.ts  # isWriteAllowed() + realpath
│   │   │   ├── hook.ts            # validateWriteHook()
│   │   │   └── index.ts
│   │   ├── __tests__/
│   │   │   ├── validate-write.test.ts
│   │   │   └── path-traversal.test.ts
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── jest.config.ts
│   │
│   ├── worker/               # @parallelc/worker
│   │   ├── src/
│   │   │   ├── spawn.ts           # spawnWorker() + cleanupWorktrees()
│   │   │   ├── startup.ts         # verifySnapshotVersion()
│   │   │   ├── lifecycle.ts       # routeExitCode() + collectModifiedFiles()
│   │   │   └── index.ts
│   │   ├── __tests__/
│   │   │   ├── spawn.test.ts
│   │   │   ├── startup.test.ts
│   │   │   └── lifecycle.test.ts
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── jest.config.ts
│   │
│   └── taskboard/            # @parallelc/taskboard
│       ├── src/
│       │   ├── schema.ts          # DDL + 状态转换表
│       │   ├── db.ts              # better-sqlite3 单例 + WAL
│       │   ├── repository.ts      # Task CRUD + CAS + DAG 传播
│       │   └── index.ts
│       ├── __tests__/
│       │   ├── schema.test.ts
│       │   ├── db.test.ts
│       │   └── repository.test.ts
│       ├── package.json
│       ├── tsconfig.json
│       └── jest.config.ts
```

---

## 4. 包 API 设计

### 4.1 @parallelc/shared

纯类型与常量，零依赖。

```typescript
// 退出码
EXIT_SUCCESS      = 0
EXIT_CHECKPOINT   = 10
EXIT_TIMEOUT      = 11
EXIT_HOOK_BLOCKED = 12
EXIT_RATE_LIMIT   = 13

// 状态枚举
type TaskStatus = 'PENDING' | 'READY' | 'RUNNING' | 'SLEEP_PENDING'
  | 'CHECKPOINT_PENDING' | 'DONE' | 'FAILED' | 'CANCELLED' | 'MERGE_BLOCKED';

type TaskLevel = 'L1' | 'L2' | 'L3';

interface Task {
  id, title, status, version,
  level,                          // TaskLevel — L1/L2/L3，L1 不进入 TaskBoard
  expected_touch_files, modified_files,
  rate_limit_count, sleep_until,
  starvation_override, snapshot_version, context_mismatch,
  merge_blocked_at, merge_report_path,
  dependencies, created_at, updated_at, ready_at
}

interface WorkerContext { workerId, readonlyRoot, writeRoot, taskId, apiKey }
interface SnapshotVersion { dagId, timestamp, status }

class ParallelCError extends Error { exitCode, context }
```

### 4.2 @parallelc/validate

```typescript
isWriteAllowed(filePath: string, workerId: string, writeRoot: string): boolean
validateWriteHook(toolName: string, params: Record<string, unknown>): void
```

**规则**：
1. 使用 `fs.realpath` / `path.resolve` 规范化路径，解析 `..` 和符号链接
2. 规范化后的路径必须在 `writeRoot` 子树内
3. 路径包含 `-readonly` 的一律拒绝
4. hook 入口从 `WORKER_ID`、`WORKER_WRITE_ROOT` 环境变量读取上下文

### 4.3 @parallelc/worker

```typescript
// spawn.ts
spawnWorker(opts: SpawnWorkerOptions): Promise<SpawnWorkerResult>
cleanupWorktrees(workerId: string, repoRoot: string): Promise<void>

// startup.ts
verifySnapshotVersion(opts: StartupCheckOptions): StartupCheckResult
parseProjectContextHeader(content: string): { snapshotVersion, generatedAt, status } | null

// lifecycle.ts
routeExitCode(opts: OnWorkerExitOptions): ExitAction    // Phase 1 骨架，Phase 2+ 补充 Scheduler 重试决策
collectModifiedFiles(writeRoot: string): string[]       // Phase 1
calculateRateLimitBackoff(attempt: number, ...): { ... } // Phase 3+（429 指数退避 + 抖动）
```

**双 Worktree 创建流程**：
1. `git worktree add {readonlyRoot} {baseBranch}` — 完整检出
2. `git worktree add --no-checkout {writeRoot} {baseBranch}`
3. 从 `expectedTouchFiles` 提取唯一目录名：`const dirnames = [...new Set(expectedTouchFiles.map(f => path.dirname(f)))];`
4. `cd {writeRoot} && git sparse-checkout init --cone`
5. `git sparse-checkout set {dirnames} && git checkout {baseBranch}`
6. 环境变量注入 `WORKER_READONLY_ROOT`、`WORKER_WRITE_ROOT`

**⚠️ 已知局限：双 Worktree 运行期上下文过期（v1.5 阶段可接受）**

Worker 的只读 Worktree 在创建时固定检出，不跟随主仓库 `main` 的推进自动更新。当并发执行的其他 Worker 完成合入后，当前 Worker 读到的只读区代码可能已过时。此局限在 v1.5 阶段可接受，原因：
- 实际写入发生在隔离的稀疏写区，与只读区物理分离
- 最终代码集成由 Merge Coordinator 统一处理（Phase 3）
- 长生命周期任务可选择性执行 `git fetch` 刷新关键文件

**推荐应对策略（面向长生命周期任务）**：
```bash
git -C $WORKER_READONLY_ROOT fetch origin main
git -C $WORKER_READONLY_ROOT checkout origin/main -- src/api/user.ts
```

**退出码路由**：
| 退出码 | 动作 | 说明 |
|--------|------|------|
| 0 | MARK_DONE | 采集 modified_files |
| 10 | CHECKPOINT | 保留上下文等待重派 |
| 11 | FAILED | 进程超时，标记 FAILED，由 Scheduler 决策是否重试 |
| 12 | HOOK_BLOCKED | 记录违规标记 FAILED |
| 13 | RATE_LIMIT_SLEEP | 指数退避 + ±30s 抖动，第6次 FAILED |

### 4.4 @parallelc/taskboard

```typescript
// schema.ts
TASK_TABLE_DDL        // CREATE TABLE + 5 索引（含 level TEXT 字段，L1/L2/L3）
VALID_STATUSES        // 9 个合法状态
ALLOWED_TRANSITIONS   // from → to[] 状态转换表

// db.ts
getDb(dbPath?: string): Database
initializeSchema(db): void
closeDb(): void

// repository.ts
casUpdateStatus(db, taskId, expectedVersion, fromStatus, toStatus, extra?): boolean // Phase 1
createTask(db, task): Task                                                        // Phase 1
queryTasksByStatus(db, status, orderBy?): Task[]                                  // Phase 1
getLockedFiles(db): Set<string>                                                   // Phase 1（跨轮保护核心）
wakeSleepingTasks(db): number                                                     // Phase 3+（429 退避唤醒）
updateTask(db, taskId, expectedVersion, fields): boolean                          // Phase 1
propagateDagFailure(db, failedTaskId): number                                     // Phase 3+（DAG 失败传播）
```

**CAS 乐观锁**：所有状态变更附带 `expectedVersion`，WHERE 子句包含 `version = ?`，成功则 `version + 1`。这是调度层稳定性核心保证。

**WAL 模式**：读写并发不互斥，适合调度循环高频读取场景。

**两层保护机制 — dispatch_loop 伪代码**（Phase 2 完整实现，Phase 1 预留在 repository.ts）：

```typescript
// 此伪代码描述 Scheduler dispatch_loop 的两层保护逻辑
// Phase 1: getLockedFiles() + casUpdateStatus() 在 taskboard 包中实现
// Phase 2: 完整 dispatch_loop 在 scheduler 包中实现

const STARVATION_THRESHOLD_MS = 300_000; // 5 分钟

function dispatchLoop(db: Database, workerPool: WorkerPool): void {
  while (true) {
    // ═══ 跨轮保护 ═══════════════════════════════════════════════
    // 每轮循环头部从 DB 重建 locked_files。
    // 崩溃重启后 locked_files 自动从 DB 恢复，不存在幽灵锁。
    // getLockedFiles() 查询 status IN ('RUNNING', 'SLEEP_PENDING')。
    const lockedFiles = getLockedFiles(db);

    const readyTasks = queryTasksByStatus(db, 'READY');

    for (const task of readyTasks) {
      const taskExpected = new Set(task.expected_touch_files ?? []);
      const conflicting = [...taskExpected].filter(f => lockedFiles.has(f));

      if (conflicting.length > 0) {
        const waited = Date.now() - new Date(task.ready_at!).getTime();
        if (waited > STARVATION_THRESHOLD_MS) {
          // 饥饿保护：强制派发，标记 starvation_override=true
          log.warn(`[STARVATION] Task ${task.id} waited ${waited}ms`);
        } else {
          log.info(`[MUTEX] Task ${task.id} delayed on ${conflicting}`);
          continue; // 本轮跳过，等待下一轮
        }
      }

      if (workerPool.hasCapacity()) {
        const ok = casUpdateStatus(db, task.id, task.version, 'READY', 'RUNNING', {
          starvation_override: task.starvation_override,
        });
        if (ok) {
          workerPool.spawn(task);
          // ═══ 本轮保护 ═════════════════════════════════════════
          // CAS 成功后立即更新本轮内存 locked_files，防止同一轮内
          // 声明相同文件的另一个 READY 任务也通过检查被重复派发。
          // 安全性：此更新仅影响当前轮次；下轮循环仍以 DB 为准重建。
          for (const f of taskExpected) lockedFiles.add(f);
        }
      }
    }

    sleep(2_000); // 调度间隔
  }
}
```

**两层保护总结**：

| 保护层 | 实现方式 | 保护范围 | 崩溃安全 |
|--------|---------|---------|---------|
| 跨轮保护 | 每轮循环头部从 DB 重建 `locked_files` | 跨调度周期的状态一致性 | 是 |
| 本轮保护 | CAS 成功后立即更新本轮内存 `locked_files` | 同一轮循环内的竞态窗口 | 是（内存丢失后跨轮保护兜底） |

---

## 5. 依赖关系

```
@parallelc/shared  ← 无依赖
    ↑
@parallelc/validate  ← shared
@parallelc/taskboard ← shared
@parallelc/worker    ← shared
```

---

## 6. Phase 1 验收标准

```bash
# 1. 写区拦截（正常路径）
# → 退出码 12，日志记录越权路径

# 2. 路径穿越防御
# → /repo/worktrees/w1-write/../src/main.py → 退出码 12

# 3. 双 Worktree 创建
# → readonly 区完整检出，write 区仅含预测目录，体积缩小 > 80%

# 4. 快照版本校验
# → 一致正常启动，不一致输出 WARNING + context_mismatch=true

# 5. 退出码路由
# → 0/10/11/12/13 分别产生正确的 ExitAction
```

---

## 7. 不在 Phase 1 范围内的内容

- Scheduler `dispatch_loop` 完整实现（Phase 2）
- Merge Coordinator（Phase 3）
- API Key 轮转（Phase 3）
- 饥饿保护与 MERGE_BLOCKED（Phase 2/3）
- `project_context.md` 生成逻辑（Phase 2）

---

*基于 ParallelC v1.5 项目计划书 | 2026-05-23*
