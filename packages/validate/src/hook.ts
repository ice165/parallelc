import { ParallelCError } from '@parallelc/shared';
import { EXIT_HOOK_BLOCKED } from '@parallelc/shared';
import { isWriteAllowed } from './validate-write.js';

export function validateWriteHook(
  toolName: string,
  params: Record<string, unknown>,
): void {
  const writeTools = ['Edit', 'Write'];

  if (!writeTools.includes(toolName)) {
    return;
  }

  const workerId = process.env['WORKER_ID'];
  const writeRoot = process.env['WORKER_WRITE_ROOT'];

  if (!workerId || !writeRoot) {
    return;
  }

  const filePath = params['file_path'] as string | undefined;
  if (!filePath) {
    throw new ParallelCError(
      `Hook blocked ${toolName}: missing file_path parameter`,
      EXIT_HOOK_BLOCKED,
      { toolName, params },
    );
  }

  if (!isWriteAllowed(filePath, workerId, writeRoot)) {
    throw new ParallelCError(
      `Hook blocked write to ${filePath}: outside write root`,
      EXIT_HOOK_BLOCKED,
      { toolName, filePath, workerId, writeRoot },
    );
  }
}
