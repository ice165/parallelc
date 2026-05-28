import type { CeoReviewInput, CeoFeedback, CeoReviewResult } from '@parallelc/shared';
import { MAX_REVIEW_OUTPUT_TOKENS } from '@parallelc/shared';
import { matchIntent } from './intent-matcher.js';
import { getCeoModel } from './iteration-tracker.js';
import type { TaskLevel } from '@parallelc/shared';

export interface CeoAgentOptions {
  apiKey: string;
  level: TaskLevel;
  useMock?: boolean;
}

const PRICING: Record<string, { input: number; output: number }> = {
  opus: { input: 15, output: 75 },
  sonnet: { input: 3, output: 15 },
};

const CEO_SYSTEM_PROMPT = `You are a code review expert (CEO role). Your task is to review whether Worker code changes align with the user's original requirements.

Review dimensions (0-100):
1. Feature coverage (35 pts): Does the diff implement all key features from the requirements?
2. Gap detection (25 pts): Are there unimplemented key features (penalty)?
3. Excess changes (20 pts): Are there changes unrelated to the task (penalty)?
4. Side effect risk (20 pts): Are export/import changes affecting other modules (penalty)?

Output strict JSON:
{
  "verdict": "PASS|REVISION|ESCALATE",
  "score": 0-100,
  "summary": "one-sentence summary",
  "gaps": ["missing items"],
  "excess": ["unnecessary changes"],
  "sideEffects": ["side effects"],
  "suggestions": ["specific revision suggestions"]
}`;

function buildCeoPrompt(input: CeoReviewInput): string {
  return `## User Request
${input.userRequest}

## Task Description
${input.taskTitle}
Reasoning: ${input.taskReasoning}

## Modified Files
${input.modifiedFiles.join('\n')}

## Worker Diff
\`\`\`diff
${input.diff.slice(0, 8000)}
\`\`\`

## Round
Round ${input.iteration + 1} of 3

Output JSON with verdict (PASS>=80, REVISION 50-79, ESCALATE<50 or round 3 not passing)`;
}

export async function ceoReview(
  input: CeoReviewInput,
  taskId: string,
  opts: CeoAgentOptions,
): Promise<CeoReviewResult> {
  const model = getCeoModel(opts.level);

  // Mock mode: use rule-based scoring only
  if (opts.useMock || process.env['PARALLELC_MOCK_CEO_RESPONSE']) {
    const feedback = matchIntent(input);
    return { taskId, feedback, model, tokensUsed: 0, cost: 0 };
  }

  // Rule engine runs first for pre-scoring
  const ruleResult = matchIntent(input);

  // Try LLM call, fall back to rules on failure
  try {
    const prompt = buildCeoPrompt(input);
    const { spawnSync } = await import('child_process');
    const claudeResult = spawnSync('claude', [
      '--model', model,
      '--max-tokens', String(MAX_REVIEW_OUTPUT_TOKENS),
      '--system', CEO_SYSTEM_PROMPT,
      '--prompt', prompt,
    ], {
      env: { ...process.env, ANTHROPIC_API_KEY: opts.apiKey },
      encoding: 'utf-8',
      timeout: 60_000,
    });

    if (claudeResult.status === 0 && claudeResult.stdout) {
      const output = claudeResult.stdout.trim();
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const llmFeedback = JSON.parse(jsonMatch[0]) as CeoFeedback;
        const inputTokens = Math.ceil(prompt.length / 3.5);
        const outputTokens = Math.ceil(output.length / 3.5);
        const price = PRICING[model] ?? PRICING['sonnet']!;
        const cost = (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
        return { taskId, feedback: llmFeedback, model, tokensUsed: inputTokens + outputTokens, cost };
      }
    }
  } catch { /* LLM call failed, fall through to rule-based result */ }

  return { taskId, feedback: ruleResult, model, tokensUsed: 0, cost: 0 };
}
