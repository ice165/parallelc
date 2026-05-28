import { F1BetaTracker } from '../src/f1-beta-tracker';

describe('F1BetaTracker', () => {
  test('新 tracker 返回 neutral', () => {
    const tracker = new F1BetaTracker(10);
    expect(tracker.getAverageScore()).toBe(1.0);
  });

  test('记录完美预测', () => {
    const tracker = new F1BetaTracker(10);
    tracker.record({ expected: ['a.ts', 'b.ts'], actual: ['a.ts', 'b.ts'] });
    expect(tracker.getAverageScore()).toBe(1.0);
  });

  test('记录部分匹配', () => {
    const tracker = new F1BetaTracker(10);
    tracker.record({ expected: ['a.ts', 'b.ts'], actual: ['a.ts'] });
    expect(tracker.getAverageScore()).toBeLessThan(1.0);
    expect(tracker.getAverageScore()).toBeGreaterThan(0);
  });

  test('冷启动保护: history < 2 → 不降级', () => {
    const tracker = new F1BetaTracker(10);
    tracker.record({ expected: ['a.ts'], actual: ['b.ts'] });
    expect(tracker.shouldDegrade()).toBe(false);
  });

  test('窗口滑动淘汰旧记录', () => {
    const tracker = new F1BetaTracker(5);
    for (let i = 0; i < 7; i++) {
      tracker.record({ expected: ['a.ts'], actual: ['a.ts'] });
    }
    expect(tracker.scoreCount()).toBe(5);
  });
});
