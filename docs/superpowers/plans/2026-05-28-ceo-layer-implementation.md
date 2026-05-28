# ParallelC CEO 层 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现 CEO 层 — Worker 产出意图对齐审查、批处理反馈、最多 3 轮审查-修改迭代循环

**Architecture:** 新包 `@parallelc/ceo` 插在 Scheduler 的 reapTick 和 Coordinator 之间，批处理审查 DONE→REVIEW_PENDING 任务，4 维评分引擎（功能覆盖/缺失/多余/副作用），PASS→合并、REVISION→增量修改、ESCALATE→人工

**Tech Stack:** TypeScript (strict), pnpm workspaces, better-sqlite3, Jest + ts-jest, Anthropic API (Claude Opus/Sonnet)

**基于规范:** `docs/superpowers/specs/2026-05-28-ceo-layer-design.md`

---

## 文件结构

```
packages/ceo/
├── package.json
├── tsconfig.json
├── jest.config.ts
├── src/
│   ├── index.ts
│   ├── intent-matcher.ts        # 意图对齐评分引擎
│   ├── feedback-generator.ts    # 修改意见生成
│   ├── iteration-tracker.ts     # 轮次管理 + 跳过决策
│   ├── ceo-agent.ts             # LLM 审查主入口
│   ├── batch-reviewer.ts        # 批处理审查编排
│   └── cli.ts                   # CLI 命令
└── __tests__/
    ├── intent-matcher.test.ts
    ├── iteration-tracker.test.ts
    ├── batch-reviewer.test.ts
    └── ceo-agent.test.ts

修改文件:
├── packages/shared/src/types.ts          # 新增 3 状态 + CEOReviewResult + CeoFeedback
├── packages/shared/src/constants.ts      # 新增 CEO 常量
├── packages/taskboard/src/schema.ts      # 新增 4 列 + 3 状态 + 转换规则
├── packages/taskboard/src/repository.ts  # rowToTask 映射新字段
├── packages/scheduler/src/dispatch-loop.ts # ceoReviewTick 集成
└── packages/scheduler/package.json       # 新增依赖
```

---

### Task 1: @parallelc/ceo — 包骨架 + 共享类型扩展

**Files:**
- Create: `packages/ceo/package.json`
- Create: `packages/ceo/tsconfig.json`
- Create: `packages/ceo/jest.config.ts`
- Create: `packages/ceo/src/index.ts`
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/constants.ts`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "@parallelc/ceo",
  "version": "0.1.0",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "bin": {
    "parallelc-ceo": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsup src/index.ts src/cli.ts --format cjs,esm --dts --clean",
    "typecheck": "tsc --noEmit",
    "test": "jest",
    "test:ci": "jest --ci --coverage"
  },
  "dependencies": {
    "@parallelc/shared": "workspace:*",
    "@parallelc/taskboard": "workspace:*"
  },
  "devDependencies": {
    "@types/jest": "^29.5.14",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.5"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 3: 创建 jest.config.ts**

```typescript
import baseConfig from '../../jest.config.base';
export default baseConfig;
```

- [ ] **Step 4: 扩展 shared/types.ts — 新增状态和类型**

在 `TaskStatus` 类型末尾追加 3 个状态（`'MERGE_BLOCKED'` 之后）：

```typescript
// packages/shared/src/types.ts — TaskStatus 类型：
export type TaskStatus =
  | 'PENDING'
  | 'READY'
  | 'RUNNING'
  | 'SLEEP_PENDING'
  | 'CHECKPOINT_PENDING'
  | 'DONE'
  | 'FAILED'
  | 'CANCELLED'
  | 'MERGE_BLOCKED'
  | 'REVIEW_PENDING'
  | 'REVISION_NEEDED'
  | 'CEO_ESCALATED';
```

在 Task 接口末尾追加新字段：

```typescript
export interface Task {
  // ... existing fields ...
  f1_beta: number | null;
  ceo_score: number | null;
  ceo_feedback: string | null;
  ceo_iteration: number;
  parent_task_id: string | null;
}
```

在文件末尾新增 CEO 类型：

```typescript
export interface CeoFeedback {
  verdict: 'PASS' | 'REVISION' | 'ESCALATE';
  score: number;
  summary: string;
  gaps: string[];
  excess: string[];
  sideEffects: string[];
  suggestions: string[];
}

export interface CeoReviewInput {
  userRequest: string;
  taskTitle: string;
  taskReasoning: string;
  diff: string;
  modifiedFiles: string[];
  iteration: number;
}

export interface CeoReviewResult {
  taskId: string;
  feedback: CeoFeedback;
  model: 'sonnet' | 'opus';
  tokensUsed: number;
  cost: number;
}
```

- [ ] **Step 5: 扩展 shared/constants.ts**

```typescript
// CEO 相关常量
export const MAX_CEO_ROUNDS = 3;
export const CEO_PASS_THRESHOLD = 80;
export const CEO_ESCALATE_THRESHOLD = 50;
export const MAX_CEO_COST_PER_DAG = 1.00;
export const MAX_CEO_COST_PER_SESSION = 5.00;
export const MAX_REVIEW_OUTPUT_TOKENS = 4096;

