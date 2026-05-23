export class ParallelCError extends Error {
  public readonly exitCode: number;
  public readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    exitCode: number,
    context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ParallelCError';
    this.exitCode = exitCode;
    this.context = context;
  }
}
