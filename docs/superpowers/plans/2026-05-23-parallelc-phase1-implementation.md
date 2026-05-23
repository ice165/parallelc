# ParallelC Phase 1 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建 ParallelC TypeScript monorepo 骨架，实现写保护、双 Worktree 管理、快照校验、退出码路由和 TaskBoard 数据层。

**Architecture:** pnpm monorepo，4 个包：shared（类型/常量）→ validate（写保护）、worker（Worktree/生命周期）、taskboard（SQLite CRUD+CAS）。所有包遵循 TDD：先写测试验证失败，再写实现通过。

**Tech Stack:** TypeScript (strict), pnpm workspaces, better-sqlite3, Jest + ts-jest, tsx, tsup

**基于规范:** `docs/superpowers/specs/2026-05-23-parallelc-phase1-design.md`

---

### Task 1: Monorepo 根骨架

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `jest.config.base.ts`
- Create: `.env.example`
- Create: `.gitignore`

- [ ] **Step 1: 创建 pnpm-workspace.yaml**

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 2: 创建根 package.json**

```json
{
  "name": "parallelc",
  "private": true,
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "test:ci": "pnpm -r test:ci",
    "lint": "eslint packages --ext .ts",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "@types/jest": "^29.5.14",
    "@types/node": "^22.10.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.5",
    "tsup": "^8.3.5",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2"
  },
  "engines": {
    "node": ">=20.0.0",
    "pnpm": ">=9.0.0"
  }
}
```

- [ ] **Step 3: 创建 tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  }
}
```

- [ ] **Step 4: 创建 jest.config.base.ts**

```typescript
import type { Config } from 'jest';

const baseConfig: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    // ts-jest 默认不解析 .js 扩展名到 .ts 源文件
    // ESM 规范要求 import 带 .js 扩展名，此映射解决编译期路径分歧
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  collectCoverageFrom: ['src/**/*.ts'],
};

export default baseConfig;
```

- [ ] **Step 5: 创建 .env.example**

```bash
# ParallelC API Keys Pool
# 多个 Key 用逗号分隔，Worker 启动时循环轮转
ANTHROPIC_API_KEYS=sk-ant-xxx,sk-ant-yyy
```

- [ ] **Step 6: 创建 .gitignore**

```gitignore
node_modules/
dist/
.parallelc/
*.db
*.db-wal
*.db-shm
.env
```

- [ ] **Step 7: 安装依赖并验证**

Run: `pnpm install`
Expected: 无错误，node_modules 创建成功

- [ ] **Step 8: 验证 TypeScript 配置**

Run: `pnpm exec tsc --showConfig`
Expected: 显示合并后的 TS 配置，无报错

- [ ] **Step 9: Commit**

```bash
git add pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json jest.config.base.ts .env.example .gitignore
git commit -m "feat: add monorepo root skeleton with pnpm workspaces"
```

---

### Task 2: @parallelc/shared — 类型、常量、错误基类

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/jest.config.ts`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/types.ts`
- Create: `packages/shared/src/constants.ts`
- Create: `packages/shared/src/errors.ts`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "@parallelc/shared",
  "version": "0.1.0",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "tsup src/index.ts --format cjs,esm --dts --clean",
    "typecheck": "tsc --noEmit",
    "test": "jest",
    "test:ci": "jest --ci --coverage"
  }
}
```

> `@parallelc/shared` 是纯类型和常量包，零依赖，不需要 devDependencies（尤其是不能自引用 `workspace:*`）。

- [ ] **Step 2: 创建 tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: 创建 jest.config.ts**

```typescript
import baseConfig from '../../jest.config.base';

export default baseConfig;
```

- [ ] **Step 4: 创建 src/constants.ts**

```typescript
/** Worker 正常完成 */
export const EXIT_SUCCESS = 0;

/** Worker 达到 30 轮上下文上限 */
export const EXIT_CHECKPOINT = 10;

/** Worker 进程运行超时（Watchdog 触发） */
export const EXIT_TIMEOUT = 11;

/** Worker 试图跨区写入被 validate_write hook 拦截 */
export const EXIT_HOOK_BLOCKED = 12;

/** Worker 遭遇 API 429 限流 */
export const EXIT_RATE_LIMIT = 13;

/** 退出码 → 常量名映射 */
export const EXIT_CODE_LABELS: Record<number, string> = {
  [EXIT_SUCCESS]: 'EXIT_SUCCESS',
  [EXIT_CHECKPOINT]: 'EXIT_CHECKPOINT',
  [EXIT_TIMEOUT]: 'EXIT_TIMEOUT',
  [EXIT_HOOK_BLOCKED]: 'EXIT_HOOK_BLOCKED',
  [EXIT_RATE_LIMIT]: 'EXIT_RATE_LIMIT',
};
```

- [ ] **Step 5: 创建 src/types.ts**

```typescript
export type TaskStatus =
  | 'PENDING'
  | 'READY'
  | 'RUNNING'
  | 'SLEEP_PENDING'
  | 'CHECKPOINT_PENDING'
  | 'DONE'
  | 'FAILED'
  | 'CANCELLED'
  | 'MERGE_BLOCKED';

export type TaskLevel = 'L1' | 'L2' | 'L3';

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  version: number;
  level: TaskLevel;
  expected_touch_files: string[] | null;
  modified_files: string[] | null;
  rate_limit_count: number;
  sleep_until: string | null;
  starvation_override: boolean;
  snapshot_version: string | null;
  context_mismatch: boolean;
  merge_blocked_at: string | null;
  merge_report_path: string | null;
  dependencies: string[] | null;
  ready_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkerContext {
  workerId: string;
  readonlyRoot: string;
  writeRoot: string;
  taskId: string;
  apiKey: string;
}

export interface SnapshotVersion {
  dagId: string;
  timestamp: string;
  status: 'FROZEN' | 'ACTIVE';
}

export interface SpawnWorkerOptions {
  workerId: string;
  expectedTouchFiles: string[];
  repoRoot: string;
  apiKey: string;
  baseBranch?: string;
}

export interface SpawnWorkerResult {
  workerId: string;
  readonlyRoot: string;
  writeRoot: string;
  spawnedAt: string;
}

export interface StartupCheckOptions {
  taskId: string;
  snapshotVersion: string;
  projectContextPath: string;
}

export interface StartupCheckResult {
  versionMatch: boolean;
  contextMismatch: boolean;
  actualVersion: string | null;
  warnings: string[];
}

export type ExitAction =
  | { type: 'MARK_DONE'; modifiedFiles: string[] }
  | { type: 'CHECKPOINT'; message: string }
  | { type: 'FAILED'; reason: string }
  | { type: 'RATE_LIMIT_SLEEP'; attempt: number; wakeAt: Date }
  | { type: 'HOOK_BLOCKED'; filePath: string };

export interface OnWorkerExitOptions {
  taskId: string;
  exitCode: number;
  writeRoot: string;
  rateLimitCount: number;
  maxRateLimitRetries?: number;
}

export interface RateLimitBackoffResult {
  wakeAt: Date;
  exceeded: boolean;
}
```

- [ ] **Step 6: 创建 src/errors.ts**

```typescript
export class ParallelCError extends Error {
  public readonly exitCode: number;
  public readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    exitCode: number,
    context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ParallelCError';
    this.exitCode = exitCode;
    this.context = context;
  }
}
```

- [ ] **Step 7: 创建 src/index.ts**

```typescript
export * from './types.js';
export * from './constants.js';
export * from './errors.js';
```

- [ ] **Step 8: 验证编译**

Run: `cd packages/shared && pnpm typecheck`
Expected: 无类型错误

- [ ] **Step 9: Commit**

```bash
git add packages/shared/
git commit -m "feat(shared): add types, constants, and error base class"
```

---