// CEO 跳过条件阈值
export const CEO_SKIP_CLARITY_SCORE = 95;
export const CEO_SKIP_F1BETA_SCORE = 0.85;
```

更新 `shared/src/index.ts` 导出新类型和常量。

- [ ] **Step 6: 创建 src/index.ts 骨架**

```typescript
export { matchIntent } from './intent-matcher.js';
export type { IntentScore } from './intent-matcher.js';
export { generateFeedback } from './feedback-generator.js';
export { shouldReview, getCeoModel, IterationTracker } from './iteration-tracker.js';
export type { IterationDecision } from './iteration-tracker.js';
export { ceoReview } from './ceo-agent.js';
export type { CeoAgentOptions } from './ceo-agent.js';
export { ceoBatchReview } from './batch-reviewer.js';
export type { BatchReviewResult } from './batch-reviewer.js';
```

- [ ] **Step 7: Commit**

```bash
git add packages/ceo/ packages/shared/
git commit -m "feat(ceo): add package skeleton, shared types and constants"
```

---

### Task 2: TaskBoard Schema 扩展

**Files:**
- Modify: `packages/taskboard/src/schema.ts`
- Modify: `packages/taskboard/src/repository.ts`
- Modify: `packages/taskboard/src/db.ts`

- [ ] **Step 1: 扩展 schema.ts — DDL**

在 `TASK_TABLE_DDL` 的列定义中追加：

```sql
    -- 在 f1_beta REAL 之后追加:
    ceo_score REAL,
    ceo_feedback TEXT,
    ceo_iteration INTEGER DEFAULT 0,
    parent_task_id TEXT
```

- [ ] **Step 2: 扩展 VALID_STATUSES**

```typescript
export const VALID_STATUSES = [
  'PENDING', 'READY', 'RUNNING',
  'SLEEP_PENDING', 'CHECKPOINT_PENDING',
  'DONE', 'FAILED', 'CANCELLED', 'MERGE_BLOCKED',
  'REVIEW_PENDING', 'REVISION_NEEDED', 'CEO_ESCALATED',
] as const;
```

- [ ] **Step 3: 扩展 ALLOWED_TRANSITIONS**

在 `DONE` 和 `MERGE_BLOCKED` 转换规则中追加，并新增 3 条：

```typescript
DONE:              ['REVIEW_PENDING'],       // 新增
REVIEW_PENDING:    ['DONE', 'REVISION_NEEDED', 'CEO_ESCALATED'],  // 新增
REVISION_NEEDED:   ['READY', 'CEO_ESCALATED'],                     // 新增
CEO_ESCALATED:     ['DONE'],                                        // 新增
```

- [ ] **Step 4: 扩展 repository.ts — rowToTask**

在 `rowToTask` 函数中追加新字段的映射：

```typescript
ceo_score: row['ceo_score'] != null ? Number(row['ceo_score']) : null,
ceo_feedback: row['ceo_feedback'] ? String(row['ceo_feedback']) : null,
ceo_iteration: row['ceo_iteration'] ? Number(row['ceo_iteration']) : 0,
parent_task_id: row['parent_task_id'] ? String(row['parent_task_id']) : null,
```

- [ ] **Step 5: 扩展 db.ts — 迁移**

在 `initializeSchema` 中追加迁移语句：

```typescript
// Migration: add CEO columns for existing databases
const ceoColumns = ['ceo_score REAL', 'ceo_feedback TEXT',
  'ceo_iteration INTEGER DEFAULT 0', 'parent_task_id TEXT'];
for (const col of ceoColumns) {
  try { db.exec(`ALTER TABLE tasks ADD COLUMN ${col}`); } catch { /* exists */ }
}
```

- [ ] **Step 6: Commit**

```bash
git add packages/taskboard/
git commit -m "feat(taskboard): add CEO review states, columns, and transitions"
```

---

### Task 3: IntentMatcher + FeedbackGenerator

**Files:**
- Create: `packages/ceo/src/intent-matcher.ts`
- Create: `packages/ceo/src/feedback-generator.ts`
- Create: `packages/ceo/__tests__/intent-matcher.test.ts`

- [ ] **Step 1: 编写 intent-matcher 测试**

```typescript
// packages/ceo/__tests__/intent-matcher.test.ts
import { matchIntent } from '../src/intent-matcher';
import type { CeoReviewInput, CeoFeedback } from '@parallelc/shared';

const makeInput = (overrides?: Partial<CeoReviewInput>): CeoReviewInput => ({
  userRequest: '在 src/api/auth.ts 中添加 JWT 登录接口',
  taskTitle: '实现 JWT 登录 API',
  taskReasoning: '创建登录路由和 JWT 签发逻辑',
  diff: `+export function login(req: LoginRequest): LoginResponse {
+  const token = jwt.sign({ userId: user.id }, secret);
+  return { token, user };
+}
+function validatePassword(input: string, hash: string): boolean {
+  return bcrypt.compare(input, hash);
+}`,
  modifiedFiles: ['src/api/auth.ts'],
  iteration: 0,
  ...overrides,
});

describe('matchIntent', () => {
  test('完全对齐 → score ≥ 80, verdict PASS', () => {
    const result = matchIntent(makeInput());
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.verdict).toBe('PASS');
  });

  test('缺失关键功能 → score < 80', () => {
    const input = makeInput({
      userRequest: '添加 JWT 登录接口和密码重置功能',
      diff: '+export function login() { return { token: "xxx" }; }',
    });
    const result = matchIntent(input);
    expect(result.score).toBeLessThan(80);
    expect(result.gaps.length).toBeGreaterThan(0);
  });

  test('修改了无关文件 → excess 非空', () => {
    const input = makeInput({
      modifiedFiles: ['src/api/auth.ts', 'src/utils/random.ts'],
    });
    const result = matchIntent(input);
    expect(result.excess.length).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(90);
  });

  test('副作用检测 → 修改了 import 导出方', () => {
    const input = makeInput({
      diff: '+import { User } from "../models/user";\n-export { User } from "../models/user";',
    });
    const result = matchIntent(input);
    expect(result.sideEffects.length).toBeGreaterThan(0);
  });

  test('迭代轮次 ≥ 3 → 强制 ESCALATE', () => {
    const input = makeInput({ iteration: 2 }); // 第3次（0-indexed）
    const result = matchIntent(input);
    expect(result.verdict).toBe('ESCALATE');
  });

  test('分数 < 50 → verdict ESCALATE', () => {
    const input = makeInput({
      userRequest: '重写整个认证系统，支持 OAuth2.0、SAML、LDAP',
      diff: '+console.log("hello");',
    });
    const result = matchIntent(input);
    expect(result.verdict).toBe('ESCALATE');
  });
});
```

- [ ] **Step 2: 实现 intent-matcher.ts**

```typescript
// packages/ceo/src/intent-matcher.ts
import type { CeoReviewInput, CeoFeedback } from '@parallelc/shared';
import { MAX_CEO_ROUNDS, CEO_PASS_THRESHOLD, CEO_ESCALATE_THRESHOLD } from '@parallelc/shared';

