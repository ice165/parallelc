# ParallelC CEO 层 — 设计规范

> 版本：v1.0 · 日期：2026-05-28 · 基于 v2.0 架构设计

---

## 执行摘要

CEO 层是 ParallelC 的第五层，位于现有四层流水线（Orchestrator→Scheduler→Worker→Coordinator）之上，负责：

1. **意图对齐审查**：检查 Worker 产出是否与用户原始需求对齐（不审查代码语法）
2. **批处理式反馈**：收集所有 Worker 产出后批量审查，生成 PASS/REVISION/ESCALATE 决策
3. **审查-修改迭代**：REVISION 时生成具体修改意见，Worker 增量修改，最多 3 轮
4. **质量门禁**：通过后才放行给 Coordinator 合并

**核心原则**：
- CEO 是"产品经理"角色，只审查意图对齐，不审查代码质量
- 分层信任模型：L1 跳过 / L2 抽查 / L3 必须审查
- 成本可控：单 DAG 最多 $1.00，单会话最多 $5.00

---

## 一、架构位置与数据流

```
                                ┌── PASS ──→ Coordinator 合并
Worker DONE → reapTick → CEO 审查（批处理）
                                └── REVISION ──→ 创建 REVISION Worker（含 CEO 反馈）
                                        │          │
                                        │          └── 完成后再次 CEO 审查（最多 3 轮）
                                        │               └── 3 轮未通过 → ESCALATE
                                        │
                                        └── ESCALATE（S < 50 直接升级，或 3 轮耗尽）
                                               └── MERGE_BLOCKED → 人工
```

### 批处理时序

```
reapTick 回收所有 DONE 的 Worker
    │
    ▼
ceoBatchReview(db, doneTasks[])
    │  对每个 DONE 任务：
    │    1. 取任务描述 + Worker stdout/diff + 原始用户需求
    │    2. CEO 审查（单次 LLM 调用）
    │    3. 输出：PASS / REVISION / ESCALATE
    │
    ├── PASS → casUpdateStatus(DONE) → coordinateMerge()
    │
    ├── REVISION → casUpdateStatus(REVISION_NEEDED)
    │              → 创建新 Task（含 CEO 反馈），重新派发 Worker
    │              → ceo_iteration++
    │
    └── ESCALATE → casUpdateStatus(CEO_ESCALATED)
                   → 生成 CEO 审查报告 → 等待人工
```

---

## 二、新增文件与修改文件

### 新增文件（7 个）

```
packages/ceo/src/
├── ceo-agent.ts              # CEO 审查主入口（buildPrompt + 调 LLM）
├── intent-matcher.ts         # 意图对齐评分引擎（功能覆盖/缺失/多余/副作用）
├── batch-reviewer.ts         # 批处理审查编排器（遍历 doneTasks，调用 ceo-agent）
├── feedback-generator.ts     # 生成 Worker 修改意见（JSON schema）
├── iteration-tracker.ts      # 审查轮次管理、成本追踪、ESCALATE 决策
└── cli.ts                    # CLI 命令入口

packages/ceo/__tests__/
└── ceo-agent.test.ts         # CEO 审查测试
```

### 修改文件（5 个）

```
packages/shared/src/constants.ts     # 新增 CEO 相关常量
packages/shared/src/types.ts         # 新增 CEOReviewResult, CeoFeedback 类型
packages/taskboard/src/schema.ts     # 新增 4 列 + 3 种状态 + 状态转换
packages/scheduler/src/dispatch-loop.ts # reapTick MARK_DONE 出口插入 ceoBatchReview
packages/scheduler/package.json      # 新增 @parallelc/ceo 依赖
```

---

## 三、CEO 审查引擎

### 审查输入

| 输入 | 来源 |
|------|------|
| 用户原始需求 | `buildDAG` 时保存的 `userRequest`（需新增 `dag_user_request` 表或存在 TaskBoard） |
| 任务描述 | Task 的 `title` + `reasoning` |
| Worker diff | `git diff` 输出 |
| 修改文件列表 | `collectModifiedFiles()` 返回值 |
| 当前迭代轮次 | `ceo_iteration`（0/1/2） |

### 评分维度（0-100 分制）

| 维度 | 分值 | 检测方式 |
|------|------|---------|
| **功能覆盖** | 0-35 | diff 中的函数/类/接口是否对应任务描述要求 |
| **缺失检测** | 0-25 | 任务描述中的关键需求词是否在 diff 中无对应实现 |
| **多余检测** | 0-20 | diff 中是否有与需求无关的修改（YAGNI 违规扣分） |
| **副作用风险** | 0-20 | 是否修改了需求文件之外的 import 导出方 / 类型定义 |

