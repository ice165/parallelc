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
      conflict: {
        file: 'a.ts', lines: 'L45-L67',
        taskA: { taskId: 't1', starvationOverride: true, diff: 'diff1' },
        taskB: { taskId: 't2', starvationOverride: true, diff: 'diff2' },
      },
    });
    expect(decision.action).toBe('BLOCKED');
  });

  test('情形 B: 单 starvation + 冲突 → ATTEMPT_STRUCTURED', () => {
    const decision = arbitrateMerge({
      taskA: { taskId: 't1', starvationOverride: true, diff: 'diff1' },
      taskB: { taskId: 't2', starvationOverride: false, diff: 'diff2' },
      conflict: {
        file: 'a.ts', lines: 'L45-L67',
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
      conflict: {
        file: 'a.ts', lines: 'L45-L67',
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

    // 验证 DB 更新
    const dbTask = db.prepare('SELECT status, merge_report_path FROM tasks WHERE id = ?').get('t1') as Record<string, string>;
    expect(dbTask['status']).toBe('MERGE_BLOCKED');
    expect(dbTask['merge_report_path']).toBeTruthy();
    db.close();
  });
});
