import { KeyPool } from '../src/key-pool';

describe('KeyPool', () => {
  test('nextKey 循环轮转', () => {
    const pool = new KeyPool(['sk-a', 'sk-b', 'sk-c']);
    expect(pool.nextKey()).toBe('sk-a');
    expect(pool.nextKey()).toBe('sk-b');
    expect(pool.nextKey()).toBe('sk-c');
    expect(pool.nextKey()).toBe('sk-a');
  });

  test('跳过 COOLDOWN Key', () => {
    const pool = new KeyPool(['sk-a', 'sk-b']);
    pool.markRateLimited('sk-a'); pool.markRateLimited('sk-a'); pool.markRateLimited('sk-a');
    const status = pool.status();
    expect(status.find(s => s.key === 'sk-a')!.status).toBe('COOLDOWN');
    expect(pool.nextKey()).toBe('sk-b');
  });

  test('全部 COOLDOWN 时返回最早恢复的', () => {
    const pool = new KeyPool(['sk-a', 'sk-b']);
    for (let i = 0; i < 3; i++) { pool.markRateLimited('sk-a'); pool.markRateLimited('sk-b'); }
    expect(['sk-a', 'sk-b']).toContain(pool.nextKey());
  });

  test('markSuccess 重置计数器', () => {
    const pool = new KeyPool(['sk-a']);
    pool.markRateLimited('sk-a'); pool.markRateLimited('sk-a');
    pool.markSuccess('sk-a');
    expect(pool.status()[0]!.consecutive429).toBe(0);
    expect(pool.status()[0]!.status).toBe('ACTIVE');
  });

  test('allPaused 全部冷却返回 true', () => {
    const pool = new KeyPool(['sk-a']);
    for (let i = 0; i < 3; i++) pool.markRateLimited('sk-a');
    expect(pool.allPaused()).toBe(true);
  });

  test('earliestRecovery 返回最近冷却到期时间', () => {
    const pool = new KeyPool(['sk-a', 'sk-b']);
    for (let i = 0; i < 3; i++) { pool.markRateLimited('sk-a'); pool.markRateLimited('sk-b'); }
    expect(pool.earliestRecovery()).not.toBeNull();
  });
});
