# ParallelC Phase 3B — Orchestrator 智能任务分解 设计文档

**项目代号**：ParallelC
**文档版本**：v1.0
**日期**：2026-05-23
**基于**：Phase 2 交付版 + claude code并行Agentv1.5.docx

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
  ├─ Pre-process（确定性）              ← 给 LLM 精准上下文，减少幻觉
  │   ├── scanRepoContext()            从文件树提取 repo 摘要
  │   └── extractModuleMap()           推断模块边界 + import 依赖
  │
  ├─ LLM Decompose（非确定性）          ← Claude Opus MCP 调用
  │   ├── buildOrchestratorPrompt()    组装含分级规则 + JSON Schema 的 prompt
  │   ├── decomposeViaClaude()         调用 Claude（maxRounds=3, timeout=2min）
  │   └── parseTaskDAG()              解析 JSON 响应 → TaskDraft[]
  │
  └─ Post-validate（确定性）            ← 硬约束校验，不信任 LLM
      ├── enforceHardRules()           L1/L2/L3 级别裁定（禁止降级）
      ├── validatePaths()              文件路径存在性检查
      ├── validateDAG()                拓扑环检测 + 孤儿节点
      └── buildDAG()                   写入 TaskBoard
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
    │
    ├── pre-process/
    │   ├── repo-scanner.ts         # scanRepoContext()
    │   └── module-map.ts           # extractModuleMap()
    │
    ├── decompose/
    │   ├── prompt-builder.ts       # buildOrchestratorPrompt()
    │   ├── mcp-decomposer.ts       # decomposeViaClaude()
    │   └── response-parser.ts      # parseTaskDAG()
    │
    ├── post-validate/
    │   ├── rule-engine.ts          # enforceHardRules()
    │   ├── path-validator.ts       # validatePaths()
    │   └── dag-validator.ts        # validateDAG()
    │
    ├── dag-builder.ts              # buildDAG() — 流水线入口
    └── cli.ts
```

**依赖**：
```
@parallelc/orchestrator
  ├── @parallelc/shared
  ├── @parallelc/taskboard
  └── @parallelc/worker           # spawnMcpWorker
```

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

export function extractModuleMap(repoContext: RepoContext): ModuleBoundary[];
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
}

export interface DecomposerResult {
  raw: string;
  parsed: TaskDraft[] | null;
  tokensUsed: number;
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
}

/**
 * L1: 文件数 ≤2 AND 同目录 AND 无新建 AND token预估 < 10K
 * L2: 文件数 3-10 OR 涉及接口变更 OR 需新建文件
 * L3: 文件数 >10 OR DB schema 变更 OR 跨仓库
 *
 * 降级禁止（LLM 标 L2 不能降 L1），升级允许。
 */
export function enforceHardRules(
  task: TaskDraft,
  repoContext: RepoContext,
): RuleResult;
```

```typescript
// path-validator.ts

export interface PathValidation {
  valid: string[];
  invalid: string[];
  withWarnings: string[];
}

/**
 * 校验 expected_touch_files 路径。
 * 已存在：检查 fs.existsSync
 * 新建文件：检查父目录是否存在
 * 不在 moduleMap 中的路径标记 warning（可疑幻觉）
 */
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

### 4.4 dag-builder + CLI

```typescript
// dag-builder.ts

export interface BuildDagOptions {
  repoRoot: string;
  dbPath: string;
  apiKey: string;
  maxRetries?: number;          // 默认 2
}

export interface BuildDagResult {
  dagId: string;
  summary: string;
  tasksCreated: number;
  l1Skipped: number;
  l3Pending: number;
  tokensUsed: number;
  retries: number;
}

export function buildDAG(
  input: DecompositionInput,
  opts: BuildDagOptions,
): Promise<BuildDagResult>;
```

### 4.5 CLI

```bash
$ npx parallelc-orchestrate "实现用户登录功能" --repo /path --api-key sk-xxx

[Orchestrator] 扫描仓库... 47 文件, 5 个模块
[Orchestrator] 调用 Claude Opus 进行任务分解... done (1234 tokens)
[Orchestrator] 验证通过: 3 L2, 1 L3 待确认, 1 L1 直接执行
[Orchestrator] DAG dag-20260701-001 写入 TaskBoard

Summary: 实现用户登录 API，含路由、中间件和测试

  task-dag-001-001  [L2] 创建登录路由 src/api/auth.ts
  task-dag-001-002  [L2] 实现 JWT 中间件 src/middleware/auth.ts ← 依赖 001
  task-dag-001-003  [L2] 编写登录测试 __tests__/auth.test.ts ← 依赖 001,002
  task-dag-001-004  [L3] 数据库迁移 migration/001_add_users.sql ⚠️ 需人工确认
```

---

## 5. 验收标准

| # | 能力 | 验证方式 |
|---|------|---------|
| 1 | 仓库上下文自动扫描 | 在示例 repo 上运行，输出 fileTree + moduleMap |
| 2 | LLM 任务分解 | 传入中文需求，输出合法 JSON DAG |
| 3 | L1/L2/L3 硬约束 | 构造边界用例（LLM 标 L2 但满足 L1 条件 → 不降级） |
| 4 | 文件路径校验 | 传入含不存在路径的 LLM 输出 → invalid 列表 |
| 5 | DAG 环检测 | 传入含循环依赖的 LLM 输出 → 拒绝 |
| 6 | 端到端：需求 → TaskBoard | `npx parallelc-orchestrate "xxx"` → DB 中可查到 Task |
| 7 | L1 快速路径 | L1 任务不创建 Task，直接输出执行建议 |
| 8 | L3 人工确认 | L3 任务 status=PENDING + 标记，不自动进 READY |

---

## 6. 不在 Phase 3B 范围内

- Merge Coordinator（Phase 3A）
- API Key 池健康检查（Phase 3A）
- `expected_touch_files` 预测准确率持续监控（Phase 3A 数据采集）

---

*基于 ParallelC v1.5 项目计划书 | 2026-05-23*
