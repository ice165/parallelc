import fs from 'fs';
import path from 'path';

export interface TokenEstimate {
  estimatedTokens: number;
  totalChars: number;
  reasoning: string;
}

const CHARS_PER_TOKEN = 2;

export function estimateTokens(files: string[], repoRoot: string): TokenEstimate {
  let totalChars = 0;
  let count = 0;
  for (const f of files) {
    try {
      const content = fs.readFileSync(path.join(repoRoot, f), 'utf-8');
      totalChars += content.length;
      count++;
    } catch {
      totalChars += 500;
    }
  }
  const estimatedTokens = Math.ceil(totalChars / CHARS_PER_TOKEN);
  return {
    estimatedTokens,
    totalChars,
    reasoning: `${count} files, ${totalChars} chars, ${estimatedTokens} tokens (${CHARS_PER_TOKEN} chars/token)`,
  };
}
