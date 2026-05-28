import type { CeoReviewInput, CeoFeedback } from '@parallelc/shared';
import { MAX_CEO_ROUNDS, CEO_PASS_THRESHOLD, CEO_ESCALATE_THRESHOLD } from '@parallelc/shared';

export interface IntentScore {
  coverage: number;
  gapPenalty: number;
  excessPenalty: number;
  sideEffectPenalty: number;
}

function extractKeywords(text: string): string[] {
  const terms: string[] = [];
  const cnRe = /[一-鿿]{2,8}/g;
  let m: RegExpExecArray | null;
  while ((m = cnRe.exec(text)) !== null) terms.push(m[0]);
  const enRe = /\b[a-zA-Z_]\w{2,}\b/g;
  while ((m = enRe.exec(text)) !== null) terms.push(m[0]);
  return [...new Set(terms)];
}

function scoreCoverage(requestKeywords: string[], diff: string): number {
  let hits = 0;
  const diffLower = diff.toLowerCase();
  for (const kw of requestKeywords) {
    if (diffLower.includes(kw.toLowerCase())) hits++;
  }
  if (requestKeywords.length === 0) return 35;
  return Math.min(35, Math.round((hits / requestKeywords.length) * 35));
}

function scoreGaps(requestKeywords: string[], diff: string): number {
  const diffLower = diff.toLowerCase();
  const missing = requestKeywords.filter(kw => !diffLower.includes(kw.toLowerCase()));
  if (requestKeywords.length === 0) return 0;
  return Math.min(25, Math.round((missing.length / requestKeywords.length) * 25));
}

function scoreExcess(taskTitle: string, modifiedFiles: string[]): number {
  const taskKeywords = extractKeywords(taskTitle);
  const excessCount = modifiedFiles.filter(f => {
    const fLower = f.toLowerCase();
    return !taskKeywords.some(kw => fLower.includes(kw.toLowerCase()));
  }).length;
  return Math.min(20, excessCount * 10);
}

function scoreSideEffects(diff: string, modifiedFiles: string[]): number {
  let risk = 0;
  if (/^[-+]export\s/m.test(diff)) risk += 10;
  if (/^[-+]import\s/m.test(diff)) risk += 5;
  if (modifiedFiles.length > 3) risk += 5;
  return Math.min(20, risk);
}

export function matchIntent(input: CeoReviewInput): CeoFeedback {
  if (input.iteration >= MAX_CEO_ROUNDS - 1) {
    return {
      verdict: 'ESCALATE', score: 0,
      summary: `Max iterations (${MAX_CEO_ROUNDS}) reached`,
      gaps: [], excess: [], sideEffects: [],
      suggestions: ['Manual review required'],
    };
  }

  const requestKeywords = extractKeywords(input.userRequest);
  const taskKeywords = extractKeywords(input.taskTitle);

  const coverage = scoreCoverage(requestKeywords, input.diff);
  const gapPenalty = scoreGaps(requestKeywords, input.diff);
  const excessPenalty = scoreExcess(input.taskTitle, input.modifiedFiles);
  const sideEffectPenalty = scoreSideEffects(input.diff, input.modifiedFiles);

  const score = Math.max(0, coverage + (25 - gapPenalty) + (20 - excessPenalty) + (20 - sideEffectPenalty));
  const cappedScore = Math.min(100, score);

  const gaps: string[] = [];
  const excess: string[] = [];
  const sideEffects: string[] = [];
  const suggestions: string[] = [];

  const diffLower = input.diff.toLowerCase();
  for (const kw of requestKeywords) {
    if (!diffLower.includes(kw.toLowerCase())) {
      gaps.push(`Missing: ${kw}`);
      suggestions.push(`Add implementation for: ${kw}`);
    }
  }

  for (const f of input.modifiedFiles) {
    const fLower = f.toLowerCase();
    if (!taskKeywords.some(kw => fLower.includes(kw.toLowerCase()))) {
      excess.push(`Unrelated file modified: ${f}`);
      suggestions.push(`Consider reverting changes to: ${f}`);
    }
  }

  if (/^[-+]export\s/m.test(input.diff)) {
    sideEffects.push('Export signature modified — may affect other modules');
  }

  let verdict: CeoFeedback['verdict'];
  if (cappedScore < CEO_ESCALATE_THRESHOLD) {
    verdict = 'ESCALATE';
  } else if (cappedScore >= CEO_PASS_THRESHOLD) {
    verdict = 'PASS';
  } else {
    verdict = 'REVISION';
  }

  return {
    verdict, score: cappedScore,
    summary: `C=${coverage}/35 G=-${gapPenalty}/25 E=-${excessPenalty}/20 S=-${sideEffectPenalty}/20`,
    gaps, excess, sideEffects,
    suggestions: suggestions.slice(0, 5),
  };
}
