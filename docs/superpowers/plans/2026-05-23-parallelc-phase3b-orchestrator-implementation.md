# ParallelC Phase 3B Orchestrator 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Orchestrator 智能任务分解系统——接收用户需求，自动分解为 Task DAG，预测文件锁，按 L1/L2/L3 分级，写入 TaskBoard 供 Scheduler 派发。

**Architecture:** 三阶段流水线：Pre-process（确定性上下文提取）→ LLM Decompose（Claude Opus MCP 分解）→ Post-validate（硬约束校验 + L1 直接执行 + L3 人工确认）。LLM 提供语义理解，确定性代码负责边界校验。

**Tech Stack:** TypeScript (strict), pnpm workspaces, better-sqlite3, child_process, Jest + ts-jest

**基于规范:** `docs/superpowers/specs/2026-05-23-parallelc-phase3b-orchestrator-design.md`

---

### Task 1: @parallelc/orchestrator — 包骨架

**Files:**
- Create: `packages/orchestrator/package.json`
- Create: `packages/orchestrator/tsconfig.json`
- Create: `packages/orchestrator/jest.config.ts`
- Create: `packages/orchestrator/src/index.ts`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "@parallelc/orchestrator",
  "version": "0.1.0",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "bin": {
    "parallelc-orchestrate": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsup src/index.ts src/cli.ts --format cjs,esm --dts --clean",
    "typecheck": "tsc --noEmit",
    "test": "jest",
    "test:ci": "jest --ci --coverage"
  },
  "dependencies": {
    "@parallelc/shared": "workspace:*",
    "@parallelc/taskboard": "workspace:*",
    "@parallelc/worker": "workspace:*",
    "better-sqlite3": "^11.7.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
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

- [ ] **Step 4: 创建 src/index.ts（骨架导出）**

```typescript
// Pre-process
export { scanRepoContext } from './pre-process/repo-scanner.js';
export type { RepoContext } from './pre-process/repo-scanner.js';
export { extractModuleMap } from './pre-process/module-map.js';
export type { ModuleBoundary } from './pre-process/module-map.js';
export { estimateTokens } from './pre-process/token-estimator.js';
export type { TokenEstimate } from './pre-process/token-estimator.js';

// Decompose
export { buildOrchestratorPrompt } from './decompose/prompt-builder.js';
export type { DecompositionInput } from './decompose/prompt-builder.js';
export { decomposeViaClaude } from './decompose/mcp-decomposer.js';
export type { DecomposerOptions, DecomposerResult } from './decompose/mcp-decomposer.js';
export { parseTaskDAG } from './decompose/response-parser.js';
export type { TaskDraft } from './decompose/response-parser.js';

// Post-validate
export { enforceHardRules } from './post-validate/rule-engine.js';
export type { RuleResult } from './post-validate/rule-engine.js';
export { validatePaths } from './post-validate/path-validator.js';
export type { PathValidation } from './post-validate/path-validator.js';
export { validateDAG } from './post-validate/dag-validator.js';
export type { DagValidation } from './post-validate/dag-validator.js';
export { executeL1Directly } from './post-validate/l1-executor.js';
export type { L1ExecutionResult } from './post-validate/l1-executor.js';
export { confirmL3Tasks } from './post-validate/l3-confirm.js';
export type { L3Confirmation } from './post-validate/l3-confirm.js';

// Core
export { buildDAG } from './dag-builder.js';
export type { BuildDagOptions, BuildDagResult } from './dag-builder.js';
export { recordPrediction, updatePredictionRecord, getPredictionAccuracy } from './metrics-collector.js';
export type { PredictionRecord } from './metrics-collector.js';
```

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/
git commit -m "feat(orchestrator): add package skeleton with full export map"
```

---

### Task 2: Pre-process（repo-scanner + module-map + token-estimator）

**Files:**
- Create: `packages/orchestrator/src/pre-process/repo-scanner.ts`
- Create: `packages/orchestrator/src/pre-process/module-map.ts`
- Create: `packages/orchestrator/src/pre-process/token-estimator.ts`
- Create: `packages/orchestrator/__tests__/pre-process.test.ts`

- [ ] **Step 1: 编写测试**

Create `packages/orchestrator/__tests__/pre-process.test.ts`:

```typescript
import { scanRepoContext } from '../src/pre-process/repo-scanner';
import { extractModuleMap } from '../src/pre-process/module-map';
import { estimateTokens } from '../src/pre-process/token-estimator';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';

let repoRoot: string;
let db: Database.Database;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallelc-orch-pre-'));
  db = new Database(':memory:');
  // 创建示例仓库结构
  fs.mkdirSync(path.join(repoRoot, 'src/api'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'src/models'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'src/utils'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src/api/user.ts'), 'export const getUser = () => {}');
  fs.writeFileSync(path.join(repoRoot, 'src/models/user.ts'), 'import { getUser } from "../api/user";\nexport class User {}');
  fs.writeFileSync(path.join(repoRoot, 'src/utils/helper.ts'), 'export const helper = 1;');
  fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'test-project' }));
  fs.writeFileSync(path.join(repoRoot, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { paths: { "@app/*": ["src/*"] } }
  }));
});

afterEach(() => {
  db.close();
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('scanRepoContext', () => {
  test('扫描仓库并返回文件树和模块目录', () => {
    const ctx = scanRepoContext(repoRoot, db);
    expect(ctx.fileTree).toContain('src/api/user.ts');
    expect(ctx.fileTree).toContain('src/models/user.ts');
    expect(ctx.moduleDirs).toContain('src/api');
    expect(ctx.moduleDirs).toContain('src/models');
    expect(ctx.moduleDirs).toContain('src/utils');
    expect(ctx.packageJson?.name).toBe('test-project');
  });

  test('跳过 node_modules 和 .git', () => {
    fs.mkdirSync(path.join(repoRoot, 'node_modules/test'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'node_modules/test/index.js'), '');
    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, '.git/config'), '');

    const ctx = scanRepoContext(repoRoot, db);
    expect(ctx.fileTree.every(f => !f.startsWith('node_modules/'))).toBe(true);
    expect(ctx.fileTree.every(f => !f.startsWith('.git/'))).toBe(true);
  });
});

describe('extractModuleMap', () => {
  test('优先使用 tsconfig paths', () => {
    const ctx = scanRepoContext(repoRoot, db);
    const modules = extractModuleMap(ctx, repoRoot);
    // 应检测到 @app/* → src/* 映射
    expect(modules.length).toBeGreaterThan(0);
  });

  test('从 import 语句提取模块间依赖', () => {
    const ctx = scanRepoContext(repoRoot, db);
    const modules = extractModuleMap(ctx, repoRoot);
    const modelsModule = modules.find(m => m.dir === 'src/models');
    expect(modelsModule).toBeDefined();
    expect(modelsModule!.imports.length).toBeGreaterThan(0);
  });
});