### 决策矩阵

```
得分 S:
  S ≥ 80  → PASS        → 放行给 Coordinator
  50 ≤ S < 80 → REVISION  → 生成反馈，Worker 增量修改
  S < 50  → ESCALATE    → 差距太大，转人工

  第 3 轮（ceo_iteration = 2）S < 80 → 强制 ESCALATE
```

### 审查跳过条件

满足任一即跳过审查，直接 PASS：

| 条件 | 理由 |
|------|------|
| ClarityEngine 评分 > 95 | 需求极其明确 |
| F1-β 当前窗口平均 > 0.85 | Worker 产出高度可预测 |
| 任务级别 = L1 | 改动极小 |
| CEO 会话预算耗尽 | 不阻塞流水线 |
| 修改文件数 = 1 且仅有新增行，无删除 | 纯增量零风险 |

### 反馈 JSON Schema

```json
{
  "verdict": "PASS | REVISION | ESCALATE",
  "score": 0-100,
  "summary": "一句话总结审查结论",
  "gaps": ["缺失的需求项"],
  "excess": ["多余的修改"],
  "sideEffects": ["可能的副作用"],
  "suggestions": ["具体的修改建议"]
}
```

---

## 四、状态机扩展

### 新增 3 种状态

| 状态 | 含义 | 触发条件 |
|------|------|---------|
| `REVIEW_PENDING` | Worker 完成，等待 CEO 审查 | Worker exit(0) → reapTick |
| `REVISION_NEEDED` | CEO 驳回，需修改 | CEO score 50-79 |
| `CEO_ESCALATED` | 转人工处理 | score < 50 或 3 轮未通过 |

### 状态转换追加

```typescript
DONE:              ['REVIEW_PENDING'],
REVIEW_PENDING:    ['DONE', 'REVISION_NEEDED', 'CEO_ESCALATED'],
REVISION_NEEDED:   ['READY', 'CEO_ESCALATED'],
CEO_ESCALATED:     ['DONE'],
```

### Task 表新增 4 列

```sql
ceo_score       REAL              -- 最近一次 CEO 评分 (0-100)
ceo_feedback    TEXT              -- JSON 格式审查反馈
ceo_iteration   INTEGER DEFAULT 0 -- 审查-修改轮次
parent_task_id  TEXT              -- REVISION 任务指回原始任务
```

---

## 五、审查-修改迭代流程

### 完整生命周期

```
1. Worker 完成（exit 0）
2. reapTick 路由到 REVIEW_PENDING（替代原 DONE）
3. ceoBatchReview() 执行审查
4. 决策分支：
   ├── PASS:
   │     casUpdateStatus → DONE
   │     coordinateMerge() → Coordinator
   │
   ├── REVISION:
   │     casUpdateStatus(原任务) → REVISION_NEEDED
   │     创建子任务（title=原title + "(Revision N)"）
   │     子任务.ceo_feedback = CEO 反馈 JSON
   │     子任务.parent_task_id = 原任务.id
   │     子任务.expected_touch_files = 原任务修改文件列表
   │     子任务.ceo_iteration = 原任务.ceo_iteration + 1
   │     子任务 → PENDING → READY → 被 dispatchTick 派发
   │     Worker 在已有 Worktree 上增量修改
   │
   └── ESCALATE:
         casUpdateStatus → CEO_ESCALATED
         generateCeoReport() → Markdown 报告
         等待人工 confirm
```

### 迭代追踪示例

```
迭代 0: Task "Add JWT login"
        RUNNING → DONE → REVIEW_PENDING
        CEO: score=65, verdict=REVISION
        创建子任务 t1-r1

迭代 1: Task "Add JWT login (Revision 1)"  [parent=t1, iteration=1]
        RUNNING → DONE → REVIEW_PENDING
        CEO: score=85, verdict=PASS
        子任务 DONE, 父任务 DONE
        coordinateMerge()
```

### 3 轮上限

```
迭代 2（第 3 次执行）:
        CEO score=72（仍 < 80）
        → 强制 ESCALATE
        → 生成报告，停止迭代
```

---

## 六、成本控制

### CEO 审查 token 预算

| 项目 | 估算 tokens |
|------|------------|
| 用户需求 + 任务描述 | ~500 |
| Worker diff（单任务） | ~2000 |
| CEO Prompt + JSON Schema | ~800 |
| CEO 输出 | ~600 |
| **单次审查合计** | **~4000** |

