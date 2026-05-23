# Changelog

## v0.4.0 — Phase 3A: 合并协调 + Key Pool + 预测闭环 (2026-05-23)

### 新增
- **@parallelc/coordinator**: 分层合并引擎 (AUTO / STRUCTURED / BLOCKED)、仲裁决策树 (情形 A/B/C)、DAG 传播、MERGE_BLOCKED 仲裁报告生成
- **@parallelc/keypool**: API Key 池轮转、指数退避冷却 (5/10/20/40 min + 抖动)、全局退避暂停
- **预测准确率闭环**: Jaccard 相似度回填、<70% 阈值告警
- Scheduler 集成 Merge Coordinator 和 KeyPool

## v0.3.0 — Phase 3B: Orchestrator 智能任务分解 (2026-05-23)

### 新增
- **@parallelc/orchestrator**: Pre-process (仓库扫描 + 模块边界 + token 预估) → LLM Decompose (Claude MCP 任务分解) → Post-validate (L1/L2/L3 硬约束 + 路径校验 + DAG 环检测)
- L1 直接执行、L3 人工确认机制
- 预测准确率采集骨架 (metrics-collector)
- CLI: `parallelc-orchestrate decompose / confirm / accuracy`

## v0.2.0 — Phase 2: 通信总线与调度左移 (2026-05-23)

### 新增
- **@parallelc/scheduler**: dispatch_loop 三阶段 (派发/回收/唤醒)、两层保护机制 (跨轮 DB 重建 + 本轮 CAS 后更新)、饥饿保护 (300s)、Watchdog 超时
- **MCP 客户端** (worker/mcp-client): Claude 子进程启动、system prompt 构建、Watchdog 机制
- **runWorker** 入口: 环境变量校验 + 快照版本校验
- CLI: `parallelc-scheduler start / status`

## v0.1.0 — Phase 1: 隔离与安全基础验证 (2026-05-23)

### 新增
- **@parallelc/shared**: Task/TaskStatus/WorkerContext 类型、退出码常量、ParallelCError
- **@parallelc/validate**: isWriteAllowed (realpath 路径穿越防御)、validateWriteHook
- **@parallelc/taskboard**: SQLite Schema (partial index)、Map 多例 db 管理、Repository (CAS 乐观锁 CRUD + getLockedFiles)
- **@parallelc/worker**: 双 Worktree 创建/清理、快照版本校验、退出码路由
