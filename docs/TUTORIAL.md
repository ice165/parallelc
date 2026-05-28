# ParallelC 使用教程

> **版本**：v2.0 · **日期**：2026-05-28
>
> 面向 Claude Code 的多 Agent 并行协同工作系统 — 完整流水线

---

## 目录

1. [环境要求](#1-环境要求)
2. [项目结构](#2-项目结构)
3. [安装与配置](#3-安装与配置)
4. [快速上手](#4-快速上手)
5. [核心 API 使用指南](#5-核心-api-使用指南)
6. [退出码协议](#6-退出码协议)
7. [测试编写指南](#7-测试编写指南)
8. [常见问题](#8-常见问题)

---

## 1. 环境要求

| 工具 | 最低版本 | 验证命令 |
|------|---------|---------|
| Node.js | ≥ 20.0.0 | `node --version` |
| pnpm | ≥ 9.0.0 | `pnpm --version` |
| Git | ≥ 2.38.0 | `git --version` |
| Claude Code CLI | 最新版 | `claude --version` |

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
├── tsconfig.base.json        # 全局 TypeScript 配置
├── jest.config.base.ts       # 全局 Jest 配置
│
├── packages/
│   ├── shared/               # @parallelc/shared — 基础层
│   │   └── src/
│   │       ├── types.ts      #   核心类型（Task, WorkerContext, ExitAction 等）
│   │       ├── constants.ts  #   退出码常量 (0/10/11/12/13/14)
│   │       ├── errors.ts     #   ParallelCError 基类
│   │       └── telemetry.ts  #   OpenTelemetry span 辅助
│   │
│   ├── validate/             # @parallelc/validate — 安全层
│   │   └── src/
│   │       ├── validate-write.ts  # isWriteAllowed() — 路径穿越防御
│   │       └── hook.ts            # validateWriteHook() — Write/Edit 拦截
│   │
│   ├── taskboard/            # @parallelc/taskboard — 数据层
│   │   └── src/
│   │       ├── schema.ts          # DDL + 状态转换白名单
│   │       ├── db.ts              # Map 多例 + WAL + 迁移
│   │       ├── repository.ts      # CRUD + CAS 乐观锁 + DAG 传播
│   │       └── ghost-detector.ts  # 幽灵 Worker 检测（PID/心跳/平台适配）
│   │
│   ├── keypool/              # @parallelc/keypool — Key 管理
│   │   └── src/
│   │       ├── key-pool.ts        # ACTIVE→COOLDOWN→DEAD 三态轮转
│   │       ├── health-check.ts    # API 健康检查探针
│   │       └── rate-limit.ts      # 全局退避控制
│   │
│   ├── worker/               # @parallelc/worker — 执行层
│   │   └── src/
│   │       ├── startup.ts         # 快照版本校验
│   │       ├── lifecycle.ts       # 退出码路由 + 文件采集
│   │       ├── spawn.ts           # 双 Worktree 创建/清理
│   │       ├── mcp-client.ts      # MCP 子进程启动 + Mock 模式
│   │       ├── run-worker.ts      # Worker 入口（含 HMAC 验证）
│   │       └── hmac-verify.ts     # HMAC-SHA256 生成/验证
│   │
│   ├── orchestrator/         # @parallelc/orchestrator — 编排层
│   │   └── src/
│   │       ├── dag-builder.ts          # DAG 构建完整入口
│   │       ├── metrics-collector.ts    # 预测准确率采集
│   │       ├── cost-tracker.ts         # 三层成本预算控制
│   │       ├── repro-generator.ts      # 失败复现脚本生成
│   │       ├── cli.ts                  # CLI 命令入口
│   │       ├── pre-process/            # 仓库扫描 + 模块映射 + token 估算
│   │       ├── decompose/              # LLM 分解 + 清晰度评估 + 响应解析
│   │       ├── post-validate/          # 规则引擎 + 路径/DAG 校验 + 死锁检测
│   │       └── predictor/              # 文件预测三层兜底
│   │
│   ├── coordinator/          # @parallelc/coordinator — 合并层
│   │   └── src/
│   │       ├── merge-strategy.ts       # AUTO/STRUCTURED/BLOCKED 三级合并
│   │       ├── merge-coordinator.ts    # 合并协调 + DAG 级联传播
│   │       ├── arbitrate.ts            # 仲裁决策树
│   │       ├── accuracy-bridge.ts      # Jaccard 预测准确率回填
│   │       ├── report-generator.ts     # MERGE_BLOCKED 仲裁报告
│   │       ├── rebase-handler.ts       # git rebase + 2次重试+延迟
│   │       └── ast-conflict-detector.ts # AST 语义冲突检测
│   │
│   └── scheduler/            # @parallelc/scheduler — 调度层（整合者）
│       └── src/
│           ├── dispatch-loop.ts     # 主调度循环（派发/回收/唤醒）
│           ├── worker-pool.ts       # Worker 进程池 + HMAC 密钥生成
│           ├── context-generator.ts # project_context.md 快照生成
│           ├── f1-beta-tracker.ts   # F1-β 滑动窗口评估
│           ├── audit-logger.ts      # JSONL 审计日志
│           └── cli.ts               # CLI 命令入口
```

### 包依赖关系

```
@parallelc/shared  ← 零外部依赖
    ↑
    ├── @parallelc/validate
    ├── @parallelc/taskboard  ← +better-sqlite3
    ├── @parallelc/worker
    ├── @parallelc/keypool
    │
    ├── @parallelc/orchestrator  ← +shared + taskboard + worker
    ├── @parallelc/coordinator   ← +shared + taskboard
    │
    └── @parallelc/scheduler  ← +shared + taskboard + worker
                                + coordinator + orchestrator + keypool
```

---

## 3. 安装与配置

### 3.1 克隆项目

```bash
git clone https://github.com/ice165/parallelc.git
cd parallelc
```

### 3.2 安装依赖

```bash
pnpm install
```

### 3.3 构建

```bash
pnpm build
```

### 3.4 验证安装

```bash
pnpm typecheck   # 所有包类型检查
pnpm test        # 运行全部测试
```

---

## 4. 快速上手

### 4.1 启动调度器

在一个终端常驻运行：

```bash
npx parallelc-scheduler start \
  --repo /path/to/your-project \
  --api-keys "sk-ant-xxx,sk-ant-yyy" \
  --max-workers 4
```

调度器启动时会自动执行幽灵 Worker 恢复，然后进入 2 秒间隔的派发/回收/唤醒循环。

### 4.2 提交任务

在另一个终端：

```bash
npx parallelc-orchestrate decompose "在 src/api/auth.ts 中添加 JWT 登录接口" \
  --repo /path/to/your-project \
  --api-key sk-ant-xxx
```

Orchestrator 会：
1. 评估需求清晰度（<50 分建议细化但不阻断）
2. 扫描仓库上下文
3. 调用 Claude Opus 拆解为 DAG 任务
4. 文件预测三层兜底（LLM → 静态分析 → git diff）
5. 规则校验后写入 TaskBoard

### 4.3 确认 L3 任务

高风险任务（涉及 DB schema / 跨仓库 / >10 文件）需要手动确认：

```bash
npx parallelc-orchestrate confirm --dag dag-xxx --task task-xxx
```

### 4.4 监控

```bash
# 查看调度面板（任务状态、等待时间）
npx parallelc-scheduler status

# 查看预测准确率
npx parallelc-orchestrate accuracy
```

---

## 5. 核心 API 使用指南

### 5.1 @parallelc/shared — 类型与常量

```typescript
import {
  // 退出码
  EXIT_SUCCESS,        // 0  — 正常完成
  EXIT_CHECKPOINT,     // 10 — 上下文轮次上限
  EXIT_TIMEOUT,        // 11 — 进程超时
  EXIT_HOOK_BLOCKED,   // 12 — 跨区写入被拦截
  EXIT_RATE_LIMIT,     // 13 — API 429 限流
  EXIT_TAMPER,         // 14 — HMAC 验证失败（v2.0 新增）

  // 核心类型
  type Task,            // 任务实体
  type TaskStatus,      // 9 种状态联合类型
  type TaskLevel,       // 'L1' | 'L2' | 'L3'
  type ExitAction,      // 退出码路由结果联合类型

  // OTel 辅助
  traceSpan,            // 条件性 span 记录
} from '@parallelc/shared';
```

### 5.2 @parallelc/taskboard — 任务数据层

```typescript
import { getDb, initializeSchema } from '@parallelc/taskboard';
import {
  createTask, casUpdateStatus, queryTasksByStatus,
  getLockedFiles, wakeSleepingTasks, updateTask,
  propagateDagFailure, detectGhosts, GhostDetector,
} from '@parallelc/taskboard';

const db = getDb('.parallelc/taskboard.db');
initializeSchema(db);

// 创建任务
const task = createTask(db, {
  id: 'task-001',
  title: '实现用户登录 API',
  level: 'L2',
  expected_touch_files: ['src/api/auth.ts'],
  snapshot_version: 'dag1',
});

// CAS 乐观锁状态更新
casUpdateStatus(db, 'task-001', 0, 'PENDING', 'READY');

// 文件锁集合
const locked = getLockedFiles(db); // Set<string>

// 幽灵 Worker 检测（v2.0 新增）
const detector = new GhostDetector(db);
const ghosts = detector.detect(new Set()); // GhostTask[]
```

### 5.3 @parallelc/worker — 执行层

```typescript
import {
  spawnWorker, cleanupWorktrees, spawnMcpWorker,
  routeExitCode, collectModifiedFiles,
  generateHmac, verifyHmac,  // v2.0 新增
} from '@parallelc/worker';

// HMAC 生成与验证（v2.0 新增）
import crypto from 'crypto';
const secret = crypto.randomBytes(32);
const taskData = JSON.stringify({ taskId: 'task-001' });
const hmac = generateHmac(secret, taskData);
const valid = verifyHmac(secret, taskData, hmac); // true/false

// Worker 退出码路由
const action = routeExitCode({
  taskId: 'task-001',
  exitCode: 0,
  writeRoot: '/repo/worktrees/w1-write',
  rateLimitCount: 0,
});
// → { type: 'MARK_DONE', modifiedFiles: [...] }
```

### 5.4 @parallelc/orchestrator — 编排层

```typescript
import {
  buildDAG, scanRepoContext, extractModuleMap,
  evaluateClarity,       // v2.0 新增：清晰度评估
  FilePredictor,         // v2.0 新增：文件预测
  detectStalled,         // v2.0 新增：死锁检测
  CostTracker,           // v2.0 新增：成本追踪
  generateRepro,         // v2.0 新增：复现脚本
  recordPrediction, updatePredictionRecord,
} from '@parallelc/orchestrator';

// 清晰度评估（v2.0 新增）
const clarity = evaluateClarity('在 src/api/auth.ts 中添加登录接口');
// → { score: 95, zone: 'PASS', verbScore: 30, ... }

// 文件预测（v2.0 新增）
const predictor = new FilePredictor();
const result = predictor.predict(['src/api/auth.ts'], 'Add login', '/repo');
// → { files: [...], source: 'LLM', confidence: 0.8 }

// 成本追踪（v2.0 新增）
const tracker = new CostTracker({ maxCostPerTask: 3.0, maxCostPerSession: 20.0 });
tracker.recordUsage({ model: 'sonnet', inputTokens: 1000, outputTokens: 500 });
```

### 5.5 @parallelc/coordinator — 合并层

```typescript
import {
  coordinateMerge, mergeTask,
  rebaseHandler,            // v2.0 新增
  detectAstConflicts,       // v2.0 新增
} from '@parallelc/coordinator';

// Rebase 合并（v2.0 新增）
const result = await rebaseHandler.attemptRebase('task-001', '/repo');
// → { status: 'REBASE_SUCCESS' | 'REBASE_BLOCKED', modifiedFiles, retriesUsed }
```

### 5.6 @parallelc/scheduler — 调度层

```typescript
import {
  startScheduler, WorkerPool,
  F1BetaTracker,     // v2.0 新增
  AuditLogger,       // v2.0 新增
} from '@parallelc/scheduler';

// F1-β 追踪（v2.0 新增）
const tracker = new F1BetaTracker(10);
tracker.record({ expected: ['a.ts'], actual: ['a.ts'] });
tracker.isColdStart();  // true if history < 20

// 审计日志（v2.0 新增）
const logger = new AuditLogger('.parallelc/audit.log');
logger.log('TASK_STARTED', { taskId: 'task-001' });
```

---

## 6. 退出码协议

| 退出码 | 常量 | 语义 | Scheduler 响应 |
|--------|------|------|---------------|
| 0 | `EXIT_SUCCESS` | 正常完成 | 触发 Coordinator 合并 |
| 10 | `EXIT_CHECKPOINT` | 上下文轮次上限 | SLEEP_PENDING，到期唤醒 |
| 11 | `EXIT_TIMEOUT` | 进程超时 | SIGTERM → 5s → SIGKILL |
| 12 | `EXIT_HOOK_BLOCKED` | 越权写入拦截 | 标记 FAILED |
| 13 | `EXIT_RATE_LIMIT` | API 429 限流 | KeyPool 退避冷却 |
| **14** | **`EXIT_TAMPER`** | **HMAC 验证失败** | **标记 FAILED（v2.0 新增）** |

---

## 7. 测试编写指南

### 7.1 测试约定

```
packages/<name>/__tests__/<module>.test.ts
```

### 7.2 taskboard 包测试模式

```typescript
import Database from 'better-sqlite3';
import { initializeSchema } from '../src/db';
import { createTask, casUpdateStatus } from '../src/repository';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
});

afterEach(() => db.close());

test('CAS 版本冲突', () => {
  createTask(db, { id: 't1', title: 'Test' });
  expect(casUpdateStatus(db, 't1', 999, 'PENDING', 'READY')).toBe(false);
});
```

### 7.3 spawn 测试模式

```typescript
beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallelc-'));
  execSync('git init -b main', { cwd: repoRoot });
  execSync('git config user.email "test@test.com"', { cwd: repoRoot });
  execSync('git config user.name "Test"', { cwd: repoRoot });
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});
```

---

## 8. 常见问题

### Q: `pnpm install` 报错 "Unsupported engine"

检查 Node.js ≥ 20：`node --version`

### Q: 测试报错 "Cannot find module '@parallelc/shared'"

先运行 `pnpm install` 建立 workspace 软链接。

### Q: better-sqlite3 编译失败（Windows）

```powershell
npm install -g windows-build-tools
```

### Q: 如何重置数据库

```bash
rm .parallelc/taskboard.db .parallelc/taskboard.db-wal .parallelc/taskboard.db-shm
```

### Q: 如何启用 Mock 模式调试（v2.0 新增）

```bash
export PARALLELC_MOCK_CLAUDE_RESPONSE=/path/to/prerecorded-response.json
```

### Q: 如何启用 OpenTelemetry 追踪（v2.0 新增）

```bash
export PARALLELC_OTEL_ENABLED=1
```

---

*文档版本：v2.0 | 基于 ParallelC Path B Enhancement | 2026-05-28*
