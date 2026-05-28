# ParallelC 使用教程

> **版本**：v2.2 · **日期**：2026-05-28
>
> 面向 Claude Code 的多 Agent 并行协同工作系统 — 含 CEO 需求确认 + 质量门禁

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

### 安装 pnpm

```bash
corepack enable          # Node.js 16.9+ 内置
# 或
npm install -g pnpm
```

---

## 2. 项目结构

```
parallelc/
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
├── jest.config.base.ts
│
├── packages/
│   ├── shared/        共享类型、常量、HMAC 工具、Git 工具、OTel 辅助
│   ├── validate/      写保护、路径穿越防御
│   ├── taskboard/     SQLite 任务状态机、CAS 乐观锁、幽灵Worker检测
│   ├── keypool/       API Key 池轮转、健康检查、指数退避
│   ├── worker/        Worker 生命周期、MCP 客户端、HMAC 验证、启动校验
│   ├── orchestrator/  清晰度评估、仓库扫描、DAG 拆解、文件预测、死锁检测
│   │                 成本追踪、复现脚本、规则校验、准确率追踪
│   ├── coordinator/   git rebase + AST 冲突检测、三级合并
│   ├── scheduler/     调度主循环、F1-β 追踪、审计日志、CEO 集成
│   └── ceo/           需求确认+方案生成、意图对齐审查、4维评分
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

### 4.1 需求确认（推荐）

先用 CEO 确认需求，生成结构化方案：

```bash
npx parallelc-ceo intake "在 src/api/auth.ts 中添加 JWT 登录接口"
```

- 清晰度 <70 → 输出澄清问题列表，用户补充后重新运行
- 清晰度 ≥70 → 输出方案（验收标准 + 文件范围 + 风险等级 + 建议级别）

```bash
# 补充澄清信息后重新确认
npx parallelc-ceo intake "添加 JWT 登录接口，修改 src/api/auth.ts，必须保持向后兼容"
```

### 4.2 启动调度器

在一个终端常驻运行：

```bash
npx parallelc-scheduler start \
  --repo /path/to/your-project \
  --api-keys "sk-ant-xxx,sk-ant-yyy" \
  --max-workers 4
```

### 4.3 提交任务

在另一个终端：

```bash
npx parallelc-orchestrate decompose "在 src/api/auth.ts 中添加 JWT 登录接口" \
  --repo /path/to/your-project \
  --api-key sk-ant-xxx
```

### 4.4 确认 L3 任务

```bash
npx parallelc-orchestrate confirm --dag dag-xxx --task task-xxx
```

### 4.5 监控

```bash
npx parallelc-scheduler status
npx parallelc-orchestrate accuracy
npx parallelc-ceo status
npx parallelc-ceo review --repo . --api-key sk-ant-xxx
npx parallelc-ceo confirm --task task-xxx --verdict pass
```

---

## 5. 核心 API 使用指南

### 5.1 @parallelc/ceo — 需求确认（v2.2 新增）

```typescript
import { intakeRequirement, confirmWithClarification } from '@parallelc/ceo';

// 需求确认（清晰度 <70 → CLARIFY，≥70 → READY + 方案）
const result = intakeRequirement('添加用户登录功能');

if (result.phase === 'CLARIFY') {
  for (const q of result.clarifyingQuestions) {
    console.log(`  - ${q}`);
  }
  // 用户补充后重新确认
  const confirmed = confirmWithClarification(
    '添加用户登录功能',
    '修改 src/api/auth.ts，使用 JWT，必须保持向后兼容'
  );
  console.log(confirmed.spec); // Markdown 格式方案
}
```

**清晰度评分阈值：**

| 分数 | 区域 | 行为 |
|------|------|------|
| <70 | BRAINSTORM | CEO 生成澄清问题，用户补充后重新评估 |
| 70-90 | DUAL_ENGINE | 规则引擎 + LLM 双引擎评估 |
| >90 | PASS | 直接生成方案，无需澄清 |

### 5.2 @parallelc/shared — 类型与常量

```typescript
import {
  EXIT_SUCCESS, EXIT_CHECKPOINT, EXIT_TIMEOUT,
  EXIT_HOOK_BLOCKED, EXIT_RATE_LIMIT, EXIT_TAMPER,
  Task, TaskStatus, TaskLevel, ExitAction, traceSpan,
} from '@parallelc/shared';
```

### 5.3 @parallelc/taskboard — 任务数据层

```typescript
import { getDb, initializeSchema } from '@parallelc/taskboard';
import {
  createTask, casUpdateStatus, queryTasksByStatus, queryTaskById,
  getLockedFiles, wakeSleepingTasks, updateTask, propagateDagFailure,
  GhostDetector,
} from '@parallelc/taskboard';