describe('estimateTokens', () => {
  test('基于文件字符数估算 token', () => {
    const estimate = estimateTokens(['src/api/user.ts', 'src/models/user.ts'], repoRoot);
    expect(estimate.estimatedTokens).toBeGreaterThan(0);
    expect(estimate.totalChars).toBeGreaterThan(0);
  });

  test('空文件列表返回 0', () => {
    const estimate = estimateTokens([], repoRoot);
    expect(estimate.estimatedTokens).toBe(0);
  });

  test('不存在的文件不算入', () => {
    const estimate = estimateTokens(['src/api/user.ts', 'nonexistent.ts'], repoRoot);
    expect(estimate.totalChars).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 验证测试失败**

Run: `cd packages/orchestrator && npx jest --testPathPattern="pre-process"`
Expected: FAIL

- [ ] **Step 3: 实现 repo-scanner.ts**

```typescript
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { queryTasksByStatus } from '@parallelc/taskboard';

export interface RepoContext {
  fileTree: string[];
  moduleDirs: string[];
  packageJson: { name: string; scripts: Record<string,string>; dependencies: Record<string,string> } | null;
  existingTasks: string[];
}

export function scanRepoContext(repoRoot: string, db: Database.Database): RepoContext {
  const skip = new Set(['node_modules', '.git', 'dist', '.parallelc', 'worktrees']);
  const fileTree: string[] = [];
  const dirSet = new Set<string>();

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else {
        const rel = path.relative(repoRoot, full).replace(/\\/g, '/');
        fileTree.push(rel);
        dirSet.add(path.dirname(rel));
      }
    }
  }

  walk(repoRoot);

  let packageJson = null;
  try {
    packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
  } catch {}

  const existing = queryTasksByStatus(db, ['PENDING','READY','RUNNING','SLEEP_PENDING','CHECKPOINT_PENDING']);
  const existingTasks = existing.map(t => t.title);

  return {
    fileTree: fileTree.sort(),
    moduleDirs: [...dirSet].sort(),
    packageJson,
    existingTasks,
  };
}
```

- [ ] **Step 4: 实现 module-map.ts**

```typescript
import fs from 'fs';
import path from 'path';
import type { RepoContext } from './repo-scanner.js';

export interface ModuleBoundary {
  dir: string;
  files: string[];
  imports: string[];
  exportedSymbols: string[];
}

export function extractModuleMap(ctx: RepoContext, repoRoot: string): ModuleBoundary[] {
  // 1. tsconfig paths
  const pathAliases = new Map<string, string>();
  try {
    const tsconfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tsconfig.json'), 'utf-8'));
    const paths = tsconfig.compilerOptions?.paths ?? {};
    for (const [alias, targets] of Object.entries(paths) as [string, string[]][]) {
      const target = targets[0]?.replace('/*', '');
      if (target) pathAliases.set(alias.replace('/*', ''), target);
    }
  } catch {}

  // 2. package.json workspaces
  const workspaceDirs: string[] = [];
  if (ctx.packageJson?.workspaces) {
    // 简化处理：仅记录 workspaces 声明
  }

  // 3. 启发式：每个 top-level src/ 子目录为一个模块
  const modules = new Map<string, ModuleBoundary>();
  for (const file of ctx.fileTree) {
    const parts = file.split('/');
    const moduleDir = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0]!;
    let mod = modules.get(moduleDir);
    if (!mod) {
      mod = { dir: moduleDir, files: [], imports: [], exportedSymbols: [] };
      modules.set(moduleDir, mod);
    }
    mod.files.push(file);

    // 解析 import 和 export
    try {
      const content = fs.readFileSync(path.join(repoRoot, file), 'utf-8');
      const importMatches = content.matchAll(/from\s+['"]([^'"]+)['"]/g);
      for (const m of importMatches) {
        if (!m[1]!.startsWith('.') && !m[1]!.startsWith('@parallelc')) {
          mod.imports.push(m[1]!);
        }
      }
      const exportMatches = content.matchAll(/export\s+(?:const|function|class|interface|type)\s+(\w+)/g);
      for (const m of exportMatches) {
        mod.exportedSymbols.push(m[1]!);
      }
    } catch {}
  }

  return [...modules.values()];
}
```

- [ ] **Step 5: 实现 token-estimator.ts**

```typescript
import fs from 'fs';
import path from 'path';

export interface TokenEstimate {
  estimatedTokens: number;
  totalChars: number;
  reasoning: string;
}

const CHARS_PER_TOKEN = 2; // 保守估计

export function estimateTokens(files: string[], repoRoot: string): TokenEstimate {
  let totalChars = 0;
  let count = 0;
  for (const f of files) {
    try {
      const content = fs.readFileSync(path.join(repoRoot, f), 'utf-8');
      totalChars += content.length;
      count++;
    } catch {
      // 文件不存在（可能是新建），估算 500 字符
      totalChars += 500;
    }
  }
  const estimatedTokens = Math.ceil(totalChars / CHARS_PER_TOKEN);
  return {
    estimatedTokens,
    totalChars,
    reasoning: `${count} 文件, ${totalChars} 字符, ${estimatedTokens} tokens (${CHARS_PER_TOKEN} chars/token)`,
  };
}
```

- [ ] **Step 6: 验证测试通过**

Run: `cd packages/orchestrator && npx jest --testPathPattern="pre-process"`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/orchestrator/
git commit -m "feat(orchestrator): add pre-process modules (repo-scanner, module-map, token-estimator)"
```

---

### Task 3: Decompose（prompt-builder + mcp-decomposer + response-parser）

**Files:**
- Create: `packages/orchestrator/src/decompose/prompt-builder.ts`
- Create: `packages/orchestrator/src/decompose/mcp-decomposer.ts`
- Create: `packages/orchestrator/src/decompose/response-parser.ts`
- Create: `packages/orchestrator/__tests__/decompose.test.ts`

- [ ] **Step 1: 编写测试**

Create `packages/orchestrator/__tests__/decompose.test.ts`:

```typescript
import { buildOrchestratorPrompt, type DecompositionInput } from '../src/decompose/prompt-builder';
import { parseTaskDAG } from '../src/decompose/response-parser';

const makeInput = (): DecompositionInput => ({
  userRequest: 'Add user login API with JWT auth',
  repoContext: {
    fileTree: ['src/api/auth.ts', 'src/models/user.ts', 'src/utils/jwt.ts'],
    moduleDirs: ['src/api', 'src/models', 'src/utils'],
    packageJson: { name: 'test', scripts: {}, dependencies: {} },
    existingTasks: [],
  },
  moduleMap: [
    { dir: 'src/api', files: ['src/api/auth.ts'], imports: [], exportedSymbols: ['login'] },
    { dir: 'src/models', files: ['src/models/user.ts'], imports: ['../api/auth'], exportedSymbols: ['User'] },
    { dir: 'src/utils', files: ['src/utils/jwt.ts'], imports: [], exportedSymbols: ['sign'] },
  ],
});

describe('buildOrchestratorPrompt', () => {
  test('包含用户需求', () => {
    const prompt = buildOrchestratorPrompt(makeInput());
    expect(prompt).toContain('Add user login API');
  });

  test('包含仓库上下文摘要', () => {
    const prompt = buildOrchestratorPrompt(makeInput());
    expect(prompt).toContain('src/api/auth.ts');
    expect(prompt).toContain('src/models/user.ts');
  });

  test('包含 L1/L2/L3 分级规则', () => {
    const prompt = buildOrchestratorPrompt(makeInput());
    expect(prompt).toContain('L1');
    expect(prompt).toContain('L2');
    expect(prompt).toContain('L3');
    expect(prompt).toContain('expected_touch_files');
  });

  test('包含 JSON 输出格式要求', () => {
    const prompt = buildOrchestratorPrompt(makeInput());
    expect(prompt).toContain('JSON');
    expect(prompt).toContain('"tasks"');
  });

  test('包含模块依赖信息', () => {
    const prompt = buildOrchestratorPrompt(makeInput());
    expect(prompt).toContain('src/api');
    expect(prompt).toContain('src/models');
  });
});

describe('parseTaskDAG', () => {
  test('解析合法 JSON 响应', () => {
    const json = `{
  "dagId": "dag-test",
  "summary": "Add login API",
  "tasks": [
    {
      "title": "Create auth route",
      "level": "L2",
      "expected_touch_files": ["src/api/auth.ts"],
      "dependencies": [],
      "reasoning": "New route file"
    },
    {
      "title": "Add JWT middleware",
      "level": "L2",
      "expected_touch_files": ["src/utils/jwt.ts"],
      "dependencies": ["Create auth route"],
      "reasoning": "JWT helpers"
    }
  ]
}`;

    const result = parseTaskDAG(json);
    expect(result).not.toBeNull();
    expect(result!.dagId).toBe('dag-test');
    expect(result!.tasks).toHaveLength(2);
    expect(result!.tasks[0]!.level).toBe('L2');
    expect(result!.tasks[1]!.dependencies).toContain('Create auth route');
  });

  test('解析无效 JSON 返回 null', () => {
    const result = parseTaskDAG('not json {');
    expect(result).toBeNull();
  });

  test('解析缺少 tasks 字段返回 null', () => {
    const json = '{"dagId": "test", "summary": "test"}';
    const result = parseTaskDAG(json);
    expect(result).toBeNull();
  });

  test('解析含 markdown code block 的 JSON', () => {
    const json = '```json\n{"dagId":"dag-test","summary":"test","tasks":[]}\n```';
    const result = parseTaskDAG(json);
    expect(result).not.toBeNull();
  });
});
```

- [ ] **Step 2: 验证测试失败**

Run: `cd packages/orchestrator && npx jest --testPathPattern="decompose"`
Expected: FAIL

- [ ] **Step 3: 实现 prompt-builder.ts**

```typescript
import type { RepoContext } from '../pre-process/repo-scanner.js';
import type { ModuleBoundary } from '../pre-process/module-map.js';

export interface DecompositionInput {
  userRequest: string;
  repoContext: RepoContext;
  moduleMap: ModuleBoundary[];
}

export function buildOrchestratorPrompt(input: DecompositionInput): string {
  const fileTreeStr = input.repoContext.fileTree.map(f => `- ${f}`).join('\n');
  const modulesStr = input.moduleMap.map(m =>
    `  ${m.dir}: ${m.files.length} files, exports: [${m.exportedSymbols.join(', ')}], deps: [${m.imports.join(', ')}]`
  ).join('\n');
  const existingStr = input.repoContext.existingTasks.length > 0
    ? input.repoContext.existingTasks.map(t => `- ${t}`).join('\n')
    : '(none)';

  return `你是任务分解专家。将用户需求拆分为可并行/串行执行的子任务。

## 仓库上下文
**文件树 (${input.repoContext.fileTree.length} files):**
${fileTreeStr}

**模块边界:**
${modulesStr}

**已有未完成任务:**
${existingStr}

## 分级规则（必须严格遵守）
| 级别 | 条件 | 动作 |
|------|------|------|
| L1 | 修改文件数 <=2, 同一目录, 无新建文件, token预估 < 10K | 直接执行, 不创建Task |
| L2 | 修改文件数 3-10, 或跨模块, 或需新建文件 | 创建Task, 进入流水线 |
| L3 | 修改文件数 >10, 或涉及DB schema, 或跨仓库 | 创建Task, 需人工确认 |

**禁止降级**：满足L2条件的任务不可标记为L1。
**expected_touch_files**：必须是仓库中存在的路径。新建文件时填写目标路径。

## 用户需求
${input.userRequest}

## 输出格式（严格JSON）
{
  "dagId": "dag-<timestamp>",
  "summary": "一句话描述",
  "tasks": [
    {
      "title": "任务标题",
      "level": "L1|L2|L3",
      "expected_touch_files": ["path/to/file.ts"],
      "dependencies": ["依赖的task title"],
      "reasoning": "拆分理由"
    }
  ]
}

dependencies 中引用其他 task 的 title（非 ID）。
task 按执行顺序排列，dependencies 只引用排序在前的 task。`;
}
```

- [ ] **Step 4: 实现 response-parser.ts**

```typescript
import type { TaskLevel } from '@parallelc/shared';

export interface TaskDraft {
  title: string;
  level: TaskLevel;
  expected_touch_files: string[];
  dependencies: string[];
  reasoning: string;
}

const VALID_LEVELS = new Set(['L1', 'L2', 'L3']);

export function parseTaskDAG(raw: string): { dagId: string; summary: string; tasks: TaskDraft[] } | null {
  // 尝试提取 markdown code block 中的 JSON
  const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const jsonStr = codeBlockMatch?.[1]?.trim() ?? raw.trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  if (typeof parsed['dagId'] !== 'string' || typeof parsed['summary'] !== 'string' || !Array.isArray(parsed['tasks'])) {
    return null;
  }

  const tasks: TaskDraft[] = [];
  for (const t of parsed['tasks'] as Record<string,unknown>[]) {
    const level = t['level'] as string;
    if (!VALID_LEVELS.has(level)) return null;
    if (typeof t['title'] !== 'string') return null;
    if (!Array.isArray(t['expected_touch_files'])) return null;
    if (!Array.isArray(t['dependencies'])) return null;

    tasks.push({
      title: t['title'],
      level: level as TaskLevel,
      expected_touch_files: t['expected_touch_files'] as string[],
      dependencies: t['dependencies'] as string[],
      reasoning: (t['reasoning'] as string) ?? '',
    });
  }

  return { dagId: parsed['dagId'], summary: parsed['summary'] as string, tasks };
}
```

- [ ] **Step 5: 实现 mcp-decomposer.ts**

```typescript
import { spawnMcpWorker } from '@parallelc/worker';
import type { DecompositionInput } from './prompt-builder.js';
import { buildOrchestratorPrompt } from './prompt-builder.js';
import { parseTaskDAG, type TaskDraft } from './response-parser.js';
import { createHash } from 'crypto';

export interface DecomposerOptions {
  apiKey: string;
  model?: 'sonnet' | 'opus';
  maxTokens?: number;
  timeoutMs?: number;
  cacheKey?: string | null;
}

export interface DecomposerResult {
  raw: string;
  parsed: TaskDraft[] | null;
  tokensUsed: number;
  cached: boolean;
}

// 会话级简单缓存
const cache = new Map<string, DecomposerResult>();

export async function decomposeViaClaude(
  input: DecompositionInput,
  opts: DecomposerOptions,
): Promise<DecomposerResult> {
  const cacheKey = opts.cacheKey === null
    ? null
    : opts.cacheKey ?? createHash('sha1')
        .update(JSON.stringify({ req: input.userRequest, files: input.repoContext.fileTree }))
        .digest('hex').slice(0, 16);

  if (cacheKey && cache.has(cacheKey)) {
    const cached = cache.get(cacheKey)!;
    return { ...cached, cached: true };
  }

  const prompt = buildOrchestratorPrompt(input);

  // MCP 调用 Claude Opus 执行分解
  const child = spawnMcpWorker(
    {
      apiKey: opts.apiKey,
      model: opts.model ?? 'opus',
      cwd: process.cwd(),
      readonlyRoot: process.cwd(),
      maxRounds: 3,
      timeoutMs: opts.timeoutMs ?? 120_000,
    },
    {
      taskId: `orchestrate-${Date.now()}`,
      snapshotVersion: 'N/A',
      dependencies: null,
    },
  );

  // 通过 stdin 注入 prompt
  child.stdin?.write(prompt);
  child.stdin?.end();

  // 收集 stdout 响应
  let raw = '';
  child.stdout?.on('data', (chunk: Buffer) => { raw += chunk.toString(); });

  return new Promise((resolve) => {
    child.on('exit', () => {
      const parsed = parseTaskDAG(raw);
      const result: DecomposerResult = {
        raw,
        parsed: parsed?.tasks ?? null,
        tokensUsed: Math.ceil(raw.length / 3.5),
        cached: false,
      };
      if (cacheKey) cache.set(cacheKey, result);
      resolve(result);
    });
  });
}
```

- [ ] **Step 6: 验证测试通过**

Run: `cd packages/orchestrator && npx jest --testPathPattern="decompose"` (prompt-builder + parser 测试)
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/orchestrator/
git commit -m "feat(orchestrator): add decompose modules (prompt-builder, mcp-decomposer, response-parser)"
```

---

### Task 4: Post-validate（rule-engine + path-validator + dag-validator）

**Files:**
- Create: `packages/orchestrator/src/post-validate/rule-engine.ts`
- Create: `packages/orchestrator/src/post-validate/path-validator.ts`
- Create: `packages/orchestrator/src/post-validate/dag-validator.ts`
- Create: `packages/orchestrator/__tests__/post-validate.test.ts`

- [ ] **Step 1: 编写测试**

Create `packages/orchestrator/__tests__/post-validate.test.ts`:

```typescript
import { enforceHardRules } from '../src/post-validate/rule-engine';
import { validatePaths } from '../src/post-validate/path-validator';
import { validateDAG } from '../src/post-validate/dag-validator';
import type { TaskDraft } from '../src/decompose/response-parser';
import type { RepoContext } from '../src/pre-process/repo-scanner';
import type { ModuleBoundary } from '../src/pre-process/module-map';
import path from 'path';
import fs from 'fs';
import os from 'os';

let repoRoot: string;
let repoContext: RepoContext;
let moduleMap: ModuleBoundary[];

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallelc-orch-val-'));
  fs.mkdirSync(path.join(repoRoot, 'src/api'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'src/models'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src/api/auth.ts'), 'export const login = () => {};\n'.repeat(50));
  fs.writeFileSync(path.join(repoRoot, 'src/models/user.ts'), 'export class User {}\n'.repeat(20));

  repoContext = {
    fileTree: ['src/api/auth.ts', 'src/models/user.ts'],
    moduleDirs: ['src/api', 'src/models'],
    packageJson: null,
    existingTasks: [],
  };
  moduleMap = [
    { dir: 'src/api', files: ['src/api/auth.ts'], imports: [], exportedSymbols: ['login'] },
    { dir: 'src/models', files: ['src/models/user.ts'], imports: [], exportedSymbols: ['User'] },
  ];
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('enforceHardRules', () => {
  test('L1 条件满足 -> DIRECT_EXECUTE', () => {
    const draft: TaskDraft = {
      title: 'Fix typo', level: 'L1',
      expected_touch_files: ['src/api/auth.ts'], dependencies: [], reasoning: '',
    };
    const result = enforceHardRules(draft, repoContext, repoRoot);
    expect(result.action).toBe('DIRECT_EXECUTE');
    expect(result.level).toBe('L1');
  });

  test('LLM 标记 L2 但满足 L1 条件 → 保持 L2（禁止降级）', () => {
    const draft: TaskDraft = {
      title: 'Fix typo', level: 'L2',
      expected_touch_files: ['src/api/auth.ts'], dependencies: [], reasoning: '',
    };
    const result = enforceHardRules(draft, repoContext, repoRoot);
    expect(result.level).toBe('L2');
    expect(result.action).toBe('CREATE_TASK');
  });

  test('文件数 >10 → L3', () => {
    const manyFiles = Array.from({ length: 11 }, (_, i) => `src/mod${i}.ts`);
    const draft: TaskDraft = {
      title: 'Big refactor', level: 'L1',
      expected_touch_files: manyFiles, dependencies: [], reasoning: '',
    };
    const result = enforceHardRules(draft, repoContext, repoRoot);
    expect(result.level).toBe('L3');
    expect(result.action).toBe('HUMAN_CONFIRM');
  });

  test('涉及跨模块 + 新建文件 → L2', () => {
    const draft: TaskDraft = {
      title: 'New feature', level: 'L1',
      expected_touch_files: ['src/api/auth.ts', 'src/models/user.ts'], dependencies: [], reasoning: '',
    };
    const result = enforceHardRules(draft, repoContext, repoRoot);
    expect(result.level).toBe('L2');
  });
});

describe('validatePaths', () => {
  test('存在文件 → valid', () => {
    const result = validatePaths(['src/api/auth.ts'], repoContext, moduleMap);
    expect(result.valid).toContain('src/api/auth.ts');
    expect(result.invalid).toHaveLength(0);
  });

  test('不存在文件 → invalid', () => {
    const result = validatePaths(['src/api/nonexistent.ts'], repoContext, moduleMap);
    expect(result.invalid).toContain('src/api/nonexistent.ts');
  });

  test('不在 moduleMap 的路径 → withWarnings', () => {
    const result = validatePaths(['some/random/file.ts'], repoContext, moduleMap);
    expect(result.withWarnings).toContain('some/random/file.ts');
  });

  test('多文件混合场景', () => {
    const result = validatePaths(
      ['src/api/auth.ts', 'src/api/nope.ts'],
      repoContext, moduleMap,
    );
    expect(result.valid).toHaveLength(1);
    expect(result.invalid).toHaveLength(1);
  });
});

describe('validateDAG', () => {
  test('合法 DAG 通过', () => {
    const tasks: TaskDraft[] = [
      { title: 'A', level: 'L2', expected_touch_files: [], dependencies: [], reasoning: '' },
      { title: 'B', level: 'L2', expected_touch_files: [], dependencies: ['A'], reasoning: '' },
    ];
    const result = validateDAG(tasks);
    expect(result.acyclic).toBe(true);
    expect(result.circularDeps).toHaveLength(0);
    expect(result.orphanNodes).toHaveLength(0);
  });

  test('检测循环依赖', () => {
    const tasks: TaskDraft[] = [
      { title: 'A', level: 'L2', expected_touch_files: [], dependencies: ['B'], reasoning: '' },
      { title: 'B', level: 'L2', expected_touch_files: [], dependencies: ['A'], reasoning: '' },
    ];
    const result = validateDAG(tasks);
    expect(result.acyclic).toBe(false);
  });

  test('检测孤儿节点（引用不存在的前置任务）', () => {
    const tasks: TaskDraft[] = [
      { title: 'A', level: 'L2', expected_touch_files: [], dependencies: ['C'], reasoning: '' },
    ];
    const result = validateDAG(tasks);
    expect(result.orphanNodes).toContain('C');
  });

  test('空任务列表通过', () => {
    const result = validateDAG([]);
    expect(result.acyclic).toBe(true);
  });
});
```

- [ ] **Step 2: 验证测试失败**

Run: `cd packages/orchestrator && npx jest --testPathPattern="post-validate"`
Expected: FAIL

- [ ] **Step 3: 实现 rule-engine.ts**

```typescript
import type { TaskLevel } from '@parallelc/shared';
import type { TaskDraft } from '../decompose/response-parser.js';
import type { RepoContext } from '../pre-process/repo-scanner.js';
import { estimateTokens, type TokenEstimate } from '../pre-process/token-estimator.js';

export interface RuleResult {
  passed: boolean;
  level: TaskLevel;
  warnings: string[];
  action: 'CREATE_TASK' | 'DIRECT_EXECUTE' | 'HUMAN_CONFIRM';
  tokenEstimate?: TokenEstimate;
}

export function enforceHardRules(
  task: TaskDraft,
  repoContext: RepoContext,
  repoRoot: string,
): RuleResult {
  const warnings: string[] = [];
  const files = task.expected_touch_files;
  const tokenEst = estimateTokens(files, repoRoot);

  // 硬约束判定
  const newFiles = files.filter(f => !repoContext.fileTree.includes(f));
  const dirs = new Set(files.map(f => f.split('/').slice(0, 2).join('/')));
  const sameDir = dirs.size <= 1;
  const crossModule = files.some(f => {
    const modDir = f.split('/').slice(0, 2).join('/');
    return !repoContext.moduleDirs.includes(modDir) && repoContext.moduleDirs.length > 0;
  });

  // 计算实际满足的最低级别
  let actualLevel: TaskLevel = 'L1';
  let action: RuleResult['action'] = 'DIRECT_EXECUTE';

  if (files.length > 10 || tokenEst.estimatedTokens > 50000) {
    actualLevel = 'L3';
    action = 'HUMAN_CONFIRM';
    warnings.push(`Files=${files.length}, tokens=${tokenEst.estimatedTokens} → L3`);
  } else if (files.length >= 3 || !sameDir || newFiles.length > 0 || crossModule || tokenEst.estimatedTokens >= 10000) {
    actualLevel = 'L2';
    action = 'CREATE_TASK';
    if (files.length >= 3) warnings.push(`Files=${files.length} >= 3 → L2`);
    if (newFiles.length > 0) warnings.push(`New files: ${newFiles.join(', ')} → L2`);
    if (crossModule) warnings.push(`Cross-module → L2`);
  }

  // 禁止降级：LLM 级别高于实际级别时保持 LLM 级别
  const levelOrder: Record<TaskLevel, number> = { L1: 0, L2: 1, L3: 2 };
  const finalLevel = levelOrder[task.level] > levelOrder[actualLevel] ? task.level : actualLevel;

  // 如果 LLM 标 L2/L3，即使满足 L1 条件也保持 LLM 级别
  if (levelOrder[task.level] > levelOrder[actualLevel]) {
    warnings.push(`LLM marked ${task.level}, actual minimum is ${actualLevel} — kept LLM level`);
    // L2 → CREATE_TASK, L3 → HUMAN_CONFIRM
    action = task.level === 'L2' ? 'CREATE_TASK' : 'HUMAN_CONFIRM';
  }

  return {
    passed: warnings.filter(w => !w.includes('kept LLM level')).length === 0,
    level: finalLevel,
    warnings,
    action,
    tokenEstimate: tokenEst,
  };
}
```

- [ ] **Step 4: 实现 path-validator.ts**

```typescript
import fs from 'fs';
import path from 'path';
import type { RepoContext } from '../pre-process/repo-scanner.js';
import type { ModuleBoundary } from '../pre-process/module-map.js';

export interface PathValidation {
  valid: string[];
  invalid: string[];
  withWarnings: string[];
}

export function validatePaths(
  files: string[],
  repoContext: RepoContext,
  moduleMap: ModuleBoundary[],
  repoRoot?: string,
): PathValidation {
  const result: PathValidation = { valid: [], invalid: [], withWarnings: [] };
  const moduleDirs = new Set(moduleMap.map(m => m.dir));

  for (const f of files) {
    const fullPath = repoRoot ? path.join(repoRoot, f) : f;

    // 检查文件是否存在
    if (repoRoot && fs.existsSync(fullPath)) {
      result.valid.push(f);
    } else if (repoRoot && !fs.existsSync(fullPath)) {
      // 新建文件：检查父目录是否存在
      const parentDir = path.dirname(fullPath);
      if (fs.existsSync(parentDir)) {
        result.valid.push(f);
      } else {
        result.invalid.push(f);
      }
    } else {
      // 无法验证（无 repoRoot）
      result.valid.push(f);
    }

    // 检查是否在已知模块内
    if (repoRoot) {
      const modDir = f.split('/').slice(0, 2).join('/');
      if (!moduleDirs.has(modDir) && moduleDirs.size > 0) {
        if (!result.withWarnings.includes(f)) {
          result.withWarnings.push(f);
        }
      }
    }
  }

  return result;
}
```

- [ ] **Step 5: 实现 dag-validator.ts**

```typescript
import type { TaskDraft } from '../decompose/response-parser.js';

export interface DagValidation {
  acyclic: boolean;
  orphanNodes: string[];
  circularDeps: string[][];
  missingRoots: boolean;
}

export function validateDAG(tasks: TaskDraft[]): DagValidation {
  const titles = new Set(tasks.map(t => t.title));
  const orphanNodes: string[] = [];
  const circularDeps: string[][] = [];

  // 检查孤儿节点
  for (const t of tasks) {
    for (const dep of t.dependencies) {
      if (!titles.has(dep)) {
        orphanNodes.push(dep);
      }
    }
  }

  // 拓扑排序检测环
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const t of tasks) {
    inDegree.set(t.title, t.dependencies.length);
    adjacency.set(t.title, []);
  }
  for (const t of tasks) {
    for (const dep of t.dependencies) {
      const list = adjacency.get(dep);
      if (list) list.push(t.title);
    }
  }

  // Kahn 算法
  const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([n]) => n);
  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited++;
    for (const neighbor of adjacency.get(node) ?? []) {
      const d = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, d);
      if (d === 0) queue.push(neighbor);
    }
  }

  const acyclic = visited === tasks.length;

  // 找循环中的节点
  if (!acyclic) {
    const inCycle = [...inDegree.entries()].filter(([, d]) => d > 0).map(([n]) => n);
    circularDeps.push(inCycle);
  }

  return {
    acyclic,
    orphanNodes,
    circularDeps,
    missingRoots: tasks.length > 0 && !tasks.some(t => t.dependencies.length === 0),
  };
}
```

- [ ] **Step 6: 验证测试通过**

Run: `cd packages/orchestrator && npx jest --testPathPattern="post-validate"`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/orchestrator/
git commit -m "feat(orchestrator): add post-validate modules (rule-engine, path-validator, dag-validator)"
```

---

### Task 5: L1 Executor + L3 Confirm

**Files:**
- Create: `packages/orchestrator/src/post-validate/l1-executor.ts`
- Create: `packages/orchestrator/src/post-validate/l3-confirm.ts`
- Create: `packages/orchestrator/__tests__/l1-l3.test.ts`

- [ ] **Step 1: 编写测试**

Create `packages/orchestrator/__tests__/l1-l3.test.ts`:

```typescript
import { executeL1Directly } from '../src/post-validate/l1-executor';
import { confirmL3Tasks } from '../src/post-validate/l3-confirm';
import type { TaskDraft } from '../src/decompose/response-parser';
import { getDb, initializeSchema, createTask, casUpdateStatus, queryTasksByStatus } from '@parallelc/taskboard';
import fs from 'fs';
import path from 'path';
import os from 'os';

jest.mock('@parallelc/worker', () => ({
  spawnWorker: jest.fn().mockResolvedValue({}),
  spawnMcpWorker: jest.fn().mockReturnValue({
    on: jest.fn(),
    stdin: { write: jest.fn(), end: jest.fn() },
    stdout: { on: jest.fn() },
  }),
}));

describe('executeL1Directly', () => {
  test('文件锁冲突时返回 success=false', async () => {
    const locked = new Set(['src/api/auth.ts']);
    const draft: TaskDraft = {
      title: 'Fix', level: 'L1',
      expected_touch_files: ['src/api/auth.ts'], dependencies: [], reasoning: '',
    };
    const result = await executeL1Directly(draft, '/tmp', 'sk-test', locked);
    expect(result.success).toBe(false);
  });
});

describe('confirmL3Tasks', () => {
  test('将 L3 PENDING 任务转为 READY', () => {
    const db = getDb(':memory:');
    initializeSchema(db);
    createTask(db, {
      id: 'task-dag1-004', title: 'DB migration',
      expected_touch_files: ['migration/001.sql'],
      dependencies: null, snapshot_version: 'dag1', level: 'L3',
    });

    const count = confirmL3Tasks(db, 'dag1', ['task-dag1-004']);
    expect(count).toBe(1);

    const ready = queryTasksByStatus(db, 'READY');
    expect(ready).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 验证测试失败**

Run: `cd packages/orchestrator && npx jest --testPathPattern="l1-l3"`
Expected: FAIL

- [ ] **Step 3: 实现 l1-executor.ts**

```typescript
import { spawnMcpWorker } from '@parallelc/worker';
import type { TaskDraft } from '../decompose/response-parser.js';

export interface L1ExecutionResult {
  success: boolean;
  modifiedFiles: string[];
  output: string;
}

export async function executeL1Directly(
  task: TaskDraft,
  repoRoot: string,
  apiKey: string,
  lockedFiles: Set<string>,
): Promise<L1ExecutionResult> {
  // 文件锁冲突检查
  const conflict = task.expected_touch_files.find(f => lockedFiles.has(f));
  if (conflict) {
    return {
      success: false,
      modifiedFiles: [],
      output: `File locked: ${conflict}. Upstream task is modifying it.`,
    };
  }

  // 直接调用 Claude 执行修改（不创建 Worktree，在 Main 仓库直接操作）
  const child = spawnMcpWorker(
    {
      apiKey,
      model: 'sonnet',
      cwd: repoRoot,
      readonlyRoot: repoRoot,
      maxRounds: 5,
      timeoutMs: 300_000,
    },
    {
      taskId: `l1-${Date.now()}`,
      snapshotVersion: 'L1-direct',
      dependencies: null,
    },
  );

  child.stdin?.write(`直接执行: ${task.title}\n${task.reasoning}`);
  child.stdin?.end();

  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });

  return new Promise((resolve) => {
    child.on('exit', (code) => {
      resolve({
        success: code === 0,
        modifiedFiles: task.expected_touch_files,
        output: output.slice(-500),
      });
    });
  });
}
```

- [ ] **Step 4: 实现 l3-confirm.ts**

```typescript
import Database from 'better-sqlite3';
import { queryTasksByStatus, casUpdateStatus } from '@parallelc/taskboard';

export interface L3Confirmation {
  taskId: string;
  taskTitle: string;
  reason: string;
  files: string[];
}

export function confirmL3Tasks(
  db: Database.Database,
  dagId: string,
  taskIds: string[],
): number {
  let count = 0;
  for (const taskId of taskIds) {
    const tasks = queryTasksByStatus(db, 'PENDING');
    const task = tasks.find(t => t.id === taskId && t.level === 'L3');
    if (task) {
      const ok = casUpdateStatus(db, task.id, task.version, 'PENDING', 'READY');
      if (ok) count++;
    }
  }
  return count;
}
```

- [ ] **Step 5: 验证测试通过**

Run: `cd packages/orchestrator && npx jest --testPathPattern="l1-l3"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/
git commit -m "feat(orchestrator): add L1 executor and L3 confirmation modules"
```

---

### Task 6: dag-builder（流水线入口）

**Files:**
- Create: `packages/orchestrator/src/dag-builder.ts`
- Create: `packages/orchestrator/__tests__/dag-builder.test.ts`

- [ ] **Step 1: 编写测试**

Create `packages/orchestrator/__tests__/dag-builder.test.ts`:

```typescript
import { buildDAG } from '../src/dag-builder';
import type { DecompositionInput } from '../src/decompose/prompt-builder';
import { getDb, initializeSchema, queryTasksByStatus } from '@parallelc/taskboard';
import fs from 'fs';
import path from 'path';
import os from 'os';

jest.mock('../src/decompose/mcp-decomposer', () => ({
  decomposeViaClaude: jest.fn().mockResolvedValue({
    raw: '{}',
    parsed: [
      { title: 'Task A', level: 'L2', expected_touch_files: ['src/a.ts'], dependencies: [], reasoning: 'test' },
      { title: 'Task B', level: 'L2', expected_touch_files: ['src/b.ts'], dependencies: ['Task A'], reasoning: 'test' },
    ],
    tokensUsed: 500,
    cached: false,
  }),
}));

jest.mock('@parallelc/worker', () => ({
  spawnMcpWorker: jest.fn().mockReturnValue({
    on: jest.fn(),
    stdin: { write: jest.fn(), end: jest.fn() },
    stdout: { on: jest.fn() },
  }),
}));

let repoRoot: string;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallelc-orch-dag-'));
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'a.ts'), 'export const a = 1;');
  fs.writeFileSync(path.join(repoRoot, 'src', 'b.ts'), 'export const b = 2;');
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('buildDAG', () => {
  test('端到端：输入需求 -> 写入 TaskBoard', async () => {
    const dbPath = path.join(repoRoot, 'test.db');
    const db = getDb(dbPath);
    initializeSchema(db);

    const input: DecompositionInput = {
      userRequest: 'Add feature X',
      repoContext: {
        fileTree: ['src/a.ts', 'src/b.ts'],
        moduleDirs: ['src'],
        packageJson: null,
        existingTasks: [],
      },
      moduleMap: [],
    };

    const result = await buildDAG(input, { repoRoot, dbPath, apiKey: 'sk-test' });

    expect(result.tasksCreated).toBe(2);
    expect(result.dagId).toBeDefined();

    const tasks = queryTasksByStatus(db, 'PENDING');
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.title).toBe('Task A');
    expect(tasks[1]!.dependencies).toContain(tasks[0]!.id);

    db.close();
  });

  test('失败后触发重试', async () => {
    const { decomposeViaClaude } = require('../src/decompose/mcp-decomposer');
    const onRetry = jest.fn();

    // 第一次失败，第二次成功
    decomposeViaClaude
      .mockRejectedValueOnce(new Error('API error'))
      .mockResolvedValueOnce({
        raw: '{}',
        parsed: [{ title: 'Solo', level: 'L2', expected_touch_files: ['src/a.ts'], dependencies: [], reasoning: '' }],
        tokensUsed: 200,
        cached: false,
      });

    const dbPath = path.join(repoRoot, 'test2.db');
    const input: DecompositionInput = {
      userRequest: 'Test',
      repoContext: { fileTree: ['src/a.ts'], moduleDirs: ['src'], packageJson: null, existingTasks: [] },
      moduleMap: [],
    };

    const result = await buildDAG(input, {
      repoRoot, dbPath, apiKey: 'sk-test', maxRetries: 2, onRetry,
    });

    expect(result.retries).toBe(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(String));
    expect(result.tasksCreated).toBe(1);
  });
});
```

- [ ] **Step 2: 验证测试失败**

Run: `cd packages/orchestrator && npx jest --testPathPattern="dag-builder"`
Expected: FAIL

- [ ] **Step 3: 实现 dag-builder.ts**

```typescript
import Database from 'better-sqlite3';
import { createTask, getDb, initializeSchema, queryTasksByStatus } from '@parallelc/taskboard';
import { scanRepoContext } from './pre-process/repo-scanner.js';
import { extractModuleMap } from './pre-process/module-map.js';
import { type DecompositionInput } from './decompose/prompt-builder.js';
import { decomposeViaClaude } from './decompose/mcp-decomposer.js';
import { enforceHardRules } from './post-validate/rule-engine.js';
import { validatePaths } from './post-validate/path-validator.js';
import { validateDAG } from './post-validate/dag-validator.js';
import { executeL1Directly } from './post-validate/l1-executor.js';
import { recordPrediction } from './metrics-collector.js';
import type { L3Confirmation } from './post-validate/l3-confirm.js';

export interface BuildDagOptions {
  repoRoot: string;
  dbPath: string;
  apiKey: string;
  maxRetries?: number;
  confirmL3?: boolean;
  onRetry?: (retryCount: number, reason: string) => void;
}

export interface BuildDagResult {
  dagId: string;
  summary: string;
  tasksCreated: number;
  l1Executed: number;
  l1Skipped: number;
  l3Pending: number;
  l3PendingTasks: L3Confirmation[];
  failedTasks: number;
  error: string | null;
  tokensUsed: number;
  retries: number;
  cached: boolean;
}

export async function buildDAG(
  input: DecompositionInput,
  opts: BuildDagOptions,
): Promise<BuildDagResult> {
  const maxRetries = opts.maxRetries ?? 2;
  let retries = 0;
  let lastError: Error | null = null;
  let l3PendingTasks: L3Confirmation[] = [];

  const db = getDb(opts.dbPath);
  initializeSchema(db);

  // 1. Pre-process
  const repoContext = scanRepoContext(opts.repoRoot, db);
  const moduleMap = extractModuleMap(repoContext, opts.repoRoot);
  const fullInput: DecompositionInput = {
    userRequest: input.userRequest,
    repoContext,
    moduleMap,
  };

  // 2. LLM Decompose（含重试）
  let decomposerResult = await decomposeViaClaude(fullInput, { apiKey: opts.apiKey });
  while (!decomposerResult.parsed && retries < maxRetries) {
    retries++;
    lastError = new Error(`LLM decomposition failed (attempt ${retries})`);
    opts.onRetry?.(retries, lastError.message);
    decomposerResult = await decomposeViaClaude(fullInput, { apiKey: opts.apiKey });
  }

  if (!decomposerResult.parsed) {
    return {
      dagId: '', summary: '', tasksCreated: 0, l1Executed: 0, l1Skipped: 0,
      l3Pending: 0, l3PendingTasks: [], failedTasks: 0,
      error: `Failed after ${retries} retries: ${lastError?.message ?? 'parse error'}`,
      tokensUsed: decomposerResult.tokensUsed, retries, cached: decomposerResult.cached,
    };
  }

  // 3. Post-validate + Build
  const dagId = `dag-${Date.now()}`;
  let tasksCreated = 0;
  let l1Executed = 0;
  let l1Skipped = 0;
  let l3Pending = 0;
  let failedTasks = 0;
  const summary = '';

  // DAG 拓扑校验
  const dagCheck = validateDAG(decomposerResult.parsed);
  if (!dagCheck.acyclic) {
    return {
      dagId, summary, tasksCreated: 0, l1Executed: 0, l1Skipped: 0,
      l3Pending: 0, l3PendingTasks: [], failedTasks: decomposerResult.parsed.length,
      error: `DAG validation failed: circular dependencies detected`,
      tokensUsed: decomposerResult.tokensUsed, retries, cached: decomposerResult.cached,
    };
  }

  // 路径校验
  const allFiles = decomposerResult.parsed.flatMap(t => t.expected_touch_files);
  const pathCheck = validatePaths(allFiles, repoContext, moduleMap, opts.repoRoot);
  if (pathCheck.invalid.length > 0) {
    return {
      dagId, summary, tasksCreated: 0, l1Executed: 0, l1Skipped: 0,
      l3Pending: 0, l3PendingTasks: [], failedTasks: pathCheck.invalid.length,
      error: `Path validation failed: ${pathCheck.invalid.join(', ')}`,
      tokensUsed: decomposerResult.tokensUsed, retries, cached: decomposerResult.cached,
    };
  }

  // 获取当前锁集合
  const lockedFiles = new Set<string>();
  const running = queryTasksByStatus(db, ['RUNNING', 'SLEEP_PENDING']);
  for (const t of running) {
    for (const f of t.expected_touch_files ?? []) lockedFiles.add(f);
  }

  // 逐个处理 TaskDraft
  for (const draft of decomposerResult.parsed) {
    const rule = enforceHardRules(draft, repoContext, opts.repoRoot);

    switch (rule.action) {
      case 'DIRECT_EXECUTE': {
        const result = await executeL1Directly(draft, opts.repoRoot, opts.apiKey, lockedFiles);
        if (result.success) l1Executed++;
        else l1Skipped++;
        break;
      }
      case 'HUMAN_CONFIRM': {
        // L3 任务：创建但保持 PENDING
        const task = createTask(db, {
          id: `task-${dagId}-${String(tasksCreated + 1).padStart(3, '0')}`,
          title: draft.title,
          expected_touch_files: draft.expected_touch_files,
          level: 'L3',
          snapshot_version: dagId,
        });
        l3Pending++;
        l3PendingTasks.push({
          taskId: task.id,
          taskTitle: draft.title,
          reason: rule.warnings.join('; '),
          files: draft.expected_touch_files,
        });
        recordPrediction(db, task.id, draft.expected_touch_files);
        tasksCreated++;
        break;
      }
      case 'CREATE_TASK': {
        const task = createTask(db, {
          id: `task-${dagId}-${String(tasksCreated + 1).padStart(3, '0')}`,
          title: draft.title,
          expected_touch_files: draft.expected_touch_files,
          level: rule.level,
          snapshot_version: dagId,
        });
        recordPrediction(db, task.id, draft.expected_touch_files);
        tasksCreated++;
        break;
      }
    }
  }

  return {
    dagId, summary: decomposerResult.parsed.length > 0 ? `${tasksCreated} tasks created` : '',
    tasksCreated, l1Executed, l1Skipped, l3Pending, l3PendingTasks,
    failedTasks, error: null,
    tokensUsed: decomposerResult.tokensUsed, retries, cached: decomposerResult.cached,
  };
}
```

- [ ] **Step 4: 验证测试通过**

Run: `cd packages/orchestrator && npx jest --testPathPattern="dag-builder"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/
git commit -m "feat(orchestrator): add dag-builder pipeline entry point"
```

---

### Task 7: metrics-collector + CLI

**Files:**
- Create: `packages/orchestrator/src/metrics-collector.ts`
- Create: `packages/orchestrator/__tests__/metrics-collector.test.ts`
- Create: `packages/orchestrator/src/cli.ts`

- [ ] **Step 1: 实现 metrics-collector.ts**

```typescript
import Database from 'better-sqlite3';

export interface PredictionRecord {
  taskId: string;
  expectedFiles: string[];
  actualFiles: string[] | null;
  accuracy: number | null;  // Phase 3A 回填
  recordedAt: string;
}

export function recordPrediction(
  db: Database.Database,
  taskId: string,
  expectedFiles: string[],
): void {
  db.prepare(`
    INSERT INTO prediction_records (task_id, expected_files, recorded_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(task_id) DO UPDATE SET expected_files = excluded.expected_files
  `).run(taskId, JSON.stringify(expectedFiles));
}

export function updatePredictionRecord(
  db: Database.Database,
  taskId: string,
  actualFiles: string[],
): void {
  const row = db.prepare(
    'SELECT expected_files FROM prediction_records WHERE task_id = ?',
  ).get(taskId) as Record<string,string> | undefined;

  if (!row) return;

  const expected: string[] = JSON.parse(row['expected_files']);
  const intersect = expected.filter(f => actualFiles.includes(f)).length;
  const union = new Set([...expected, ...actualFiles]).size;
  const accuracy = union > 0 ? intersect / union : 1;

  db.prepare(`
    UPDATE prediction_records
    SET actual_files = ?, accuracy = ?
    WHERE task_id = ?
  `).run(JSON.stringify(actualFiles), accuracy, taskId);
}

export function getPredictionAccuracy(
  db: Database.Database,
): { overall: number; details: PredictionRecord[] } {
  const rows = db.prepare(`
    SELECT task_id, expected_files, actual_files, accuracy, recorded_at
    FROM prediction_records
    ORDER BY recorded_at DESC
  `).all() as Record<string,string>[];

  const details = rows.map(r => ({
    taskId: r['task_id'],
    expectedFiles: JSON.parse(r['expected_files'] ?? '[]'),
    actualFiles: r['actual_files'] ? JSON.parse(r['actual_files']) : null,
    accuracy: r['accuracy'] ? Number(r['accuracy']) : null,
    recordedAt: r['recorded_at'],
  }));

  const withAccuracy = details.filter(d => d.accuracy !== null);
  const overall = withAccuracy.length > 0
    ? withAccuracy.reduce((sum, d) => sum + d.accuracy!, 0) / withAccuracy.length
    : 0;

  return { overall, details };
}
```

- [ ] **Step 2: 编写 metrics-collector 测试**

Create `packages/orchestrator/__tests__/metrics-collector.test.ts`:

```typescript
import { recordPrediction, updatePredictionRecord, getPredictionAccuracy } from '../src/metrics-collector';
import Database from 'better-sqlite3';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS prediction_records (
      task_id TEXT PRIMARY KEY,
      expected_files TEXT,
      actual_files TEXT,
      accuracy REAL,
      recorded_at TEXT
    )
  `);
});

afterEach(() => db.close());

describe('metrics-collector', () => {
  test('recordPrediction 写入预期文件', () => {
    recordPrediction(db, 't1', ['src/a.ts', 'src/b.ts']);
    const result = getPredictionAccuracy(db);
    expect(result.details).toHaveLength(1);
    expect(result.details[0]!.expectedFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(result.details[0]!.accuracy).toBeNull();
  });

  test('updatePredictionRecord 回填实际文件并计算准确率', () => {
    recordPrediction(db, 't1', ['src/a.ts', 'src/b.ts']);
    updatePredictionRecord(db, 't1', ['src/a.ts']);

    const result = getPredictionAccuracy(db);
    expect(result.details[0]!.actualFiles).toEqual(['src/a.ts']);
    expect(result.details[0]!.accuracy).toBe(0.5); // 1/2
  });

  test('完全匹配准确率为 1', () => {
    recordPrediction(db, 't1', ['src/a.ts']);
    updatePredictionRecord(db, 't1', ['src/a.ts']);
    const result = getPredictionAccuracy(db);
    expect(result.details[0]!.accuracy).toBe(1);
  });
});
```

- [ ] **Step 3: 实现 cli.ts**

```typescript
#!/usr/bin/env node

import { getDb, initializeSchema } from '@parallelc/taskboard';
import { scanRepoContext } from './pre-process/repo-scanner.js';
import { extractModuleMap } from './pre-process/module-map.js';
import { buildDAG } from './dag-builder.js';
import { confirmL3Tasks } from './post-validate/l3-confirm.js';
import { getPredictionAccuracy } from './metrics-collector.js';

const command = process.argv[2];

if (command === 'decompose') {
  const args = process.argv.slice(3);
  const userRequest = args.find(a => !a.startsWith('--'));
  const getArg = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i+1] : undefined; };

  const repoRoot = getArg('--repo') ?? process.cwd();
  const apiKey = getArg('--api-key') ?? process.env['ANTHROPIC_API_KEY'];
  const dbPath = getArg('--db') ?? '.parallelc/taskboard.db';

  if (!userRequest || !apiKey) {
    console.error('Usage: parallelc-orchestrate decompose <request> --repo <path> --api-key <key>');
    process.exit(1);
  }

  const db = getDb(dbPath);
  initializeSchema(db);

  const repoContext = scanRepoContext(repoRoot, db);
  const moduleMap = extractModuleMap(repoContext, repoRoot);

  console.log(`[Orchestrator] 扫描仓库... ${repoContext.fileTree.length} 文件, ${moduleMap.length} 个模块`);

  buildDAG(
    { userRequest, repoContext, moduleMap },
    { repoRoot, dbPath, apiKey },
  ).then(result => {
    if (result.error) {
      console.error(`[Orchestrator] 失败: ${result.error}`);
      process.exit(1);
    }

    console.log(`[Orchestrator] 验证通过: ${result.tasksCreated} L2, ${result.l3Pending} L3 待确认, ${result.l1Executed} L1 直接执行`);
    console.log(`[Orchestrator] DAG ${result.dagId} 写入 TaskBoard`);
    console.log(`[Orchestrator] 预测数据已记录`);
    console.log(`\nSummary: ${result.summary}`);

    if (result.l3PendingTasks.length > 0) {
      console.log(`\n待确认 L3 任务 (${result.l3Pending} 条):`);
      for (const l3 of result.l3PendingTasks) {
        console.log(`  npx parallelc-orchestrate confirm --dag ${result.dagId} --task ${l3.taskId}`);
        console.log(`    ${l3.taskTitle} — ${l3.reason}`);
      }
    }

    db.close();
  });

} else if (command === 'confirm') {
  const args = process.argv.slice(3);
  const getArg = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i+1] : undefined; };
  const dagId = getArg('--dag');
  const taskId = getArg('--task');
  const dbPath = getArg('--db') ?? '.parallelc/taskboard.db';

  if (!dagId || !taskId) {
    console.error('Usage: parallelc-orchestrate confirm --dag <id> --task <id>');
    process.exit(1);
  }

  const db = getDb(dbPath);
  const count = confirmL3Tasks(db, dagId, [taskId]);
  console.log(`[Orchestrator] 已确认 ${count} 个 L3 任务 (PENDING -> READY)`);
  db.close();

} else if (command === 'accuracy') {
  const dbPath = process.argv.slice(3).find(a => a.startsWith('--db='))?.split('=')[1] ?? '.parallelc/taskboard.db';
  const db = getDb(dbPath);
  const { overall, details } = getPredictionAccuracy(db);
  console.log(`预测准确率: ${(overall * 100).toFixed(1)}% (${details.length} 条记录)`);
  for (const d of details.slice(0, 10)) {
    const acc = d.accuracy !== null ? `${(d.accuracy * 100).toFixed(0)}%` : 'pending';
    console.log(`  ${d.taskId}  expected=${d.expectedFiles.length} actual=${d.actualFiles?.length ?? '?'} accuracy=${acc}`);
  }
  db.close();

} else {
  console.log('ParallelC Orchestrator v0.1.0');
  console.log('  decompose <request> --repo <path> --api-key <key>');
  console.log('  confirm --dag <id> --task <id>');
  console.log('  accuracy [--db <path>]');
  process.exit(0);
}
```

- [ ] **Step 4: 运行测试**

Run: `cd packages/orchestrator && npx jest --testPathPattern="metrics-collector"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/
git commit -m "feat(orchestrator): add metrics-collector and CLI commands"
```

---

## 依赖顺序

```
Task 1 (包骨架)
  └─ Task 2 (pre-process: repo-scanner, module-map, token-estimator)
       └─ Task 3 (decompose: prompt-builder, mcp-decomposer, response-parser)
            └─ Task 4 (post-validate: rule-engine, path-validator, dag-validator)
                 ├─ Task 5 (l1-executor, l3-confirm)
                 ├─ Task 6 (dag-builder — 依赖 2,3,4,5)
                 └─ Task 7 (metrics-collector + CLI — 依赖 6)
```

---

## 验收对照

| # | 验收项 | Task |
|---|--------|------|
| 1 | 仓库上下文自动扫描 | Task 2 — scanRepoContext + extractModuleMap |
| 2 | LLM 任务分解 | Task 3 — decomposeViaClaude + prompt-builder |
| 3 | L1/L2/L3 硬约束 + token 预估 | Task 2 (token-estimator) + Task 4 (rule-engine) |
| 4 | 文件路径校验 | Task 4 — path-validator |
| 5 | DAG 环检测 + 孤儿节点 | Task 4 — dag-validator |
| 6 | 端到端：需求 -> TaskBoard | Task 6 — buildDAG 测试 |
| 7 | L1 直接执行 | Task 5 — executeL1Directly |
| 8 | L3 人工确认 | Task 5 — confirmL3Tasks + CLI confirm 命令 |
| 9 | 预测数据采集 | Task 7 — metrics-collector |
| 10 | 缓存复用 | Task 3 — cacheKey 机制 |
| 11 | 重试机制 | Task 6 — buildDAG onRetry 回调 |
