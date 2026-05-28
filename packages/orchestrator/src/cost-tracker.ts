export interface CostConfig {
  maxCostPerTask: number;
  maxCostPerSession: number;
}

export interface TokenUsage {
  model: 'sonnet' | 'opus' | 'haiku';
  inputTokens: number;
  outputTokens: number;
}

// Anthropic 2026 pricing per 1M tokens
const PRICING: Record<string, { input: number; output: number }> = {
  opus: { input: 15, output: 75 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 0.8, output: 4 },
};

export class CostTracker {
  private taskCost = 0;
  private sessionCost = 0;

  constructor(private config: CostConfig) {}

  recordUsage(usage: TokenUsage): void {
    const price = PRICING[usage.model] ?? PRICING['sonnet']!;
    const cost = (usage.inputTokens / 1_000_000) * price.input +
      (usage.outputTokens / 1_000_000) * price.output;
    this.taskCost += cost;
    this.sessionCost += cost;
  }

  canDispatch(): boolean {
    return this.taskCost < this.config.maxCostPerTask &&
      this.sessionCost < this.config.maxCostPerSession;
  }

  resetTask(): void {
    this.taskCost = 0;
  }

  getSummary(): { taskCost: number; sessionCost: number; totalCost: number } {
    return {
      taskCost: this.taskCost,
      sessionCost: this.sessionCost,
      totalCost: this.sessionCost,
    };
  }
}
