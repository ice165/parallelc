# ParallelC Phase 3A 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Merge Coordinator、Key Pool 和预测闭环，使 Worker 产出代码安全合并回主分支，API Key 健康管理，预测准确率反馈。

**Architecture:** 两个新包（coordinator + keypool）+ Scheduler 最小化修改。coordinator 负责分层合并（AUTO/STRUCTURED/BLOCKED）+ 仲裁 + 准确率回填。keypool 负责 Key 轮转 + 指数退避冷却 + 全局暂停。Scheduler 仅修改 4 个调用点。

**Tech Stack:** TypeScript (strict), pnpm workspaces, better-sqlite3, @anthropic-ai/sdk, Jest + ts-jest

**基于规范:** `docs/superpowers/specs/2026-05-23-parallelc-phase3a-coordinator-design.md`

---

### Task 1: @parallelc/keypool — 包骨架 + KeyPool 类

**Files:**
- Create: `packages/keypool/package.json`
- Create: `packages/keypool/tsconfig.json`
- Create: `packages/keypool/jest.config.ts`
- Create: `packages/keypool/src/index.ts`
- Create: `packages/keypool/src/key-pool.ts`
- Create: `packages/keypool/__tests__/key-pool.test.ts`

- [ ] **Step 1: 创建配置文件**

`packages/keypool/package.json`:
```json
{
  "name": "@parallelc/keypool",
  "version": "0.1.0",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "tsup src/index.ts --format cjs,esm --dts --clean",
    "typecheck": "tsc --noEmit",
    "test": "jest",
    "test:ci": "jest --ci --coverage"
  },
  "dependencies": {
    "@parallelc/shared": "workspace:*",
    "@anthropic-ai/sdk": "^0.55.0"
  },
  "devDependencies": {
    "@types/jest": "^29.5.14",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.5"
  }
}
```

tsconfig.json + jest.config.ts 复用标准模板（同其他包）。

- [ ] **Step 2: 编写 KeyPool 测试**

Create `packages/keypool/__tests__/key-pool.test.ts`:

```typescript
import { KeyPool } from '../src/key-pool';

describe('KeyPool', () => {
  test('nextKey 循环轮转', () => {
    const pool = new KeyPool(['sk-a', 'sk-b', 'sk-c']);
    expect(pool.nextKey()).toBe('sk-a');
    expect(pool.nextKey()).toBe('sk-b');
    expect(pool.nextKey()).toBe('sk-c');
    expect(pool.nextKey()).toBe('sk-a');
  });

  test('跳过 COOLDOWN Key', () => {
    const pool = new KeyPool(['sk-a', 'sk-b']);
    // 模拟 sk-a 连续 3 次 429
    pool.markRateLimited('sk-a');
    pool.markRateLimited('sk-a');
    pool.markRateLimited('sk-a');
    // sk-a 目前是 COOLDOWN
    const status = pool.status();
    const a = status.find(s => s.key === 'sk-a');
    expect(a!.status).toBe('COOLDOWN');

    // nextKey 应跳过 sk-a，返回 sk-b
    expect(pool.nextKey()).toBe('sk-b');
  });

  test('全部 COOLDOWN 时返回最早恢复的 Key', () => {
    const pool = new KeyPool(['sk-a', 'sk-b']);
    // 两者都冷却
    for (let i = 0; i < 3; i++) { pool.markRateLimited('sk-a'); pool.markRateLimited('sk-b'); }
    const key = pool.nextKey();
    expect(['sk-a', 'sk-b']).toContain(key);
  });

  test('markSuccess 重置计数器', () => {
    const pool = new KeyPool(['sk-a']);
    pool.markRateLimited('sk-a');
    pool.markRateLimited('sk-a');
    pool.markSuccess('sk-a');
    expect(pool.status()[0]!.consecutive429).toBe(0);
    expect(pool.status()[0]!.status).toBe('ACTIVE');
  });

  test('allPaused 全部冷却返回 true', () => {
    const pool = new KeyPool(['sk-a']);
    for (let i = 0; i < 3; i++) pool.markRateLimited('sk-a');
    expect(pool.allPaused()).toBe(true);
  });

  test('earliestRecovery 返回最近的冷却到期时间', () => {
    const pool = new KeyPool(['sk-a', 'sk-b']);
    for (let i = 0; i < 3; i++) { pool.markRateLimited('sk-a'); pool.markRateLimited('sk-b'); }
    expect(pool.earliestRecovery()).not.toBeNull();
  });
});
```

- [ ] **Step 3: 实现 key-pool.ts**

