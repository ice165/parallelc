import { KeyPool } from './key-pool.js';

export function handleGlobalBackoff(pool: KeyPool): { paused: boolean; resumeAt: Date | null } {
  if (pool.allPaused()) {
    const resumeAt = pool.earliestRecovery();
    return { paused: true, resumeAt };
  }
  return { paused: false, resumeAt: null };
}
