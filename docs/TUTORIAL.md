# ParallelC 使用教程

> **代号**：ParallelC · **版本**：v0.1.0-phase1 · **日期**：2026-05-23
>
> 面向 Claude Code 的多 Agent 并行协同工作系统 — 隔离与安全基础

---

## 目录

1. [环境要求](#1-环境要求)
2. [项目结构](#2-项目结构)
3. [从零开始：环境配置与安装](#3-从零开始环境配置与安装)
4. [开发工作流](#4-开发工作流)
5. [核心 API 使用指南](#5-核心-api-使用指南)
6. [测试编写指南](#6-测试编写指南)
7. [Phase 2/3 扩展指南](#7-phase-23-扩展指南)
8. [常见问题](#8-常见问题)

---

## 1. 环境要求

| 工具 | 最低版本 | 验证命令 |
|------|---------|---------|
| Node.js | ≥ 20.0.0 | `node --version` |
| pnpm | ≥ 9.0.0 | `pnpm --version` |
| Git | ≥ 2.38.0 | `git --version` |

### Windows 额外要求

- 建议使用 **Git Bash** 或 **WSL2** 作为终端
- 确保 `${HOME}/.pnpm` 目录可写（pnpm 全局存储）

### 安装 pnpm（如未安装）

```bash
corepack enable          # Node.js 16.9+ 内置
# 或
npm install -g pnpm
```

---

## 2. 项目结构

```
parallelc/
├── pnpm-workspace.yaml       # pnpm monorepo 配置
├── package.json              # 根脚本 + 共享 devDeps
├── tsconfig.base.json        # 全局 TypeScript 配置（strict, NodeNext）
├── jest.config.base.ts       # 全局 Jest 配置（ts-jest, moduleNameMapper）
├── .env.example              # API Keys 模板 → 复制为 .env
│
├── docs/
│   └── superpowers/
│       ├── specs/            # 设计规范文档
│       └── plans/            # 实现计划文档
│
├── packages/
│   ├── shared/               # @parallelc/shared — 基础层
│   │   └── src/
│   │       ├── types.ts      #   核心类型（Task, WorkerContext, ExitAction 等）
│   │       ├── constants.ts  #   退出码常量（EXIT_SUCCESS ~ EXIT_RATE_LIMIT）
│   │       └── errors.ts     #   ParallelCError 基类
│   │
│   ├── validate/             # @parallelc/validate — 安全层
│   │   ├── src/
│   │   │   ├── validate-write.ts  # isWriteAllowed() — 路径穿越防御
│   │   │   └── hook.ts            # validateWriteHook() — Write/Edit 拦截
│   │   └── __tests__/
│   │
│   ├── taskboard/            # @parallelc/taskboard — 数据层
│   │   ├── src/
│   │   │   ├── schema.ts          # DDL（含 2 个 partial index）
│   │   │   ├── db.ts              # Map 多例数据库管理 + WAL
│   │   │   └── repository.ts      # CRUD + CAS 乐观锁 + getLockedFiles
│   │   └── __tests__/
│   │
│   └── worker/               # @parallelc/worker — 执行层
│       ├── src/
│       │   ├── startup.ts         # 快照版本校验
│       │   ├── lifecycle.ts       # 退出码路由 + 文件采集
│       │   └── spawn.ts           # 双 Worktree 创建/清理
│       └── __tests__/
```

### 包依赖关系

```
@parallelc/shared  ← 零依赖（纯类型 + 常量）
    ↑
    ├── @parallelc/validate   ← 依赖 shared
    ├── @parallelc/taskboard  ← 依赖 shared + better-sqlite3
    └── @parallelc/worker     ← 依赖 shared
```

---

## 3. 从零开始：环境配置与安装

### 3.1 克隆项目（或直接进入目录）

```bash
cd D:\Claude Code\Project    # 进入项目根目录
```

### 3.2 配置环境变量

```bash
# 复制模板
cp .env.example .env

# 编辑 .env，填入你的 Anthropic API Keys
# 多个 Key 用逗号分隔，Worker 启动时循环轮转
ANTHROPIC_API_KEYS=sk-ant-xxxxxxxxx,sk-ant-yyyyyyyyy
```

### 3.3 安装依赖

```bash
pnpm install
```

预期输出：
```
Scope: all 4 workspace projects
Packages: +123
Progress: resolved 150, reused 0, downloaded 123, done
Done
```

### 3.4 验证安装

```bash
# 类型检查（所有包）
pnpm typecheck

# 运行全部测试
pnpm test

# 或分包运行
cd packages/validate && npx jest
cd packages/taskboard && npx jest
cd packages/worker && npx jest
```

预期输出（全部通过）：
```
PASS  packages/shared/__tests__/...
PASS  packages/validate/__tests__/validate-write.test.ts
PASS  packages/validate/__tests__/path-traversal.test.ts
PASS  packages/taskboard/__tests__/schema.test.ts
PASS  packages/taskboard/__tests__/db.test.ts
PASS  packages/taskboard/__tests__/repository.test.ts
PASS  packages/worker/__tests__/startup.test.ts
PASS  packages/worker/__tests__/lifecycle.test.ts
PASS  packages/worker/__tests__/spawn.test.ts

Test Suites: 9 passed, 9 total
Tests:       XX passed, XX total
```

---

## 4. 开发工作流

### 4.1 日常开发循环

```bash
# 1. 编写/修改代码
vim packages/validate/src/validate-write.ts

# 2. 类型检查
pnpm typecheck

# 3. 运行相关测试
cd packages/validate && npx jest --watch

# 4. 全量测试
pnpm test

# 5. 提交
git add packages/validate/
git commit -m "feat(validate): add new validation rule"

# 6. 全量验证（CI 模拟）
pnpm test:ci
```

### 4.2 可用脚本

| 命令 | 作用 | 适用场景 |
|------|------|---------|
| `pnpm typecheck` | 所有包 TypeScript 类型检查 | 每次修改后 |
| `pnpm test` | 运行所有测试 | 提交前 |
| `pnpm test:ci` | CI 模式（含覆盖率报告） | PR/合并前 |
| `pnpm build` | 所有包生产构建（tsup） | 发布前 |
| `pnpm -r <script>` | 在所有包中运行 `<script>` | 批量操作 |

### 4.3 开发期直接运行 TS

```bash
# 使用 tsx 直接运行 TypeScript 文件（无需编译）
npx tsx packages/worker/src/startup.ts

# 或在包的 package.json 中配置脚本
```

### 4.4 添加新包

```bash
# 1. 创建目录结构
mkdir -p packages/my-package/src
mkdir -p packages/my-package/__tests__

# 2. 复制配置模板
cp packages/shared/package.json packages/my-package/package.json
cp packages/shared/tsconfig.json packages/my-package/tsconfig.json
cp packages/shared/jest.config.ts packages/my-package/jest.config.ts

# 3. 修改 package.json 中的 name 和依赖
# "name": "@parallelc/my-package"

# 4. 回到根目录安装
cd ../.. && pnpm install
```

---

## 5. 核心 API 使用指南

### 5.1 @parallelc/shared — 类型与常量

```typescript
import {
  // 退出码
  EXIT_SUCCESS,        // 0  — 正常完成
  EXIT_CHECKPOINT,     // 10 — 上下文轮次上限
  EXIT_TIMEOUT,        // 11 — 进程超时（Watchdog）
  EXIT_HOOK_BLOCKED,   // 12 — 跨区写入被拦截
  EXIT_RATE_LIMIT,     // 13 — API 429 限流

  // 状态
  EXIT_CODE_LABELS,    // Record<number, string> — 退出码 → 名称映射

  // 核心类型
  type Task,            // 任务实体（17 个字段）
  type TaskStatus,      // 9 种状态联合类型
  type TaskLevel,       // 'L1' | 'L2' | 'L3'
  type WorkerContext,   // Worker 运行上下文
  type ExitAction,      // 退出码路由结果联合类型
  type OnWorkerExitOptions,
  type SpawnWorkerOptions,
  type SpawnWorkerResult,
  type StartupCheckOptions,
  type StartupCheckResult,

  // 错误基类
  ParallelCError,       // extends Error { exitCode, context }
} from '@parallelc/shared';
```

**Task 状态机速查：**

```
PENDING → READY → RUNNING ─┬─→ DONE
   │        │       ├─→ SLEEP_PENDING → READY（退避到期）
   │        │       ├─→ CHECKPOINT_PENDING → READY（重派）
   │        │       └─→ FAILED（重试超限 / 超时）
   │        │
   └────────┴────→ CANCELLED（上游失败传播）

独立路径：MERGE_BLOCKED → DONE（人工仲裁完成）
```

### 5.2 @parallelc/validate — 写保护

```typescript
import { isWriteAllowed, validateWriteHook } from '@parallelc/validate';

// 场景 1：手动检查写入权限
const allowed = isWriteAllowed(
  '/repo/worktrees/w1-write/src/api/user.ts',  // 目标路径
  'w1',                                         // Worker ID
  '/repo/worktrees/w1-write'                    // writeRoot
);
// → true（路径在写区内）

const blocked = isWriteAllowed(
  '/repo/worktrees/w1-write/../w1-readonly/secret.ts',
  'w1',
  '/repo/worktrees/w1-write'
);
// → false（realpath 解析后识别为越权，路径穿越被拦截）

// 场景 2：Claude Code Hook 集成
// 在 Worker 环境的 hook 脚本中调用：
// validateWriteHook('Write', { file_path: '../../secret.ts' });
// → 越权时抛出 ParallelCError(exitCode=12)
```

**安全机制：**
- `fs.realpathSync` 解析符号链接和 `..`
- 相对路径以 `writeRoot` 为基准拼接
- `-readonly` 子串检测作额外防线

### 5.3 @parallelc/taskboard — 任务数据层

```typescript
import { getDb, initializeSchema, closeDb } from '@parallelc/taskboard';
import {
  createTask,
  casUpdateStatus,
  queryTasksByStatus,
  getLockedFiles,
  wakeSleepingTasks,
  updateTask,
  propagateDagFailure,      // Phase 3+
} from '@parallelc/taskboard';

// ── 初始化 ──────────────────────────────────────────
const db = getDb('.parallelc/taskboard.db');  // Map 多例，按路径复用
initializeSchema(db);                          // 幂等建表

// ── 创建任务 ────────────────────────────────────────
const task = createTask(db, {
  id: 'task-001',
  title: '实现用户登录 API',
  level: 'L2',
  expected_touch_files: ['src/api/auth.ts', 'src/middleware/auth.ts'],
  dependencies: ['task-000'],                  // 前置任务
  snapshot_version: 'dag1-20260701T100000Z',
});
// → Task { id, status: 'PENDING', version: 0, ... }

// ── CAS 乐观锁状态更新 ──────────────────────────────
// Phase 2 将以此为核心调度实现 dispatch_loop
const ok = casUpdateStatus(
  db, 'task-001',           // 任务 ID
  0,                        // expectedVersion（乐观锁）
  'PENDING',                // fromStatus
  'READY',                  // toStatus
);
// → ok === true，version 变为 1

// 版本冲突示例
const conflict = casUpdateStatus(db, 'task-001', 999, 'READY', 'RUNNING');
// → false（version 不匹配，被其他操作抢先）

// ── 查询任务 ────────────────────────────────────────
const readyTasks = queryTasksByStatus(db, 'READY');
const activeTasks = queryTasksByStatus(db, ['RUNNING', 'SLEEP_PENDING']);

// SQL 注入防御：orderBy 白名单
const tasks = queryTasksByStatus(
  db, 'PENDING', "1; DROP TABLE tasks;--"
);
// → 自动回退到默认排序 'created_at ASC'，注入无效

// ── 文件锁集合（跨轮保护核心） ───────────────────────
const lockedFiles = getLockedFiles(db);
// → Set { 'src/api/auth.ts', 'src/middleware/auth.ts', ... }
// 合并了 RUNNING 和 SLEEP_PENDING 状态所有任务的 expected_touch_files

// ── 限流任务唤醒（Phase 3+） ─────────────────────────
const woken = wakeSleepingTasks(db);
// → 将到期的 SLEEP_PENDING 任务批量转为 READY

// ── 更新任务字段 ─────────────────────────────────────
updateTask(db, 'task-001', 1, {
  modified_files: ['src/api/auth.ts'],
  context_mismatch: false,
});
```

**数据库特性：**
- **WAL 模式**：读写并发不互斥
- **Map 多例**：不同 dbPath 独立连接，相同路径复用
- **Partial Index**：`WHERE status = 'SLEEP_PENDING'` 仅索引相关行
- **CAS 乐观锁**：WHERE 子句校验 `status + version`

### 5.4 @parallelc/worker — 执行层

#### 5.4.1 快照版本校验

```typescript
import { verifySnapshotVersion, parseProjectContextHeader } from '@parallelc/worker';

// 解析 project_context.md 头部
const header = parseProjectContextHeader(`
snapshot_version: dag1-20260701T100000Z
generated_at: 2026-07-01T10:00:00Z
status: FROZEN
`);
// → { snapshotVersion: 'dag1-...', generatedAt: '2026-...', status: 'FROZEN' }

// Worker 启动时校验
const result = verifySnapshotVersion({
  taskId: 'task-001',
  snapshotVersion: 'dag1-20260701T100000Z',
  projectContextPath: '.parallelc/project_context.md',
});
// → { versionMatch: true, contextMismatch: false, warnings: [] }
```

#### 5.4.2 退出码路由

```typescript
import { routeExitCode, collectModifiedFiles, calculateRateLimitBackoff } from '@parallelc/worker';

// Worker 进程退出后调用
const action = routeExitCode({
  taskId: 'task-001',
  exitCode: 0,              // EXIT_SUCCESS
  writeRoot: '/repo/worktrees/w1-write',
  rateLimitCount: 0,
});
// → { type: 'MARK_DONE', modifiedFiles: ['src/api/auth.ts', ...] }

// 429 限流处理
const rateLimitAction = routeExitCode({
  taskId: 'task-002',
  exitCode: 13,             // EXIT_RATE_LIMIT
  writeRoot: '/repo/worktrees/w2-write',
  rateLimitCount: 2,        // 已是第 2 次 429
});
// → { type: 'RATE_LIMIT_SLEEP', attempt: 3, wakeAt: Date }
// attempt = rateLimitCount + 1, 上报给 Scheduler 更新 sleep_until

// 超出上限（rateLimitCount = 5）
const exhausted = routeExitCode({
  taskId: 'task-003',
  exitCode: 13,
  writeRoot: '/repo/worktrees/w3-write',
  rateLimitCount: 5,
});
// → { type: 'FAILED', reason: 'rate_limit_exhausted' }

// 退避计算
const backoff = calculateRateLimitBackoff(3);
// → { wakeAt: Date (≈4min ±30s), exceeded: false }
```

**文件采集机制：**
```
collectModifiedFiles(writeRoot)
  ├── git diff --name-only HEAD    → 已跟踪文件变更
  └── git ls-files --others        → 未跟踪新建文件（Write 工具创建）
       └── Set 去重合并
```

#### 5.4.3 双 Worktree 创建

```typescript
import { spawnWorker, cleanupWorktrees } from '@parallelc/worker';

// 创建隔离工作环境
const result = await spawnWorker({
  workerId: 'worker-1',
  expectedTouchFiles: [
    'src/api/user.ts',
    'src/models/user.ts',
  ],
  repoRoot: '/repo',
  apiKey: 'sk-ant-xxxxxxxxx',
  baseBranch: 'main',            // 可选，默认 'main'
});
// → {
//   workerId: 'worker-1',
//   readonlyRoot: '/repo/worktrees/worker-1-readonly',  // 完整检出
//   writeRoot:    '/repo/worktrees/worker-1-write',      // 仅预测目录
//   spawnedAt: '2026-07-01T10:00:00.000Z',
// }

// 任务完成后清理
await cleanupWorktrees('worker-1', '/repo');
// 两次 git worktree remove --force
```

**双 Worktree 架构：**

| 区 | 路径 | 检出 | 用途 | 写保护 |
|----|------|------|------|--------|
| 只读区 | `worktrees/{id}-readonly` | 完整 | 读取全量上下文 | validate_write hook |
| 写区 | `worktrees/{id}-write` | 稀疏（仅预测目录） | 执行写入 | 仅允许本区写入 |

**已知局限：** 只读区在 Worker 运行期间不自动跟随主仓库推进（v1.5 可接受，Merge Coordinator 兜底）。

---

## 6. 测试编写指南

### 6.1 测试文件约定

```
packages/<name>/__tests__/<module>.test.ts
```

### 6.2 validate 包测试模式

```typescript
import { isWriteAllowed } from '../src/validate-write';
import path from 'path';
import fs from 'fs';
import os from 'os';

let writeRoot: string;
let readonlyRoot: string;

beforeEach(() => {
  // 使用临时目录隔离每个测试
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallelc-'));
  writeRoot = path.join(tmpDir, 'w1-write');
  readonlyRoot = path.join(tmpDir, 'w1-readonly');
  fs.mkdirSync(writeRoot, { recursive: true });
  fs.mkdirSync(readonlyRoot, { recursive: true });
});

describe('isWriteAllowed', () => {
  test('允许写区写入', () => {
    expect(isWriteAllowed(
      path.join(writeRoot, 'src/a.ts'), 'w1', writeRoot
    )).toBe(true);
  });

  test('拒绝只读区写入', () => {
    expect(isWriteAllowed(
      path.join(readonlyRoot, 'secret.ts'), 'w1', writeRoot
    )).toBe(false);
  });
});
```

### 6.3 taskboard 包测试模式

```typescript
import Database from 'better-sqlite3';
import { initializeSchema } from '../src/db';
import { createTask, casUpdateStatus, queryTasksByStatus } from '../src/repository';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');   // 内存数据库隔离
  initializeSchema(db);             // 每个测试全新建表
});

afterEach(() => {
  db.close();                       // 清理
});

test('CAS 版本冲突', () => {
  createTask(db, { id: 't1', title: 'Test' });
  const ok = casUpdateStatus(db, 't1', 999, 'PENDING', 'READY');
  expect(ok).toBe(false);           // version 不匹配
});
```

### 6.4 spawn 测试模式

```typescript
// 每个测试创建临时 git 仓库
beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallelc-spawn-'));
  execSync('git init -b main', { cwd: repoRoot });   // ← 显式分支名
  execSync('git config user.email "test@test.com"', { cwd: repoRoot });
  execSync('git config user.name "Test"', { cwd: repoRoot });
  // ... 创建文件并提交
});

afterEach(() => {
  // 清理 worktrees 和临时仓库
  fs.rmSync(repoRoot, { recursive: true, force: true });
});
```

### 6.5 覆盖率目标

| 包 | 目标 |
|----|------|
| @parallelc/shared | 无需测试（纯类型） |
| @parallelc/validate | 100% 分支覆盖 |
| @parallelc/taskboard | ≥ 90% |
| @parallelc/worker | ≥ 85% |

---

## 7. Phase 2/3 扩展指南

### 7.1 预留 API 清单

以下函数已在 Phase 1 实现骨架，Phase 2/3 将完整实现：

| 函数 | 当前状态 | 目标 Phase | 扩展方向 |
|------|---------|-----------|---------|
| `wakeSleepingTasks` | 骨架 | Phase 3 | 集成到 Scheduler dispatch_loop 主循环 |
| `propagateDagFailure` | 骨架 | Phase 3 | 递归传播失败到下游、生成传播报告 |
| `calculateRateLimitBackoff` | 完整 | Phase 3 | 集成到 on_worker_exit 实际流程 |
| `routeExitCode` | 骨架 | Phase 2 | 接入 Scheduler 重试决策 |

### 7.2 Phase 2 新增包

```
packages/
└── scheduler/              # @parallelc/scheduler（Phase 2 新增）
    ├── src/
    │   ├── dispatch.ts     # dispatchLoop — 两层保护机制
    │   ├── worker-pool.ts  # Worker 进程池管理
    │   └── starvation.ts   # 饥饿保护（300s 超时强制派发）
    └── __tests__/
```

### 7.3 Phase 3 新增包

```
packages/
├── coordinator/            # @parallelc/coordinator（Phase 3 新增）
│   └── src/
│       ├── merge.ts        # 自动合并 / 结构化合并 / MERGE_BLOCKED 仲裁
│       └── report.ts       # 仲裁报告生成
│
└── keypool/                # @parallelc/keypool（Phase 3 新增）
    └── src/
        └── rotate.ts       # API Key 池负载轮转 + 健康检查
```

### 7.4 实现新包步骤

```bash
# 1. 创建包骨架
mkdir -p packages/scheduler/src packages/scheduler/__tests__

# 2. 配置 package.json
cat > packages/scheduler/package.json << 'JSON'
{
  "name": "@parallelc/scheduler",
  "version": "0.1.0",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "tsup src/index.ts --format cjs,esm --dts --clean",
    "typecheck": "tsc --noEmit",
    "test": "jest",
    "test:ci": "jest --ci --coverage"
  },
  "dependencies": {
    "@parallelc/shared": "workspace:*",
    "@parallelc/taskboard": "workspace:*",
    "@parallelc/worker": "workspace:*",
    "better-sqlite3": "^11.7.0"
  }
}
JSON

# 3. 复制 tsconfig 和 jest 配置
cp packages/shared/tsconfig.json packages/scheduler/
cp packages/shared/jest.config.ts packages/scheduler/

# 4. 安装
pnpm install
```

---

## 8. 常见问题

### Q: `pnpm install` 报错 "Unsupported engine"

**A:** 检查 Node.js 版本 ≥ 20.0.0：

```bash
node --version
# 如果 < 20，使用 nvm 切换：
nvm install 20
nvm use 20
```

### Q: 测试报错 "Cannot find module '@parallelc/shared'"

**A:** 需要先运行 `pnpm install` 建立 workspace 软链接：

```bash
pnpm install
ls packages/validate/node_modules/@parallelc/shared
# 应该是一个符号链接指向 ../../shared
```

### Q: Jest 报错 "Unexpected token 'export'" 或 ".js extension" 问题

**A:** `jest.config.base.ts` 中 `moduleNameMapper` 负责处理 `.js` 扩展名映射。如果问题持续：

```bash
# 检查 Jest 是否正确读取 ts-jest preset
cd packages/<name> && npx jest --showConfig | grep preset
# 应该显示 "preset": "ts-jest"
```

### Q: spawn 测试报错 "main branch not found"

**A:** spawn 测试使用 `git init -b main` 显式创建 main 分支。如果遇到旧版 git（< 2.28），手动处理：

```bash
# 临时方案
git init
git checkout -b main
```

### Q: 如何只运行某个包的测试？

```bash
# 进入包目录
cd packages/validate && npx jest

# 或从根目录指定
npx jest --config packages/validate/jest.config.ts

# 运行特定测试文件
cd packages/validate && npx jest --testPathPattern="path-traversal"
```

### Q: better-sqlite3 编译失败（Windows）

**A:** 需要安装 Windows 构建工具：

```powershell
# 以管理员身份运行 PowerShell
npm install -g windows-build-tools
# 或
npm install -g node-gyp
```

### Q: 如何重置数据库？

```bash
rm .parallelc/taskboard.db .parallelc/taskboard.db-wal .parallelc/taskboard.db-shm
# 下次调用 getDb() 时自动重建（initializeSchema 会执行 DDL）
```

---

*文档版本：v1.0 | 基于 ParallelC Phase 1 交付版 | 2026-05-23*
