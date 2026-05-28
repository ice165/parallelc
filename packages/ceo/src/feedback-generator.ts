import type { CeoFeedback } from '@parallelc/shared';

export function generateFeedback(feedback: CeoFeedback): string {
  return JSON.stringify(feedback, null, 2);
}

export function parseFeedback(json: string): CeoFeedback | null {
  try {
    const parsed = JSON.parse(json) as CeoFeedback;
    if (!['PASS', 'REVISION', 'ESCALATE'].includes(parsed.verdict)) return null;
    if (typeof parsed.score !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}
