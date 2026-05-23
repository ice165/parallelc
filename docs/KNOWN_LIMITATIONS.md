# ParallelC 已知局限

本文档遵循 v1.5 项目计划书要求，显式声明系统在当前版本（v0.4.0）中的已知局限边界。开发者应了解这些局限，避免依赖隐性假设。

---

## 1. 双 Worktree 运行期上下文过期

**状态**：`v0.1.0` 起存在，计划在 Phase 4 修复

**现象**：Worker 的只读 Worktree 在创建时固定检出，不跟随主仓库 `main` 的推进自动更新。当并发执行的其他 Worker 完成合入后，当前 Worker 读到的只读区代码可能已过时。

**影响**：长生命周期 Worker 可能基于陈旧上下文做决策。

**兜底机制**：最终代码集成由 Merge Coordinator 统一处理，运行期上下文偏差导致的冲突在合并阶段被兜底。

**应对策略（面向长生命周期任务）**：
```bash
git -C $WORKER_READONLY_ROOT fetch origin main
git -C $WORKER_READONLY_ROOT checkout origin/main -- <关心的文件>
```

**计划修复**：Phase 4 引入 Git 智能暂存区追踪，Orchestrator 实时推送 main 的增量变更摘要给运行中的 Worker。

---

## 2. Worker 合并依赖 Worktree 存在

**状态**：`v0.3.0` 起存在

**现象**：Merge Coordinator 的 `mergeTask` 需要访问 Worker 的 write Worktree 来执行合并。如果 Worktree 在合并前被提前清理，合并会失败。

**当前保障**：`reapTick` 已将 `cleanupWorktrees` 延迟到 `coordinateMerge` 的 `.then()` 回调中执行，确保 Worktree 在合并期间存活。合并失败后的 `.catch()` 也执行清理。

**风险场景**：Scheduler 进程崩溃重启后，DB 中状态为 DONE 但尚未合并的任务，其 Worktree 可能已被手动清理。

---

## 3. L1 直接执行无安全回滚

**状态**：`v0.3.0` 起存在

**现象**：L1 任务通过 `executeL1Directly` 在 Main 仓库直接操作修改文件，不走 Worktree 隔离和 Scheduler 流水线。如果 L1 执行产生错误修改，没有自动回滚机制。

**当前保障**：L1 仅适用于极简单任务（单文件、同目录、无新建），且执行前检查文件锁。风险窗口较小。

---

## 4. 预测准确率依赖 Phase 3B 采集

**状态**：`v0.4.0` 起存在

**现象**：预测准确率监控依赖 Orchestrator 的 `metrics-collector` 在任务创建时调用 `recordPrediction`。如果 Orchestrator 未被使用（任务由其他方式写入 TaskBoard），则无预测数据可回填，准确率始终为 N/A。

---

## 5. 单机架构限制

**状态**：全部版本

**现象**：Scheduler 为单实例进程，Worker 和数据库本地部署。不支持跨机器分布式并行。

**适用场景**：单仓库、单机 Claude Code 使用。多机器场景需要引入分布式 DB 和调度器集群。

---

## 6. SQLite 并发限制

**状态**：全部版本

**现象**：SQLite 的 WAL 模式支持 1 写多读并发，但当大量 Worker 同时写入 TaskBoard（collectModifiedFiles）时仍可能出现 SQLITE_BUSY。

**当前保障**：Scheduler 单线程写入、Worker 独立工作不并发写 DB。实际触发概率极低。

---

## 7. 路径穿越检测仅限字符串匹配

**状态**：`v0.1.0` 起存在

**现象**：`validateWriteHook` 通过 `realpath` 解析和 `-readonly` 子串检测来防御路径穿越。`-readonly` 子串匹配是额外防线，理论上极端情况可能出现误判（正常文件名含 `-readonly` 会被拦截）。

**当前保障**：`realpath` 解析已覆盖绝大多数路径穿越攻击。`-readonly` 子串匹配作为兜底，牺牲少量可用性换取安全性。

---

## 8. 未实现的 Phase 4 能力

| 能力 | 影响 |
|------|------|
| 生产压测（20 Worker 并发） | 当前未验证高并发下调度饥饿率和 MERGE_BLOCKED 率 |
| Prometheus 监控接入 | 无运维数据暴露，问题感知靠日志 |
| 准确率 < 70% 自动降级串行 | 当前仅输出 WARNING，不自动暂停并行 |
| Orchestrator Prompt 迭代优化 | 预测准确率依赖初始 Prompt 设计，未经大规模验证调优 |

---

*文档版本：v1.0 | 基于 ParallelC v0.4.0 | 2026-05-23*