### Task 3: @parallelc/validate — 写保护与路径穿越防御

**Files:**
- Create: `packages/validate/package.json`
- Create: `packages/validate/tsconfig.json`
- Create: `packages/validate/jest.config.ts`
- Create: `packages/validate/src/index.ts`
- Create: `packages/validate/src/validate-write.ts`
- Create: `packages/validate/src/hook.ts`
- Create: `packages/validate/__tests__/validate-write.test.ts`
- Create: `packages/validate/__tests__/path-traversal.test.ts`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "@parallelc/validate",
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
    "@parallelc/shared": "workspace:*"
  },
  "devDependencies": {
    "@types/jest": "^29.5.14",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.5"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json 和 jest.config.ts**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

```typescript
import baseConfig from '../../jest.config.base';
export default baseConfig;
```

- [ ] **Step 3: 编写 isWriteAllowed 失败测试**

Create `packages/validate/__tests__/validate-write.test.ts`:

```typescript
import { isWriteAllowed } from '../src/validate-write';
import path from 'path';
import fs from 'fs';
import os from 'os';

let writeRoot: string;
let readonlyRoot: string;

beforeEach(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallelc-validate-'));
  writeRoot = path.join(tmpDir, 'w1-write');
  readonlyRoot = path.join(tmpDir, 'w1-readonly');
  fs.mkdirSync(writeRoot, { recursive: true });
  fs.mkdirSync(readonlyRoot, { recursive: true });
});

describe('isWriteAllowed', () => {
  test('允许在写区内写入绝对路径', () => {
    expect(isWriteAllowed(path.join(writeRoot, 'src/a.ts'), 'w1', writeRoot)).toBe(true);
  });

  test('拒绝写入只读区', () => {
    expect(isWriteAllowed(path.join(readonlyRoot, 'src/a.ts'), 'w1', writeRoot)).toBe(false);
  });

  test('允许相对路径（以 writeRoot 为基准解析）', () => {
    // filePath 为相对路径时，以 writeRoot 为基准拼接后再规范化
    expect(isWriteAllowed('src/a.ts', 'w1', writeRoot)).toBe(true);
  });
});
```

- [ ] **Step 4: 验证测试失败**

Run: `cd packages/validate && pnpm test`
Expected: FAIL — `isWriteAllowed is not defined`

- [ ] **Step 5: 实现 isWriteAllowed**

Create `packages/validate/src/validate-write.ts`:

```typescript
import fs from 'fs';
import path from 'path';

/**
 * 判断写入操作是否允许。
 * 关键：对 filePath 先与 writeRoot 拼接后再规范化（path.resolve(writeRoot, filePath)），
 * 确保相对路径以 writeRoot 为基准解析，而非 CWD。
 */
export function isWriteAllowed(
  filePath: string,
  _workerId: string,
  writeRoot: string,
): boolean {
  const resolvedRoot = fs.realpathSync(writeRoot);
  let resolvedPath: string;

  try {
    resolvedPath = fs.realpathSync(path.resolve(writeRoot, filePath));
  } catch {
    // 路径不存在时（新建文件），使用 resolve 结果
    resolvedPath = path.resolve(writeRoot, filePath);
  }

  if (
    !resolvedPath.startsWith(resolvedRoot + path.sep) &&
    resolvedPath !== resolvedRoot
  ) {
    return false;
  }

  if (resolvedPath.includes('-readonly')) {
    return false;
  }

  return true;
}
```

- [ ] **Step 6: 验证测试通过**

Run: `cd packages/validate && pnpm test`
Expected: PASS — 3 tests

- [ ] **Step 7: 编写路径穿越测试**

Create `packages/validate/__tests__/path-traversal.test.ts`:

```typescript
import { isWriteAllowed } from '../src/validate-write';
import path from 'path';
import fs from 'fs';
import os from 'os';

let writeRoot: string;
let readonlyRoot: string;

beforeEach(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallelc-traversal-'));
  writeRoot = path.join(tmpDir, 'w1-write');
  readonlyRoot = path.join(tmpDir, 'w1-readonly');
  fs.mkdirSync(writeRoot, { recursive: true });
  fs.mkdirSync(readonlyRoot, { recursive: true });
  // 在只读区写入一个文件，模拟穿越探测
  fs.writeFileSync(path.join(readonlyRoot, 'secret.ts'), 'secret');
});

describe('路径穿越防御', () => {
  test('.. 穿越到只读区被拦截', () => {
    const traversalPath = path.join(writeRoot, '..', 'w1-readonly', 'secret.ts');
    expect(isWriteAllowed(traversalPath, 'w1', writeRoot)).toBe(false);
  });

  test('多级 .. 穿越被拦截', () => {
    const traversalPath = path.join(writeRoot, 'a', '..', '..', 'w1-readonly', 'secret.ts');
    expect(isWriteAllowed(traversalPath, 'w1', writeRoot)).toBe(false);
  });

  test('路径包含 -readonly 被拦截', () => {
    const trickyPath = path.join(writeRoot, 'subdir-w1-readonly-etc', 'file.ts');
    // 目录包含 -readonly 子串统一拦截
    expect(isWriteAllowed(trickyPath, 'w1', writeRoot)).toBe(false);
  });

  test('新建文件（路径不存在）在写区内允许', () => {
    const newFilePath = path.join(writeRoot, 'new-dir', 'new-file.ts');
    expect(isWriteAllowed(newFilePath, 'w1', writeRoot)).toBe(true);
  });
});
```

- [ ] **Step 8: 验证穿越测试通过**

Run: `cd packages/validate && pnpm test`
Expected: PASS — 7 tests total

- [ ] **Step 9: 实现 hook.ts**

Create `packages/validate/src/hook.ts`:

```typescript
import { ParallelCError } from '@parallelc/shared';
import { EXIT_HOOK_BLOCKED } from '@parallelc/shared';
import { isWriteAllowed } from './validate-write.js';

export function validateWriteHook(
  toolName: string,
  params: Record<string, unknown>,
): void {
  const writeTools = ['Edit', 'Write'];

  if (!writeTools.includes(toolName)) {
    return;
  }

  const workerId = process.env['WORKER_ID'];
  const writeRoot = process.env['WORKER_WRITE_ROOT'];

  if (!workerId || !writeRoot) {
    return; // 非 Worker 环境，放行
  }

  const filePath = params['file_path'] as string | undefined;
  if (!filePath) {
    throw new ParallelCError(
      `Hook blocked ${toolName}: missing file_path parameter`,
      EXIT_HOOK_BLOCKED,
      { toolName, params },
    );
  }

  if (!isWriteAllowed(filePath, workerId, writeRoot)) {
    throw new ParallelCError(
      `Hook blocked write to ${filePath}: outside write root`,
      EXIT_HOOK_BLOCKED,
      { toolName, filePath, workerId, writeRoot },
    );
  }
}
```

- [ ] **Step 10: 验证编译**

Run: `cd packages/validate && pnpm typecheck`
Expected: 无错误

- [ ] **Step 11: Commit**

```bash
git add packages/validate/
git commit -m "feat(validate): add write protection and path traversal defense"
```

---

### Task 4: @parallelc/taskboard — Schema 与数据库连接

**Files:**
- Create: `packages/taskboard/package.json`
- Create: `packages/taskboard/tsconfig.json`
- Create: `packages/taskboard/jest.config.ts`
- Create: `packages/taskboard/src/index.ts`
- Create: `packages/taskboard/src/schema.ts`
- Create: `packages/taskboard/src/db.ts`
- Create: `packages/taskboard/__tests__/schema.test.ts`
- Create: `packages/taskboard/__tests__/db.test.ts`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "@parallelc/taskboard",
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

- [ ] **Step 2: 创建 tsconfig.json 和 jest.config.ts**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

```typescript
import baseConfig from '../../jest.config.base';
export default baseConfig;
```

- [ ] **Step 3: 编写 schema 测试**

Create `packages/taskboard/__tests__/schema.test.ts`:

```typescript
import { TASK_TABLE_DDL, VALID_STATUSES, ALLOWED_TRANSITIONS } from '../src/schema';

describe('TASK_TABLE_DDL', () => {
  test('包含 CREATE TABLE tasks 语句', () => {
    expect(TASK_TABLE_DDL).toContain('CREATE TABLE IF NOT EXISTS tasks');
  });

  test('包含所有状态字段', () => {
    expect(TASK_TABLE_DDL).toContain('status');
    expect(TASK_TABLE_DDL).toContain('version');
    expect(TASK_TABLE_DDL).toContain('expected_touch_files');
    expect(TASK_TABLE_DDL).toContain('modified_files');
    expect(TASK_TABLE_DDL).toContain('level');
    expect(TASK_TABLE_DDL).toContain('starvation_override');
    expect(TASK_TABLE_DDL).toContain('snapshot_version');
  });

  test('包含 4 个索引，其中 2 个为 partial index', () => {
    const indexCount = (TASK_TABLE_DDL.match(/CREATE INDEX/g) ?? []).length;
    expect(indexCount).toBe(4);
    // Partial index: 仅对特定 WHERE 条件生效
    expect(TASK_TABLE_DDL).toContain("WHERE status = 'SLEEP_PENDING'");
    expect(TASK_TABLE_DDL).toContain("WHERE status = 'MERGE_BLOCKED'");
  });
});

describe('VALID_STATUSES', () => {
  test('包含 9 个合法状态', () => {
    expect(VALID_STATUSES).toHaveLength(9);
  });

  test('包含 MERGE_BLOCKED', () => {
    expect(VALID_STATUSES).toContain('MERGE_BLOCKED');
  });
});

describe('ALLOWED_TRANSITIONS', () => {
  test('RUNNING 可转为 DONE', () => {
    expect(ALLOWED_TRANSITIONS['RUNNING']).toContain('DONE');
  });

  test('DONE 为终态，无可用转换', () => {
    expect(ALLOWED_TRANSITIONS['DONE']).toEqual([]);
  });

  test('READY 可转为 RUNNING', () => {
    expect(ALLOWED_TRANSITIONS['READY']).toContain('RUNNING');
  });
});
```

- [ ] **Step 4: 验证测试失败**

Run: `cd packages/taskboard && pnpm test`
Expected: FAIL — schema module not found

- [ ] **Step 5: 实现 schema.ts**

Create `packages/taskboard/src/schema.ts`:

```typescript
export const TASK_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    version INTEGER NOT NULL DEFAULT 0,
    level TEXT NOT NULL DEFAULT 'L2',
    expected_touch_files TEXT,
    modified_files TEXT,
    rate_limit_count INTEGER DEFAULT 0,
    sleep_until TEXT,
    starvation_override INTEGER DEFAULT 0,
    snapshot_version TEXT,
    context_mismatch INTEGER DEFAULT 0,
    merge_blocked_at TEXT,
    merge_report_path TEXT,
    dependencies TEXT,
    ready_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_sleep_until ON tasks(sleep_until)
    WHERE status = 'SLEEP_PENDING';
CREATE INDEX IF NOT EXISTS idx_tasks_merge_blocked ON tasks(merge_blocked_at)
    WHERE status = 'MERGE_BLOCKED';
`;

export const VALID_STATUSES = [
  'PENDING',
  'READY',
  'RUNNING',
  'SLEEP_PENDING',
  'CHECKPOINT_PENDING',
  'DONE',
  'FAILED',
  'CANCELLED',
  'MERGE_BLOCKED',
] as const;

export const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  PENDING:              ['READY', 'CANCELLED'],
  READY:                ['RUNNING', 'CANCELLED'],
  RUNNING:              ['DONE', 'SLEEP_PENDING', 'CHECKPOINT_PENDING', 'FAILED'],
  SLEEP_PENDING:        ['READY', 'FAILED'],
  CHECKPOINT_PENDING:   ['READY', 'FAILED'],
  DONE:                 [],
  FAILED:               [],
  CANCELLED:            [],
  MERGE_BLOCKED:        ['DONE'],
};
```

- [ ] **Step 6: 验证 schema 测试通过**

Run: `cd packages/taskboard && pnpm test -- --testPathPattern="schema"`
Expected: PASS — all schema tests

- [ ] **Step 7: 编写 db 测试**

Create `packages/taskboard/__tests__/db.test.ts`:

```typescript
import Database from 'better-sqlite3';
import { getDb, initializeSchema, closeDb } from '../src/db';
import path from 'path';
import os from 'os';

