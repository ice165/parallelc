import { generateRepro } from '../src/repro-generator';
import fs from 'fs';
import path from 'path';
import os from 'os';

let outputDir: string;

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallelc-repro-'));
});

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true });
});

describe('generateRepro', () => {
  test('生成复现脚本和上下文文件', () => {
    generateRepro({
      taskId: 'task-001',
      outputDir,
      gitHead: 'abc123',
      snapshotVersion: 'dag-1',
      stdout: 'Build failed: type error at line 42',
      exitCode: 1,
    });

    const scriptPath = path.join(outputDir, 'task-001.sh');
    const contextPath = path.join(outputDir, 'task-001-context.json');

    expect(fs.existsSync(scriptPath)).toBe(true);
    expect(fs.existsSync(contextPath)).toBe(true);

    const scriptContent = fs.readFileSync(scriptPath, 'utf-8');
    expect(scriptContent).toContain('#!/bin/bash');
    expect(scriptContent).toContain('task-001');
    expect(scriptContent).toContain('abc123');

    const context = JSON.parse(fs.readFileSync(contextPath, 'utf-8'));
    expect(context.exitCode).toBe(1);
    expect(context.stdoutLast500).toContain('Build failed');
  });

  test('输出目录自动创建', () => {
    const nestedDir = path.join(outputDir, 'nested', 'repro');
    generateRepro({
      taskId: 'task-002', outputDir: nestedDir,
      gitHead: 'def456', snapshotVersion: 'dag-2',
      stdout: '', exitCode: 0,
    });
    expect(fs.existsSync(path.join(nestedDir, 'task-002.sh'))).toBe(true);
  });
});
