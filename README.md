# ParallelC

**Claude Code 多 Agent 并行协同工作系统**

> 用传统工程确定性（数据库锁、DAG、文件隔离）框定 LLM 的非确定性，让复杂开发任务自动分解并在隔离环境中高效并行处理。

## 架构

```
用户需求 → Orchestrator(LLM分解) → TaskBoard(SQLite) → Scheduler(派发) → Worker(MCP隔离) → Merge(合并)
                                                                     ↑
                                                                KeyPool(API轮转)
```

## 项目结构

```
packages/
├── shared/          @parallelc/shared        类型、常量、错误基类
├── validate/        @parallelc/validate      写保护 + 路径穿越防御
├── taskboard/       @parallelc/taskboard     SQLite Schema + CAS 乐观锁 CRUD
├── worker/          @parallelc/worker        MCP 通信 + 双 Worktree 管理
├── scheduler/       @parallelc/scheduler     dispatch_loop 三阶段调度
├── keypool/         @parallelc/keypool       API Key 轮转 + 指数退避冷却
├── coordinator/     @parallelc/coordinator   分层合并 + 仲裁 + 准确率反馈
└── orchestrator/    @parallelc/orchestrator  LLM 任务分解 + L1/L2/L3 分级
```

## 快速开始

### 环境要求

- Node.js >= 20.0.0
- pnpm >= 9.0.0
- Git >= 2.38.0
- [Claude Code CLI](https://claude.ai/code) (用于 Worker 执行)

### 安装

```bash
git clone https://github.com/YOUR_USERNAME/parallelc.git
cd parallelc

pnpm install
cp .env.example .env
# 编辑 .env，填入 Anthropic API Keys
```

### 使用

```bash
# 1. 分解需求为 Task DAG
npx parallelc-orchestrate decompose "实现用户登录功能" --repo . --api-key sk-xxx

# 2. 启动 Scheduler 自动派发和执行
npx parallelc-scheduler start --repo . --api-keys sk-xxx,sk-yyy

# 3. 查看调度状态
npx parallelc-scheduler status

# 4. 查看预测准确率
npx parallelc-orchestrate accuracy

# 5. 运行测试
pnpm test
```

### 完整教程

详见 [docs/TUTORIAL.md](docs/TUTORIAL.md)

## 版本

| Tag | Phase | 内容 |
|-----|-------|------|
| v0.1.0 | Phase 1 | 类型/写保护/数据层/双 Worktree |
| v0.2.0 | Phase 2 | MCP Worker/Scheduler dispatch_loop/WorkerPool |
| v0.3.0 | Phase 3B | Orchestrator LLM 任务分解/L1-L3 分级 |
| v0.4.0 | Phase 3A | Merge Coordinator/KeyPool/预测准确率闭环 |

## 技术栈

TypeScript (strict) · pnpm monorepo · better-sqlite3 · Jest · Git Worktree · Claude MCP

## 许可

MIT License — 详见 [LICENSE](LICENSE)
