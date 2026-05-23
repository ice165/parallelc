# ParallelC Phase 3B — Orchestrator 智能任务分解 设计文档

**项目代号**：ParallelC
**文档版本**：v1.1
**日期**：2026-05-23
**基于**：Phase 2 交付版 + claude code并行Agentv1.5.docx
**审查版本**：v1.1（2026-05-23 代码审查修订）

---

## 1. 概述

Orchestrator 是 ParallelC 的"大脑"——接收用户需求，自动分解为 Task DAG，
预测 `expected_touch_files`，按 L1/L2/L3 分级，写入 TaskBoard 供 Scheduler 派发。

核心设计哲学：**LLM 语义分解 + 确定性规则验证**。LLM 负责"理解需求"，确定性代码负责"校验边界"。

---

## 2. 架构

```
用户需求
  │
  ├─ Pre-process（确定性）
  │   ├── scanRepoContext()            从文件树提取 repo 摘要
  │   ├── extractModuleMap()           推断模块边界 + import 依赖
  │   └── estimateTokens()            基于文件字符数估算 LLM 消耗

  ├─ LLM Decompose（非确定性）         Claude Opus MCP 调用
  │   ├── buildOrchestratorPrompt()    组装含分级规则 + JSON Schema 的 prompt
  │   ├── decomposeViaClaude()         调用 Claude（cacheKey, maxRounds=3）
  │   └── parseTaskDAG()              解析 JSON 响应 → TaskDraft[]

  └─ Post-validate（确定性）           硬约束校验，不信任 LLM
      ├── enforceHardRules()           L1/L2/L3 级别裁定（集成 token 预估）
      ├── validatePaths()              文件路径存在性检查
      ├── validateDAG()                拓扑环检测 + 孤儿节点
      ├── executeL1Directly()          L1 直接执行修改，不写 TaskBoard
      ├── confirmL3Tasks()             人工确认后 L3 PENDING → READY
      ├── buildDAG()                   写入 TaskBoard + 记录预测数据
      └── metrics-collector.ts         预测准确率采集骨架
```

**关键技术选型**：

| 项目 | 选择 |
|------|------|
| LLM 调用 | `spawnMcpWorker`（与 Worker 统一，Claude Opus） |
| Prompt 策略 | 混合：默认单轮分解（L2），L3 迭代式 |
| 交互入口 | MCP 为主 + CLI 辅助 |
| 路径校验 | 基于 pre-process 提取的实际文件树 |
| 级别裁定 | 硬约束规则引擎（LLM 建议 + 代码终裁） |

---

## 3. 包结构

```
packages/orchestrator/
├── package.json
├── tsconfig.json
├── jest.config.ts
└── src/
    ├── index.ts

    ├── pre-process/
    │   ├── repo-scanner.ts         # scanRepoContext()
    │   ├── module-map.ts           # extractModuleMap()
    │   └── token-estimator.ts      # estimateTokens()

    ├── decompose/
    │   ├── prompt-builder.ts       # buildOrchestratorPrompt()
    │   ├── mcp-decomposer.ts       # decomposeViaClaude()
    │   └── response-parser.ts      # parseTaskDAG()

    ├── post-validate/
    │   ├── rule-engine.ts          # enforceHardRules()
    │   ├── path-validator.ts       # validatePaths()
    │   ├── dag-validator.ts        # validateDAG()
    │   ├── l1-executor.ts          # executeL1Directly()
    │   └── l3-confirm.ts           # confirmL3Tasks()

    ├── dag-builder.ts              # buildDAG() + recordPredictionAccuracy()
    ├── metrics-collector.ts        # 预测准确率采集骨架
    └── cli.ts
```

**依赖**：
```
@parallelc/orchestrator
  ├── @parallelc/shared
  ├── @parallelc/taskboard
  └── @parallelc/worker           # spawnMcpWorker
```

> **TODO**: `spawnMcpWorker` 当前在 @parallelc/worker 包中，被 scheduler 和 orchestrator 共用。后续版本考虑提取到独立的 @parallelc/mcp-common 包。

---

## 4. 模块 API

### 4.1 Pre-process