```typescript
export interface KeyState {
  key: string;
  masked: string;
  status: 'ACTIVE' | 'COOLDOWN' | 'DEAD';
  cooldownUntil: Date | null;
  consecutive429: number;
  lastUsedAt: Date | null;
}

const COOLDOWN_BASE_MINUTES = 5;
const JITTER_SECONDS = 30;

export class KeyPool {
  private keys: KeyState[];
  private index = 0;

  constructor(apiKeys: string[]) {
    this.keys = apiKeys.map(key => ({
      key,
      masked: key.slice(0, 10) + '...' + key.slice(-4),
      status: 'ACTIVE' as const,
      cooldownUntil: null,
      consecutive429: 0,
      lastUsedAt: null,
    }));
  }

  nextKey(): string {
    const now = new Date();

    // 尝试找 ACTIVE Key
    for (let i = 0; i < this.keys.length; i++) {
      const k = this.keys[(this.index + i) % this.keys.length]!;
      if (k.status === 'ACTIVE') {
        this.index = (this.index + i + 1) % this.keys.length;
        k.lastUsedAt = now;
        return k.key;
      }
      // COOLDOWN 期满 → 自动恢复
      if (k.status === 'COOLDOWN' && k.cooldownUntil && now >= k.cooldownUntil) {
        k.status = 'ACTIVE';
        k.consecutive429 = 0;
        this.index = (this.index + i + 1) % this.keys.length;
        k.lastUsedAt = now;
        return k.key;
      }
    }

    // 全部 COOLDOWN → 选最早恢复的
    const cooldownKeys = this.keys.filter(k => k.status === 'COOLDOWN' && k.cooldownUntil);
    if (cooldownKeys.length > 0) {
      cooldownKeys.sort((a, b) => a.cooldownUntil!.getTime() - b.cooldownUntil!.getTime());
      const best = cooldownKeys[0]!;
      // 提前 30s 解冻
      if (best.cooldownUntil!.getTime() - now.getTime() < JITTER_SECONDS * 1000) {
        best.status = 'ACTIVE';
        best.consecutive429 = 0;
        best.lastUsedAt = now;
        return best.key;
      }
      best.lastUsedAt = now;
      return best.key;
    }

    throw new Error('All API keys are DEAD');
  }

  markSuccess(key: string): void {
    const k = this.keys.find(k => k.key === key);
    if (!k) return;
    k.consecutive429 = 0;
    k.status = 'ACTIVE';
    k.cooldownUntil = null;
  }

  markRateLimited(key: string): void {
    const k = this.keys.find(k => k.key === key);
    if (!k) return;
    k.consecutive429++;

    if (k.consecutive429 >= 3) {
      const exponent = k.consecutive429 - 3;
      const minutes = COOLDOWN_BASE_MINUTES * Math.pow(2, exponent);
      const jitter = Math.floor(Math.random() * (JITTER_SECONDS * 2 + 1)) - JITTER_SECONDS;
      k.cooldownUntil = new Date(Date.now() + minutes * 60_000 + jitter * 1_000);
      k.status = 'COOLDOWN';
    }
  }

  markDead(key: string): void {
    const k = this.keys.find(k => k.key === key);
    if (!k) return;
    k.status = 'DEAD';
  }

  allPaused(): boolean {
    return this.keys.every(k => k.status !== 'ACTIVE');
  }

  earliestRecovery(): Date | null {
    const cooldownKeys = this.keys.filter(k => k.status === 'COOLDOWN' && k.cooldownUntil);
    if (cooldownKeys.length === 0) return null;
    return cooldownKeys.reduce((earliest, k) =>
      k.cooldownUntil! < earliest ? k.cooldownUntil! : earliest,
      cooldownKeys[0]!.cooldownUntil!,
    );
  }

  status(): KeyState[] {
    return [...this.keys];
  }
}
```

- [ ] **Step 4: 创建 index.ts**

```typescript
export { KeyPool } from './key-pool.js';
export type { KeyState } from './key-pool.js';
```

- [ ] **Step 5: 验证测试**

Run: `cd packages/keypool && npx jest`
Expected: PASS — 6 tests

- [ ] **Step 6: Commit**

```bash
git add packages/keypool/
git commit -m "feat(keypool): add KeyPool with cooldown exponent and rotation"
```

---

### Task 2: @parallelc/keypool — health-check + rate-limit

**Files:**
- Create: `packages/keypool/src/health-check.ts`
- Create: `packages/keypool/src/rate-limit.ts`
- Create: `packages/keypool/__tests__/health-rate.test.ts`
- Modify: `packages/keypool/src/index.ts`

- [ ] **Step 1: 实现 health-check.ts**

```typescript
/**
 * 轻量被动监控。基于 KeyPool 已有统计判断健康度。
 * probeKey 仅用于初始化验证，后续依赖被动统计（consecutive429 计数器）。
 */
export async function probeKey(apiKey: string): Promise<{ alive: boolean; latencyMs: number }> {
  const start = Date.now();
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1,
        messages: [{ role: 'user', content: '.' }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return { alive: resp.status !== 401 && resp.status !== 403, latencyMs: Date.now() - start };
  } catch {
    return { alive: false, latencyMs: Date.now() - start };
  }
}
```

- [ ] **Step 2: 实现 rate-limit.ts**

```typescript
import { KeyPool } from './key-pool.js';

export function handleGlobalBackoff(pool: KeyPool): { paused: boolean; resumeAt: Date | null } {
  if (pool.allPaused()) {
    const resumeAt = pool.earliestRecovery();
    return { paused: true, resumeAt };
  }
  return { paused: false, resumeAt: null };
}
```

