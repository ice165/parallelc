# ParallelC Phase 3A — 合并协调 + Key Pool + 预测闭环 设计文档

**项目代号**：ParallelC
**文档版本**：v1.1
**日期**：2026-05-23
**基于**：Phase 3B 交付版 + claude code并行Agentv1.5.docx
**审查版本**：v1.1（2026-05-23 代码审查修订）

---

## 1. 概述

Phase 3A 是端到端链路的最后一环——负责 Worker 产出代码的**安全合并**、**API Key 健康管理**和**预测准确率反馈闭环**。

---

## 2. 架构

```
Worker DONE
  │
  ├─ Scheduler reapTick 中 MARK_DONE 之后
  │     │
  │     ├─ KeyPool.markSuccess(apiKey)
  │     │
  │     └─ coordinateMerge(taskId)
  │           │
  │           ├─ 1. mergeTask(taskId) — 分层合并
  │           │     ├─ AUTO:       git merge（无冲突）
  │           │     ├─ STRUCTURED: 文件级 diff3（同文件不同区域）
  │           │     └─ arbitrateMerge() — 决策树
  │           │           ├─ 情形A: 双 starvation + 同区域 → BLOCKED
  │           │           ├─ 情形B: 单 starvation + 冲突 → 尝试 STRUCTURED
  │           │           └─ 情形C: 无 starvation / 不同区域 → STRUCTURED
  │           │
  │           ├─ 2. DAG 传播
  │           │     检查直接下游任务的所有上游依赖是否全部 DONE
  │           │     → 全部就绪: 触发下游 coordinateMerge()
  │           │
  │           └─ 3. accuracy-bridge
  │                 updatePredictionRecord(db, taskId, modifiedFiles)
  │                 → Jaccard 准确率: |E ∩ A| / |E ∪ A|
  │                 → 全局 < 70%: 输出 WARNING（Phase 4 触发降级串行）
  │
  ├─ Key Pool（并行）
  │     ├─ nextKey()          ← 跳过 COOLDOWN/DEAD
  │     ├─ markRateLimited()  ← 连续3次429 → 冷却 5/10/20/40min + ±30s 抖动
  │     └─ handleGlobalBackoff() ← 全部冷却 → 暂停 dispatchTick
  │
  └─ 准确率闭环
        Orchestrator recordPrediction → Worker 执行 → Merge 回填 → 监控
```

**技术选型**：

| 项目 | 选择 |
|------|------|
| 合并策略 | 三层：AUTO（git merge）→ STRUCTURED（文件级 diff3）→ BLOCKED（仲裁） |
| Key 冷却 | 指数退避 + 抖动：[5, 10, 20, 40]min ± 30s |
| 准确率 | Jaccard 相似度，全局监控 @ < 70% 告警 |
| 新增依赖 | @anthropic-ai/sdk（仅 keypool/health-check） |
| 依赖解耦 | coordinator 仅依赖 taskboard，不依赖 orchestrator |

---

## 3. 包结构

```
packages/
├── coordinator/              # [新包] @parallelc/coordinator
│   └── src/
│       ├── index.ts
│       ├── merge-strategy.ts     # mergeTask — AUTO/STRUCTURED/BLOCKED 三层
│       ├── arbitrate.ts          # arbitrateMerge — 仲裁决策树（情形A/B/C）
│       ├── merge-coordinator.ts  # coordinateMerge — 入口 + DAG 传播
│       ├── report-generator.ts   # generateBlockedReport + 文件写入
│       └── accuracy-bridge.ts    # bridgeAccuracy — Jaccard + 阈值监控
│
├── keypool/                  # [新包] @parallelc/keypool
│   └── src/
│       ├── index.ts
│       ├── key-pool.ts           # KeyPool 类 + 指数退避冷却
│       ├── health-check.ts       # probeKey — 轻量被动监控
│       └── rate-limit.ts         # handleGlobalBackoff
│
├── scheduler/                # [修改] 最小化改动
│   └── src/
│       ├── dispatch-loop.ts      # reapTick 集成 coordinateMerge
│       └── worker-pool.ts        # spawn 集成 KeyPool.nextKey()
│
└── orchestrator/             # 不变
```

