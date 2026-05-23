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
    expect(result.warnings).toContain('project_context.md status is not FROZEN: ACTIVE');
  });
});
