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
  test('检测 tsconfig paths', () => {
    const ctx = scanRepoContext(repoRoot, db);
    const modules = extractModuleMap(ctx, repoRoot);
    expect(modules.length).toBeGreaterThan(0);
  });

  test('从 import 提取模块间依赖', () => {
    const ctx = scanRepoContext(repoRoot, db);
    const modules = extractModuleMap(ctx, repoRoot);
    const modelsModule = modules.find(m => m.dir === 'src/models');
    expect(modelsModule).toBeDefined();
    expect(modelsModule!.imports.length).toBeGreaterThan(0);
  });
});

describe('estimateTokens', () => {
  test('基于文件字符数估算', () => {
    const est = estimateTokens(['src/api/user.ts', 'src/models/user.ts'], repoRoot);
    expect(est.estimatedTokens).toBeGreaterThan(0);
    expect(est.totalChars).toBeGreaterThan(0);
  });

  test('空文件列表返回 0', () => {
    expect(estimateTokens([], repoRoot).estimatedTokens).toBe(0);
  });

  test('不存在的文件不算入', () => {
    const est = estimateTokens(['src/api/user.ts', 'nonexistent.ts'], repoRoot);
    expect(est.totalChars).toBeGreaterThan(0);
  });
});