```typescript
// repo-scanner.ts

export interface RepoContext {
  fileTree: string[];
  moduleDirs: string[];
  packageJson: { name: string; scripts: Record<string,string>; dependencies: Record<string,string> } | null;
  existingTasks: string[];
}

export function scanRepoContext(repoRoot: string, db: Database.Database): RepoContext;
```

```typescript
// module-map.ts

export interface ModuleBoundary {
  dir: string;
  files: string[];
  imports: string[];
  exportedSymbols: string[];
}

/**
 * 从仓库结构推断模块边界。
 *
 * 优先级：
 *   1. tsconfig.json `paths` 别名 → 显式模块定义
 *   2. package.json `workspaces` → 子包边界
 *   3. 启发式：每个 top-level src/ 子目录为一个模块
 */
export function extractModuleMap(repoContext: RepoContext, repoRoot: string): ModuleBoundary[];
```

```typescript
// token-estimator.ts

export interface TokenEstimate {
  estimatedTokens: number;       // 预估 token 消耗
  totalChars: number;            // 涉及文件总字符数
  reasoning: string;             // 估算说明
}

/**
 * 基于目标文件的字符数粗略预估 LLM token 消耗。
 * 经验比例：1 token ≈ 3.5 字符（英文）或 1 token ≈ 2.5 字符（中英混合）。
 * 保守估计使用 1 token ≈ 2 字符。
 *
 * 阈值：
 *   < 10K tokens  → L1 候选
 *   10K-50K       → L2
 *   > 50K         → L3 候选
 */
export function estimateTokens(files: string[], repoRoot: string): TokenEstimate;
```

### 4.2 Decompose

```typescript
// prompt-builder.ts

export interface DecompositionInput {
  userRequest: string;
  repoContext: RepoContext;
  moduleMap: ModuleBoundary[];
}

export function buildOrchestratorPrompt(input: DecompositionInput): string;
```

```typescript
// mcp-decomposer.ts

export interface DecomposerOptions {
  apiKey: string;
  model?: 'sonnet' | 'opus';     // 默认 opus
  maxTokens?: number;            // 默认 4096
  timeoutMs?: number;            // 默认 120_000

  /**
   * 缓存键。相同 cacheKey 在会话内复用 LLM 结果。
   * 默认值：sha1(userRequest + JSON.stringify(repoContext.fileTree)) 的前 16 位。
   * 传入 null 跳过缓存，始终调用 LLM。
   */
  cacheKey?: string | null;
}

export interface DecomposerResult {
  raw: string;
  parsed: TaskDraft[] | null;
  tokensUsed: number;
  cached: boolean;
}

export function decomposeViaClaude(
  input: DecompositionInput,
  opts: DecomposerOptions,
): Promise<DecomposerResult>;
```

```typescript
// response-parser.ts

export interface TaskDraft {
  title: string;
  level: TaskLevel;
  expected_touch_files: string[];
  dependencies: string[];
  reasoning: string;
}

export function parseTaskDAG(raw: string): {
  dagId: string;
  summary: string;
  tasks: TaskDraft[];
} | null;
```

**LLM 输出 JSON Schema**：
```json
{
  "dagId": "string",
  "summary": "string",
  "tasks": [
    {
      "title": "string",
      "level": "L1|L2|L3",
      "expected_touch_files": ["string"],
      "dependencies": ["task-title"],
      "reasoning": "string"
    }
  ]
}
```

### 4.3 Post-validate

```typescript
// rule-engine.ts

export interface RuleResult {
  passed: boolean;
  level: TaskLevel;
  warnings: string[];
  action: 'CREATE_TASK' | 'DIRECT_EXECUTE' | 'HUMAN_CONFIRM';
  tokenEstimate?: TokenEstimate;  // L1 判定时附带 token 预估
}

/**
 * 强制执行 L1/L2/L3 硬约束。LLM 输出的是建议级别，此函数做最终裁定。
 *
 * L1: 文件数 <=2 AND 同目录 AND 无新建 AND estimateTokens() < 10K
 * L2: 文件数 3-10 OR 涉及接口变更 OR 需新建文件 OR tokens 10K-50K
 * L3: 文件数 >10 OR DB schema 变更 OR 跨仓库 OR tokens >50K
 *
 * 降级禁止：LLM 标记为 L2 的实际不得降级为 L1。
 * 升级允许：LLM 标记为 L1 但实际满足 L2 条件时自动升级。
 */
export function enforceHardRules(
  task: TaskDraft,
  repoContext: RepoContext,
  repoRoot: string,
): RuleResult;
```

