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

export function generateRepro(ctx: ReproContext): { scriptPath: string; contextPath: string } {
  fs.mkdirSync(ctx.outputDir, { recursive: true });

  const scriptPath = path.join(ctx.outputDir, `${ctx.taskId}.sh`);
  const contextPath = path.join(ctx.outputDir, `${ctx.taskId}-context.json`);

  const script = `#!/bin/bash
# Auto-generated repro script for ${ctx.taskId}
# Generated at ${new Date().toISOString()}
export PARALLELC_REPRODUCE=1
export PARALLELC_TASK_ID=${ctx.taskId}
git checkout ${ctx.gitHead}
echo "Reproducing task ${ctx.taskId}..."
parallelc-scheduler start --repo . --api-keys "$PARALLELC_API_KEYS" --single-task ${ctx.taskId}
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
