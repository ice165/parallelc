import { EXIT_SUCCESS, EXIT_CHECKPOINT, EXIT_TIMEOUT, EXIT_CODE_LABELS, ParallelCError } from '../src';

describe('shared constants', () => {
  it('exit codes should be distinct', () => {
    const codes = [EXIT_SUCCESS, EXIT_CHECKPOINT, EXIT_TIMEOUT];
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('EXIT_CODE_LABELS should have entries for all codes', () => {
    expect(EXIT_CODE_LABELS[EXIT_SUCCESS]).toBe('EXIT_SUCCESS');
    expect(EXIT_CODE_LABELS[EXIT_TIMEOUT]).toBe('EXIT_TIMEOUT');
  });
});

describe('ParallelCError', () => {
  it('should set name and exitCode', () => {
    const err = new ParallelCError('test error', 42);
    expect(err.name).toBe('ParallelCError');
    expect(err.exitCode).toBe(42);
  });

  it('should store optional context', () => {
    const err = new ParallelCError('ctx error', 1, { key: 'value' });
    expect(err.context).toEqual({ key: 'value' });
  });
});
