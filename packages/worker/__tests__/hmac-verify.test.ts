import { generateHmac, verifyHmac } from '../src/hmac-verify';
import crypto from 'crypto';

describe('HMAC', () => {
  test('生成和验证 HMAC 有效', () => {
    const secret = crypto.randomBytes(32);
    const data = JSON.stringify({ taskId: 'task-001', snapshotVersion: 'v1' });
    const hmac = generateHmac(secret, data);
    expect(verifyHmac(secret, data, hmac)).toBe(true);
  });

  test('错误 HMAC 被拒绝', () => {
    const secret = crypto.randomBytes(32);
    const data = JSON.stringify({ taskId: 'task-001' });
    const wrongHmac = generateHmac(crypto.randomBytes(32), data);
    expect(verifyHmac(secret, data, wrongHmac)).toBe(false);
  });

  test('篡改数据被检测', () => {
    const secret = crypto.randomBytes(32);
    const original = JSON.stringify({ taskId: 'task-001' });
    const hmac = generateHmac(secret, original);
    const tampered = JSON.stringify({ taskId: 'task-002' });
    expect(verifyHmac(secret, tampered, hmac)).toBe(false);
  });
});
