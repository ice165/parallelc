export interface KeyState {
  key: string;
  masked: string;
  status: 'ACTIVE' | 'COOLDOWN' | 'DEAD';
  cooldownUntil: Date | null;
  consecutive429: number;
  lastUsedAt: Date | null;
}

const COOLDOWN_BASE_MINUTES = 5;
const JITTER_SECONDS = 30;

export class KeyPool {
  private keys: KeyState[];
  private index = 0;

  constructor(apiKeys: string[]) {
    this.keys = apiKeys.map(key => ({
      key,
      masked: key.slice(0, 10) + '...' + key.slice(-4),
      status: 'ACTIVE' as const,
      cooldownUntil: null,
      consecutive429: 0,
      lastUsedAt: null,
    }));
  }

  nextKey(): string {
    const now = new Date();

    for (let i = 0; i < this.keys.length; i++) {
      const k = this.keys[(this.index + i) % this.keys.length]!;
      if (k.status === 'ACTIVE') {
        this.index = (this.index + i + 1) % this.keys.length;
        k.lastUsedAt = now;
        return k.key;
      }
      if (k.status === 'COOLDOWN' && k.cooldownUntil && now >= k.cooldownUntil) {
        k.status = 'ACTIVE';
        k.consecutive429 = 0;
        this.index = (this.index + i + 1) % this.keys.length;
        k.lastUsedAt = now;
        return k.key;
      }
    }

    const cooldownKeys = this.keys.filter(k => k.status === 'COOLDOWN' && k.cooldownUntil);
    if (cooldownKeys.length > 0) {
      cooldownKeys.sort((a, b) => a.cooldownUntil!.getTime() - b.cooldownUntil!.getTime());
      const best = cooldownKeys[0]!;
      if (best.cooldownUntil!.getTime() - now.getTime() < JITTER_SECONDS * 1000) {
        best.status = 'ACTIVE';
        best.consecutive429 = 0;
        best.lastUsedAt = now;
        return best.key;
      }
      best.lastUsedAt = now;
      return best.key;
    }

    throw new Error('All API keys are DEAD');
  }

  markSuccess(key: string): void {
    const k = this.keys.find(k => k.key === key);
    if (!k) return;
    k.consecutive429 = 0;
    k.status = 'ACTIVE';
    k.cooldownUntil = null;
  }

  markRateLimited(key: string): void {
    const k = this.keys.find(k => k.key === key);
    if (!k) return;
    k.consecutive429++;
    if (k.consecutive429 >= 3) {
      const exponent = k.consecutive429 - 3;
      const minutes = COOLDOWN_BASE_MINUTES * Math.pow(2, exponent);
      const jitter = Math.floor(Math.random() * (JITTER_SECONDS * 2 + 1)) - JITTER_SECONDS;
      k.cooldownUntil = new Date(Date.now() + minutes * 60_000 + jitter * 1_000);
      k.status = 'COOLDOWN';
    }
  }

  markDead(key: string): void {
    const k = this.keys.find(k => k.key === key);
    if (!k) return;
    k.status = 'DEAD';
  }

  allPaused(): boolean {
    return this.keys.every(k => k.status !== 'ACTIVE');
  }

  earliestRecovery(): Date | null {
    const cooldownKeys = this.keys.filter(k => k.status === 'COOLDOWN' && k.cooldownUntil);
    if (cooldownKeys.length === 0) return null;
    return cooldownKeys.reduce((earliest, k) =>
      k.cooldownUntil! < earliest ? k.cooldownUntil! : earliest,
      cooldownKeys[0]!.cooldownUntil!,
    );
  }

  status(): KeyState[] {
    return [...this.keys];
  }
}