export interface IntentScore {
  coverage: number;
  gapPenalty: number;
  excessPenalty: number;
  sideEffectPenalty: number;
}

function extractKeywords(text: string): string[] {
  // Extract Chinese and English technical terms
  const terms: string[] = [];
  // Match Chinese noun phrases (2-8 chars between punctuation)
  const cnRe = /[一-鿿]{2,8}/g;
  let m: RegExpExecArray | null;
  while ((m = cnRe.exec(text)) !== null) terms.push(m[0]);
  // Match English identifiers
  const enRe = /\b[a-zA-Z_]\w{2,}\b/g;
  while ((m = enRe.exec(text)) !== null) terms.push(m[0]);
  return [...new Set(terms)];
}

function scoreCoverage(taskKeywords: string[], diff: string, requestKeywords: string[]): number {
  let hits = 0;
  const diffLower = diff.toLowerCase();
  for (const kw of requestKeywords) {
    if (diffLower.includes(kw.toLowerCase())) hits++;
  }
  if (requestKeywords.length === 0) return 35;
  return Math.min(35, Math.round((hits / requestKeywords.length) * 35));
}

function scoreGaps(requestKeywords: string[], diff: string): number {
  const diffLower = diff.toLowerCase();
  const missing = requestKeywords.filter(kw => !diffLower.includes(kw.toLowerCase()));
  if (requestKeywords.length === 0) return 0;
  return Math.min(25, Math.round((missing.length / requestKeywords.length) * 25));
}

function scoreExcess(taskTitle: string, modifiedFiles: string[]): number {
  // Files outside expected scope are "excess"
  const taskKeywords = extractKeywords(taskTitle);
  const excessCount = modifiedFiles.filter(f => {
    const fLower = f.toLowerCase();
    return !taskKeywords.some(kw => fLower.includes(kw.toLowerCase()));
  }).length;
  return Math.min(20, excessCount * 10);
}

function scoreSideEffects(diff: string, modifiedFiles: string[]): number {
  // Detect export changes and import source modifications
  let risk = 0;
  if (/^[-+]export\s/m.test(diff)) risk += 10;
  if (/^[-+]import\s/m.test(diff)) risk += 5;
  if (modifiedFiles.length > 3) risk += 5;
  return Math.min(20, risk);
}

export function matchIntent(input: CeoReviewInput): CeoFeedback {
  // Hard rule: iteration cap
  if (input.iteration >= MAX_CEO_ROUNDS - 1) {
    return {
      verdict: 'ESCALATE', score: 0, summary: `Max iterations (${MAX_CEO_ROUNDS}) reached`,
      gaps: [], excess: [], sideEffects: [], suggestions: ['Manual review required'],
    };
  }

  const requestKeywords = extractKeywords(input.userRequest);
  const taskKeywords = extractKeywords(input.taskTitle);

  const coverage = scoreCoverage(taskKeywords, input.diff, requestKeywords);
  const gapPenalty = scoreGaps(requestKeywords, input.diff);
  const excessPenalty = scoreExcess(input.taskTitle, input.modifiedFiles);
  const sideEffectPenalty = scoreSideEffects(input.diff, input.modifiedFiles);

  const score = Math.max(0, coverage + (25 - gapPenalty) + (20 - excessPenalty) + (20 - sideEffectPenalty));
  const cappedScore = Math.min(100, score);

  const gaps: string[] = [];
  const excess: string[] = [];
  const suggestions: string[] = [];

  const diffLower = input.diff.toLowerCase();
  for (const kw of requestKeywords) {
    if (!diffLower.includes(kw.toLowerCase())) {
      gaps.push(`Missing: ${kw}`);
      suggestions.push(`Add implementation for: ${kw}`);
    }
  }

  for (const f of input.modifiedFiles) {
    const fLower = f.toLowerCase();
    if (!taskKeywords.some(kw => fLower.includes(kw.toLowerCase()))) {
      excess.push(`Unrelated file modified: ${f}`);
      suggestions.push(`Consider reverting changes to: ${f}`);
    }
  }

  let verdict: CeoFeedback['verdict'];
  if (cappedScore < CEO_ESCALATE_THRESHOLD) {
    verdict = 'ESCALATE';
  } else if (cappedScore >= CEO_PASS_THRESHOLD) {
    verdict = 'PASS';
  } else {
    verdict = 'REVISION';
  }

  return {
    verdict, score: cappedScore,
    summary: `Coverage=${coverage}/35 Gaps=-${gapPenalty}/25 Excess=-${excessPenalty}/20 SideEffects=-${sideEffectPenalty}/20`,
    gaps, excess, sideEffects: [],
    suggestions: suggestions.slice(0, 5),
  };
}
```

- [ ] **Step 3: 实现 feedback-generator.ts**

```typescript
// packages/ceo/src/feedback-generator.ts
import type { CeoFeedback } from '@parallelc/shared';

