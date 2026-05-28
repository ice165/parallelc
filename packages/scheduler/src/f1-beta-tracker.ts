export interface PredictionScore {
  expected: string[];
  actual: string[];
}

export class F1BetaTracker {
  private scores: number[] = [];
  private readonly beta = 0.5;
  private consecutiveLow = 0;

  constructor(private windowSize: number = 10) {}

  record(score: PredictionScore): void {
    const f1 = this.calculateF1Beta(score.expected, score.actual);
    this.scores.push(f1);
    if (this.scores.length > this.windowSize) {
      this.scores.shift();
    }

    if (f1 < 0.7) {
      this.consecutiveLow++;
    } else {
      this.consecutiveLow = 0;
    }
  }

  getAverageScore(): number {
    if (this.scores.length === 0) return 1.0;
    const sum = this.scores.reduce((a, b) => a + b, 0);
    return sum / this.scores.length;
  }

  shouldDegrade(): boolean {
    if (this.scores.length < 2) return false;
    if (this.consecutiveLow >= 3) return true;
    if (this.scores.length >= this.windowSize && this.getAverageScore() < 0.7) return true;
    return false;
  }

  scoreCount(): number {
    return this.scores.length;
  }

  private calculateF1Beta(expected: string[], actual: string[]): number {
    if (expected.length === 0 && actual.length === 0) return 1.0;
    if (expected.length === 0 || actual.length === 0) return 0.0;

    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);

    const intersect = [...expectedSet].filter(f => actualSet.has(f)).length;
    const precision = actual.length > 0 ? intersect / actual.length : 0;
    const recall = expected.length > 0 ? intersect / expected.length : 0;

    const betaSq = this.beta * this.beta;
    const denominator = betaSq * precision + recall;
    if (denominator === 0) return 0;

    return ((1 + betaSq) * precision * recall) / denominator;
  }
}