**依赖**：
```
@parallelc/coordinator
  ├── @parallelc/shared
  └── @parallelc/taskboard       # 不依赖 orchestrator

@parallelc/keypool
  ├── @parallelc/shared
  └── @anthropic-ai/sdk

@parallelc/scheduler
  ├── @parallelc/coordinator     # 新增
  └── @parallelc/keypool         # 新增
```

---

## 4. 模块 API

### 4.1 @parallelc/coordinator — merge-strategy.ts

```typescript
export interface MergeResult {
  success: boolean;
  strategy: 'AUTO' | 'STRUCTURED' | 'BLOCKED';
  mergedFiles: string[];
  conflicts: ConflictDetail[];
  reportPath: string | null;       // BLOCKED 时有值
}

export interface ConflictDetail {
  file: string;
  lines: string;                    // "L45-L67"
  taskA: { taskId: string; starvationOverride: boolean; diff: string };
  taskB: { taskId: string; starvationOverride: boolean; diff: string };
}

/**
 * 三层合并流水线：
 *
 *   Phase 1 — AUTO（git merge）
 *     git merge <worker-branch> --no-edit
 *     无冲突 → 成功，返回 AUTO
 *
 *   Phase 2 — STRUCTURED（文件级 diff3）
 *     git merge 有冲突 → 对每个冲突文件做 diff3 分析
 *     判断冲突行是否由不同 Worker 写入的不同代码区域
 *     可安全拼接 → STRUCTURED
 *
 *   Phase 3 — 仲裁决策
 *     STRUCTURED 也失败 → 调用 arbitrateMerge()
 *     → 情形 A/B/C 判定，可能返回 BLOCKED + 生成仲裁报告
 *
 * 注意：Worker 写区与主分支 git 历史独立，不存在 fast-forward 可能。
 */
export function mergeTask(
  db: Database.Database,
  taskId: string,
  repoRoot: string,
): Promise<MergeResult>;
```

### 4.2 arbitrate.ts — 仲裁决策树

```typescript
export interface ArbitrationInput {
  taskA: { taskId: string; starvationOverride: boolean; diff: string };
  taskB: { taskId: string; starvationOverride: boolean; diff: string };
  conflict: ConflictDetail;
}

export type ArbitrationDecision =
  | { action: 'ATTEMPT_STRUCTURED' }    // 允许最后一次结构化合并尝试
  | { action: 'BLOCKED'; reason: string };  // 禁止合并，请求仲裁

/**
 * 仲裁决策树（v1.5 spec 原文实现）：
 *
 *   情形 A: 两个任务均携带 starvation_override=true
 *           AND 修改了同一文件的同一代码区域
 *           → BLOCKED（禁止自动合并）
 *           → 生成仲裁报告
 *
 *   情形 B: 仅一个任务携带 starvation_override=true
 *           另一个为正常派发
 *           → ATTEMPT_STRUCTURED（允许尝试结构化合并）
 *           → 若结构化合并失败，升级为 MERGE_BLOCKED
 *
 *   情形 C: starvation_override=true 的任务修改了不同文件
 *           或同文件不同区域
 *           → ATTEMPT_STRUCTURED（视同普通冲突处理）
 */
export function arbitrateMerge(input: ArbitrationInput): ArbitrationDecision;
```

### 4.3 merge-coordinator.ts — 入口 + DAG 传播

