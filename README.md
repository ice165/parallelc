# ParallelC

> 对 Claude Code 说一句话，自动拆成多个任务并行执行，结果自动合并——就像有多个 Claude 同时为你工作。

## 它是什么

ParallelC 是 Claude Code 的并行执行引擎。你只需要描述想要完成的功能，它自动将任务拆解、在隔离环境中并行执行、最后把代码安全合并回主分支。

**一个指令，多条流水线，自动协同。**

## 核心架构

```
你的一句话需求
      │
      ▼
┌──────────────┐
│ Orchestrator │  分析仓库结构 → DAG 拆解 → 预测文件锁 → 写入 TaskBoard
│  (LLM 大脑)   │  L1 简单任务直接执行 / L2 进入流水线 / L3 人工确认
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Scheduler   │  跨轮 DB 重建锁 + 本轮 CAS 后更新锁（两层保护）
│  (调度管家)   │  饥饿保护（300s 强制派发）→ 429 退避抖动 → Key 池轮转
└──────┬───────┘
       │ 双 Worktree 隔离
       ▼
┌──────────────┐
│   Worker N   │  只读区（全量代码）+ 稀疏写区（仅预测目录）
│  (执行工人)   │  snapshot_version 校验 → 越权写拦截（退出码 12）
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Coordinator │  AUTO → STRUCTURED → MERGE_BLOCKED 三级合并
│  (合并大师)   │  starvation_override 双冲突 → 人工仲裁报告
└──────────────┘
```

## v1.5 核心特性

- **预测性文件锁**：Orchestrator 预测每个任务的 `expected_touch_files`，Scheduler 在派发前检查冲突
- **两层锁保护**：跨轮从 DB 重建 + 本轮 CAS 成功后立即更新内存锁，消除同轮竞态
- **饥饿保护**：等待超 300s 的任务强制派发（`starvation_override`），由 Merge Coordinator 仲裁
- **429 防共振**：指数退避序列 [1,2,4,8,16] 分钟，每次 ±30s 随机抖动
- **双 Worktree 隔离**：只读完整区（全量上下文）+ 稀疏写区（仅预测目录，体积缩小 >80%）
- **路径穿越防御**：`realpath` 规范化 + `-readonly` 路径前缀拦截
- **L1/L2/L3 智能分级**：单文件小改直接执行，跨模块进入流水线，Schema 变更强制人工确认
- **Jaccard 预测准确率**：预期 vs 实际修改文件对比，低于 70% 告警
- **DAG 失败传播**：上游 FAILED → 下游自动 CANCELLED
- **崩溃恢复**：DB 为唯一信源，locked_files 每轮重建，无幽灵锁

## 对比 Claude Code Team 模式

| 维度 | Claude Code Team 模式 | ParallelC |
|------|----------------------|-----------|
| **分工方式** | 多个 Agent 讨论同一个任务，协商后分工 | Orchestrator 分析文件依赖，自动拆解为独立子任务 |
| **执行环境** | 共享工作区，无文件隔离 | 每个 Worker 独立 Git Worktree，写保护防止越权修改 |
| **冲突处理** | 依赖 Agent 自身判断，无硬约束 | 预测性文件锁，提前阻止同文件并发写入 |
| **合并方式** | Agent 自行 git commit，手动 merge | 自动分层合并（AUTO → STRUCTURED → 仲裁报告） |
| **失败恢复** | 重新对话，手动重试 | 429 自动退避、Key 池轮转、超时自动重试、崩溃后 DB 重建状态 |

> **简单说**：Team 模式是"几个人开会商量着干"，ParallelC 是"工头分任务，每人独立工位干，干完自动汇总"。两者互补，不互斥。

## 快速开始

### 你需要

- **Node.js ≥ 20**（项目 `.node/` 目录已自带 Node.js v22，解压即用）
- **pnpm ≥ 9**（Node.js 自带 `corepack enable pnpm`）
- **Git**（项目必须是一个 git 仓库）
- **[Claude Code CLI](https://claude.ai/code)**（Worker 通过 `claude` 命令执行任务）
- **Anthropic API Key(s)**（单 Key 或多 Key 逗号分隔）

### 安装

```bash
git clone https://github.com/ice165/parallelc.git
cd parallelc

# 如果系统没有 Node.js，解压自带的
# Windows: 解压 .node/node22.zip 到 .node/
# macOS/Linux: 下载 Node.js 或使用 nvm

# 启用 pnpm
corepack enable pnpm

# 安装依赖
pnpm install

# 构建
pnpm build
```

### 使用（三步走）

**第 1 步 — 启动 Scheduler（调度管家）**

在一个终端常驻运行，负责派发任务、监控状态：

```bash
npx parallelc-scheduler start \
  --repo /path/to/your-project \
  --api-keys "sk-ant-xxx,sk-ant-yyy" \
  --max-workers 4
```

**第 2 步 — 拆解任务（编排大脑）**

在另一个终端，把你的一句话需求提交给编排器：

```bash
npx parallelc-orchestrate decompose "给商城加一个优惠券系统" \
  --repo /path/to/your-project \
  --api-key sk-ant-xxx
```

Orchestrator 会扫描仓库、调用 Claude 拆解为 DAG 子任务、写入 TaskBoard。L3 级别任务（数据库变更等高风险操作）需要手动确认。

**第 3 步 — 确认 L3 任务（如有）**

```bash
npx parallelc-orchestrate confirm --dag dag-xxx --task task-xxx
```

### 监控

```bash
# 查看调度面板（任务状态、等待时间、失败记录）
npx parallelc-scheduler status

# 查看预测准确率
npx parallelc-orchestrate accuracy
```

## 开发

### 运行测试

```bash
pnpm build     # 构建全部 8 个包
pnpm test      # 运行全部 137 个测试
pnpm typecheck # 类型检查
```

### 项目结构

```
packages/
├── shared/        共享类型、常量、错误类
├── validate/      写保护、路径穿越防御
├── taskboard/     SQLite 任务状态机、CAS 乐观锁
├── keypool/       API Key 池轮转、健康检查
├── worker/        Worker 生命周期、MCP 客户端、启动校验
├── orchestrator/  仓库扫描、DAG 拆解、规则校验、准确率追踪
├── coordinator/   三级合并策略、仲裁决策树、报告生成
└── scheduler/     调度主循环、派发/收割/唤醒、上下文快照
```

### 任务状态机

```
PENDING → READY → RUNNING → DONE
                   ↓ 429
              SLEEP_PENDING → (到期) → READY
                   ↓ 超限
                FAILED → 下游 CANCELLED
                   ↓ 冲突
              MERGE_BLOCKED → 人工仲裁
```

## 技术栈

TypeScript · pnpm monorepo · better-sqlite3 · Jest · Git Worktree · Claude MCP · tsup

## 许可

MIT License — 详见 [LICENSE](LICENSE)
