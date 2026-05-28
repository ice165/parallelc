import { FilePredictor } from '../src/predictor/file-predictor';
import { StaticAnalyzer } from '../src/predictor/static-analyzer';
import { GitDiffFallback } from '../src/predictor/git-diff-fallback';
import fs from 'fs';
import path from 'path';
import os from 'os';

let repoRoot: string;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallelc-pred-'));
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'auth.ts'),
    'import { User } from "./models/user";\nexport function login(u: User) { return u; }');
  fs.mkdirSync(path.join(repoRoot, 'src', 'models'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'models', 'user.ts'), 'export class User { name = ""; }');
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('StaticAnalyzer', () => {
  test('从 import 图推导受影响文件', () => {
    const analyzer = new StaticAnalyzer();
    const files = analyzer.analyze(['src/auth.ts'], repoRoot);
    expect(files).toContain('src/auth.ts');
    // Should also find src/models/user.ts via import resolution
    expect(files.some(f => f.includes('user.ts'))).toBe(true);
  });

  test('空输入返回空列表', () => {
    const analyzer = new StaticAnalyzer();
    const files = analyzer.analyze([], repoRoot);
    expect(files).toHaveLength(0);
  });
});

describe('GitDiffFallback', () => {
  test('返回 src 目录下文件', () => {
    const fallback = new GitDiffFallback();
    const files = fallback.getFallback(repoRoot);
    // Should find files in src/
    expect(files.length).toBeGreaterThan(0);
  });
});

describe('FilePredictor', () => {
  test('验证合法预测通过', () => {
    const predictor = new FilePredictor();
    const result = predictor.validatePrediction(['src/auth.ts'], repoRoot);
    expect(result.valid).toBe(true);
  });

  test('验证路径穿越被拒绝', () => {
    const predictor = new FilePredictor();
    const result = predictor.validatePrediction(['../outside.ts'], repoRoot);
    expect(result.valid).toBe(false);
  });

  test('验证超过50文件被拒绝', () => {
    const predictor = new FilePredictor();
    const manyFiles = Array.from({length: 51}, (_, i) => `src/file${i}.ts`);
    const result = predictor.validatePrediction(manyFiles, repoRoot);
    expect(result.valid).toBe(false);
  });

  test('空文件列表有效', () => {
    const predictor = new FilePredictor();
    const result = predictor.validatePrediction([], repoRoot);
    expect(result.valid).toBe(true);
  });

  test('三层兜底：LLM预测优先', () => {
    const predictor = new FilePredictor();
    // Create a real file so validation passes
    fs.writeFileSync(path.join(repoRoot, 'src', 'real.ts'), '// test');
    const result = predictor.predict(['src/real.ts'], 'Test Task', repoRoot);
    expect(result.source).toBe('LLM');
    expect(result.confidence).toBe(0.8);
  });

  test('三层兜底：无效LLM预测降级到静态分析', () => {
    const predictor = new FilePredictor();
    // LLM predicts bad path -> should fall back to static analysis
    const result = predictor.predict(['../outside.ts'], 'auth', repoRoot);
    expect(result.source).not.toBe('LLM');
    // Static analysis on 'auth' won't find any files (no such file exists)
    // so it falls to git diff which should find files
    expect(result.confidence).toBeLessThanOrEqual(0.6);
  });
});
