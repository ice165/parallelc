import { execSync } from 'child_process';
import {
  EXIT_SUCCESS,
  EXIT_CHECKPOINT,
  EXIT_TIMEOUT,
  EXIT_HOOK_BLOCKED,
  EXIT_RATE_LIMIT,
  EXIT_TAMPER,
} from '@parallelc/shared';
import type { ExitAction, OnWorkerExitOptions, RateLimitBackoffResult } from '@parallelc/shared';

const BACKOFF_MINUTES = [1, 2, 4, 8, 16];
const MAX_RATE_LIMIT_RETRIES = 5;

export function routeExitCode(opts: OnWorkerExitOptions): ExitAction {
  const { taskId, exitCode, writeRoot, rateLimitCount, maxRateLimitRetries = MAX_RATE_LIMIT_RETRIES } = opts;

  switch (exitCode) {
    case EXIT_SUCCESS:
      return {
        type: 'MARK_DONE',
        modifiedFiles: collectModifiedFiles(writeRoot),
      };

    case EXIT_CHECKPOINT:
      return {
        type: 'CHECKPOINT',
        message: `Task ${taskId} reached 30-turn context limit`,
      };

    case EXIT_TIMEOUT:
      return {
        type: 'FAILED',
        reason: `Task ${taskId} timed out`,
      };

    case EXIT_HOOK_BLOCKED:
      return {
        type: 'HOOK_BLOCKED',
        filePath: 'unknown',
      };

    case EXIT_RATE_LIMIT: {
      const newCount = rateLimitCount + 1;
      if (newCount > maxRateLimitRetries) {
        return {
          type: 'FAILED',
          reason: `Task ${taskId} rate_limit_exhausted after ${newCount} attempts`,
        };
      }
      const backoff = calculateRateLimitBackoff(newCount, maxRateLimitRetries);
      return {
        type: 'RATE_LIMIT_SLEEP',
        attempt: newCount,
        wakeAt: backoff.wakeAt,
      };
    }

    case EXIT_TAMPER:
      return {
        type: 'FAILED',
        reason: `HMAC verification failed for task ${taskId} — possible tampering or misconfiguration`,
      };

    default:
      return {
        type: 'FAILED',
        reason: `Unknown exit code ${exitCode} for task ${taskId}`,
      };
  }
}

/**
 * 采集 Worker 写区所有变更文件。
 * git diff --name-only HEAD 捕获已跟踪文件的变更；
 * git ls-files --others --exclude-standard 捕获未跟踪的新建文件。
 */
export function collectModifiedFiles(writeRoot: string): string[] {
  try {
    const tracked = execSync('git diff --name-only HEAD', {
      cwd: writeRoot,
      encoding: 'utf-8',
      timeout: 10_000,
    })
      .trim()
      .split('\n')
      .filter((f) => f.length > 0);

    const untracked = execSync('git ls-files --others --exclude-standard', {
      cwd: writeRoot,
      encoding: 'utf-8',
      timeout: 10_000,
    })
      .trim()
      .split('\n')
      .filter((f) => f.length > 0);

    return [...new Set([...tracked, ...untracked])];
  } catch (err) {
    console.warn(`[lifecycle] collectModifiedFiles failed in ${writeRoot}:`, err instanceof Error ? err.message : err);
    return [];
  }
}

export function calculateRateLimitBackoff(
  attempt: number,
  maxRetries: number = MAX_RATE_LIMIT_RETRIES,
): RateLimitBackoffResult {
  if (attempt > maxRetries) {
    return { wakeAt: new Date(), exceeded: true };
  }

  const minutes = BACKOFF_MINUTES[attempt - 1] ?? 16;
  const jitterSeconds = Math.floor(Math.random() * 61) - 30;
  const wakeAt = new Date(Date.now() + minutes * 60_000 + jitterSeconds * 1_000);

  return { wakeAt, exceeded: false };
}