```typescript
export interface CoordinatorConfig {
  repoRoot: string;
  dbPath: string;
  accuracyWarnThreshold?: number;   // 默认 0.70
}

export interface CoordinatorResult {
  taskId: string;
  mergeResult: MergeResult;
  accuracyUpdated: boolean;
  downstreamTriggered: string[];     // 被触发合并的下游 task ID 列表
}

/**
 * 合并协调器入口。
 * Scheduler 在 reapTick 的 MARK_DONE 分支中调用。
 *
 * 完整流程：
 *   1. 查询 Task 信息（modified_files, dependencies 等）
 *   2. mergeTask(taskId, repoRoot) — 三层合并
 *   3. 合并成功:
 *      a. bridgeAccuracy() — 回填预测准确率
 *      b. DAG 传播:
 *         - 查询所有 dependencies 中包含此 taskId 的下游任务
 *         - 对每个下游任务，检查其所有上游依赖是否全部 status='DONE'
 *         - 全部就绪 → coordinateMerge(downstreamTaskId)
 *      c. 全局准确率检查 → < 70% 输出 WARNING
 *   4. 合并失败 (BLOCKED):
 *      a. generateBlockedReport() → 写入 .parallelc/reports/
 *      b. casUpdateStatus(DONE → MERGE_BLOCKED)
 *      c. 人工介入后: npx parallelc-scheduler unblock --task <id>
 */
export function coordinateMerge(
  config: CoordinatorConfig,
  taskId: string,
): Promise<CoordinatorResult>;
```

### 4.4 report-generator.ts + accuracy-bridge.ts

```typescript
// report-generator.ts

export interface MergeReport {
  triggeredAt: string;
  conflictFile: string;
  conflictLines: string;
  taskA: { taskId: string; title: string; waitedMs: number; diff: string; contextSummary: string };
  taskB: { taskId: string; title: string; waitedMs: number; diff: string; contextSummary: string };
  suggestedDirection: string;
}

/**
 * 生成 MERGE_BLOCKED 仲裁报告。
 *
 * 文件命名规则：
 *   .parallelc/reports/MERGE_BLOCKED-{taskIdA}-{taskIdB}-{timestamp}.md
 *
 * 写入流程：
 *   1. 确保 .parallelc/reports/ 目录存在
 *   2. 生成 Markdown 报告内容
 *   3. fs.writeFileSync(reportPath, content)
 *   4. updateTask(db, taskId, { merge_report_path: reportPath })
 */
export function generateBlockedReport(
  db: Database.Database,
  taskA: Task,
  taskB: Task,
  conflict: ConflictDetail,
): MergeReport;
```

```typescript
// accuracy-bridge.ts

/**
 * 连接 Merge Coordinator 和预测准确率采集。
 *
 * Jaccard 相似度: accuracy = |expected ∩ actual| / |expected ∪ actual|
 *
 * 调用时机: mergeTask 成功后
 * 实现: 调用 prediction_records 表的 updatePredictionRecord
 *
 * 全局准确率监控:
 *   getPredictionAccuracy(db).overall < 0.70
 *   → console.warn("[coordinator] 预测准确率低于 70%，建议审查 Orchestrator Prompt")
 *   → Phase 4: 触发降级串行模式（自动）
 */
export function bridgeAccuracy(
  db: Database.Database,
  taskId: string,
  warnThreshold?: number,
): { accuracy: number | null; updated: boolean; shouldWarn: boolean };
```

### 4.5 @parallelc/keypool

```typescript
// key-pool.ts

export interface KeyState {
  key: string;
  masked: string;                    // "sk-ant-xxx...yyy"
  status: 'ACTIVE' | 'COOLDOWN' | 'DEAD';
  cooldownUntil: Date | null;
  consecutive429: number;
  lastUsedAt: Date | null;
}

/**
 * Key 池管理器。
 *
 * nextKey() 逻辑:
 *   1. 遍历池，跳过 COOLDOWN（冷却期内）和 DEAD
 *   2. 优先选 ACTIVE Key（轮转顺序）
 *   3. 全部 COOLDOWN → 选最近到期的 COOLDOWN Key（提前30s解冻）
 *   4. 全部 DEAD → 抛出异常
 *
 * 冷却算法（markRateLimited）:
 *   consecutive429++;
 *   if consecutive429 >= 3:
 *     cooldownMinutes = 5 * 2^(consecutive429 - 3)  → [5, 10, 20, 40]
 *     叠加 ±30s 随机抖动
 *     status = 'COOLDOWN'
 *     cooldownUntil = now + cooldownMinutes + jitter
 *
 * 冷却期内又 429: cooldownMinutes 翻倍（指数退避）
 *
 * Key 恢复:
 *   markSuccess(key) → consecutive429 = 0, status = 'ACTIVE'
 *   冷却期满 → nextKey 自动恢复为 ACTIVE
 */
export class KeyPool {
  constructor(keys: string[]);
  nextKey(): string;
  markSuccess(key: string): void;
  markRateLimited(key: string): void;
  markDead(key: string): void;
  allPaused(): boolean;              // 是否所有 Key 都在 COOLDOWN/DEAD
  earliestRecovery(): Date | null;   // 最近恢复时间
  status(): KeyState[];
}
```