let dbPath: string;
let dbPath2: string;

beforeEach(() => {
  const tmpDir = os.mkdtempSync(path.join(os.tmpdir(), 'parallelc-db-'));
  dbPath = path.join(tmpDir, 'test.db');
  dbPath2 = path.join(tmpDir, 'test2.db');
});

afterEach(() => {
  closeDb();
});

describe('getDb', () => {
  test('返回 Database 实例', () => {
    const db = getDb(dbPath);
    expect(db).toBeInstanceOf(Database);
  });

  test('相同 dbPath 返回同一实例', () => {
    const db1 = getDb(dbPath);
    const db2 = getDb(dbPath);
    expect(db1).toBe(db2);
  });

  test('不同 dbPath 返回不同实例', () => {
    const db1 = getDb(dbPath);
    const db2 = getDb(dbPath2);
    expect(db1).not.toBe(db2);
  });
});

describe('initializeSchema', () => {
  test('幂等创建表结构', () => {
    const db = getDb(dbPath);
    initializeSchema(db);
    // 第二次调用不应报错
    expect(() => initializeSchema(db)).not.toThrow();
  });

  test('创建后可插入任务', () => {
    const db = getDb(dbPath);
    initializeSchema(db);
    db.prepare(`INSERT INTO tasks (id, title, level) VALUES (?, ?, ?)`).run('t1', 'Test', 'L2');
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get('t1') as Record<string, unknown>;
    expect(row['title']).toBe('Test');
    expect(row['level']).toBe('L2');
  });

  test('WAL 模式已启用', () => {
    const db = getDb(dbPath);
    initializeSchema(db);
    const journalMode = db.prepare('PRAGMA journal_mode').get() as Record<string, string>;
    expect(journalMode['journal_mode']).toBe('wal');
  });
});
```

- [ ] **Step 8: 验证 db 测试失败**

Run: `cd packages/taskboard && pnpm test -- --testPathPattern="db"`
Expected: FAIL — `getDb is not defined`

- [ ] **Step 9: 实现 db.ts（按 dbPath 多例管理）**

Create `packages/taskboard/src/db.ts`:

```typescript
import Database from 'better-sqlite3';
import { TASK_TABLE_DDL } from './schema.js';

const instances = new Map<string, Database.Database>();