```typescript
// path-validator.ts

export interface PathValidation {
  valid: string[];
  invalid: string[];
  withWarnings: string[];
}

export function validatePaths(
  files: string[],
  repoContext: RepoContext,
  moduleMap: ModuleBoundary[],
): PathValidation;
```

```typescript
// dag-validator.ts

export interface DagValidation {
  acyclic: boolean;
  orphanNodes: string[];
  circularDeps: string[][];
  missingRoots: boolean;
}

export function validateDAG(tasks: TaskDraft[]): DagValidation;
```

```typescript
// l1-executor.ts

export interface L1ExecutionResult {
  success: boolean;
  modifiedFiles: string[];
  output: string;
}

/**
 * L1 直接执行：调用 Claude 直接在 Main 仓库修改文件，不创建 Task，不走 TaskBoard。
 * 适用于单文件小改、typo 修复等简单场景。
 *
 * 与 Worker 的区别：
 *   - 不创建 Worktree（在 Main 仓库直接操作）
 *   - 不经过 Scheduler（跳过流水线）
 *   - 文件锁保护：调用前检查所有目标文件不在 lockedFiles 集合中
 *   - 失败时自动升级：返回 failed → 上层调用 buildDAG 创建正式 Task
 */
export function executeL1Directly(
  task: TaskDraft,
  repoRoot: string,
  apiKey: string,
  lockedFiles: Set<string>,
): Promise<L1ExecutionResult>;
```

```typescript
// l3-confirm.ts

export interface L3Confirmation {
  taskId: string;
  taskTitle: string;
  reason: string;              // 为什么需要 L3（文件数 / schema 变更等）
  files: string[];
}

/**
 * 将人工确认后的 L3 任务从 PENDING 转为 READY。
 *
 * CLI 中的确认交互：
 *   $ npx parallelc-orchestrate confirm --dag dag-20260701-001 --task task-004
 *   确认执行 L3 任务 [task-dag-001-004] 数据库迁移 migration/001_add_users.sql? [y/N] y
 *   [Orchestrator] task-dag-001-004 PENDING -> READY
 *
 * 未确认的 L3 任务保持 PENDING，不进入 Scheduler 派发。
 */
export function confirmL3Tasks(
  db: Database.Database,
  dagId: string,
  taskIds: string[],
): number;  // 返回确认数量
```

### 4.4 dag-builder + metrics-collector

```typescript
// dag-builder.ts

export interface BuildDagOptions {
  repoRoot: string;
  dbPath: string;
  apiKey: string;
  maxRetries?: number;          // LLM 分解失败重试次数，默认 2
  confirmL3?: boolean;          // true=跳过人工确认，L3 直接写 READY
  /**
   * 重试回调。每次重试后调用，可用于日志或通知。
   * 参数：(retryCount, reason)
   */
  onRetry?: (retryCount: number, reason: string) => void;
}

export interface BuildDagResult {
  dagId: string;
  summary: string;

  // 任务统计
  tasksCreated: number;         // 写入 TaskBoard 的任务数（L2 + L3）
  l1Executed: number;           // L1 直接执行成功（不走 TaskBoard）
  l1Skipped: number;            // L1 因文件锁跳过（上游未完成）
  l3Pending: number;            // L3 等待人工确认
  l3PendingTasks: L3Confirmation[];  // P1-3: L3 详情列表

  // 错误统计
  failedTasks: number;          // 解析/验证失败的任务数
  error: string | null;         // 首个致命错误描述

  tokensUsed: number;
  retries: number;
  cached: boolean;              // 本次是否命中缓存
}

export function buildDAG(
  input: DecompositionInput,
  opts: BuildDagOptions,
): Promise<BuildDagResult>;
```

