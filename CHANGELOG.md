# Changelog

## v2.1.0 — CEO 层 + 安全加固 (2026-05-28)

### 新增 — CEO 质量门禁层
- **@parallelc/ceo**: 意图对齐审查包，插在 Worker 和 Coordinator 之间
- **IntentMatcher**: 4 维评分引擎（功能覆盖 35 + 缺失检测 25 + 多余修改 20 + 副作用 20）
- **BatchReviewer**: 批处理审查编排器，遍历 REVIEW_PENDING 任务并调用 CEO 审查
- **IterationTracker**: 审查轮次管理、分层跳过条件、分级模型选择（L2→Sonnet, L3→Opus）
- **CeoAgent**: LLM 审查 + 规则引擎回退 + Mock 模式
- **CLI**: `parallelc-ceo review / status / confirm` 命令

### 新增 — 状态机扩展
- 3 种新状态：REVIEW_PENDING、REVISION_NEEDED、CEO_ESCALATED
- 审查-修改迭代循环（最多 3 轮）
- 自动跳过策略：L1 / F1-β>0.85 / 清晰度>95 / 单文件纯增量

### 安全修复
- **C-1**: 全局 `execFileSync` 替代 `execSync`，消除 shell 命令注入
- **C-2**: `isWriteAllowed` 父目录链 `realpathSync`，修复 TOCTOU 竞态
- **C-3**: `ceoReviewTick` 并发保护标志位
- **C-4**: LLM 响应 `parseFeedback()` 验证
- **H-1**: 提取 `collectModifiedFiles`/`getConflictFiles` 到 `shared/git-utils.ts`
- **H-3**: 移除 keypool 无用依赖
- **M-2**: 导出 `queryTaskById` 消除重复实现

## v2.0.0 — Path B Enhancement: 12 模块全面增强 (2026-05-28)

### 新增 — P0 正确性与安全
- **FilePredictor**: 文件预测三层兜底 (LLM → 静态分析 import graph → git diff → 全量 src)
- **ClarityEngine**: 中文需求清晰度评分 0-100，三分区策略 (BRAINSTORM/DUAL_ENGINE/PASS)
- **GhostDetector**: 幽灵 Worker 恢复，PID 状态检查 (Linux/Windows)，上游依赖感知

### 新增 — P1 健壮性与调度智能
- **RebaseHandler**: git rebase 替代 merge，2 次重试 + 5s/10s 延迟
- **ASTConflictDetector**: 语义冲突检测 (重复定义 + 冲突标记)
- **StallDetector**: 依赖图死锁打断，FAILED/CANCELLED 上游 → 下游自动取消
- **F1BetaTracker**: F0.5-β 滑动窗口，冷启动 20 轮保护 + ×1.5 扩展，连续低分自动降级

### 新增 — P2 运营与可观测性
- **CostTracker**: 三层预算控制 (单次 8192 tokens / 单任务 $3 / 单会话 $20)，Anthropic 2026 定价
- **AuditLogger**: JSONL append-only + SHA256 校验，16 种事件类型，>100MB 自动归档
- **ReproGenerator**: 失败自动生成 .sh 复现脚本 + context.json

### 新增 — P3 安全加固与可观测性
- **HMAC 验证**: 每次 spawn 随机 32B 密钥，SHA-256 HMAC 防任务数据篡改
- **EXIT_TAMPER (14)**: HMAC 验证失败退出码
- **Mock 模式**: `PARALLELC_MOCK_CLAUDE_RESPONSE` 加载预录制响应
- **OpenTelemetry**: 控制台 span 导出器，`PARALLELC_OTEL_ENABLED=1` 开启

### 修复
- FilePredictor: symlink 路径穿越防御 (realpathSync 验证)
- ReproGenerator: shell 命令注入防御 (sanitize + 单引号)
- CostTracker: 预算死锁修复 (各出口调用 resetTask)
- merge-strategy: 命令注入防御 (execFileSync 替代 execSync)
- AuditLogger: crc32 → checksum 字段名修正

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