export function getDb(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? '.parallelc/taskboard.db';

  let db = instances.get(resolvedPath);
  if (!db) {
    db = new Database(resolvedPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    instances.set(resolvedPath, db);
  }
  return db;
}

export function initializeSchema(db: Database.Database): void {
  db.exec(TASK_TABLE_DDL);
}

export function closeDb(dbPath?: string): void {
  if (dbPath) {
    const db = instances.get(dbPath);
    if (db) {
      db.close();
      instances.delete(dbPath);
    }
  } else {
    for (const [, db] of instances) {
      db.close();
    }
    instances.clear();
  }
}
```

- [ ] **Step 10: 验证 db 测试全部通过**

Run: `cd packages/taskboard && pnpm test`
Expected: PASS — schema + db tests

- [ ] **Step 11: Commit**

```bash
git add packages/taskboard/
git commit -m "feat(taskboard): add SQLite schema, multi-instance db, and WAL setup"
```

---

### Task 5: @parallelc/taskboard — Repository（CRUD + CAS + getLockedFiles）

**Files:**
- Create: `packages/taskboard/src/repository.ts`
- Create: `packages/taskboard/__tests__/repository.test.ts`

- [ ] **Step 1: 编写 repository 测试**

Create `packages/taskboard/__tests__/repository.test.ts`:

```typescript
import Database from 'better-sqlite3';
import { initializeSchema } from '../src/db';
import {
  createTask,
  casUpdateStatus,
  queryTasksByStatus,
  getLockedFiles,
  updateTask,
} from '../src/repository';
import { TaskStatus } from '@parallelc/shared';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

describe('createTask', () => {
  test('创建任务并返回完整记录', () => {
    const task = createTask(db, {
      id: 't1',
      title: 'Add login page',
      expected_touch_files: ['src/login.ts', 'src/auth.ts'],
      dependencies: ['t0'],
      snapshot_version: 'dag1-20260701',
      level: 'L2',
    });

    expect(task.id).toBe('t1');
    expect(task.status).toBe('PENDING');
    expect(task.version).toBe(0);
    expect(task.level).toBe('L2');
    expect(task.expected_touch_files).toEqual(['src/login.ts', 'src/auth.ts']);
  });
});

describe('casUpdateStatus', () => {
  test('CAS 成功更新状态', () => {
    createTask(db, { id: 't1', title: 'Test', level: 'L2' });

    const ok = casUpdateStatus(db, 't1', 0, 'PENDING', 'READY');
    expect(ok).toBe(true);

    const tasks = queryTasksByStatus(db, 'READY');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.version).toBe(1);
  });

  test('CAS 版本冲突返回 false', () => {
    createTask(db, { id: 't1', title: 'Test', level: 'L2' });

    const ok = casUpdateStatus(db, 't1', 999, 'PENDING', 'READY');
    expect(ok).toBe(false);

    const tasks = queryTasksByStatus(db, 'PENDING');
    expect(tasks).toHaveLength(1);
  });

  test('CAS 状态不匹配返回 false', () => {
    createTask(db, { id: 't1', title: 'Test', level: 'L2' });

    const ok = casUpdateStatus(db, 't1', 0, 'RUNNING', 'READY');
    expect(ok).toBe(false);
  });

  test('非法状态转换返回 false', () => {
    createTask(db, { id: 't1', title: 'Test', level: 'L2' });

    const ok = casUpdateStatus(db, 't1', 0, 'PENDING', 'DONE');
    expect(ok).toBe(false);
  });
});

describe('getLockedFiles', () => {
  test('返回 RUNNING 和 SLEEP_PENDING 任务的文件集合', () => {
    createTask(db, {
      id: 't1', title: 'Task 1',
      expected_touch_files: ['src/a.ts', 'src/b.ts'],
      level: 'L2',
    });
    createTask(db, {
      id: 't2', title: 'Task 2',
      expected_touch_files: ['src/b.ts', 'src/c.ts'],
      level: 'L2',
    });

    // t1 → RUNNING
    casUpdateStatus(db, 't1', 0, 'PENDING', 'READY');
    const t1version = queryTasksByStatus(db, 'READY')[0]!.version;
    casUpdateStatus(db, 't1', t1version, 'READY', 'RUNNING');

    // t2 → SLEEP_PENDING
    casUpdateStatus(db, 't2', 0, 'PENDING', 'READY');
    const t2version = queryTasksByStatus(db, 'READY')[0]!.version;
    casUpdateStatus(db, 't2', t2version, 'READY', 'RUNNING');
    // 手动设置 sleep_until
    db.prepare('UPDATE tasks SET status = ?, sleep_until = ? WHERE id = ?')
      .run('SLEEP_PENDING', new Date().toISOString(), 't2');

    const lockedFiles = getLockedFiles(db);
    expect(lockedFiles).toContain('src/a.ts');
    expect(lockedFiles).toContain('src/b.ts');
    expect(lockedFiles).toContain('src/c.ts');
  });

  test('空任务时返回空集合', () => {
    const lockedFiles = getLockedFiles(db);
    expect(lockedFiles.size).toBe(0);
  });
});

describe('queryTasksByStatus', () => {
  test('按单个状态查询', () => {
    createTask(db, { id: 't1', title: 'T1', level: 'L2' });
    createTask(db, { id: 't2', title: 'T2', level: 'L2' });

    casUpdateStatus(db, 't1', 0, 'PENDING', 'READY');

    const pending = queryTasksByStatus(db, 'PENDING');
    const ready = queryTasksByStatus(db, 'READY');
    expect(pending).toHaveLength(1);
    expect(ready).toHaveLength(1);
  });

  test('按多个状态查询', () => {
    createTask(db, { id: 't1', title: 'T1', level: 'L2' });
    createTask(db, { id: 't2', title: 'T2', level: 'L2' });

    const tasks = queryTasksByStatus(db, ['PENDING', 'READY']);
    expect(tasks).toHaveLength(2);
  });

  test('非法 orderBy 使用默认排序', () => {
    createTask(db, { id: 't1', title: 'T1', level: 'L2' });
    createTask(db, { id: 't2', title: 'T2', level: 'L2' });
    // 即使传入非法参数也不应抛出异常
    const tasks = queryTasksByStatus(db, 'PENDING', '1; DROP TABLE tasks;--');
    expect(tasks).toHaveLength(2);
  });
});

describe('updateTask', () => {
  test('更新任务字段', () => {
    createTask(db, { id: 't1', title: 'Test', level: 'L2' });

    const ok = updateTask(db, 't1', 0, { modified_files: ['src/a.ts'], context_mismatch: true });
    expect(ok).toBe(true);

    const tasks = queryTasksByStatus(db, 'PENDING');
    expect(tasks[0]!.modified_files).toEqual(['src/a.ts']);
    expect(tasks[0]!.context_mismatch).toBe(true);
  });
});
```

- [ ] **Step 2: 验证测试失败**

Run: `cd packages/taskboard && pnpm test -- --testPathPattern="repository"`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 repository.ts**

Create `packages/taskboard/src/repository.ts`:

```typescript
import Database from 'better-sqlite3';
import type { Task, TaskStatus } from '@parallelc/shared';
import { ALLOWED_TRANSITIONS } from './schema.js';

interface CreateTaskInput {
  id: string;
  title: string;
  expected_touch_files?: string[] | null;
  dependencies?: string[] | null;
  snapshot_version?: string | null;
  level?: string;
}

/** orderBy 白名单，防 SQL 拼接注入 */
const ALLOWED_ORDER_BY = new Set([
  'created_at ASC',
  'created_at DESC',
  'updated_at ASC',
  'updated_at DESC',
  'ready_at ASC',
]);

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row['id'] as string,
    title: row['title'] as string,
    status: row['status'] as TaskStatus,
    version: (row['version'] as number) ?? 0,
    level: (row['level'] as Task['level']) ?? 'L2',
    expected_touch_files: row['expected_touch_files']
      ? JSON.parse(row['expected_touch_files'] as string)
      : null,
    modified_files: row['modified_files']
      ? JSON.parse(row['modified_files'] as string)
      : null,
    rate_limit_count: (row['rate_limit_count'] as number) ?? 0,
    sleep_until: (row['sleep_until'] as string) ?? null,
    starvation_override: Boolean(row['starvation_override']),
    snapshot_version: (row['snapshot_version'] as string) ?? null,
    context_mismatch: Boolean(row['context_mismatch']),
    merge_blocked_at: (row['merge_blocked_at'] as string) ?? null,
    merge_report_path: (row['merge_report_path'] as string) ?? null,
    dependencies: row['dependencies']
      ? JSON.parse(row['dependencies'] as string)
      : null,
    ready_at: (row['ready_at'] as string) ?? null,
    created_at: row['created_at'] as string,
    updated_at: row['updated_at'] as string,
  };
}

