import type { Task, TaskLevel } from '@parallelc/shared';
import {
  MAX_CEO_ROUNDS,
  CEO_SKIP_CLARITY_SCORE,
  CEO_SKIP_F1BETA_SCORE,
} from '@parallelc/shared';

export interface IterationDecision {
  action: 'REVIEW' | 'SKIP' | 'ESCALATE';
  reason: string;
}

export function shouldReview(
  task: Task,
  clarityScore: number,
  f1BetaAvg: number,
  remainingCeoBudget: number,
): boolean {
  if (task.level === 'L1') return false;
  if (remainingCeoBudget <= 0) return false;
  if (task.level === 'L3') return true;
  if (clarityScore > CEO_SKIP_CLARITY_SCORE) return false;
  if (f1BetaAvg > CEO_SKIP_F1BETA_SCORE) return false;
  if ((task.modified_files ?? []).length === 1 && task.ceo_iteration === 0) return false;
  return true;
}

export function getCeoModel(level: TaskLevel): 'sonnet' | 'opus' {
  return level === 'L3' ? 'opus' : 'sonnet';
}

export class IterationTracker {
  canRetry(iteration: number): boolean {
    return iteration < MAX_CEO_ROUNDS - 1;
  }

  getMaxRounds(): number {
    return MAX_CEO_ROUNDS;
  }
}
