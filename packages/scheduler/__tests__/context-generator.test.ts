import { generateContextSnapshot } from '../src/context-generator';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';

let repoRoot: string;
let db: Database.Database;

const makeTasks = () => [{
  id: 'task-001',
  title: 'Test',
  status: 'READY' as const,
  version: 0,
  level: 'L2' as const,
  expected_touch_files: ['src/index.ts'],
  modified_files: null,
  rate_limit_count: 0,
  sleep_until: null,
  starvation_override: false,
  snapshot_version: 'dag1-20260701',
  context_mismatch: false,
  merge_blocked_at: null,
  merge_report_path: null,
  dependencies: null,
  ready_at: null,
  created_at: '',
  updated_at: '',
}];

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallelc-ctx-'));
  fs.mkdirSync(path.join(repoRoot, '.parallelc'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'index.ts'), 'export {}');
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Test Project\nDescription');

  db = new Database(':memory:');
});

afterEach(() => {
  db.close();
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('generateContextSnapshot', () => {
  test('生成快照文件并返回 ContextSnapshot', () => {
    const result = generateContextSnapshot(db, 'dag-test', makeTasks(), repoRoot);
    expect(result).not.toBeNull();
    expect(result!.dagId).toBe('dag-test');
    expect(result!.status).toBe('FROZEN');
    expect(result!.taskIds).toContain('task-001');

    const ctxPath = path.join(repoRoot, '.parallelc', 'project_context.md');
    expect(fs.existsSync(ctxPath)).toBe(true);

    const content = fs.readFileSync(ctxPath, 'utf-8');
    expect(content).toContain('snapshot_version: dag-test');
    expect(content).toContain('status: FROZEN');
    expect(content).toContain('src/index.ts');
  });

  test('已有 FROZEN 快照时跳过并返回 null', () => {
    generateContextSnapshot(db, 'dag-test', makeTasks(), repoRoot);
    const result = generateContextSnapshot(db, 'dag-test-2', makeTasks(), repoRoot);
    expect(result).toBeNull();
  });

  test('事务冲突时返回 null', () => {
    db.prepare('BEGIN IMMEDIATE').run();
    const result = generateContextSnapshot(db, 'dag-test', makeTasks(), repoRoot);
    expect(result).toBeNull();
  });

  test('scanRepoFiles 跳过 node_modules 和 .git', () => {
    const result = generateContextSnapshot(db, 'dag-test', makeTasks(), repoRoot);
    expect(result).not.toBeNull();
    const files = result!.files;
    // 不应包含跳过目录内的文件
    expect(files.every((f: string) => !f.startsWith('.git/'))).toBe(true);
    expect(files.every((f: string) => !f.startsWith('node_modules/'))).toBe(true);
    // 应包含 README.md 和 src/index.ts
    expect(files).toContain('README.md');
    expect(files).toContain('src/index.ts');
  });
});