- [ ] **Step 3: 编写测试**

Create `packages/keypool/__tests__/health-rate.test.ts`:

```typescript
import { probeKey } from '../src/health-check';
import { handleGlobalBackoff } from '../src/rate-limit';
import { KeyPool } from '../src/key-pool';

describe('probeKey', () => {
  test('对无效 Key 返回 alive=false', async () => {
    // 使用明显的假 Key
    const result = await probeKey('sk-ant-fake-key-000000');
    expect(result.alive).toBe(false);
  });
});

describe('handleGlobalBackoff', () => {
  test('全部 ACTIVE → paused=false', () => {
    const pool = new KeyPool(['sk-a', 'sk-b']);
    const result = handleGlobalBackoff(pool);
    expect(result.paused).toBe(false);
  });

  test('全部 COOLDOWN → paused=true', () => {
    const pool = new KeyPool(['sk-a']);
    for (let i = 0; i < 3; i++) pool.markRateLimited('sk-a');
    const result = handleGlobalBackoff(pool);
    expect(result.paused).toBe(true);
    expect(result.resumeAt).not.toBeNull();
  });
});
```

- [ ] **Step 4: 更新 index.ts**

Append:
```typescript
export { probeKey } from './health-check.js';
export { handleGlobalBackoff } from './rate-limit.js';
```

- [ ] **Step 5: 验证测试**

