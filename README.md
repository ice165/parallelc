# ParallelC

> 对 Claude Code 说一句话，自动拆成多个任务并行执行，结果自动合并——就像有多个 Claude 同时为你工作。

## 它是什么

ParallelC 是 Claude Code 的并行执行引擎。你只需要描述想要完成的功能，它自动将任务拆解、在隔离环境中并行执行、最后把代码安全合并回主分支。

**一个指令，多条流水线，自动协同。**

## 它解决什么问题

使用 Claude Code 时，单个会话一次只能做一件事。遇到"修改登录接口时也要同步改中间件和测试"的场景，你需要在不同文件间反复切换、手动协调，耗时且容易遗漏。

ParallelC 把这一切自动化：

| 场景 | 用 ParallelC 前 | 用 ParallelC 后 |
|------|----------------|----------------|
| 加一个登录功能 | 逐文件串行修改，手动处理依赖 | 自动拆成路由/中间件/测试三个任务，并行执行 |
| 重构 API 层 | 改 A 时不能动 B，怕冲突 | 预测文件锁，无冲突并行，有冲突排队 |
| 多人协作项目 | 手动 git merge，冲突时手足无措 | 自动合并，冲突时生成详细的仲裁报告 |

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
