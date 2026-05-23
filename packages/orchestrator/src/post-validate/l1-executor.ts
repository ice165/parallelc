import { spawnMcpWorker } from '@parallelc/worker';
import type { TaskDraft } from '../decompose/response-parser.js';

export interface L1ExecutionResult {
  success: boolean;
  modifiedFiles: string[];
  output: string;
}

export async function executeL1Directly(
  task: TaskDraft,
  repoRoot: string,
  apiKey: string,
  lockedFiles: Set<string>,
): Promise<L1ExecutionResult> {
  const conflict = task.expected_touch_files.find(f => lockedFiles.has(f));
  if (conflict) {
    return {
      success: false,
      modifiedFiles: [],
      output: `File locked: ${conflict}. Upstream task is modifying it.`,
    };
  }

  const child = spawnMcpWorker(
    {
      apiKey,
      model: 'sonnet',
      cwd: repoRoot,
      readonlyRoot: repoRoot,
      maxRounds: 5,
      timeoutMs: 300_000,
    },
    {
      taskId: `l1-${Date.now()}`,
      snapshotVersion: 'L1-direct',
      dependencies: null,
    },
  );

  child.stdin?.write(`直接执行: ${task.title}\n${task.reasoning}`);
  child.stdin?.end();

  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });

  return new Promise((resolve) => {
    child.on('exit', (code) => {
      resolve({
        success: code === 0,
        modifiedFiles: task.expected_touch_files,
        output: output.slice(-500),
      });
    });
  });
}