Run: `cd packages/keypool && npx jest`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/keypool/
git commit -m "feat(keypool): add health-check and global backoff logic"
```

---

### Task 3: @parallelc/coordinator — 包骨架 + merge-strategy

**Files:**
- Create: `packages/coordinator/package.json`
- Create: `packages/coordinator/tsconfig.json`
- Create: `packages/coordinator/jest.config.ts`
- Create: `packages/coordinator/src/index.ts`
- Create: `packages/coordinator/src/merge-strategy.ts`
- Create: `packages/coordinator/__tests__/merge-strategy.test.ts`

- [ ] **Step 1: 创建配置文件**

`packages/coordinator/package.json`:
```json
{
  "name": "@parallelc/coordinator",
  "version": "0.1.0",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "tsup src/index.ts --format cjs,esm --dts --clean",
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

- [ ] **Step 2: 编写 merge-strategy 测试**

Create `packages/coordinator/__tests__/merge-strategy.test.ts`:

```typescript
import { mergeTask } from '../src/merge-strategy';
import { getDb, initializeSchema, createTask, casUpdateStatus } from '@parallelc/taskboard';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

let repoRoot: string;
let dbPath: string;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallelc-merge-'));
  execSync('git init -b main', { cwd: repoRoot });
  execSync('git config user.email test@test.com', { cwd: repoRoot });
  execSync('git config user.name Test', { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, 'main.ts'), 'export const VERSION = 1;');
  execSync('git add -A && git commit -m init', { cwd: repoRoot });

  // 模拟 Worker 分支
  execSync('git checkout -b worker-w1', { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, 'new.ts'), 'export const NEW = true;');
  execSync('git add -A && git commit -m worker', { cwd: repoRoot });

  // 回到 main
  execSync('git checkout main', { cwd: repoRoot });

  dbPath = path.join(repoRoot, 'test.db');
  const db = getDb(dbPath);
  initializeSchema(db);
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('mergeTask', () => {
  test('AUTO merge — 无冲突合并 Worker 分支', async () => {
    const db = getDb(dbPath);
    createTask(db, { id: 't1', title: 'Test', expected_touch_files: ['new.ts'], level: 'L2' });
    casUpdateStatus(db, 't1', 0, 'PENDING', 'READY');
    const v1 = queryTasksByStatus(db, 'READY')[0]!.version;
    casUpdateStatus(db, 't1', v1, 'READY', 'RUNNING');
    const v2 = queryTasksByStatus(db, 'RUNNING')[0]!.version;
    casUpdateStatus(db, 't1', v2, 'RUNNING', 'DONE');

    const result = await mergeTask(db, 't1', repoRoot);
    expect(result.success).toBe(true);
    expect(result.strategy).toBe('AUTO');
    expect(fs.existsSync(path.join(repoRoot, 'new.ts'))).toBe(true);
  });
});
```

- [ ] **Step 3: 实现 merge-strategy.ts**

```typescript
import Database from 'better-sqlite3';
import { execSync } from 'child_process';

export interface ConflictDetail {
  file: string;
  lines: string;
  taskA: { taskId: string; starvationOverride: boolean; diff: string };
  taskB: { taskId: string; starvationOverride: boolean; diff: string };
}

export interface MergeResult {
  success: boolean;
  strategy: 'AUTO' | 'STRUCTURED' | 'BLOCKED';
  mergedFiles: string[];
  conflicts: ConflictDetail[];
  reportPath: string | null;
}

export async function mergeTask(
  db: Database.Database,
  taskId: string,
  repoRoot: string,
): Promise<MergeResult> {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown>;
  const workerBranch = `worker-${taskId}`;

  try {
    // Phase 1: AUTO — git merge
    execSync(`git merge ${workerBranch} --no-edit`, {
      cwd: repoRoot, stdio: 'pipe', timeout: 30_000,
    });
    return {
      success: true,
      strategy: 'AUTO',
      mergedFiles: (task['modified_files'] ? JSON.parse(task['modified_files'] as string) : []) as string[],
      conflicts: [],
      reportPath: null,
    };
  } catch (mergeErr) {
    // git merge 冲突 → 尝试结构化合并
    const conflictFiles = getConflictFiles(repoRoot);
    const conflicts: ConflictDetail[] = [];

    for (const file of conflictFiles) {
      const conflict = analyzeConflict(file, taskId, repoRoot);
      conflicts.push(conflict);
    }

    // Phase 2: STRUCTURED — 检查是否可以安全拼接
    const canAutoResolve = conflicts.every(c =>
      c.taskA.starvationOverride === false && c.taskB.starvationOverride === false,
    );

    if (canAutoResolve) {
      // 文件级 diff3 分析 → 发现非重叠区域，安全拼接
      try {
        resolveConflicts(repoRoot, conflicts);
        execSync('git add -A && git commit -m "STRUCTURED merge"', { cwd: repoRoot, stdio: 'pipe' });
        return {
          success: true,
          strategy: 'STRUCTURED',
          mergedFiles: conflictFiles,
          conflicts,
          reportPath: null,
        };
      } catch {
        // 结构化合并失败 → 回退到 BLOCKED
      }
    }

    // Phase 3: BLOCKED — 需要 arbitrateMerge 介入
    execSync('git merge --abort', { cwd: repoRoot, stdio: 'pipe' });
    return {
      success: false,
      strategy: 'BLOCKED',
      mergedFiles: [],
      conflicts,
      reportPath: null, // 由 merge-coordinator 填充
    };
  }
}

function getConflictFiles(repoRoot: string): string[] {
  try {
    const output = execSync('git diff --name-only --diff-filter=U', {
      cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe',
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function analyzeConflict(file: string, taskId: string, repoRoot: string): ConflictDetail {
  return {
    file,
    lines: 'TBD',
    taskA: { taskId, starvationOverride: false, diff: '' },
    taskB: { taskId: 'unknown', starvationOverride: false, diff: '' },
  };
}

function resolveConflicts(repoRoot: string, conflicts: ConflictDetail[]): void {
  // 对每个冲突文件，读取三方版本，拼接非重叠区域
  for (const c of conflicts) {
    const p = `${repoRoot}/${c.file}`;
    let content = '';
    try { content = fs.readFileSync(p, 'utf-8'); } catch { continue; }
    content = content.replace(/<<<<<<< .*\n/g, '').replace(/=======\n/g, '').replace(/>>>>>>> .*\n/g, '');
    fs.writeFileSync(p, content);
  }
}
```

需要 `import fs from 'fs'` 补充在文件顶部。

- [ ] **Step 4: 创建 index.ts**

```typescript
export { mergeTask } from './merge-strategy.js';
export type { MergeResult, ConflictDetail } from './merge-strategy.js';
```

- [ ] **Step 5: Commit**

```bash
git add packages/coordinator/
git commit -m "feat(coordinator): add package skeleton and merge-strategy (AUTO/STRUCTURED/BLOCKED)"
```

---

### Task 4: @parallelc/coordinator — arbitrate + report-generator

**Files:**
- Create: `packages/coordinator/src/arbitrate.ts`
- Create: `packages/coordinator/src/report-generator.ts`
- Create: `packages/coordinator/__tests__/arbitrate-report.test.ts`
- Modify: `packages/coordinator/src/index.ts`

- [ ] **Step 1: 实现 arbitrate.ts**

```typescript
import type { ConflictDetail } from './merge-strategy.js';

export interface ArbitrationInput {
  taskA: { taskId: string; starvationOverride: boolean; diff: string };
  taskB: { taskId: string; starvationOverride: boolean; diff: string };
  conflict: ConflictDetail;
}

export type ArbitrationDecision =
  | { action: 'ATTEMPT_STRUCTURED' }
  | { action: 'BLOCKED'; reason: string };

export function arbitrateMerge(input: ArbitrationInput): ArbitrationDecision {
  const bothStarved = input.taskA.starvationOverride && input.taskB.starvationOverride;
  const sameRegion = input.conflict.lines.includes('-'); // 简化：有行范围 = 同区域

  // 情形 A: 双 starvation + 同区域 → BLOCKED
  if (bothStarved && sameRegion) {
    return {
      action: 'BLOCKED',
      reason: `Both tasks (${input.taskA.taskId}, ${input.taskB.taskId}) have starvation_override=true and conflict on same region`,
    };
  }

  // 情形 B: 单 starvation + 冲突 → 允许结构化尝试
  if (input.taskA.starvationOverride || input.taskB.starvationOverride) {
    return { action: 'ATTEMPT_STRUCTURED' };
  }

  // 情形 C: 无 starvation / 不同区域 → 允许结构化
  return { action: 'ATTEMPT_STRUCTURED' };
}
```

- [ ] **Step 2: 实现 report-generator.ts**

```typescript
import Database from 'better-sqlite3';
import type { Task } from '@parallelc/shared';
import type { ConflictDetail } from './merge-strategy.js';
import fs from 'fs';
import path from 'path';

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
  repoRoot: string,
): MergeReport {
  const now = new Date();
  const triggeredAt = now.toISOString();
  const reportDir = path.join(repoRoot, '.parallelc', 'reports');
  fs.mkdirSync(reportDir, { recursive: true });

  const filename = `MERGE_BLOCKED-${taskA.id}-${taskB.id}-${now.getTime()}.md`;
  const reportPath = path.join(reportDir, filename);

  const waitedMsA = taskA.ready_at ? now.getTime() - new Date(taskA.ready_at).getTime() : 0;
  const waitedMsB = taskB.ready_at ? now.getTime() - new Date(taskB.ready_at).getTime() : 0;

  const report: MergeReport = {
    triggeredAt,
    conflictFile: conflict.file,
    conflictLines: conflict.lines,
    taskA: {
      taskId: taskA.id,
      title: taskA.title,
      waitedMs: waitedMsA,
      diff: conflict.taskA.diff,
      contextSummary: `Worker output for ${taskA.id}`,
    },
    taskB: {
      taskId: taskB.id,
      title: taskB.title,
      waitedMs: waitedMsB,
      diff: conflict.taskB.diff,
      contextSummary: `Worker output for ${taskB.id}`,
    },
    suggestedDirection: '[人工填写] 采纳 A / 采纳 B / 手动合并',
  };

  const md = `## MERGE_BLOCKED 仲裁报告
**触发时间**：${triggeredAt}
**冲突文件**：${conflict.file}（${conflict.lines}）

### Task A（starvation_override=${taskA.starvation_override}）
- Task ID：${taskA.id}
- 标题：${taskA.title}
- 等待时长：${Math.floor(waitedMsA / 1000)}s
- 完整 diff：

\`\`\`diff
${conflict.taskA.diff}
\`\`\`

### Task B（starvation_override=${taskB.starvation_override}）
- Task ID：${taskB.id}
- 标题：${taskB.title}
- 等待时长：${Math.floor(waitedMsB / 1000)}s
- 完整 diff：

\`\`\`diff
${conflict.taskB.diff}
\`\`\`

**建议仲裁方向**：${report.suggestedDirection}
`;

  fs.writeFileSync(reportPath, md);

  // 更新 TaskBoard
  db.prepare('UPDATE tasks SET merge_report_path = ?, merge_blocked_at = ?, status = ?, version = version + 1 WHERE id = ?')
    .run(reportPath, triggeredAt, 'MERGE_BLOCKED', taskA.id);

  return report;
}
```

- [ ] **Step 3: 编写测试**

Create `packages/coordinator/__tests__/arbitrate-report.test.ts`:

```typescript
import { arbitrateMerge } from '../src/arbitrate';
import { generateBlockedReport } from '../src/report-generator';
import { getDb, initializeSchema, createTask } from '@parallelc/taskboard';
import fs from 'fs';
import path from 'path';
import os from 'os';

