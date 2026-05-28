import { createHmac, timingSafeEqual } from 'crypto';

export function generateHmac(secret: Buffer, data: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

export function verifyHmac(secret: Buffer, data: string, hmac: Buffer): boolean {
  try {
    const expected = generateHmac(secret, data);
    if (expected.length !== hmac.length) return false;
    return timingSafeEqual(expected, hmac);
  } catch {
    return false;
  }
}
