import { probeKey } from '../src/health-check';
import { handleGlobalBackoff } from '../src/rate-limit';
import { KeyPool } from '../src/key-pool';

describe('probeKey', () => {
  test('无效 Key 返回 alive=false', async () => {
    const result = await probeKey('sk-ant-fake-key-000000');
    expect(result.alive).toBe(false);
  });
});

describe('handleGlobalBackoff', () => {
  test('全部 ACTIVE → paused=false', () => {
    const pool = new KeyPool(['sk-a', 'sk-b']);
    const result = handleGlobalBackoff(pool);
    expect(result.paused).toBe(false);
  });

  test('全部 COOLDOWN → paused=true', () => {
    const pool = new KeyPool(['sk-a']);
    for (let i = 0; i < 3; i++) pool.markRateLimited('sk-a');
    const result = handleGlobalBackoff(pool);
    expect(result.paused).toBe(true);
    expect(result.resumeAt).not.toBeNull();
  });
});