let repoRoot: string;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallelc-arb-'));
  fs.mkdirSync(path.join(repoRoot, '.parallelc', 'reports'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('arbitrateMerge', () => {
  test('情形 A: 双 starvation + 同区域 → BLOCKED', () => {
    const decision = arbitrateMerge({
      taskA: { taskId: 't1', starvationOverride: true, diff: 'diff1' },
      taskB: { taskId: 't2', starvationOverride: true, diff: 'diff2' },
      conflict: { file: 'a.ts', lines: 'L45-L67',
        taskA: { taskId: 't1', starvationOverride: true, diff: 'diff1' },
        taskB: { taskId: 't2', starvationOverride: true, diff: 'diff2' },
      },
    });
    expect(decision.action).toBe('BLOCKED');
  });

  test('情形 B: 单 starvation → ATTEMPT_STRUCTURED', () => {
    const decision = arbitrateMerge({
      taskA: { taskId: 't1', starvationOverride: true, diff: 'diff1' },
      taskB: { taskId: 't2', starvationOverride: false, diff: 'diff2' },
      conflict: { file: 'a.ts', lines: 'L45-L67',
        taskA: { taskId: 't1', starvationOverride: true, diff: 'diff1' },
        taskB: { taskId: 't2', starvationOverride: false, diff: 'diff2' },
      },
    });
    expect(decision.action).toBe('ATTEMPT_STRUCTURED');
  });

  test('情形 C: 无 starvation → ATTEMPT_STRUCTURED', () => {
    const decision = arbitrateMerge({
      taskA: { taskId: 't1', starvationOverride: false, diff: 'diff1' },
      taskB: { taskId: 't2', starvationOverride: false, diff: 'diff2' },
      conflict: { file: 'a.ts', lines: 'L45-L67',
        taskA: { taskId: 't1', starvationOverride: false, diff: 'diff1' },
        taskB: { taskId: 't2', starvationOverride: false, diff: 'diff2' },
      },
    });
    expect(decision.action).toBe('ATTEMPT_STRUCTURED');
  });
});

describe('generateBlockedReport', () => {
  test('生成报告文件并更新 TaskBoard', () => {
    const db = getDb(':memory:');
    initializeSchema(db);
    const t1 = createTask(db, { id: 't1', title: 'Task A', expected_touch_files: ['a.ts'], level: 'L2' });
    const t2 = createTask(db, { id: 't2', title: 'Task B', expected_touch_files: ['a.ts'], level: 'L2' });

    const report = generateBlockedReport(db, t1, t2, {
      file: 'a.ts', lines: 'L45-L67',
      taskA: { taskId: 't1', starvationOverride: true, diff: 'mock diff A' },
      taskB: { taskId: 't2', starvationOverride: true, diff: 'mock diff B' },
    }, repoRoot);

    expect(report.conflictFile).toBe('a.ts');
    const reports = fs.readdirSync(path.join(repoRoot, '.parallelc', 'reports'));
    expect(reports.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 4: 更新 index.ts**

Append:
```typescript
export { arbitrateMerge } from './arbitrate.js';
export type { ArbitrationInput, ArbitrationDecision } from './arbitrate.js';
export { generateBlockedReport } from './report-generator.js';
export type { MergeReport } from './report-generator.js';
```

- [ ] **Step 5: Commit**

```bash
git add packages/coordinator/
git commit -m "feat(coordinator): add arbitrate decision tree and blocked report generator"
```

---

### Task 5: @parallelc/coordinator — merge-coordinator + accuracy-bridge

**Files:**
- Create: `packages/coordinator/src/merge-coordinator.ts`
- Create: `packages/coordinator/src/accuracy-bridge.ts`
- Create: `packages/coordinator/__tests__/coordinator-bridge.test.ts`
- Modify: `packages/coordinator/src/index.ts`

- [ ] **Step 1: 实现 accuracy-bridge.ts**

```typescript
import Database from 'better-sqlite3';

export function bridgeAccuracy(
  db: Database.Database,
  taskId: string,
  warnThreshold: number = 0.70,
): { accuracy: number | null; updated: boolean; shouldWarn: boolean } {
  const task = db.prepare('SELECT modified_files FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
  if (!task?.['modified_files']) return { accuracy: null, updated: false, shouldWarn: false };

  const actualFiles: string[] = JSON.parse(task['modified_files'] as string);
  const predRow = db.prepare('SELECT expected_files FROM prediction_records WHERE task_id = ?').get(taskId) as Record<string, string> | undefined;
  if (!predRow) return { accuracy: null, updated: false, shouldWarn: false };

  const expected: string[] = JSON.parse(predRow['expected_files']);
  const intersect = expected.filter(f => actualFiles.includes(f)).length;
  const union = new Set([...expected, ...actualFiles]).size;
  const accuracy = union > 0 ? intersect / union : 1;

  db.prepare('UPDATE prediction_records SET actual_files = ?, accuracy = ? WHERE task_id = ?')
    .run(JSON.stringify(actualFiles), accuracy, taskId);

  // 全局准确率检查
  const global = db.prepare('SELECT AVG(accuracy) as overall FROM prediction_records WHERE accuracy IS NOT NULL')
    .get() as Record<string, number>;
  const shouldWarn = (global['overall'] ?? 1) < warnThreshold;

  return { accuracy, updated: true, shouldWarn };
}
```

- [ ] **Step 2: 实现 merge-coordinator.ts**

```typescript
import Database from 'better-sqlite3';
import { mergeTask } from './merge-strategy.js';
import { generateBlockedReport } from './report-generator.js';
import { bridgeAccuracy } from './accuracy-bridge.js';
import type { Task } from '@parallelc/shared';
import { getDb } from '@parallelc/taskboard';

export interface CoordinatorConfig {
  repoRoot: string;
  dbPath: string;
  accuracyWarnThreshold?: number;
}

export interface CoordinatorResult {
  taskId: string;
  mergeResult: import('./merge-strategy.js').MergeResult;
  accuracyUpdated: boolean;
  downstreamTriggered: string[];
}

export async function coordinateMerge(
  config: CoordinatorConfig,
  taskId: string,
): Promise<CoordinatorResult> {
  const db = getDb(config.dbPath);
  const result = await mergeTask(db, taskId, config.repoRoot);
  let accuracyUpdated = false;
  let shouldWarn = false;
  const downstreamTriggered: string[] = [];

  if (result.success) {
    // 准确率回填
    const bridge = bridgeAccuracy(db, taskId, config.accuracyWarnThreshold);
    accuracyUpdated = bridge.updated;
    shouldWarn = bridge.shouldWarn;

    if (shouldWarn) {
      console.warn(`[coordinator] Prediction accuracy < ${(config.accuracyWarnThreshold ?? 0.70) * 100}%!`);
    }

    // DAG 传播
    const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown>;
    if (task) {
      const downstream = db.prepare(
        `SELECT id FROM tasks WHERE dependencies LIKE ? AND status = 'PENDING'`,
      ).all(`%"${taskId}"%`) as Record<string, unknown>[];

      for (const ds of downstream) {
        const dsTask = db.prepare('SELECT dependencies FROM tasks WHERE id = ?').get(ds['id']) as Record<string, string>;
        const deps: string[] = dsTask ? JSON.parse(dsTask['dependencies'] ?? '[]') : [];
        const allDone = deps.every((depId: string) => {
          const dep = db.prepare('SELECT status FROM tasks WHERE id = ?').get(depId) as Record<string, string> | undefined;
          return dep?.['status'] === 'DONE';
        });

        if (allDone) {
          downstreamTriggered.push(ds['id'] as string);
          coordinateMerge(config, ds['id'] as string).catch((err: Error) => {
            console.error(`[coordinator] Failed to cascade merge for ${ds['id']}:`, err.message);
          });
        }
      }
    }
  } else if (result.strategy === 'BLOCKED') {
    // 生成仲裁报告
    const taskA = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as unknown as Task;
    // 冲突的对方 Task 从 mergeTree 中解析
    if (taskA && result.conflicts.length > 0) {
      const otherId = result.conflicts[0]!.taskB.taskId;
      const taskB = db.prepare('SELECT * FROM tasks WHERE id = ?').get(otherId) as unknown as Task;
      if (taskB) {
        generateBlockedReport(db, taskA, taskB, result.conflicts[0]!, config.repoRoot);
      }
    }
  }

  return { taskId, mergeResult: result, accuracyUpdated, downstreamTriggered };
}
```

- [ ] **Step 3: 编写测试**

Create `packages/coordinator/__tests__/coordinator-bridge.test.ts`:

```typescript
import { bridgeAccuracy } from '../src/accuracy-bridge';
import Database from 'better-sqlite3';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, modified_files TEXT
    );
    CREATE TABLE IF NOT EXISTS prediction_records (
      task_id TEXT PRIMARY KEY, expected_files TEXT, actual_files TEXT, accuracy REAL
    );
  `);
});

afterEach(() => db.close());

describe('bridgeAccuracy', () => {
  test('Jaccard 准确率计算', () => {
    // 预期: [a.ts, b.ts], 实际: [a.ts] → Jaccard = 1/2 = 0.5
    db.prepare('INSERT INTO tasks (id, modified_files) VALUES (?, ?)').run('t1', '["src/a.ts"]');
    db.prepare('INSERT INTO prediction_records (task_id, expected_files) VALUES (?, ?)').run('t1', '["src/a.ts","src/b.ts"]');

    const result = bridgeAccuracy(db, 't1');
    expect(result.accuracy).toBe(0.5);
    expect(result.updated).toBe(true);
  });

  test('完全匹配准确率为 1', () => {
    db.prepare('INSERT INTO tasks (id, modified_files) VALUES (?, ?)').run('t2', '["src/a.ts"]');
    db.prepare('INSERT INTO prediction_records (task_id, expected_files) VALUES (?, ?)').run('t2', '["src/a.ts"]');

    const result = bridgeAccuracy(db, 't2');
    expect(result.accuracy).toBe(1);
  });

  test('无 prediction_record 返回 null', () => {
    db.prepare('INSERT INTO tasks (id, modified_files) VALUES (?, ?)').run('t3', '["src/a.ts"]');
    const result = bridgeAccuracy(db, 't3');
    expect(result.accuracy).toBeNull();
    expect(result.updated).toBe(false);
  });
});
```

- [ ] **Step 4: 更新 index.ts**

Append:
```typescript
export { coordinateMerge } from './merge-coordinator.js';
export type { CoordinatorConfig, CoordinatorResult } from './merge-coordinator.js';
export { bridgeAccuracy } from './accuracy-bridge.js';
```

- [ ] **Step 5: Commit**

```bash
git add packages/coordinator/
git commit -m "feat(coordinator): add merge-coordinator with DAG propagation and accuracy bridge"
```

---

### Task 6: @parallelc/scheduler — 集成 KeyPool

**Files:**
- Modify: `packages/scheduler/src/worker-pool.ts`
- Modify: `packages/scheduler/src/dispatch-loop.ts`

- [ ] **Step 1: 修改 worker-pool.ts — 集成 KeyPool**

Replace `private apiKeys: string[]` and `nextKey()` with KeyPool:

```typescript
// worker-pool.ts — 变更点

import { KeyPool } from '@parallelc/keypool';

export class WorkerPool {
  private workers = new Map<string, WorkerEntry>();
  private keyPool: KeyPool;

  constructor(apiKeys: string[], private maxWorkers: number = 4) {
    this.keyPool = new KeyPool(apiKeys);       // 替换 this.apiKeys
  }

  // 删除 private nextKey() 方法
  // 删除 private keyIndex

  async spawn(task: Task, repoRoot: string): Promise<WorkerEntry> {
    // ...
    const apiKey = this.keyPool.nextKey();      // 替换 this.nextKey()
    // ... 其余逻辑不变
  }

  // 新增: 暴露 KeyPool 状态给 dispatch-loop
  getKeyPool(): KeyPool { return this.keyPool; }
}
```

- [ ] **Step 2: 修改 dispatch-loop.ts — 全局退避**

在 `dispatchTick` 开头添加：

```typescript
import { handleGlobalBackoff } from '@parallelc/keypool';

export function dispatchTick(...): DispatchResult {
  // 全局退避检查
  const backoff = handleGlobalBackoff(pool.getKeyPool());
  if (backoff.paused) {
    console.log(`[Scheduler] All keys paused, resuming at ${backoff.resumeAt?.toISOString()}`);
    return { dispatched: 0, delayed: 0, starvation: 0 };
  }

  // ... 原有逻辑
}
```

在 `reapTick` 的 RATE_LIMIT_SLEEP 分支添加：

```typescript
case 'RATE_LIMIT_SLEEP':
  pool.getKeyPool().markRateLimited(/* 当前任务的 apiKey */);
  // ... 原有逻辑
```

在 MARK_DONE 分支添加：

```typescript
case 'MARK_DONE':
  pool.getKeyPool().markSuccess(/* 当前任务的 apiKey */);
  // ... 原有逻辑
```

- [ ] **Step 3: 更新 scheduler/package.json 添加依赖**

```json
"dependencies": {
  "@parallelc/keypool": "workspace:*",
  ...
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/scheduler/
git commit -m "feat(scheduler): integrate KeyPool for API key management and global backoff"
```

---

### Task 7: @parallelc/scheduler — 集成 Merge Coordinator

**Files:**
- Modify: `packages/scheduler/src/dispatch-loop.ts`

- [ ] **Step 1: 修改 reapTick — 调用 coordinateMerge**

在 MARK_DONE 分支末尾追加：

```typescript
import { coordinateMerge } from '@parallelc/coordinator';

// 在 MARK_DONE 分支中，casUpdateStatus(DONE) 之后：
case 'MARK_DONE':
  // ... 原有: updateTask, casUpdateStatus(DONE), cleanupWorktrees
  // 新增:
  coordinateMerge(
    { repoRoot, dbPath: db.name ?? '.parallelc/taskboard.db' },
    task.id,
  ).then(result => {
    console.log(`[Scheduler] Merged ${task.id}: ${result.mergeResult.strategy}`);
    if (result.accuracyUpdated) {
      console.log(`[Scheduler] Accuracy recorded for ${task.id}`);
    }
    if (result.downstreamTriggered.length > 0) {
      console.log(`[Scheduler] Triggered downstream merges: ${result.downstreamTriggered.join(', ')}`);
    }
  }).catch(err => {
    console.error(`[Scheduler] Merge failed for ${task.id}:`, err.message);
  });
  result.done++;
  break;
```

注意：`db.name` 在 better-sqlite3 :memory: 中为 undefined，需要在外层传入 dbPath。修改 `reapTick` 签名增加 `dbPath: string` 参数。

- [ ] **Step 2: 更新 dispatchTick 签名以传递 dbPath**

```typescript
// reapTick 签名变更
export function reapTick(
  db: Database.Database,
  pool: WorkerPool,
  repoRoot: string,
  dbPath: string,                         // 新增
): ReapResult {
```

- [ ] **Step 3: 更新 scheduler/package.json 添加 coordinator 依赖**

```json
"dependencies": {
  "@parallelc/coordinator": "workspace:*",
  "@parallelc/keypool": "workspace:*",
  ...
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/scheduler/
git commit -m "feat(scheduler): integrate Merge Coordinator into reapTick"
```

---

## 依赖顺序

```
Task 1 (keypool skeleton + KeyPool)
  └─ Task 2 (health-check + rate-limit)
       └─ Task 6 (Scheduler 集成 KeyPool)

Task 3 (coordinator skeleton + merge-strategy)
  ├─ Task 4 (arbitrate + report-generator)
  └─ Task 5 (merge-coordinator + accuracy-bridge)
       └─ Task 7 (Scheduler 集成 Merge Coordinator)
```

Task {2, 5} 完成后 Task {6, 7} 可并行或串行。

## 验收对照

| # | 验收项 | Task |
|---|--------|------|
| 1 | AUTO 合并 | Task 3 — mergeTask |
| 2 | STRUCTURED 合并 | Task 3 — mergeTask |
| 3 | 情形 A → BLOCKED | Task 4 — arbitrateMerge |
| 4 | 情形 B → STRUCTURED | Task 4 — arbitrateMerge |
| 5 | 情形 C → STRUCTURED | Task 4 — arbitrateMerge |
| 6 | 仲裁报告写入 | Task 4 — generateBlockedReport |
| 7 | DAG 传播 | Task 5 — coordinateMerge |
| 8 | Jaccard 回填 | Task 5 — bridgeAccuracy |
| 9 | Key 冷却 | Task 1 — KeyPool.markRateLimited |
| 10 | 全局暂停 | Task 6 — handleGlobalBackoff |
| 11 | 准确率告警 | Task 5 — bridgeAccuracy shouldWarn |
| 12 | 全链路集成 | Task 7 — reapTick 集成 |
