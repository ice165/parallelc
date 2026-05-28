import fs from 'fs';
import path from 'path';

export interface ReproContext {
  taskId: string;
  outputDir: string;
  gitHead: string;
  snapshotVersion: string;
  stdout: string;
  exitCode: number;
}

function sanitizeShellToken(value: string): string {
  // Only allow alphanumeric, hyphens, underscores, and dots
  return value.replace(/[^a-zA-Z0-9\-_.]/g, '');
}

export function generateRepro(ctx: ReproContext): { scriptPath: string; contextPath: string } {
  fs.mkdirSync(ctx.outputDir, { recursive: true });

  const safeTaskId = sanitizeShellToken(ctx.taskId);
  const safeGitHead = sanitizeShellToken(ctx.gitHead);

  const scriptPath = path.join(ctx.outputDir, `${safeTaskId}.sh`);
  const contextPath = path.join(ctx.outputDir, `${safeTaskId}-context.json`);

  const script = `#!/bin/bash
# Auto-generated repro script for ${safeTaskId}
# Generated at ${new Date().toISOString()}
export PARALLELC_REPRODUCE=1
export PARALLELC_TASK_ID='${safeTaskId}'
git checkout '${safeGitHead}'
echo "Reproducing task ${safeTaskId}..."
parallelc-scheduler start --repo . --api-keys "$PARALLELC_API_KEYS" --single-task '${safeTaskId}'
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  const context = {
    taskId: ctx.taskId,
    gitHead: ctx.gitHead,
    snapshotVersion: ctx.snapshotVersion,
    exitCode: ctx.exitCode,
    stdoutLast500: ctx.stdout.slice(-500),
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(contextPath, JSON.stringify(context, null, 2));

  return { scriptPath, contextPath };
}
