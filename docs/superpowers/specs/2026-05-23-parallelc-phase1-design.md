# ParallelC Phase 1 — 隔离与安全基础验证 设计文档

**项目代号**：ParallelC
**文档版本**：v1.0
**日期**：2026-05-23
**基于**：claude code并行Agentv1.5.docx

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
routeExitCode(opts: OnWorkerExitOptions): ExitAction
collectModifiedFiles(writeRoot: string): string[]
calculateRateLimitBackoff(attempt: number, maxRetries?: number): { wakeAt, exceeded }
```

**双 Worktree 创建流程**：
1. `git worktree add {readonlyRoot} {baseBranch}` — 完整检出
2. `git worktree add --no-checkout {writeRoot} {baseBranch}`
3. `cd {writeRoot} && git sparse-checkout init --cone`
4. `git sparse-checkout set {dirnames} && git checkout {baseBranch}`
5. 环境变量注入 `WORKER_READONLY_ROOT`、`WORKER_WRITE_ROOT`

**退出码路由**：
| 退出码 | 动作 | 说明 |
|--------|------|------|
| 0 | MARK_DONE | 采集 modified_files |
| 10 | CHECKPOINT | 保留上下文等待重派 |
| 11 | RETRY | 自动重试一次 |
| 12 | HOOK_BLOCKED | 记录违规标记 FAILED |
| 13 | RATE_LIMIT_SLEEP | 指数退避 + ±30s 抖动，第6次 FAILED |

### 4.4 @parallelc/taskboard

```typescript
// schema.ts
TASK_TABLE_DDL        // CREATE TABLE + 4 索引
VALID_STATUSES        // 9 个合法状态
ALLOWED_TRANSITIONS   // from → to[] 状态转换表

// db.ts
getDb(dbPath?: string): Database
initializeSchema(db): void
closeDb(): void

// repository.ts
casUpdateStatus(db, taskId, expectedVersion, fromStatus, toStatus, extra?): boolean
createTask(db, task): Task
queryTasksByStatus(db, status, orderBy?): Task[]
getLockedFiles(db): Set<string>
wakeSleepingTasks(db): number
updateTask(db, taskId, expectedVersion, fields): boolean
propagateDagFailure(db, failedTaskId): number
```

**CAS 乐观锁**：所有状态变更附带 `expectedVersion`，WHERE 子句包含 `version = ?`，成功则 `version + 1`。这是调度层稳定性核心保证。

**WAL 模式**：读写并发不互斥，适合调度循环高频读取场景。

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