const db = getDb('.parallelc/taskboard.db');
initializeSchema(db);

// 创建任务
createTask(db, { id: 'task-001', title: '实现登录 API',
  expected_touch_files: ['src/api/auth.ts'], snapshot_version: 'dag1' });

// CAS 乐观锁
casUpdateStatus(db, 'task-001', 0, 'PENDING', 'READY');

// 幽灵 Worker 检测
const detector = new GhostDetector(db);
const ghosts = detector.detect(new Set());
```

### 5.4 @parallelc/worker — 执行层

```typescript
import {
  spawnWorker, cleanupWorktrees, spawnMcpWorker,
  routeExitCode, collectModifiedFiles,
  generateHmac, verifyHmac,
} from '@parallelc/worker';
```

### 5.5 @parallelc/orchestrator — 编排层

```typescript
import {
  buildDAG, scanRepoContext, evaluateClarity,
  FilePredictor, detectStalled, CostTracker, generateRepro,
} from '@parallelc/orchestrator';
```

### 5.6 @parallelc/coordinator — 合并层

```typescript
import {
  coordinateMerge, rebaseHandler, detectAstConflicts,
} from '@parallelc/coordinator';

const result = await rebaseHandler.attemptRebase('task-001', '/repo');
```

### 5.7 @parallelc/scheduler — 调度层

```typescript
import {
  startScheduler, WorkerPool, F1BetaTracker, AuditLogger,
} from '@parallelc/scheduler';
```

---

## 6. 退出码协议

| 退出码 | 常量 | 语义 | Scheduler 响应 |
|--------|------|------|---------------|
| 0 | `EXIT_SUCCESS` | 正常完成 | CEO 审查 → Coordinator 合并 |
| 10 | `EXIT_CHECKPOINT` | 上下文轮次上限 | SLEEP_PENDING，到期唤醒 |
| 11 | `EXIT_TIMEOUT` | 进程超时 | SIGTERM → 5s → SIGKILL |
| 12 | `EXIT_HOOK_BLOCKED` | 越权写入拦截 | 标记 FAILED |
| 13 | `EXIT_RATE_LIMIT` | API 429 限流 | KeyPool 退避冷却 |
| **14** | **`EXIT_TAMPER`** | **HMAC 验证失败** | **标记 FAILED** |

---

## 7. 测试编写指南

```typescript
// taskboard 模式
import Database from 'better-sqlite3';
import { initializeSchema } from '../src/db';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); initializeSchema(db); });
afterEach(() => db.close());

// spawn 模式
import { execSync } from 'child_process';
beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallelc-'));
  execSync('git init -b main', { cwd: repoRoot });
});
afterEach(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
```

---

## 8. 常见问题

### Q: `pnpm install` 报错 "Unsupported engine"

检查 Node.js ≥ 20：`node --version`

### Q: better-sqlite3 编译失败（Windows）

```powershell
npm install -g windows-build-tools
```

### Q: 如何重置数据库

```bash
rm .parallelc/taskboard.db .parallelc/taskboard.db-wal .parallelc/taskboard.db-shm
```

### Q: 如何启用 Mock 模式

```bash
export PARALLELC_MOCK_CLAUDE_RESPONSE=/path/to/prerecorded-response.json
export PARALLELC_MOCK_CEO_RESPONSE=1   # CEO 审查使用规则引擎（无需 LLM）
```

### Q: 如何启用 OpenTelemetry 追踪

```bash
export PARALLELC_OTEL_ENABLED=1
```

### Q: CEO 需求确认如何使用（v2.2 新增）

```bash
# 1. 先确认需求
npx parallelc-ceo intake "你的需求描述"

# 2. 如果清晰度不足，补充信息后重新运行
npx parallelc-ceo intake "原始需求 + 补充说明"

# 3. 确认方案后交给 Orchestrator
npx parallelc-orchestrate decompose "确认后的需求" --repo . --api-key sk-ant-xxx
```

---

*文档版本：v2.2 | 基于 ParallelC CEO Layer | 2026-05-28*
