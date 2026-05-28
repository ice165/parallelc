export interface ClarityResult {
  score: number;
  zone: 'BRAINSTORM' | 'DUAL_ENGINE' | 'PASS';
  verbScore: number;
  scopeScore: number;
  constraintScore: number;
  ambiguityPenalty: number;
  warnings: string[];
}

const ACTION_VERBS = /\b(创建|修复|添加|移除|删除|重构|优化|实现|编写|修改|更新|迁移|合并|拆分|提取|重命名|配置|集成|替换|回滚|升级|降级)\b/g;
const SCOPE_PATTERNS = /(?:src|packages|lib|tests?|docs?)\/[\w\/\-+.]+\.(?:ts|js|tsx|jsx|py|rs|go|java|sql)/g;
const CONSTRAINT_PATTERNS = /(必须|不能|要求|限制|不超过|至少|最多|保持|确保|保证|禁止|不允许)/g;
const AMBIGUITY_WORDS = /\b(可能|大概|左右|类似|优化一下|改一下|弄一下|那种|什么的|等等|之类|或许|差不多|随便|看看)\b/g;

export function evaluateClarity(userRequest: string): ClarityResult {
  const warnings: string[] = [];

  // 1. Action verb score (0-30)
  const verbMatches = userRequest.match(ACTION_VERBS) ?? [];
  const verbScore = Math.min(30, verbMatches.length * 15);

  // 2. Scope boundary score (0-25)
  const scopeMatches = userRequest.match(SCOPE_PATTERNS) ?? [];
  const scopeScore = Math.min(25, scopeMatches.length * 12);

  // 3. Constraint expression score (0-20)
  const constraintMatches = userRequest.match(CONSTRAINT_PATTERNS) ?? [];
  const constraintScore = Math.min(20, constraintMatches.length * 10);

  // 4. Ambiguity penalty (0-25)
  const ambiguityMatches = userRequest.match(AMBIGUITY_WORDS) ?? [];
  const ambiguityPenalty = Math.min(25, ambiguityMatches.length * 10);

  for (const word of ambiguityMatches) {
    warnings.push(`歧义词: "${word}"`);
  }

  const score = Math.max(0, verbScore + scopeScore + constraintScore - ambiguityPenalty);

  let zone: ClarityResult['zone'];
  if (score < 70) {
    zone = 'BRAINSTORM';
    warnings.push('需求清晰度不足 (<70)，建议 CEO 需求确认后再执行');
  } else if (score <= 90) {
    zone = 'DUAL_ENGINE';
  } else {
    zone = 'PASS';
  }

  return { score, zone, verbScore, scopeScore, constraintScore, ambiguityPenalty, warnings };
}
