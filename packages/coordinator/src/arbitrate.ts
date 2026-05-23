import type { ConflictDetail } from './merge-strategy.js';

export interface ArbitrationInput {
  taskA: { taskId: string; starvationOverride: boolean; diff: string };
  taskB: { taskId: string; starvationOverride: boolean; diff: string };
  conflict: ConflictDetail;
}

export type ArbitrationDecision =
  | { action: 'ATTEMPT_STRUCTURED' }
  | { action: 'BLOCKED'; reason: string };

/**
 * 仲裁决策树（v1.5 spec 原文实现）：
 *
 * 情形 A: 双 starvation + 同区域 → BLOCKED
 * 情形 B: 单 starvation + 冲突 → ATTEMPT_STRUCTURED
 * 情形 C: 无 starvation / 不同区域 → ATTEMPT_STRUCTURED
 */
export function arbitrateMerge(input: ArbitrationInput): ArbitrationDecision {
  const bothStarved = input.taskA.starvationOverride && input.taskB.starvationOverride;
  const sameRegion = input.conflict.lines.length > 0 && input.conflict.lines !== 'unknown';

  if (bothStarved && sameRegion) {
    return {
      action: 'BLOCKED',
      reason: `Both tasks (${input.taskA.taskId}, ${input.taskB.taskId}) have starvation_override=true and conflict on same region (${input.conflict.lines})`,
    };
  }

  if (input.taskA.starvationOverride || input.taskB.starvationOverride) {
    return { action: 'ATTEMPT_STRUCTURED' };
  }

  return { action: 'ATTEMPT_STRUCTURED' };
}