```typescript
// metrics-collector.ts

export interface PredictionRecord {
  taskId: string;
  expectedFiles: string[];       // Orchestrator 预测
  actualFiles: string[] | null;  // Worker 实际修改（Phase 3A 回填）
  accuracy: number | null;       // 重合度（Phase 3A 计算）
  recordedAt: string;
}

/**
 * 预测准确率采集骨架。
 *
 * Phase 3B: 在 buildDAG 中调用 recordPrediction，写入 expected_files。
 *           actualFiles 和 accuracy 由 Phase 3A 的 Merge Coordinator 回填。
 *
 * Phase 3A 对接点：
 *   - Merge Coordinator 收到 Worker 的 modified_files 后
 *   - 调用 updatePredictionRecord(taskId, actualFiles)
 *   - accuracy = |expected intersect actual| / |expected union actual|
 */
export function recordPrediction(
  db: Database.Database,
  taskId: string,
  expectedFiles: string[],
): void;

export function updatePredictionRecord(
  db: Database.Database,
  taskId: string,
  actualFiles: string[],
): void;

export function getPredictionAccuracy(
  db: Database.Database,
): { overall: number; details: PredictionRecord[] };
```

### 4.5 CLI

```bash
$ npx parallelc-orchestrate "实现用户登录功能" --repo /path --api-key sk-xxx

[Orchestrator] 扫描仓库... 47 文件, 5 个模块
[Orchestrator] 调用 Claude Opus 进行任务分解... done (1234 tokens)
[Orchestrator] 验证通过: 3 L2, 1 L3 待确认, 1 L1 直接执行

Summary: 实现用户登录 API，含路由、中间件和测试

  [L1] 修复 README 拼写                         直接执行  ✅ 成功
  [L2] task-dag-001-001  创建登录路由 src/api/auth.ts
  [L2] task-dag-001-002  实现 JWT 中间件 src/middleware/auth.ts  ← 依赖 001
  [L2] task-dag-001-003  编写登录测试 __tests__/auth.test.ts    ← 依赖 001,002
  [L3] task-dag-001-004  数据库迁移 migration/001_add_users.sql ⚠️ 需人工确认

[Orchestrator] DAG dag-20260701-001 写入 TaskBoard
[Orchestrator] 预测数据已记录（4 条），Phase 3A 回填实际值

待确认 L3 任务（1 条）：
  npx parallelc-orchestrate confirm --dag dag-20260701-001 --task task-dag-001-004
```

---

## 5. 验收标准

| # | 能力 | 验证方式 |
|---|------|---------|
| 1 | 仓库上下文自动扫描 | 在示例 repo 上运行，输出 fileTree + moduleMap |
| 2 | LLM 任务分解 | 传入中文需求，输出合法 JSON DAG |
| 3 | L1/L2/L3 硬约束 + token 预估 | 构造边界用例验证级别裁定 |
| 4 | 文件路径校验 | 传入含不存在路径的 LLM 输出 -> invalid 列表 |
| 5 | DAG 环检测 | 传入含循环依赖的 LLM 输出 -> 拒绝 |
| 6 | 端到端：需求 -> TaskBoard | `npx parallelc-orchestrate "xxx"` -> DB 中可查到 Task |
| 7 | L1 直接执行 | L1 任务不创建 Task，executeL1Directly 修改文件 |
| 8 | L3 人工确认 | L3 任务 status=PENDING，confirmL3Tasks 后才转 READY |
| 9 | 预测数据采集 | recordPrediction 写入 DB，metrics-collector 可查询 |
| 10 | 缓存复用 | 相同 repoContext + 相同需求 -> cached=true |
| 11 | 重试机制 | LLM 分解失败时自动重试，onRetry 回调触发 |

---

## 6. 不在 Phase 3B 范围内

- Merge Coordinator（Phase 3A）
- API Key 池健康检查（Phase 3A）
- `expected_touch_files` 预测准确率实际计算（Phase 3A 回填 actualFiles）
- 限流容灾全链路集成（Phase 3A）
- 生产压测与监控看板（Phase 4）

---

*基于 ParallelC v1.5 项目计划书 | 审查版本 v1.1 | 2026-05-23*
