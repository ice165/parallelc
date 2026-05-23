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
  test('L1 -> DIRECT_EXECUTE', () => {
    const draft: TaskDraft = { title:'Fix', level:'L1', expected_touch_files:['src/api/auth.ts'], dependencies:[], reasoning:'' };
    const result = enforceHardRules(draft, repoContext, repoRoot);
    expect(result.action).toBe('DIRECT_EXECUTE');
    expect(result.level).toBe('L1');
  });

  test('LLM marks L2 but fits L1 -> keeps L2 (no downgrade)', () => {
    const draft: TaskDraft = { title:'Fix', level:'L2', expected_touch_files:['src/api/auth.ts'], dependencies:[], reasoning:'' };
    const result = enforceHardRules(draft, repoContext, repoRoot);
    expect(result.level).toBe('L2');
    expect(result.action).toBe('CREATE_TASK');
  });

  test('files > 10 -> L3', () => {
    const many = Array.from({length:11},(_,i)=>`src/mod${i}.ts`);
    const draft: TaskDraft = { title:'Big', level:'L1', expected_touch_files:many, dependencies:[], reasoning:'' };
    const result = enforceHardRules(draft, repoContext, repoRoot);
    expect(result.level).toBe('L3');
    expect(result.action).toBe('HUMAN_CONFIRM');
  });

  test('cross-module -> L2', () => {
    const draft: TaskDraft = { title:'Cross', level:'L1', expected_touch_files:['src/api/auth.ts','src/models/user.ts'], dependencies:[], reasoning:'' };
    const result = enforceHardRules(draft, repoContext, repoRoot);
    expect(result.level).toBe('L2');
  });
});

describe('validatePaths', () => {
  test('existing file -> valid', () => {
    const result = validatePaths(['src/api/auth.ts'], repoContext, moduleMap, repoRoot);
    expect(result.valid).toContain('src/api/auth.ts');
    expect(result.invalid).toHaveLength(0);
  });

  test('nonexistent file -> invalid', () => {
    const result = validatePaths(['src/api/nope.ts'], repoContext, moduleMap, repoRoot);
    expect(result.invalid).toContain('src/api/nope.ts');
  });

  test('file outside moduleMap -> withWarnings', () => {
    const result = validatePaths(['some/random/file.ts'], repoContext, moduleMap, repoRoot);
    expect(result.withWarnings).toContain('some/random/file.ts');
  });
});

describe('validateDAG', () => {
  test('valid DAG passes', () => {
    const tasks: TaskDraft[] = [
      { title:'A', level:'L2', expected_touch_files:[], dependencies:[], reasoning:'' },
      { title:'B', level:'L2', expected_touch_files:[], dependencies:['A'], reasoning:'' },
    ];
    const result = validateDAG(tasks);
    expect(result.acyclic).toBe(true);
    expect(result.orphanNodes).toHaveLength(0);
  });

  test('detects circular dependency', () => {
    const tasks: TaskDraft[] = [
      { title:'A', level:'L2', expected_touch_files:[], dependencies:['B'], reasoning:'' },
      { title:'B', level:'L2', expected_touch_files:[], dependencies:['A'], reasoning:'' },
    ];
    expect(validateDAG(tasks).acyclic).toBe(false);
  });

  test('detects orphan nodes', () => {
    const tasks: TaskDraft[] = [
      { title:'A', level:'L2', expected_touch_files:[], dependencies:['C'], reasoning:'' },
    ];
    expect(validateDAG(tasks).orphanNodes).toContain('C');
  });

  test('empty task list passes', () => {
    expect(validateDAG([]).acyclic).toBe(true);
  });
});
