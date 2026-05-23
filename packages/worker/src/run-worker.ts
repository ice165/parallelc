import { verifySnapshotVersion } from './startup.js';
import { spawnMcpWorker } from './mcp-client.js';
import { EXIT_HOOK_BLOCKED } from '@parallelc/shared';

export function runWorker(): void {
  const workerId = process.env['WORKER_ID'];
  const writeRoot = process.env['WORKER_WRITE_ROOT'];
  const readonlyRoot = process.env['WORKER_READONLY_ROOT'];
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  const taskId = process.env['TASK_ID'];
  const snapshotVersion = process.env['SNAPSHOT_VERSION'];

  if (!workerId || !writeRoot || !readonlyRoot || !taskId || !snapshotVersion) {
    console.error('[runWorker] Missing required environment variables');
    console.error(`  WORKER_ID=${workerId}`);
    console.error(`  WORKER_WRITE_ROOT=${writeRoot}`);
    console.error(`  WORKER_READONLY_ROOT=${readonlyRoot}`);
    console.error(`  TASK_ID=${taskId}`);
    console.error(`  SNAPSHOT_VERSION=${snapshotVersion}`);
    process.exit(EXIT_HOOK_BLOCKED);
  }

  // 1. 快照版本校验
  const check = verifySnapshotVersion({
    taskId,
    snapshotVersion,
    projectContextPath: `${readonlyRoot}/.parallelc/project_context.md`,
  });

  if (check.warnings.length > 0) {
    console.warn(`[runWorker] ${check.warnings.join('\n')}`);
  }

  // 2. 启动 MCP Worker（阻塞直到子进程退出）
  const child = spawnMcpWorker(
    {
      apiKey: apiKey ?? '',
      cwd: writeRoot,
      readonlyRoot,
    },
    {
      taskId,
      snapshotVersion,
      dependencies: null, // Phase 2 从任务记录注入
    },
  );

  // 3. 等待子进程退出，传递退出码
  child.on('exit', (code) => {
    const exitCode = code ?? 1;
    console.log(`[runWorker] Worker ${workerId} exited with code ${exitCode}`);
    process.exit(exitCode);
  });
}