```typescript
// health-check.ts

/**
 * 轻量被动监控。不主动消耗 API token。
 * 基于 KeyPool 中已有的 consecutive429 和 lastUsedAt 数据判断健康度。
 *
 * probeKey 仅用于初始化验证（首次加载 Key 时），后续依赖被动统计。
 */
export function probeKey(apiKey: string): Promise<{ alive: boolean; latencyMs: number }>;
```

```typescript
// rate-limit.ts

/**
 * 全局退避逻辑。
 * 在 dispatchTick 开头调用。
 *
 * if pool.allPaused():
 *   → 暂停 dispatchTick 本轮
 *   → 记录恢复时间 = pool.earliestRecovery()
 *   → 日志: "[Scheduler] All keys paused, resuming at {recoveryTime}"
 */
export function handleGlobalBackoff(pool: KeyPool): { paused: boolean; resumeAt: Date | null };
```

### 4.6 Scheduler 集成（最小化改动）

```
改动点 1: dispatch-loop.ts reapTick 的 MARK_DONE 分支
  现有: updateTask → casUpdateStatus(DONE) → cleanupWorktrees
  改为: 上述 + coordinateMerge(config, taskId)

改动点 2: worker-pool.ts spawn 方法
  现有: const apiKey = this.nextKey()（简单轮转）
  改为: const apiKey = this.keyPool.nextKey()（KeyPool 管理）

改动点 3: dispatchTick 开头
  新增: handleGlobalBackoff(pool) → paused 则跳过本轮

改动点 4: reapTick 的 RATE_LIMIT_SLEEP 分支
  新增: keyPool.markRateLimited(apiKey)

不改: dispatch-loop 主循环结构（setInterval 不变）
```

---

## 5. 验收标准

| # | 能力 | 验证方式 |
|---|------|---------|
| 1 | AUTO 合并（无冲突） | Worker 改独立文件 → git merge 成功 |
| 2 | STRUCTURED 合并（同文件不同区域） | 两 Worker 改同文件不同行 → diff3 拼接成功 |
| 3 | 仲裁情形 A → BLOCKED | 双 starvation + 同区域 → 报告生成 |
| 4 | 仲裁情形 B → STRUCTURED 尝试 | 单 starvation + 冲突 → 允许尝试 |
| 5 | 仲裁情形 C → STRUCTURED | 无 starvation / 不同区域 → 正常处理 |
| 6 | 仲裁报告写入 | .parallelc/reports/MERGE_BLOCKED-*.md |
| 7 | DAG 传播 | 上游全部 DONE → 下游自动 coordinateMerge |
| 8 | Jaccard 准确率回填 | mergeTask 成功 → prediction_records 更新 |
| 9 | Key 冷却 5/10/20/40min | 模拟连续 429 → 指数退避 + 抖动 |
| 10 | 全局暂停 | 所有 Key COOLDOWN → dispatchTick 跳过 |
| 11 | 准确率 < 70% 告警 | bridgeAccuracy 输出 WARNING |
| 12 | 全链路集成 | Scheduler reapTick 调用 coordinateMerge |

---

## 6. 不在 Phase 3A 范围内

- 生产压测与监控看板（Phase 4）
- Orchestrator Prompt 迭代优化（持续）
- 准确率 < 70% 自动降级串行（Phase 4）
- 跨仓库依赖追踪（V2.0）

---

*基于 ParallelC v1.5 项目计划书 | 审查版本 v1.1 | 2026-05-23*
