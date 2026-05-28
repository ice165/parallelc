import { evaluateClarity } from '@parallelc/orchestrator';
import type { ClarityResult } from '@parallelc/orchestrator';
import { generateSpec } from './spec-generator.js';

export interface IntakeResult {
  phase: 'CLARIFY' | 'READY';
  clarity: ClarityResult;
  clarifyingQuestions: string[];
  confirmedRequirement: string | null;
  spec: string | null;
}

export function intakeRequirement(userRequest: string): IntakeResult {
  const clarity = evaluateClarity(userRequest);

  if (clarity.zone === 'BRAINSTORM') {
    return {
      phase: 'CLARIFY',
      clarity,
      clarifyingQuestions: generateClarifyingQuestions(clarity),
      confirmedRequirement: null,
      spec: null,
    };
  }

  const spec = generateSpec(userRequest, clarity);
  return {
    phase: 'READY',
    clarity,
    clarifyingQuestions: [],
    confirmedRequirement: userRequest,
    spec,
  };
}

export function confirmWithClarification(
  originalRequest: string,
  clarifications: string,
): IntakeResult {
  const combined = `${originalRequest}\n\n用户补充说明：\n${clarifications}`;
  return intakeRequirement(combined);
}

function generateClarifyingQuestions(clarity: ClarityResult): string[] {
  const questions: string[] = [];

  if (clarity.verbScore < 15) {
    questions.push('希望执行什么操作？（创建/修改/删除/重构/优化）');
  }
  if (clarity.scopeScore < 12) {
    questions.push('需要修改哪些文件或模块？可以提供具体路径吗？');
  }
  if (clarity.constraintScore < 10) {
    questions.push('有什么约束或必须满足的条件？（向后兼容/性能要求/不修改公共API等）');
  }
  if (clarity.ambiguityPenalty > 0) {
    questions.push(`检测到模糊表述（${clarity.warnings.filter(w => w.includes('歧义')).join('、')}），能否更具体地描述？`);
  }
  if (questions.length === 0) {
    questions.push('能否更详细地描述需求的目标和预期结果？');
  }

  return questions;
}