### 分层预算

| 层级 | 配置项 | 默认值 | 超限行为 |
|------|--------|--------|---------|
| 单次审查 | `MAX_REVIEW_OUTPUT_TOKENS` | 4096 | 截断 |
| 单任务 | `MAX_CEO_ROUNDS` | 3 | 强制 ESCALATE |
| 单 DAG | `MAX_CEO_COST_PER_DAG` | $1.00 | 剩余任务跳过 CEO |
| 单会话 | `MAX_CEO_COST_PER_SESSION` | $5.00 | 全部跳过 CEO |

### 分层信任模型

| 任务级别 | CEO 模型 | 最大迭代 | 跳过条件 |
|---------|---------|---------|---------|
| L1 | 跳过 | 0 | 始终跳过 |
| L2 | Sonnet | 2 | F1-β > 0.85 或 Clarity > 95 |
| L3 | Opus | 3 | 不跳过（除非预算耗尽） |

### 成本估算

```
典型 DAG（10 个 L2 任务，2 个 L3 任务）：
  L2: 10 × 2轮 × $0.02(Sonnet) = $0.40
  L3: 2  × 1轮 × $0.06(Opus)   = $0.12
  单 DAG 总额                    ≈ $0.52
  在 $1.00 预算内 ✅
```

---

## 七、集成点

### dispatch-loop.ts 变更

```typescript
// reapTick() 中 MARK_DONE 分支的变更：

case 'MARK_DONE': {
  // ... 现有逻辑（updateTask, casUpdateStatus, F1-β, audit）
  
  // 路由到 CEO 审查（替代直接 coordinateMerge）
  const needsReview = shouldReview(task, costTracker);
  if (needsReview) {
    casUpdateStatus(db, task.id, version, 'DONE', 'REVIEW_PENDING');
    // 审查在下一个 tick 的 ceoReviewTick() 中批量执行
  } else {
    // 跳过 CEO，直接合并（原逻辑）
    coordinateMerge(...);
  }
}

// 新增 ceoReviewTick() 函数：
function ceoReviewTick(db, repoRoot, dbPath) {
  const reviewTasks = queryTasksByStatus(db, 'REVIEW_PENDING');
  if (reviewTasks.length === 0) return;
  
  const results = ceoBatchReview(db, reviewTasks, repoRoot);
  for (const r of results) {
    switch (r.verdict) {
      case 'PASS':       /* → DONE → coordinateMerge() */ break;
      case 'REVISION':   /* → REVISION_NEEDED + 创建子任务 */ break;
      case 'ESCALATE':   /* → CEO_ESCALATED + 生成报告 */ break;
    }
  }
}
```

### startScheduler() 变更

```typescript
// 在主循环中增加 ceoReviewTick 调用：
const loop = setInterval(() => {
  tick++;
  const dispatch = dispatchTick(...);
  const reap = reapTick(...);
  const ceoReview = ceoReviewTick(db, repoRoot, dbPath);  // 新增
  const woken = wakeTick(db);
}, tickIntervalMs);
```

---

## 八、CLI 命令

```bash
# 手动触发 CEO 审查（通常自动执行）
npx parallelc-ceo review --dag <id> --db <path>

# 查看 CEO 审查状态
npx parallelc-ceo status --db <path>

# 人工确认 ESCALATED 任务
npx parallelc-ceo confirm --task <id> [--verdict pass|revision]
```

---

## 九、测试策略

- **单元测试**：intent-matcher 评分逻辑、iteration-tracker 上限控制、跳过条件判断
- **集成测试**：ceoBatchReview 端到端（Mock LLM）、状态转换正确性、迭代轮次上限
- **成本测试**：验证预算耗尽时自动跳过、分层模型选择正确

### 测试文件

```
packages/ceo/__tests__/
├── intent-matcher.test.ts
├── iteration-tracker.test.ts
├── batch-reviewer.test.ts
└── ceo-agent.test.ts
```

---

## 十、量化指标

| 指标 | 计算方式 | 目标值 |
|------|---------|--------|
| CEO 审查通过率（首轮） | PASS数 / 总审查数 | ≥60% |
| 平均迭代轮次 | Σ(通过时的轮次) / PASS数 | ≤1.5 |
| CEO 成本占比 | CEO成本 / 总成本 | ≤25% |
| 审查跳过率 | 跳过数 / 总任务数 | ≥30%（L1 天然跳过） |
| ESCALATE 率 | ESCALATE数 / 总审查数 | ≤10% |

---

*文档版本：v1.0 · 2026-05-28*
