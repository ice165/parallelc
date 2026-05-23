# ParallelC

> 对 Claude Code 说一句话，自动拆成多个任务并行执行，结果自动合并——就像有多个 Claude 同时为你工作。

## 它是什么

ParallelC 是 Claude Code 的并行执行引擎。你只需要描述想要完成的功能，它自动将任务拆解、在隔离环境中并行执行、最后把代码安全合并回主分支。

**一个指令，多条流水线，自动协同。**

## 它解决什么问题

使用 Claude Code 时，单个会话一次只能做一件事。遇到"修改登录接口时也要同步改中间件和测试"的场景，你需要在不同文件间反复切换、手动协调，耗时且容易遗漏。

### 对比 Claude Code Team 模式

Claude Code 的 Team 模式允许多个 Agent 协作对话，但它解决的是"沟通协调"，而不是"执行隔离"：

| 维度 | Claude Code Team 模式 | ParallelC |
|------|----------------------|-----------|
| **分工方式** | 多个 Agent 讨论同一个任务，协商后分工 | Orchestrator 分析文件依赖，自动拆解为独立子任务 |
| **执行环境** | 共享工作区，无文件隔离 | 每个 Worker 独立 Git Worktree，写保护防止越权修改 |
| **冲突处理** | 依赖 Agent 自身判断，无硬约束 | 预测性文件锁，提前阻止同文件并发写入 |
| **合并方式** | Agent 自行 git commit，手动 merge | 自动分层合并（AUTO → STRUCTURED → 仲裁报告） |
| **任务大小** | 适合讨论型、设计型任务 | 适合明确的多文件代码修改任务 |
| **失败恢复** | 重新对话，手动重试 | 429 自动退避、Key 池轮转、超时自动重试、崩溃后 DB 重建状态 |

> **简单说**：Team 模式是"几个人开会商量着干"，ParallelC 是"工头分任务，每人独立工位干，干完自动汇总"。两者互补，不互斥。

### ParallelC 的改善

| 场景 | 用 ParallelC 前 | 用 ParallelC 后 |
|------|----------------|----------------|
| 加一个登录功能 | 逐文件串行修改，手动处理依赖 | 自动拆成路由/中间件/测试三个任务，并行执行 |
| 重构 API 层 | 改 A 时不能动 B，怕冲突 | 预测文件锁，无冲突并行，有冲突排队 |
| 多人协作项目 | 手动 git merge，冲突时手足无措 | 自动合并，冲突时生成详细的仲裁报告 |

## 适用场景

### 适合用 ParallelC

| 场景 | 示例 | 为什么适合 |
|------|------|-----------|
| **全栈功能开发** | "给商城加一个优惠券系统" | 涉及路由、Service、Model、前端组件、测试等多个文件，天然可拆 |
| **批量代码迁移** | "把项目中所有 `var` 改成 `const`" | 文件间无依赖，可大规模并行执行 |
| **接口层重构** | "把用户模块的 REST API 改成 GraphQL" | 关联文件有明确的依赖关系，DAG 可以精确建模 |
| **多模块同步升级** | "升级所有 package 的 TypeScript 到 5.7" | 每个 package 独立，但需要统一合并验证 |
| **测试补全** | "给 src/api/ 下所有接口补单元测试" | 每个测试文件独立编写，无冲突风险 |

### 不太适合 ParallelC

| 场景 | 原因 |
|------|------|
| 修一个拼写错误（单文件小改） | L1 直接执行即可，流水线反而浪费 |
| 设计讨论、架构选型 | 需要多轮对话和反复推敲，Team 模式更适合 |
| 改一个文件同时改它的所有调用方 | 文件锁会强制排队，实际退化为串行 |
| 代码审查（只读） | 没有写入操作，不需要 Worktree 隔离 |

> **经验法则**：如果你要做的事涉及 **3 个以上文件** 且有明确的 **"做了 A 才能做 B"** 关系，ParallelC 会显著加速。

## 如何工作

