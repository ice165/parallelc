import { CostTracker } from '../src/cost-tracker';

describe('CostTracker', () => {
  test('初始预算充足', () => {
    const tracker = new CostTracker({ maxCostPerTask: 3.0, maxCostPerSession: 20.0 });
    expect(tracker.canDispatch()).toBe(true);
  });

  test('记录 token 消耗更新预算', () => {
    const tracker = new CostTracker({ maxCostPerTask: 3.0, maxCostPerSession: 20.0 });
    tracker.recordUsage({ model: 'sonnet', inputTokens: 1000, outputTokens: 500 });
    const summary = tracker.getSummary();
    expect(summary.totalCost).toBeGreaterThan(0);
  });

  test('会话超预算 → canDispatch 返回 false', () => {
    const tracker = new CostTracker({ maxCostPerTask: 3.0, maxCostPerSession: 0.001 });
    tracker.recordUsage({ model: 'opus', inputTokens: 10000, outputTokens: 10000 });
    expect(tracker.canDispatch()).toBe(false);
  });

  test('resetTask 重置任务级预算', () => {
    const tracker = new CostTracker({ maxCostPerTask: 3.0, maxCostPerSession: 20.0 });
    tracker.recordUsage({ model: 'sonnet', inputTokens: 50000, outputTokens: 50000 });
    tracker.resetTask();
    expect(tracker.canDispatch()).toBe(true);
  });
});
