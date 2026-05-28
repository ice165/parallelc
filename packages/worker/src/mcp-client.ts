import { spawn, ChildProcess } from 'child_process';

export interface McpClientOptions {
  apiKey: string;
  model?: 'haiku' | 'sonnet' | 'opus';
  cwd: string;
  readonlyRoot: string;
  maxRounds?: number;
  timeoutMs?: number;
  /** 额外的环境变量，会合并到子进程 env 中（覆盖同名变量） */
  extraEnv?: Record<string, string>;
}

export interface McpTaskContext {
  taskId: string;
  snapshotVersion: string;
  dependencies: string[] | null;
}

const DEFAULT_MAX_ROUNDS = 30;
const DEFAULT_TIMEOUT_MS = 600_000; // 10 分钟
const SIGKILL_DELAY_MS = 5_000;

export function spawnMcpWorker(
  opts: McpClientOptions,
  context: McpTaskContext,
): ChildProcess {
  // Mock mode: set PARALLELC_MOCK_CLAUDE_RESPONSE env var to a JSON file path
  // containing pre-recorded Claude responses to skip real API calls.
  // Used primarily in orchestrator's mcp-decomposer.ts.
  const {
    apiKey,
    model = 'sonnet',
    cwd,
    readonlyRoot,
    maxRounds = DEFAULT_MAX_ROUNDS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    extraEnv = {},
  } = opts;

  const env = {
    ...process.env,
    ANTHROPIC_API_KEY: apiKey,
    CLAUDE_MODEL: model,
    WORKER_READONLY_ROOT: readonlyRoot,
    WORKER_WRITE_ROOT: cwd,
    ...extraEnv,
  };

  const child = spawn(
    'claude',
    [
      '--mcp',
      '--model', model,
      '--max-turns', String(maxRounds),
      '--system-prompt', buildWorkerSystemPrompt(context),
    ],
    {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  // Watchdog: 超时 → SIGTERM → SIGKILL
  const watchdog = setTimeout(() => {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }, SIGKILL_DELAY_MS);
  }, timeoutMs);

  child.on('exit', () => {
    clearTimeout(watchdog);
  });

  return child;
}

export function buildWorkerSystemPrompt(context: McpTaskContext): string {
  const depText = context.dependencies?.length
    ? `\n前置任务已完成（供上下文参考）：${context.dependencies.join(', ')}`
    : '';

  return `你是 ParallelC Worker Agent，在隔离的 Worktree 环境中执行开发任务。

## 环境信息
- 只读完整代码区：\$WORKER_READONLY_ROOT（可读取项目全部源码，禁止写入）
- 稀疏写区：\$WORKER_WRITE_ROOT（仅包含你负责的目录，可在此写入）
- 任务 ID：${context.taskId}
- 快照版本：${context.snapshotVersion}
${depText}

## 启动检查清单
1. 读取 \$WORKER_READONLY_ROOT/.parallelc/project_context.md
2. 对比 snapshot_version 字段是否等于 "${context.snapshotVersion}"
3. 若不一致，继续执行但标记 context_mismatch=true

## 写保护警告
禁止写入 WORKER_READONLY_ROOT 下的任何路径。
越权写入将被 validate_write hook 拦截（退出码 12）。
所有写入操作限定在 WORKER_WRITE_ROOT 内。

## 退出协议
- 任务完成：process.exit(0)
- 达到 ${DEFAULT_MAX_ROUNDS} 轮上限：process.exit(10)
- 上述退出码将由 Scheduler 统一路由处理`;
}