```
你的一句话需求
      │
      ▼
┌──────────────┐
│ Orchestrator │  "实现用户登录" → 拆成 3 个子任务
│  (LLM 大脑)   │   task-1: 创建路由   task-2: 写中间件   task-3: 写测试
└──────┬───────┘
       │ 写入任务到 TaskBoard
       ▼
┌──────────────┐
│  Scheduler   │  检查文件锁 → 无冲突 → 同时派发 task-1 和 task-3
│  (调度管家)   │  task-2 等 task-1 完成后再派发（依赖关系）
└──────┬───────┘
       │ 为每个任务创建隔离 Worktree
       ▼
┌──────────────┐
│   Worker N   │  在隔离的 Git 环境中执行代码修改
│  (执行工人)   │  每个 Worker 只能写自己负责的文件（写保护）
└──────┬───────┘
       │ 执行完成 → 采集修改
       ▼
┌──────────────┐
│  Coordinator │  自动 git merge，冲突时生成仲裁报告
│  (合并大师)   │  回传预测准确率数据供后续优化
└──────────────┘
```

### 核心设计

- **不只是"多开几个 Claude"**：ParallelC 分析任务间的依赖关系和文件交集，决定哪些并行、哪些排队，不是你手动开几个终端
- **预测性文件锁**：在 Worker 启动前就预测它会修改哪些文件，提前阻止冲突
- **安全性分层**：Worker 被限制在隔离的 Git Worktree 中，写保护机制防止越权修改
- **L1/L2/L3 智能分级**：小改动（修拼写）直接执行不排队，大改动（改数据库 Schema）强制人工确认
- **预测准确率反馈**：预期修改 vs 实际修改对比，低于 70% 时自动告警

## 快速开始

### 你需要

- Node.js 20+
- pnpm 9+
- [Claude Code CLI](https://claude.ai/code)
- Anthropic API Key

### 安装

```bash
git clone https://github.com/YOUR_USERNAME/parallelc.git
cd parallelc
pnpm install
cp .env.example .env
```

### 使用（三步走）

```bash
# 第一步：把你的需求拆成任务
npx parallelc-orchestrate decompose "给项目加一个用户登录功能" \
  --repo /path/to/your/project \
  --api-key sk-ant-xxxxxxxxx

# 输出：
# [Orchestrator] 扫描仓库... 47 文件, 5 个模块
# [Orchestrator] 验证通过: 3 L2, 1 L3 待确认
#   task-001  [L2] 创建登录路由 src/api/auth.ts
#   task-002  [L2] 实现 JWT 中间件 src/middleware/auth.ts  ← 依赖 001
#   task-003  [L2] 编写登录测试 __tests__/auth.test.ts      ← 依赖 001,002
#   task-004  [L3] 数据库迁移 migration/001_users.sql        ⚠️ 需人工确认

# 第二步：启动调度执行
npx parallelc-scheduler start --repo /path/to/your/project \
  --api-keys sk-ant-xxx,sk-ant-yyy

# 第三步：查看进度
npx parallelc-scheduler status
# Tick: 12 | Pool: 2/4 | Ready: 0 | Running: 2 | Done: 1 | Failed: 0
```

### 运行测试

```bash
pnpm test    # 全部测试
pnpm typecheck    # 类型检查
```

## 项目状态

**v0.4.0 — Alpha 版本，活跃开发中。**

- 核心链路（分解 → 调度 → 执行 → 合并）已完整可跑
- 目前需要 `claude` CLI 在本地环境中可用
- 欢迎 Issue 和 PR（详见 [CONTRIBUTING.md](CONTRIBUTING.md)）

## 更多文档

| 文档 | 内容 |
|------|------|
| [完整教程](docs/TUTORIAL.md) | 环境配置到所有 API 使用示例 |
| [设计文档](docs/superpowers/specs/) | 各 Phase 的详细技术规范 |
| [变更日志](CHANGELOG.md) | 每个版本的变更明细 |
| [贡献指南](CONTRIBUTING.md) | 开发环境和提交规范 |

## 技术栈

TypeScript · pnpm monorepo · better-sqlite3 · Jest · Git Worktree · Claude MCP · Anthropic SDK

## 许可

MIT License — 详见 [LICENSE](LICENSE)
