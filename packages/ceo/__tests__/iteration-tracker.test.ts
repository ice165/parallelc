import { shouldReview, getCeoModel, IterationTracker } from '../src/iteration-tracker';
import type { Task } from '@parallelc/shared';

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-001', title: 'Test', status: 'DONE', version: 0, level: 'L2',
    expected_touch_files: null, modified_files: null,
    rate_limit_count: 0, sleep_until: null, starvation_override: false,
    snapshot_version: null, context_mismatch: false,
    merge_blocked_at: null, merge_report_path: null,
    dependencies: null, ready_at: null,
    created_at: '2026-01-01', updated_at: '2026-01-01',
    f1_beta: null, ceo_score: null, ceo_feedback: null,
    ceo_iteration: 0, parent_task_id: null,
    ...overrides,
  };
}

describe('shouldReview', () => {
  test('L1 任务 → 跳过审查', () => {
    expect(shouldReview(makeTask({ level: 'L1' }), 70, 0.6, 10)).toBe(false);
  });

  test('L3 任务 → 必须审查', () => {
    expect(shouldReview(makeTask({ level: 'L3' }), 70, 0.6, 10)).toBe(true);
  });

  test('L2 + F1-β > 0.85 → 跳过', () => {
    expect(shouldReview(makeTask({ level: 'L2' }), 70, 0.9, 10)).toBe(false);
  });

  test('L2 + 预算耗尽 → 跳过', () => {
    expect(shouldReview(makeTask({ level: 'L2' }), 70, 0.6, 0)).toBe(false);
  });

  test('L2 + 正常条件 → 需要审查', () => {
    expect(shouldReview(makeTask({ level: 'L2' }), 70, 0.6, 10)).toBe(true);
  });

  test('单文件纯增量 + L2 → 跳过', () => {
    const task = makeTask({ level: 'L2', modified_files: ['src/a.ts'], ceo_iteration: 0 });
    expect(shouldReview(task, 70, 0.6, 10)).toBe(false);
  });

  test('高清晰度 > 95 → 跳过', () => {
    expect(shouldReview(makeTask({ level: 'L2' }), 96, 0.6, 10)).toBe(false);
  });
});

describe('getCeoModel', () => {
  test('L2 → sonnet', () => expect(getCeoModel('L2')).toBe('sonnet'));
  test('L3 → opus', () => expect(getCeoModel('L3')).toBe('opus'));
});

describe('IterationTracker', () => {
  test('iteration=0 → 可重试', () => {
    const tracker = new IterationTracker();
    expect(tracker.canRetry(0)).toBe(true);
  });

  test('iteration=2 → 不可重试', () => {
    const tracker = new IterationTracker();
    expect(tracker.canRetry(2)).toBe(false);
  });
});