export function createTask(db: Database.Database, input: CreateTaskInput): Task {
  const stmt = db.prepare(`
    INSERT INTO tasks (id, title, level, expected_touch_files, dependencies, snapshot_version)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    input.id,
    input.title,
    input.level ?? 'L2',
    input.expected_touch_files ? JSON.stringify(input.expected_touch_files) : null,
    input.dependencies ? JSON.stringify(input.dependencies) : null,
    input.snapshot_version ?? null,
  );
  return queryTaskById(db, input.id)!;
}

function queryTaskById(db: Database.Database, id: string): Task | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToTask(row);
}

export function casUpdateStatus(
  db: Database.Database,
  taskId: string,
  expectedVersion: number,
  fromStatus: string,
  toStatus: string,
  extra?: Partial<Pick<Task, 'starvation_override' | 'context_mismatch' | 'rate_limit_count' | 'sleep_until'>>,
): boolean {
  const allowed = ALLOWED_TRANSITIONS[fromStatus];
  if (!allowed || !allowed.includes(toStatus)) {
    return false;
  }

  const updateFields = ['status = ?', 'version = version + 1', "updated_at = datetime('now')"];
  const params: unknown[] = [toStatus];

  if (extra?.starvation_override !== undefined) {
    updateFields.push('starvation_override = ?');
    params.push(extra.starvation_override ? 1 : 0);
  }
  if (extra?.context_mismatch !== undefined) {
    updateFields.push('context_mismatch = ?');
    params.push(extra.context_mismatch ? 1 : 0);
  }
  if (extra?.rate_limit_count !== undefined) {
    updateFields.push('rate_limit_count = ?');
    params.push(extra.rate_limit_count);
  }
  if (extra?.sleep_until !== undefined) {
    updateFields.push('sleep_until = ?');
    params.push(extra.sleep_until);
  }

  if (toStatus === 'READY') {
    updateFields.push("ready_at = datetime('now')");
  }

  const stmt = db.prepare(`
    UPDATE tasks
    SET ${updateFields.join(', ')}
    WHERE id = ? AND status = ? AND version = ?
  `);
  params.push(taskId, fromStatus, expectedVersion);

  const result = stmt.run(...params);
  return result.changes > 0;
}

export function queryTasksByStatus(
  db: Database.Database,
  status: TaskStatus | TaskStatus[],
  orderBy: string = 'created_at ASC',
): Task[] {
  const safeOrderBy = ALLOWED_ORDER_BY.has(orderBy) ? orderBy : 'created_at ASC';
  const statuses = Array.isArray(status) ? status : [status];
  const placeholders = statuses.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT * FROM tasks WHERE status IN (${placeholders}) ORDER BY ${safeOrderBy}`,
  ).all(...statuses) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function getLockedFiles(db: Database.Database): Set<string> {
  const rows = db.prepare(`
    SELECT expected_touch_files FROM tasks
    WHERE status IN ('RUNNING', 'SLEEP_PENDING')
  `).all() as Record<string, unknown>[];

  const files = new Set<string>();
  for (const row of rows) {
    const parsed = row['expected_touch_files']
      ? (JSON.parse(row['expected_touch_files'] as string) as string[])
      : [];
    for (const f of parsed) files.add(f);
  }
  return files;
}

/**
 * 唤醒到期的 SLEEP_PENDING 任务。
 * 所有日期字段统一存储为 ISO 8601 格式 (new Date().toISOString())，
 * sleep_until <= datetime('now') 需要 SQLite datetime() 与 ISO 8601 兼容。
 * SQLite datetime('now') 返回 "YYYY-MM-DD HH:MM:SS"，而 ISO 8601 为
 * "YYYY-MM-DDTHH:MM:SS.mmmZ"。字符串比较时 ISO 8601 的 'T' 和 'Z' 字符
 * 不影响字典序正确性（YYYY-MM-DD 前缀一致，T/H 比较不影响时间先后）。
 */
export function wakeSleepingTasks(db: Database.Database): number {
  // Phase 3+ 完整实现。Phase 1 仅提供骨架。
  const result = db.prepare(`
    UPDATE tasks
    SET status = 'READY', version = version + 1, updated_at = datetime('now'),
        ready_at = datetime('now'), sleep_until = NULL
    WHERE status = 'SLEEP_PENDING'
      AND sleep_until IS NOT NULL
      AND datetime(sleep_until) <= datetime('now')
  `).run();
  return result.changes;
}

export function updateTask(
  db: Database.Database,
  taskId: string,
  expectedVersion: number,
  fields: Partial<Task>,
): boolean {
  const setClauses: string[] = ["updated_at = datetime('now')"];
  const params: unknown[] = [];

  if (fields.modified_files !== undefined) {
    setClauses.push('modified_files = ?');
    params.push(JSON.stringify(fields.modified_files));
  }
  if (fields.context_mismatch !== undefined) {
    setClauses.push('context_mismatch = ?');
    params.push(fields.context_mismatch ? 1 : 0);
  }
  if (fields.rate_limit_count !== undefined) {
    setClauses.push('rate_limit_count = ?');
    params.push(fields.rate_limit_count);
  }
  if (fields.sleep_until !== undefined) {
    setClauses.push('sleep_until = ?');
    params.push(fields.sleep_until);
  }
  if (fields.starvation_override !== undefined) {
    setClauses.push('starvation_override = ?');
    params.push(fields.starvation_override ? 1 : 0);
  }

  if (setClauses.length === 1) return false;

  const stmt = db.prepare(`
    UPDATE tasks
    SET ${setClauses.join(', ')}, version = version + 1
    WHERE id = ? AND version = ?
  `);
  params.push(taskId, expectedVersion);

  const result = stmt.run(...params);
  return result.changes > 0;
}

/** Phase 3+ — DAG 失败传播 */
export function propagateDagFailure(
  db: Database.Database,
  failedTaskId: string,
): number {
  const rows = db.prepare(
    `SELECT id FROM tasks WHERE dependencies LIKE ? AND status NOT IN ('DONE', 'FAILED', 'CANCELLED')`,
  ).all(`%"${failedTaskId}"%`) as Record<string, unknown>[];

  let count = 0;
  for (const row of rows) {
    db.prepare(
      `UPDATE tasks SET status = 'CANCELLED', version = version + 1, updated_at = datetime('now') WHERE id = ?`,
    ).run(row['id']);
    count++;
  }
  return count;
}
```

- [ ] **Step 4: 验证所有测试通过**

Run: `cd packages/taskboard && pnpm test`
Expected: PASS — all schema + db + repository tests

- [ ] **Step 5: 验证编译**

Run: `cd packages/taskboard && pnpm typecheck`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add packages/taskboard/
git commit -m "feat(taskboard): add repository with CAS, getLockedFiles, and CRUD"
```

---

### Task 6: @parallelc/worker — 快照版本校验

**Files:**
- Create: `packages/worker/package.json`
- Create: `packages/worker/tsconfig.json`
- Create: `packages/worker/jest.config.ts`
- Create: `packages/worker/src/index.ts`
- Create: `packages/worker/src/startup.ts`
- Create: `packages/worker/__tests__/startup.test.ts`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "@parallelc/worker",
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
    "@parallelc/shared": "workspace:*"
  },
  "devDependencies": {
    "@types/jest": "^29.5.14",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.5"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json 和 jest.config.ts**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

```typescript
import baseConfig from '../../jest.config.base';
export default baseConfig;
```

- [ ] **Step 3: 编写 startup 测试**

Create `packages/worker/__tests__/startup.test.ts`:

```typescript
import { verifySnapshotVersion, parseProjectContextHeader } from '../src/startup';
import path from 'path';
import fs from 'fs';
import os from 'os';

let tmpDir: string;
let contextPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallelc-startup-'));
  contextPath = path.join(tmpDir, 'project_context.md');
});

describe('parseProjectContextHeader', () => {
  test('正确解析标准头部', () => {
    const content = `snapshot_version: dag1-20260701T100000Z
generated_at: 2026-07-01T10:00:00Z
status: FROZEN

# Project Context
Some content here.`;

    const result = parseProjectContextHeader(content);
    expect(result).not.toBeNull();
    expect(result!.snapshotVersion).toBe('dag1-20260701T100000Z');
    expect(result!.generatedAt).toBe('2026-07-01T10:00:00Z');
    expect(result!.status).toBe('FROZEN');
  });

  test('格式不完整返回 null', () => {
    const content = 'Just some random text\nwithout proper headers';
    expect(parseProjectContextHeader(content)).toBeNull();
  });

  test('缺少 status 仍能解析', () => {
    const content = `snapshot_version: dag2-20260702
generated_at: 2026-07-02T10:00:00Z`;

    const result = parseProjectContextHeader(content);
    expect(result).not.toBeNull();
    expect(result!.snapshotVersion).toBe('dag2-20260702');
  });
});

describe('verifySnapshotVersion', () => {
  test('版本一致时返回匹配', () => {
    const content = `snapshot_version: dag1-20260701T100000Z
generated_at: 2026-07-01T10:00:00Z
status: FROZEN`;
    fs.writeFileSync(contextPath, content);

    const result = verifySnapshotVersion({
      taskId: 't1',
      snapshotVersion: 'dag1-20260701T100000Z',
      projectContextPath: contextPath,
    });

    expect(result.versionMatch).toBe(true);
    expect(result.contextMismatch).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });

  test('版本不一致时返回 mismatch', () => {
    const content = `snapshot_version: dag1-20260701T100000Z
generated_at: 2026-07-01T10:00:00Z
status: FROZEN`;
    fs.writeFileSync(contextPath, content);

    const result = verifySnapshotVersion({
      taskId: 't1',
      snapshotVersion: 'dag2-20260702T120000Z',
      projectContextPath: contextPath,
    });

    expect(result.versionMatch).toBe(false);
    expect(result.contextMismatch).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test('文件不存在时标记 mismatch', () => {
    const result = verifySnapshotVersion({
      taskId: 't1',
      snapshotVersion: 'dag1-20260701',
      projectContextPath: contextPath,
    });

    expect(result.contextMismatch).toBe(true);
    expect(result.warnings).toContain('project_context.md not found');
  });

  test('status 非 FROZEN 产生警告', () => {
    const content = `snapshot_version: dag1-20260701T100000Z
generated_at: 2026-07-01T10:00:00Z
status: ACTIVE`;
    fs.writeFileSync(contextPath, content);

    const result = verifySnapshotVersion({
      taskId: 't1',
      snapshotVersion: 'dag1-20260701T100000Z',
      projectContextPath: contextPath,
    });

    expect(result.versionMatch).toBe(true);
    expect(result.warnings).toContain('project_context.md status is not FROZEN');
  });
});
```

- [ ] **Step 4: 验证测试失败**

Run: `cd packages/worker && pnpm test -- --testPathPattern="startup"`
Expected: FAIL — `verifySnapshotVersion is not defined`

- [ ] **Step 5: 实现 startup.ts**

Create `packages/worker/src/startup.ts`:

```typescript
import fs from 'fs';
import type { StartupCheckOptions, StartupCheckResult } from '@parallelc/shared';

export function parseProjectContextHeader(content: string): {
  snapshotVersion: string;
  generatedAt: string;
  status: string;
} | null {
  const snapshotMatch = content.match(/^snapshot_version:\s*(.+)$/m);
  const generatedMatch = content.match(/^generated_at:\s*(.+)$/m);
  const statusMatch = content.match(/^status:\s*(.+)$/m);

  if (!snapshotMatch || !generatedMatch) {
    return null;
  }

  return {
    snapshotVersion: snapshotMatch[1]!.trim(),
    generatedAt: generatedMatch[1]!.trim(),
    status: statusMatch?.[1]?.trim() ?? 'FROZEN',
  };
}

export function verifySnapshotVersion(
  opts: StartupCheckOptions,
): StartupCheckResult {
  const warnings: string[] = [];

  if (!fs.existsSync(opts.projectContextPath)) {
    warnings.push('project_context.md not found');
    return {
      versionMatch: false,
      contextMismatch: true,
      actualVersion: null,
      warnings,
    };
  }

  const content = fs.readFileSync(opts.projectContextPath, 'utf-8');
  const header = parseProjectContextHeader(content);

  if (!header) {
    warnings.push('project_context.md header is malformed');
    return {
      versionMatch: false,
      contextMismatch: true,
      actualVersion: null,
      warnings,
    };
  }

  const versionMatch = header.snapshotVersion === opts.snapshotVersion;

  if (!versionMatch) {
    warnings.push(
      `Snapshot version mismatch: task=${opts.snapshotVersion}, context=${header.snapshotVersion}`,
    );
  }

  if (header.status !== 'FROZEN') {
    warnings.push(
      `project_context.md status is not FROZEN: ${header.status}`,
    );
  }

  return {
    versionMatch,
    contextMismatch: !versionMatch || header.status !== 'FROZEN',
    actualVersion: header.snapshotVersion,
    warnings,
  };
}
```

- [ ] **Step 6: 验证所有测试通过**

Run: `cd packages/worker && pnpm test -- --testPathPattern="startup"`
Expected: PASS — all startup tests

- [ ] **Step 7: Commit**

```bash
git add packages/worker/
git commit -m "feat(worker): add snapshot version verification"
```

---

### Task 7: @parallelc/worker — 退出码路由与文件采集

**Files:**
- Create: `packages/worker/src/lifecycle.ts`
- Create: `packages/worker/__tests__/lifecycle.test.ts`

- [ ] **Step 1: 编写 lifecycle 测试**

Create `packages/worker/__tests__/lifecycle.test.ts`:

```typescript
import { routeExitCode, collectModifiedFiles, calculateRateLimitBackoff } from '../src/lifecycle';
import { EXIT_SUCCESS, EXIT_CHECKPOINT, EXIT_TIMEOUT, EXIT_HOOK_BLOCKED, EXIT_RATE_LIMIT } from '@parallelc/shared';
import type { ExitAction } from '@parallelc/shared';
import path from 'path';
import fs from 'fs';
import os from 'os';

describe('routeExitCode', () => {
  test('退出码 0 → MARK_DONE', () => {
    const action = routeExitCode({
      taskId: 't1',
      exitCode: EXIT_SUCCESS,
      writeRoot: '/tmp/w1-write',
      rateLimitCount: 0,
    });
    expect(action.type).toBe('MARK_DONE');
  });

  test('退出码 10 → CHECKPOINT', () => {
    const action = routeExitCode({
      taskId: 't1',
      exitCode: EXIT_CHECKPOINT,
      writeRoot: '/tmp/w1-write',
      rateLimitCount: 0,
    });
    expect(action.type).toBe('CHECKPOINT');
  });

  test('退出码 11 → FAILED（进程超时）', () => {
    const action = routeExitCode({
      taskId: 't1',
      exitCode: EXIT_TIMEOUT,
      writeRoot: '/tmp/w1-write',
      rateLimitCount: 0,
    });
    expect(action.type).toBe('FAILED');
    expect((action as ExitAction & { reason: string }).reason).toContain('timeout');
  });

  test('退出码 12 → HOOK_BLOCKED', () => {
    const action = routeExitCode({
      taskId: 't1',
      exitCode: EXIT_HOOK_BLOCKED,
      writeRoot: '/tmp/w1-write',
      rateLimitCount: 0,
    });
    expect(action.type).toBe('HOOK_BLOCKED');
  });

  test('退出码 13 → RATE_LIMIT_SLEEP（rateLimitCount + 1）', () => {
    const action = routeExitCode({
      taskId: 't1',
      exitCode: EXIT_RATE_LIMIT,
      writeRoot: '/tmp/w1-write',
      rateLimitCount: 2,
    });
    expect(action.type).toBe('RATE_LIMIT_SLEEP');
    // attempt = rateLimitCount + 1 = 3
    expect((action as ExitAction & { attempt: number }).attempt).toBe(3);
  });

  test('退出码 13 超出上限 → FAILED', () => {
    const action = routeExitCode({
      taskId: 't1',
      exitCode: EXIT_RATE_LIMIT,
      writeRoot: '/tmp/w1-write',
      rateLimitCount: 5,
      maxRateLimitRetries: 5,
    });
    expect(action.type).toBe('FAILED');
    expect((action as ExitAction & { reason: string }).reason).toContain('rate_limit_exhausted');
  });

  test('未知退出码 → FAILED', () => {
    const action = routeExitCode({
      taskId: 't1',
      exitCode: 99,
      writeRoot: '/tmp/w1-write',
      rateLimitCount: 0,
    });
    expect(action.type).toBe('FAILED');
    expect((action as ExitAction & { reason: string }).reason).toContain('Unknown');
  });
});

describe('calculateRateLimitBackoff', () => {
  test('第 1 次退避 ≈ 1 分钟', () => {
    const result = calculateRateLimitBackoff(1);
    expect(result.exceeded).toBe(false);
    const diffMs = result.wakeAt.getTime() - Date.now();
    expect(diffMs).toBeGreaterThan(30_000);
    expect(diffMs).toBeLessThan(90_000);
  });

  test('第 6 次超出上限', () => {
    const result = calculateRateLimitBackoff(6);
    expect(result.exceeded).toBe(true);
  });

  test('第 5 次退避 ≈ 16 分钟', () => {
    const result = calculateRateLimitBackoff(5);
    expect(result.exceeded).toBe(false);
    const diffMs = result.wakeAt.getTime() - Date.now();
    expect(diffMs).toBeGreaterThan(15.5 * 60_000);
    expect(diffMs).toBeLessThan(17 * 60_000);
  });
});

describe('collectModifiedFiles', () => {
  test('采集已跟踪文件的修改', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallelc-collect-'));
    const res = collectModifiedFiles(tmpDir);
    // 在无 git 仓库中以空数组处理
    expect(Array.isArray(res)).toBe(true);
  });
});
```

- [ ] **Step 2: 验证测试失败**

Run: `cd packages/worker && pnpm test -- --testPathPattern="lifecycle"`
Expected: FAIL

- [ ] **Step 3: 实现 lifecycle.ts**

Create `packages/worker/src/lifecycle.ts`:

```typescript
import { execSync } from 'child_process';
import {
  EXIT_SUCCESS,
  EXIT_CHECKPOINT,
  EXIT_TIMEOUT,
  EXIT_HOOK_BLOCKED,
  EXIT_RATE_LIMIT,
} from '@parallelc/shared';
import type { ExitAction, OnWorkerExitOptions, RateLimitBackoffResult } from '@parallelc/shared';

const BACKOFF_MINUTES = [1, 2, 4, 8, 16];
const MAX_RATE_LIMIT_RETRIES = 5;

export function routeExitCode(opts: OnWorkerExitOptions): ExitAction {
  const { taskId, exitCode, writeRoot, rateLimitCount, maxRateLimitRetries = MAX_RATE_LIMIT_RETRIES } = opts;

  switch (exitCode) {
    case EXIT_SUCCESS:
      return {
        type: 'MARK_DONE',
        modifiedFiles: collectModifiedFiles(writeRoot),
      };

    case EXIT_CHECKPOINT:
      return {
        type: 'CHECKPOINT',
        message: `Task ${taskId} reached 30-turn context limit`,
      };

    case EXIT_TIMEOUT:
      return {
        type: 'FAILED',
        reason: `Task ${taskId} timed out`,
      };

    case EXIT_HOOK_BLOCKED:
      return {
        type: 'HOOK_BLOCKED',
        filePath: 'unknown',
      };

    case EXIT_RATE_LIMIT: {
      const newCount = rateLimitCount + 1;
      if (newCount > maxRateLimitRetries) {
        return {
          type: 'FAILED',
          reason: `Task ${taskId} rate_limit_exhausted after ${newCount} attempts`,
        };
      }
      const backoff = calculateRateLimitBackoff(newCount, maxRateLimitRetries);
      return {
        type: 'RATE_LIMIT_SLEEP',
        attempt: newCount,
        wakeAt: backoff.wakeAt,
      };
    }

    default:
      return {
        type: 'FAILED',
        reason: `Unknown exit code ${exitCode} for task ${taskId}`,
      };
  }
}

/**
 * 采集 Worker 写区所有变更文件。
 * git diff --name-only HEAD 捕获已跟踪的文件变更；
 * git ls-files --others 捕获未跟踪的新建文件。
 */
export function collectModifiedFiles(writeRoot: string): string[] {
  try {
    const tracked = execSync('git diff --name-only HEAD', {
      cwd: writeRoot,
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim().split('\n').filter((f) => f.length > 0);

    const untracked = execSync('git ls-files --others --exclude-standard', {
      cwd: writeRoot,
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim().split('\n').filter((f) => f.length > 0);

    return [...new Set([...tracked, ...untracked])];
  } catch {
    return [];
  }
}

export function calculateRateLimitBackoff(
  attempt: number,
  maxRetries: number = MAX_RATE_LIMIT_RETRIES,
): RateLimitBackoffResult {
  if (attempt > maxRetries) {
    return { wakeAt: new Date(), exceeded: true };
  }

  const minutes = BACKOFF_MINUTES[attempt - 1] ?? 16;
  // ±30 秒随机抖动，打散多 Worker 唤醒
  const jitterSeconds = Math.floor(Math.random() * 61) - 30;
  const wakeAt = new Date(Date.now() + minutes * 60_000 + jitterSeconds * 1_000);

  return { wakeAt, exceeded: false };
}
```

- [ ] **Step 4: 验证所有测试通过**

Run: `cd packages/worker && pnpm test`
Expected: PASS — all startup + lifecycle tests

- [ ] **Step 5: Commit**

```bash
git add packages/worker/
git commit -m "feat(worker): add exit code routing and modified file collection"
```

---

### Task 8: @parallelc/worker — 双 Worktree 创建

**Files:**
- Create: `packages/worker/src/spawn.ts`
- Create: `packages/worker/__tests__/spawn.test.ts`

- [ ] **Step 1: 编写 spawn 测试**

Create `packages/worker/__tests__/spawn.test.ts`:

```typescript
import { spawnWorker, cleanupWorktrees } from '../src/spawn';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

let repoRoot: string;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallelc-spawn-'));
  // 初始化最小 git 仓库，显式切到 main 分支保证分支名一致
  execSync('git init -b main', { cwd: repoRoot });
  execSync('git config user.email "test@test.com"', { cwd: repoRoot });
  execSync('git config user.name "Test"', { cwd: repoRoot });
  // 创建文件结构
  fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'src', 'models'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'src', 'utils'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'user.ts'), 'export const user = 1;');
  fs.writeFileSync(path.join(repoRoot, 'src', 'models', 'user.ts'), 'export class User {}');
  fs.writeFileSync(path.join(repoRoot, 'src', 'utils', 'helper.ts'), 'export const helper = 1;');
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Test');
  execSync('git add -A && git commit -m "init"', { cwd: repoRoot });
});

afterEach(() => {
  // 清理 worktrees
  try {
    const list = execSync('git worktree list', { cwd: repoRoot, encoding: 'utf-8' });
    for (const line of list.split('\n')) {
      const match = line.match(/^(.+?)\s/);
      if (match && match[1] && match[1] !== repoRoot) {
        execSync(`git worktree remove --force "${match[1]}"`, { cwd: repoRoot });
      }
    }
  } catch { /* 忽略清理错误 */ }
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('spawnWorker', () => {
  test('创建双 Worktree 并返回正确路径', async () => {
    const result = await spawnWorker({
      workerId: 'test-w1',
      expectedTouchFiles: ['src/api/user.ts', 'src/models/user.ts'],
      repoRoot,
      apiKey: 'sk-test-key',
    });

    expect(result.workerId).toBe('test-w1');
    expect(result.readonlyRoot).toContain('test-w1-readonly');
    expect(result.writeRoot).toContain('test-w1-write');
    expect(result.spawnedAt).toBeDefined();

    // 验证只读区完整检出
    expect(fs.existsSync(path.join(result.readonlyRoot, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(result.readonlyRoot, 'src', 'utils', 'helper.ts'))).toBe(true);

    // 验证写区存在预测目录
    expect(fs.existsSync(path.join(result.writeRoot, 'src', 'api', 'user.ts'))).toBe(true);
    expect(fs.existsSync(path.join(result.writeRoot, 'src', 'models', 'user.ts'))).toBe(true);
  });

  test('写区不包含未预测目录', async () => {
    const result = await spawnWorker({
      workerId: 'test-w2',
      expectedTouchFiles: ['src/api/user.ts'],
      repoRoot,
      apiKey: 'sk-test-key',
    });

    // utils 不应在写区中
    expect(fs.existsSync(path.join(result.writeRoot, 'src', 'utils', 'helper.ts'))).toBe(false);
    expect(fs.existsSync(path.join(result.writeRoot, 'README.md'))).toBe(false);
  });
});

describe('cleanupWorktrees', () => {
  test('清理后 worktree 目录不存在', async () => {
    const result = await spawnWorker({
      workerId: 'test-w3',
      expectedTouchFiles: ['src/api/user.ts'],
      repoRoot,
      apiKey: 'sk-test-key',
    });

    await cleanupWorktrees('test-w3', repoRoot);

    expect(fs.existsSync(result.readonlyRoot)).toBe(false);
    expect(fs.existsSync(result.writeRoot)).toBe(false);
  });
});
```

- [ ] **Step 2: 验证测试失败**

Run: `cd packages/worker && pnpm test -- --testPathPattern="spawn"`
Expected: FAIL — `spawnWorker is not defined`

- [ ] **Step 3: 实现 spawn.ts**

Create `packages/worker/src/spawn.ts`:

```typescript
import { execSync } from 'child_process';
import path from 'path';
import type { SpawnWorkerOptions, SpawnWorkerResult } from '@parallelc/shared';

export async function spawnWorker(
  opts: SpawnWorkerOptions,
): Promise<SpawnWorkerResult> {
  const {
    workerId,
    expectedTouchFiles,
    repoRoot,
    baseBranch = 'main',
  } = opts;

  const readonlyRoot = path.join(repoRoot, 'worktrees', `${workerId}-readonly`);
  const writeRoot = path.join(repoRoot, 'worktrees', `${workerId}-write`);

  try {
    // 1. 只读完整 Worktree
    execSync(`git worktree add "${readonlyRoot}" ${baseBranch}`, {
      cwd: repoRoot,
      stdio: 'pipe',
      timeout: 30_000,
    });

    // 2. 稀疏写区 Worktree
    execSync(`git worktree add --no-checkout "${writeRoot}" ${baseBranch}`, {
      cwd: repoRoot,
      stdio: 'pipe',
      timeout: 30_000,
    });

    // 3. 提取唯一目录名
    const dirnames = [
      ...new Set(expectedTouchFiles.map((f) => path.dirname(f))),
    ];

    // 4-5. Sparse checkout
    execSync('git sparse-checkout init --cone', {
      cwd: writeRoot,
      stdio: 'pipe',
      timeout: 10_000,
    });
    execSync(`git sparse-checkout set ${dirnames.join(' ')}`, {
      cwd: writeRoot,
      stdio: 'pipe',
      timeout: 10_000,
    });
    execSync(`git checkout ${baseBranch}`, {
      cwd: writeRoot,
      stdio: 'pipe',
      timeout: 30_000,
    });

    return {
      workerId,
      readonlyRoot,
      writeRoot,
      spawnedAt: new Date().toISOString(),
    };
  } catch (error) {
    // 失败时清理已创建的 worktree
    await cleanupWorktrees(workerId, repoRoot);
    throw error;
  }
}

export async function cleanupWorktrees(
  workerId: string,
  repoRoot: string,
): Promise<void> {
  const readonlyRoot = path.join(repoRoot, 'worktrees', `${workerId}-readonly`);
  const writeRoot = path.join(repoRoot, 'worktrees', `${workerId}-write`);

  try {
    execSync(`git worktree remove --force "${readonlyRoot}"`, {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  } catch { /* 目录可能不存在 */ }

  try {
    execSync(`git worktree remove --force "${writeRoot}"`, {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  } catch { /* 目录可能不存在 */ }
}
```

- [ ] **Step 4: 验证所有测试通过**

Run: `cd packages/worker && pnpm test`
Expected: PASS — all startup + lifecycle + spawn tests

- [ ] **Step 5: 创建 src/index.ts**

Create `packages/worker/src/index.ts`:

```typescript
export * from './startup.js';
export * from './lifecycle.js';
export * from './spawn.js';
```

- [ ] **Step 6: 全局验证**

Run: `pnpm install && pnpm test`
Expected: 所有包测试通过

- [ ] **Step 7: Commit**

```bash
git add packages/worker/
git commit -m "feat(worker): add dual worktree spawn and cleanup"
```

---

## 依赖顺序

```
Task 1 (根骨架)
  └─ Task 2 (shared)
       ├─ Task 3 (validate)
       ├─ Task 4 (taskboard: schema + db)
       │    └─ Task 5 (taskboard: repository)
       ├─ Task 6 (worker: startup)
       ├─ Task 7 (worker: lifecycle)
       └─ Task 8 (worker: spawn)
```

Task 3–8 在 Task 2 完成后可并行执行，Task 5 依赖 Task 4。

---

## 变更摘要（v1.1 审查修订）

| # | 级别 | 修复内容 |
|---|------|---------|
| 1 | P0 | shared 包删除 `@parallelc/shared` 自依赖 |
| 2 | P0 | `isWriteAllowed` 改用 `path.resolve(writeRoot, filePath)` 以 writeRoot 为基准解析相对路径 |
| 3 | P0 | `wakeSleepingTasks` 使用 `datetime(sleep_until)` 统一日期格式比较 |
| 4 | P0 | `jest.config.base.ts` 添加 `moduleNameMapper` 映射 `.js` → 源文件 |
| 5 | P0 | `spawn.test.ts` 使用 `git init -b main` 确保分支名一致 |
| 6 | P1 | 两个 partial index 补回 `WHERE status = 'SLEEP_PENDING'` / `WHERE status = 'MERGE_BLOCKED'` |
| 7 | P1 | `collectModifiedFiles` 增加 `git ls-files --others` 捕获未跟踪文件 |
| 8 | P1 | `getDb` 改为 `Map<dbPath, Database>` 多例管理 |
| 9 | P1 | `OnWorkerExitOptions` 增加 `rateLimitCount` 字段，`routeExitCode` 使用 `rateLimitCount + 1` 计算 attempt |
| 10 | P1 | `queryTasksByStatus` 增加 `orderBy` 白名单校验 |