export function generateFeedback(feedback: CeoFeedback): string {
  return JSON.stringify(feedback, null, 2);
}

export function parseFeedback(json: string): CeoFeedback | null {
  try {
    const parsed = JSON.parse(json) as CeoFeedback;
    if (!['PASS', 'REVISION', 'ESCALATE'].includes(parsed.verdict)) return null;
    if (typeof parsed.score !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/ceo/
git commit -m "feat(ceo): add IntentMatcher and FeedbackGenerator with tests"
```

---

### Task 4: IterationTracker

**Files:**
- Create: `packages/ceo/src/iteration-tracker.ts`
- Create: `packages/ceo/__tests__/iteration-tracker.test.ts`

- [ ] **Step 1: 编写测试**

```typescript
// packages/ceo/__tests__/iteration-tracker.test.ts
import { shouldReview, getCeoModel, IterationTracker } from '../src/iteration-tracker';
import type { Task } from '@parallelc/shared';

describe('shouldReview', () => {
  test('L1 任务 → 跳过审查', () => {
    const task = { id: 't1', level: 'L1' as const, ceo_iteration: 0 };
    expect(shouldReview(task as Task, 95, 0.9, 10.0)).toBe(false);
  });

  test('L2 任务 + F1-β 低 → 需要审查', () => {
    const task = { id: 't2', level: 'L2' as const, ceo_iteration: 0 };
    expect(shouldReview(task as Task, 70, 0.6, 10.0)).toBe(true);
  });

  test('L2 任务 + F1-β > 0.85 → 跳过', () => {
    const task = { id: 't3', level: 'L2' as const, ceo_iteration: 0 };
    expect(shouldReview(task as Task, 70, 0.9, 10.0)).toBe(false);
  });

  test('CEO 预算耗尽 → 跳过', () => {
    const task = { id: 't4', level: 'L2' as const, ceo_iteration: 0 };
    expect(shouldReview(task as Task, 70, 0.6, 0.0)).toBe(false);
  });

  test('L3 任务 → 必须审查', () => {
    const task = { id: 't5', level: 'L3' as const, ceo_iteration: 0 };
    expect(shouldReview(task as Task, 70, 0.6, 10.0)).toBe(true);
  });

  test('单文件纯增量 → 跳过', () => {
    const task = {
      id: 't6', level: 'L2' as const, ceo_iteration: 0,
      modified_files: ['src/a.ts'],
    };
    expect(shouldReview(task as Task, 70, 0.6, 10.0)).toBe(false);
  });
});

describe('getCeoModel', () => {
  test('L2 → sonnet', () => {
    expect(getCeoModel('L2')).toBe('sonnet');
  });
  test('L3 → opus', () => {
    expect(getCeoModel('L3')).toBe('opus');
  });
});

describe('IterationTracker', () => {
  test('新任务 iteration=0', () => {
    const tracker = new IterationTracker();
    expect(tracker.canRetry(0)).toBe(true);
  });

  test('iteration=2 → 不可重试（已达上限）', () => {
    const tracker = new IterationTracker();
    expect(tracker.canRetry(2)).toBe(false);
  });
});
```

- [ ] **Step 2: 实现 iteration-tracker.ts**

```typescript
// packages/ceo/src/iteration-tracker.ts
import type { Task, TaskLevel } from '@parallelc/shared';
import {
  MAX_CEO_ROUNDS, MAX_CEO_COST_PER_SESSION,
  CEO_SKIP_CLARITY_SCORE, CEO_SKIP_F1BETA_SCORE,
} from '@parallelc/shared';

export interface IterationDecision {
  action: 'REVIEW' | 'SKIP' | 'ESCALATE';
  reason: string;
}

export function shouldReview(
  task: Task,
  clarityScore: number,
  f1BetaAvg: number,
  remainingCeoBudget: number,
): boolean {
  // L1: always skip
  if (task.level === 'L1') return false;
  // Budget exhausted: skip
  if (remainingCeoBudget <= 0) return false;
  // L3: always review
  if (task.level === 'L3') return true;
  // High clarity or high F1-β: skip
  if (clarityScore > CEO_SKIP_CLARITY_SCORE) return false;
  if (f1BetaAvg > CEO_SKIP_F1BETA_SCORE) return false;
  // Single file addition only: skip
  if ((task.modified_files ?? []).length === 1 && task.ceo_iteration === 0) return false;
  return true;
}

export function getCeoModel(level: TaskLevel): 'sonnet' | 'opus' {
  return level === 'L3' ? 'opus' : 'sonnet';
}

export class IterationTracker {
  canRetry(iteration: number): boolean {
    return iteration < MAX_CEO_ROUNDS - 1;
  }

  getMaxRounds(): number {
    return MAX_CEO_ROUNDS;
  }

  decideEscalate(score: number, iteration: number): boolean {
    if (iteration >= MAX_CEO_ROUNDS - 1) return true;
    return false;
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/ceo/
git commit -m "feat(ceo): add IterationTracker with skip logic and tiered model selection"
```

---

### Task 5: CeoAgent + BatchReviewer

**Files:**
- Create: `packages/ceo/src/ceo-agent.ts`
- Create: `packages/ceo/src/batch-reviewer.ts`
- Create: `packages/ceo/__tests__/ceo-agent.test.ts`
- Create: `packages/ceo/__tests__/batch-reviewer.test.ts`

- [ ] **Step 1: 实现 ceo-agent.ts**

```typescript
// packages/ceo/src/ceo-agent.ts
import type { CeoReviewInput, CeoFeedback, CeoReviewResult } from '@parallelc/shared';
import { MAX_REVIEW_OUTPUT_TOKENS } from '@parallelc/shared';
import { matchIntent } from './intent-matcher.js';
import { getCeoModel } from './iteration-tracker.js';
import type { TaskLevel } from '@parallelc/shared';

export interface CeoAgentOptions {
  apiKey: string;
  level: TaskLevel;
  useMock?: boolean;
}

// Anthropic 2026 pricing per 1M tokens
const PRICING: Record<string, { input: number; output: number }> = {
  opus: { input: 15, output: 75 },
  sonnet: { input: 3, output: 15 },
};

export async function ceoReview(
  input: CeoReviewInput,
  taskId: string,
  opts: CeoAgentOptions,
): Promise<CeoReviewResult> {
  const model = getCeoModel(opts.level);

  // Mock mode: use rule-based scoring only
  if (opts.useMock || process.env['PARALLELC_MOCK_CEO_RESPONSE']) {
    const feedback = matchIntent(input);
    return { taskId, feedback, model, tokensUsed: 0, cost: 0 };
  }

  // Real LLM call: rules first, then LLM augments
  const ruleResult = matchIntent(input);

  // Build CEO review prompt
  const prompt = buildCeoPrompt(input, ruleResult);

  // Call Claude API (using child_process spawn)
  const { spawnSync } = await import('child_process');
  const claudeResult = spawnSync('claude', [
    '--model', model,
    '--max-tokens', String(MAX_REVIEW_OUTPUT_TOKENS),
    '--system', CEO_SYSTEM_PROMPT,
    '--prompt', prompt,
  ], {
    env: { ...process.env, ANTHROPIC_API_KEY: opts.apiKey },
    encoding: 'utf-8',
    timeout: 60_000,
  });

  if (claudeResult.error || claudeResult.status !== 0) {
    // LLM failed, fall back to rule-based result
    const price = PRICING[model] ?? PRICING['sonnet']!;
    return { taskId, feedback: ruleResult, model, tokensUsed: 0, cost: 0 };
  }

  const output = claudeResult.stdout.trim();
  const inputTokens = Math.ceil(prompt.length / 3.5);
  const outputTokens = Math.ceil(output.length / 3.5);
  const price = PRICING[model] ?? PRICING['sonnet']!;
  const cost = (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;

  // Parse LLM feedback or fall back to rules
  let llmFeedback: CeoFeedback | null = null;
  try {
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) llmFeedback = JSON.parse(jsonMatch[0]) as CeoFeedback;
  } catch { /* parse error, use rules */ }

  return {
    taskId,
    feedback: llmFeedback ?? ruleResult,
    model,
    tokensUsed: inputTokens + outputTokens,
    cost,
  };
}

const CEO_SYSTEM_PROMPT = `你是代码审查专家（CEO角色）。你的任务是审查 Worker 的代码修改是否与用户需求对齐。

审查维度（0-100分）：
1. 功能覆盖 (35分): diff 是否实现了需求中的所有关键功能
2. 缺失检测 (25分): 需求中是否有未实现的关键功能（扣分）
3. 多余修改 (20分): 是否修改了与需求无关的文件（扣分）
4. 副作用风险 (20分): 是否修改了 exports/imports 影响其他模块（扣分）

输出严格 JSON：
{
  "verdict": "PASS|REVISION|ESCALATE",
  "score": 0-100,
  "summary": "一句话总结",
  "gaps": ["缺失项"],
  "excess": ["多余修改"],
  "sideEffects": ["副作用"],
  "suggestions": ["具体修改建议"]
}`;

function buildCeoPrompt(input: CeoReviewInput, ruleResult: CeoFeedback): string {
  return `## 用户原始需求
${input.userRequest}

## 任务描述
${input.taskTitle}
理由: ${input.taskReasoning}

## Worker 修改的文件
${input.modifiedFiles.join('\n')}

## Worker 代码变更 (diff)
\`\`\`diff
${input.diff.slice(0, 8000)}
\`\`\`

## 规则引擎预评分
- 功能覆盖: 检查需求关键词是否在 diff 中有对应实现
- 缺失检测: 需求中在 diff 中无对应的关键词
- 多余检测: 修改了与任务无关的文件
- 副作用: export/import 变更

## 审查轮次
第 ${input.iteration + 1} 轮（最多 3 轮）

## 输出要求
输出 JSON，verdict 为 PASS(>=80分)/REVISION(50-79分)/ESCALATE(<50分或第3轮未通过)`;
}
```

- [ ] **Step 2: 实现 batch-reviewer.ts**

```typescript
// packages/ceo/src/batch-reviewer.ts
import Database from 'better-sqlite3';
import type { Task, CeoReviewInput, CeoReviewResult } from '@parallelc/shared';
import { queryTasksByStatus } from '@parallelc/taskboard';
import { ceoReview } from './ceo-agent.js';
import { shouldReview } from './iteration-tracker.js';

export interface BatchReviewResult {
  reviewed: number;
  passed: number;
  revision: number;
  escalated: number;
  skipped: number;
  totalCost: number;
  results: CeoReviewResult[];
}

export async function ceoBatchReview(
  db: Database.Database,
  repoRoot: string,
  apiKey: string,
  clarityScore: number,
  f1BetaAvg: number,
  remainingCeoBudget: number,
  userRequest: string,
): Promise<BatchReviewResult> {
  const reviewTasks = queryTasksByStatus(db, 'REVIEW_PENDING');
  const batchResult: BatchReviewResult = {
    reviewed: 0, passed: 0, revision: 0, escalated: 0, skipped: 0,
    totalCost: 0, results: [],
  };

  for (const task of reviewTasks) {
    // Check skip conditions
    if (!shouldReview(task, clarityScore, f1BetaAvg, remainingCeoBudget)) {
      batchResult.skipped++;
      // Auto-pass skipped tasks
      batchResult.results.push({
        taskId: task.id,
        feedback: { verdict: 'PASS', score: 100, summary: 'Auto-passed (CEO review skipped)',
          gaps: [], excess: [], sideEffects: [], suggestions: [] },
        model: 'sonnet', tokensUsed: 0, cost: 0,
      });
      continue;
    }

    // Build review input
    const diff = getTaskDiff(repoRoot, task);
    const input: CeoReviewInput = {
      userRequest,
      taskTitle: task.title,
      taskReasoning: '', // stored in task metadata if available
      diff,
      modifiedFiles: task.modified_files ?? [],
      iteration: task.ceo_iteration,
    };

    const result = await ceoReview(input, task.id, {
      apiKey,
      level: task.level,
    });

    batchResult.results.push(result);
    batchResult.totalCost += result.cost;
    batchResult.reviewed++;

    switch (result.feedback.verdict) {
      case 'PASS':  batchResult.passed++; break;
      case 'REVISION': batchResult.revision++; break;
      case 'ESCALATE': batchResult.escalated++; break;
    }
  }

  return batchResult;
}

function getTaskDiff(repoRoot: string, task: Task): string {
  const { execSync } = require('child_process');
  try {
    return execSync('git diff HEAD', {
      cwd: repoRoot, encoding: 'utf-8', timeout: 10_000,
    });
  } catch {
    return '(diff unavailable)';
  }
}
```

- [ ] **Step 3: 编写测试**

```typescript
// packages/ceo/__tests__/ceo-agent.test.ts
import { ceoReview } from '../src/ceo-agent';
import type { CeoReviewInput } from '@parallelc/shared';

const makeInput = (): CeoReviewInput => ({
  userRequest: '在 src/api/auth.ts 中添加 JWT 登录接口',
  taskTitle: '实现 JWT 登录 API',
  taskReasoning: '创建登录路由和 JWT 签发逻辑',
  diff: '+export function login() { return { token: "xxx" }; }',
  modifiedFiles: ['src/api/auth.ts'],
  iteration: 0,
});

describe('ceoReview', () => {
  test('Mock 模式使用规则引擎评分', async () => {
    const result = await ceoReview(makeInput(), 'task-001', {
      apiKey: 'sk-test', level: 'L2', useMock: true,
    });
    expect(result.feedback.verdict).toBeDefined();
    expect(result.feedback.score).toBeGreaterThanOrEqual(0);
    expect(result.feedback.score).toBeLessThanOrEqual(100);
    expect(result.model).toBe('sonnet');
    expect(result.tokensUsed).toBe(0);
    expect(result.cost).toBe(0);
  });

  test('L3 任务使用 Opus 模型', async () => {
    const result = await ceoReview(makeInput(), 'task-002', {
      apiKey: 'sk-test', level: 'L3', useMock: true,
    });
    expect(result.model).toBe('opus');
  });
});
```

```typescript
// packages/ceo/__tests__/batch-reviewer.test.ts
import Database from 'better-sqlite3';
import { initializeSchema, createTask, casUpdateStatus } from '@parallelc/taskboard';
import { ceoBatchReview } from '../src/batch-reviewer';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
});

afterEach(() => db.close());

describe('ceoBatchReview', () => {
  test('空 REVIEW_PENDING 队列 → skipped=0', async () => {
    const result = await ceoBatchReview(db, '/tmp', 'sk-test', 70, 0.6, 10, 'test');
    expect(result.reviewed).toBe(0);
    expect(result.skipped).toBe(0);
  });

  test('L1 任务 → 自动跳过', async () => {
    createTask(db, {
      id: 'task-001', title: 'Simple fix', level: 'L1',
      expected_touch_files: ['src/a.ts'], snapshot_version: 'v1',
    });
    // Manually set to REVIEW_PENDING for test
    db.prepare("UPDATE tasks SET status = 'REVIEW_PENDING' WHERE id = ?").run('task-001');

    const result = await ceoBatchReview(db, '/tmp', 'sk-test', 70, 0.6, 10, 'test');
    expect(result.skipped).toBe(1);
  });
});
```

- [ ] **Step 4: Commit**

```bash
git add packages/ceo/
git commit -m "feat(ceo): add CeoAgent with LLM review and BatchReviewer orchestrator"
```

---

### Task 6: CLI

**Files:**
- Create: `packages/ceo/src/cli.ts`

- [ ] **Step 1: 实现 cli.ts**

```typescript
#!/usr/bin/env node

import { getDb, initializeSchema, queryTasksByStatus, casUpdateStatus } from '@parallelc/taskboard';
import { ceoBatchReview } from './batch-reviewer.js';

const command = process.argv[2];

if (command === 'review') {
  const args = process.argv.slice(3);
  const getArg = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i+1] : undefined; };
  const dagId = getArg('--dag');
  const dbPath = getArg('--db') ?? '.parallelc/taskboard.db';
  const repoRoot = getArg('--repo') ?? process.cwd();
  const apiKey = getArg('--api-key') ?? process.env['ANTHROPIC_API_KEY'];

  if (!apiKey) {
    console.error('Usage: parallelc-ceo review --repo <path> --api-key <key> [--dag <id>] [--db <path>]');
    process.exit(1);
  }

  const db = getDb(dbPath);
  initializeSchema(db);

  ceoBatchReview(db, repoRoot, apiKey, 70, 0.6, 10, '').then(result => {
    console.log(`CEO Review: ${result.passed} passed, ${result.revision} revision, ${result.escalated} escalated, ${result.skipped} skipped`);
    console.log(`Total cost: $${result.totalCost.toFixed(4)}`);

    for (const r of result.results) {
      // Update task status based on verdict
      const task = queryTasksByStatus(db, 'REVIEW_PENDING').find(t => t.id === r.taskId);
      if (!task) continue;

      switch (r.feedback.verdict) {
        case 'PASS':
          casUpdateStatus(db, r.taskId, task.version, 'REVIEW_PENDING', 'DONE');
          console.log(`  ${r.taskId}: PASS (score=${r.feedback.score})`);
          break;
        case 'REVISION':
          casUpdateStatus(db, r.taskId, task.version, 'REVIEW_PENDING', 'REVISION_NEEDED');
          console.log(`  ${r.taskId}: REVISION (score=${r.feedback.score}) — ${r.feedback.summary}`);
          break;
        case 'ESCALATE':
          casUpdateStatus(db, r.taskId, task.version, 'REVIEW_PENDING', 'CEO_ESCALATED');
          console.log(`  ${r.taskId}: ESCALATED (score=${r.feedback.score}) — ${r.feedback.summary}`);
          break;
      }
    }

    db.close();
  });

} else if (command === 'status') {
  const dbPath = process.argv.slice(3).find(a => a.startsWith('--db='))?.split('=')[1] ?? '.parallelc/taskboard.db';
  const db = getDb(dbPath);

  const reviewPending = queryTasksByStatus(db, 'REVIEW_PENDING');
  const revisionNeeded = queryTasksByStatus(db, 'REVISION_NEEDED');
  const escalated = queryTasksByStatus(db, 'CEO_ESCALATED');

  console.log('CEO Review Status:');
  console.log(`  REVIEW_PENDING:  ${reviewPending.length}`);
  console.log(`  REVISION_NEEDED: ${revisionNeeded.length}`);
  console.log(`  CEO_ESCALATED:   ${escalated.length}`);

  if (escalated.length > 0) {
    console.log('\nEscalated tasks:');
    for (const t of escalated) {
      console.log(`  ${t.id}: ${t.title} (score=${t.ceo_score}, iteration=${t.ceo_iteration})`);
    }
  }

  db.close();

} else if (command === 'confirm') {
  const args = process.argv.slice(3);
  const getArg = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i+1] : undefined; };
  const taskId = getArg('--task');
  const verdict = getArg('--verdict') ?? 'pass';
  const dbPath = getArg('--db') ?? '.parallelc/taskboard.db';

  if (!taskId) {
    console.error('Usage: parallelc-ceo confirm --task <id> [--verdict pass|revision]');
    process.exit(1);
  }

  const db = getDb(dbPath);
  const tasks = queryTasksByStatus(db, 'CEO_ESCALATED');
  const task = tasks.find(t => t.id === taskId);

  if (!task) {
    console.error(`Task ${taskId} not found or not in CEO_ESCALATED state`);
    process.exit(1);
  }

  const toStatus = verdict === 'pass' ? 'DONE' : 'READY';
  casUpdateStatus(db, taskId, task.version, 'CEO_ESCALATED', toStatus);
  console.log(`Task ${taskId}: CEO_ESCALATED → ${toStatus}`);
  db.close();

} else {
  console.log('ParallelC CEO v0.1.0');
  console.log('  review  --repo <path> --api-key <key> [--dag <id>]');
  console.log('  status  [--db <path>]');
  console.log('  confirm --task <id> [--verdict pass|revision]');
  process.exit(0);
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/ceo/src/cli.ts
git commit -m "feat(ceo): add CLI with review, status, and confirm commands"
```

---

### Task 7: Scheduler 集成

**Files:**
- Modify: `packages/scheduler/src/dispatch-loop.ts`
- Modify: `packages/scheduler/package.json`

- [ ] **Step 1: 修改 dispatch-loop.ts — 新增 ceoReviewTick**

在 `startScheduler()` 的主循环中增加 ceoReviewTick 调用：

```typescript
// 在 import 区新增：
import { ceoBatchReview } from '@parallelc/ceo';

// 在主循环中（dispatchTick, reapTick 之后，wakeTick 之前）：
const ceoReview = ceoReviewTick(db, pool, repoRoot, dbPath, config.apiKeys[0] ?? '');

// 新增 ceoReviewTick 函数：
async function ceoReviewTick(
  db: Database.Database,
  pool: WorkerPool,
  repoRoot: string,
  dbPath: string,
  apiKey: string,
): Promise<BatchReviewResult> {
  const reviewTasks = queryTasksByStatus(db, 'REVIEW_PENDING');
  if (reviewTasks.length === 0) {
    return { reviewed: 0, passed: 0, revision: 0, escalated: 0, skipped: 0, totalCost: 0, results: [] };
  }

  const f1Avg = f1Tracker?.getAverageScore() ?? 0;
  const ceoBudget = (costTracker?.getSummary().sessionCost ?? 0) < 5.0 ? 5.0 : 0;
  const clarityScore = 80; // Default, actual value from Orchestrator if available

  const result = await ceoBatchReview(
    db, repoRoot, apiKey, clarityScore, f1Avg, ceoBudget, '',
  );

  // Process results
  for (const r of result.results) {
    const task = queryTaskById(db, r.taskId);
    if (!task) continue;

    switch (r.feedback.verdict) {
      case 'PASS': {
        casUpdateStatus(db, r.taskId, task.version, 'REVIEW_PENDING', 'DONE');
        auditLogger?.log('MERGE_CONFIRMED', { taskId: r.taskId, ceoScore: r.feedback.score });
        // Proceed to merge
        coordinateMerge(
          { repoRoot, dbPath, writeRoot: repoRoot },
          r.taskId,
        ).catch(err => console.error(`Merge failed for ${r.taskId}:`, err.message));
        break;
      }
      case 'REVISION': {
        casUpdateStatus(db, r.taskId, task.version, 'REVIEW_PENDING', 'REVISION_NEEDED');
        // Create revision child task
        const childId = `${r.taskId}-r${(task.ceo_iteration ?? 0) + 1}`;
        createTask(db, {
          id: childId,
          title: `${task.title} (Revision ${(task.ceo_iteration ?? 0) + 1})`,
          expected_touch_files: task.modified_files ?? task.expected_touch_files ?? [],
          level: task.level,
          snapshot_version: task.snapshot_version ?? 'unknown',
          dependencies: null,
        });
        // Update child task with CEO feedback and iteration
        db.prepare(`UPDATE tasks SET ceo_feedback = ?, ceo_iteration = ?, parent_task_id = ? WHERE id = ?`)
          .run(JSON.stringify(r.feedback), (task.ceo_iteration ?? 0) + 1, r.taskId, childId);
        auditLogger?.log('TASK_CREATED', {
          taskId: childId, parentTaskId: r.taskId, reason: `CEO REVISION (score=${r.feedback.score})`,
        });
        break;
      }
      case 'ESCALATE': {
        casUpdateStatus(db, r.taskId, task.version, 'REVIEW_PENDING', 'CEO_ESCALATED');
        db.prepare(`UPDATE tasks SET ceo_feedback = ?, ceo_score = ? WHERE id = ?`)
          .run(JSON.stringify(r.feedback), r.feedback.score, r.taskId);
        auditLogger?.log('MERGE_BLOCKED', {
          taskId: r.taskId, reason: `CEO ESCALATED (score=${r.feedback.score})`,
        });
        break;
      }
    }
  }

  if (result.reviewed > 0) {
    console.log(`[CEO] Review: ${result.passed} passed, ${result.revision} revision, ${result.escalated} escalated, ${result.skipped} skipped | cost=$${result.totalCost.toFixed(4)}`);
  }

  return result;
}
```

- [ ] **Step 2: 修改 MARK_DONE 路由**

在 `reapTick` 的 `MARK_DONE` case 中，将直接 `coordinateMerge` 改为先进入 `REVIEW_PENDING`：

```typescript
case 'MARK_DONE': {
  updateTask(db, task.id, task.version, { modified_files: action.modifiedFiles });
  // Route to CEO review instead of directly marking DONE
  casUpdateStatus(db, task.id, task.version + 1, 'RUNNING', 'DONE');
  // ↑ DONE → REVIEW_PENDING transition happens in ceoReviewTick
  // Tasks in DONE status with CEO-enabled config will be picked up by ceoReviewTick
```

实际情况中，`casUpdateStatus(db, task.id, ..., 'RUNNING', 'DONE')` 不变，但 ceoReviewTick 会查询所有 REVIEW_PENDING 状态的任务。需要额外一步将 DONE 转为 REVIEW_PENDING。

更简洁的做法：在 MARK_DONE 中直接设置 `REVIEW_PENDING`：

```typescript
case 'MARK_DONE': {
  updateTask(db, task.id, task.version, { modified_files: action.modifiedFiles });
  const nextStatus = 'REVIEW_PENDING'; // All tasks go through CEO review
  casUpdateStatus(db, task.id, task.version + 1, 'RUNNING', nextStatus);
  pool.getKeyPool().markSuccess(entry.apiKey);
  auditLogger?.log('TASK_COMPLETED', { taskId: task.id, status: nextStatus });
  // CEO review happens in ceoReviewTick on next cycle
  result.done++;
  break;
}
```

这样不需要单独的 DONE → REVIEW_PENDING 转换步骤，Worker 完成直接进入审查队列。

- [ ] **Step 3: 修改 scheduler/package.json**

添加依赖：

```json
"@parallelc/ceo": "workspace:*",
```

- [ ] **Step 4: Commit**

```bash
git add packages/scheduler/
git commit -m "feat(scheduler): integrate ceoReviewTick into dispatch loop"
```

---

## 依赖顺序

```
Task 1 (包骨架 + 共享类型)
  └─ Task 2 (Schema 扩展)
       └─ Task 3 (IntentMatcher + FeedbackGenerator)
            └─ Task 4 (IterationTracker)
                 └─ Task 5 (CeoAgent + BatchReviewer)
                      ├─ Task 6 (CLI)
                      └─ Task 7 (Scheduler 集成)
```

---

## 验收对照

| # | 验收项 | Task |
|---|--------|------|
| 1 | CEO 审查评分引擎（4 维度） | Task 3 |
| 2 | 批处理审查（ceoBatchReview） | Task 5 |
| 3 | PASS/REVISION/ESCALATE 三态决策 | Task 3 |
| 4 | 审查-修改迭代循环（最多 3 轮） | Task 4 |
| 5 | 分层跳过条件（L1/高F1-β/高清晰度/预算耗尽） | Task 4 |
| 6 | 状态机扩展（3 状态 + 4 列） | Task 2 |
| 7 | Scheduler 集成（ceoReviewTick） | Task 7 |
| 8 | CLI（review/status/confirm） | Task 6 |
| 9 | Mock 模式（环境变量控制） | Task 5 |
| 10 | 成本追踪（$1/DAG, $5/会话） | Task 4 |
