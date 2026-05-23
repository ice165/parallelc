import { spawnMcpWorker } from '@parallelc/worker';
import type { DecompositionInput } from './prompt-builder.js';
import { buildOrchestratorPrompt } from './prompt-builder.js';
import { parseTaskDAG, type TaskDraft } from './response-parser.js';
import { createHash } from 'crypto';

export interface DecomposerOptions {
  apiKey: string;
  model?: 'sonnet' | 'opus';
  maxTokens?: number;
  timeoutMs?: number;
  cacheKey?: string | null;
}

export interface DecomposerResult {
  raw: string;
  parsed: TaskDraft[] | null;
  tokensUsed: number;
  cached: boolean;
}

const cache = new Map<string, DecomposerResult>();

export async function decomposeViaClaude(
  input: DecompositionInput,
  opts: DecomposerOptions,
): Promise<DecomposerResult> {
  const cacheKey = opts.cacheKey === null
    ? null
    : opts.cacheKey ?? createHash('sha1')
        .update(JSON.stringify({ req: input.userRequest, files: input.repoContext.fileTree }))
        .digest('hex').slice(0, 16);

  if (cacheKey && cache.has(cacheKey)) {
    const cached = cache.get(cacheKey)!;
    return { ...cached, cached: true };
  }

  const prompt = buildOrchestratorPrompt(input);

  const child = spawnMcpWorker(
    {
      apiKey: opts.apiKey,
      model: opts.model ?? 'opus',
      cwd: process.cwd(),
      readonlyRoot: process.cwd(),
      maxRounds: 3,
      timeoutMs: opts.timeoutMs ?? 120_000,
    },
    {
      taskId: `orchestrate-${Date.now()}`,
      snapshotVersion: 'N/A',
      dependencies: null,
    },
  );

  child.stdin?.write(prompt);
  child.stdin?.end();

  let raw = '';
  child.stdout?.on('data', (chunk: Buffer) => { raw += chunk.toString(); });

  return new Promise((resolve) => {
    child.on('exit', () => {
      const parsed = parseTaskDAG(raw);
      const result: DecomposerResult = {
        raw,
        parsed: parsed?.tasks ?? null,
        tokensUsed: Math.ceil(raw.length / 3.5),
        cached: false,
      };
      if (cacheKey) cache.set(cacheKey, result);
      resolve(result);
    });
  });
}
