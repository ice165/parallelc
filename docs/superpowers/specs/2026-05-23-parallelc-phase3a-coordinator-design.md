# ParallelC Phase 3A — 合并协调 + Key Pool + 预测闭环 设计文档

**项目代号**：ParallelC
**文档版本**：v1.0
**日期**：2026-05-23
**基于**：Phase 3B 交付版 + claude code并行Agentv1.5.docx

---

## 1. 概述

Phase 3A 是端到端链路的最后一环——负责 Worker 产出代码的**安全合并**、**API Key 健康管理**和**预测准确率反馈闭环**。

核心目标：让 `orchestrate → TaskBoard → Scheduler → Worker → Merge → 主分支` 全流程自动化。

---

## 2. 架构

```
Worker DONE
  │
  ├─ Scheduler reapTick 中 MARK_DONE 之后
  │     │
  │     ├─ KeyPool.markSuccess(apiKey)        ← Key 成功使用，重置计数器
  │     │
  │     └─ Merge Coordinator
  │           │
  │           ├─ 1. mergeTask(taskId, repoRoot)
  │           │     ├─ Phase 1: git merge --ff-only      → FAST_FORWARD
  │           │     ├─ Phase 2: git merge                 → GIT_MERGE
  │           │     ├─ Phase 3: 文件级 diff3 分析          → FILE_LEVEL
  │           │     └─ Phase 4: 仲裁                       → MERGE_BLOCKED
  │           │
  │           ├─ 2. accuracy-bridge
  │           │     updatePredictionRecord(db, taskId, modifiedFiles)
  │           │     → 回填预测准确率到 Orchestrator metrics
  │           │
  │           └─ 3. DAG 传播
  │                 下游依赖全部就绪 → 触发下游任务合并
  │
  ├─ Key Pool（并行运行）
  │     ├─ nextKey()          ← Scheduler 派发时使用
  │     ├─ markRateLimited()  ← Worker 429 时标记冷却
  │     └─ probeAllKeys()     ← 每 10min 主动探测
  │
  └─ 准确率闭环
        Orchestrator recordPrediction → Worker 执行 → Merge 回填 → 监控
```

**技术选型**：

| 项目 | 选择 |
|------|------|
| 合并策略 | 分层 4 阶段（fast-forward → git merge → file-level → blocked） |
| Key 检测 | 混合（被动冷却 + 每 10min 主动 tokens.count_tokens 探测） |
| 预测回填 | accuracy-bridge 连接 Merge 产出和 Orchestrator metrics |
| 新增依赖 | @anthropic-ai/sdk（仅 keypool/health-check 使用） |

---

## 3. 包结构

```
packages/
├── coordinator/              # [新包] @parallelc/coordinator
│   └── src/
│       ├── index.ts
│       ├── merge-strategy.ts
│       ├── merge-coordinator.ts
│       ├── report-generator.ts
│       └── accuracy-bridge.ts
│
├── keypool/                  # [新包] @parallelc/keypool
│   └── src/
│       ├── index.ts
│       ├── key-pool.ts
│       ├── health-check.ts
│       └── rate-limit.ts
│
├── scheduler/                # [修改]
│   └── src/
│       └── dispatch-loop.ts  # 集成 KeyPool + 协调合并调用
│
└── orchestrator/             # 不变（metrics-collector 已在 Phase 3B 完成）
```

**依赖**：
```
@parallelc/coordinator
  ├── @parallelc/shared
  ├── @parallelc/taskboard
  └── @parallelc/orchestrator   # accuracy-bridge 连接 metrics-collector

@parallelc/keypool
  ├── @parallelc/shared
  └── @anthropic-ai/sdk        # health-check 使用

@parallelc/scheduler  → 新增依赖 coordinator + keypool
```

---

## 4. 模块 API

### 4.1 @parallelc/coordinator — merge-strategy.ts

```typescript
export interface MergeResult {
  success: boolean;
  strategy: 'FAST_FORWARD' | 'GIT_MERGE' | 'FILE_LEVEL' | 'BLOCKED';
  mergedFiles: string[];
  conflicts: ConflictDetail[];
  report: MergeReport | null;
}

export interface ConflictDetail {
  file: string;
  lines: string;                    // "L45-L67"
  taskA: { taskId: string; diff: string };
  taskB: { taskId: string; diff: string };
}

/**
 * 分层合并流水线：
 *   Phase 1: git merge --ff-only → FAST_FORWARD
 *   Phase 2: git merge（三方合并） → GIT_MERGE
 *   Phase 3: 文件级 diff3 结构化合并 → FILE_LEVEL
 *   Phase 4: 双方 starvation_override + 同区域冲突 → BLOCKED
 */
export function mergeTask(
  db: Database.Database,
  taskId: string,
  repoRoot: string,
): Promise<MergeResult>;
```

### 4.2 merge-coordinator.ts + report-generator.ts + accuracy-bridge.ts

```typescript
// merge-coordinator.ts

export interface CoordinatorConfig {
  repoRoot: string;
  dbPath: string;
}

export interface CoordinatorResult {
  taskId: string;
  mergeResult: MergeResult;
  accuracyUpdated: boolean;
}

export function coordinateMerge(
  config: CoordinatorConfig,
  taskId: string,
): Promise<CoordinatorResult>;
```

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

export function generateBlockedReport(
  db: Database.Database,
  taskA: Task,
  taskB: Task,
  conflict: ConflictDetail,
): MergeReport;
```

```typescript
// accuracy-bridge.ts

export function bridgeAccuracy(
  db: Database.Database,
  taskId: string,
): { accuracy: number | null; updated: boolean };
```

### 4.3 @parallelc/keypool

```typescript
// key-pool.ts

export interface KeyState {
  key: string;
  masked: string;
  status: 'ACTIVE' | 'COOLDOWN' | 'DEAD';
  cooldownUntil: Date | null;
  consecutive429: number;
  lastUsedAt: Date | null;
}

export class KeyPool {
  constructor(keys: string[]);
  nextKey(): string;
  markSuccess(key: string): void;
  markRateLimited(key: string): void;
  markDead(key: string): void;
  status(): KeyState[];
}
```

```typescript
// health-check.ts

export interface HealthCheckResult {
  key: string;
  alive: boolean;
  latencyMs: number;
  checkedAt: Date;
}

export function probeKey(apiKey: string): Promise<HealthCheckResult>;
export function probeAllKeys(pool: KeyPool): Promise<HealthCheckResult[]>;
```

```typescript
// rate-limit.ts

export function handleGlobalBackoff(pool: KeyPool): { paused: boolean; resumeAt: Date | null };
```

---

## 5. 验收标准

| # | 能力 | 验证方式 |
|---|------|---------|
| 1 | 无冲突快进合并 | Worker 修改独立文件 → mergeTask 返回 FAST_FORWARD |
| 2 | 无冲突三方合并 | Worker 修改与 main 无交集 → GIT_MERGE |
| 3 | 文件级合并 | 两个 Worker 改同文件不同区域 → FILE_LEVEL |
| 4 | MERGE_BLOCKED 触发 | 两个 starvation_override 同区域冲突 → BLOCKED + 报告 |
| 5 | 仲裁报告生成 | .parallelc/reports/ 下生成完整 .md |
| 6 | 预测准确率回填 | mergeTask 成功 → updatePredictionRecord 被调用 |
| 7 | Key 被动冷却 | 模拟连续 3 次 429 → Key 进入 COOLDOWN 5min |
| 8 | Key 主动探测 | probeAllKeys 对 ACTIVE Key 返回 alive/latency |
| 9 | 全链路集成 | reapTick 调用 coordinateMerge → DB 状态正确转换 |

---

## 6. 不在 Phase 3A 范围内

- 生产压测与监控看板（Phase 4）
- Orchestrator Prompt 迭代优化（持续）
- 跨仓库依赖追踪（V2.0）

---

*基于 ParallelC v1.5 项目计划书 | 2026-05-23*
