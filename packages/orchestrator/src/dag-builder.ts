import Database from 'better-sqlite3';
import { createTask, getDb, initializeSchema, queryTasksByStatus } from '@parallelc/taskboard';
import { scanRepoContext } from './pre-process/repo-scanner.js';
import { extractModuleMap } from './pre-process/module-map.js';
import { type DecompositionInput } from './decompose/prompt-builder.js';
import { decomposeViaClaude } from './decompose/mcp-decomposer.js';
import { enforceHardRules } from './post-validate/rule-engine.js';
import { validatePaths } from './post-validate/path-validator.js';
import { validateDAG } from './post-validate/dag-validator.js';
import { executeL1Directly } from './post-validate/l1-executor.js';
import { recordPrediction } from './metrics-collector.js';
import type { L3Confirmation } from './post-validate/l3-confirm.js';

export interface BuildDagOptions {
  repoRoot: string;
  dbPath: string;
  apiKey: string;
  maxRetries?: number;
  confirmL3?: boolean;
  onRetry?: (retryCount: number, reason: string) => void;
}

export interface BuildDagResult {
  dagId: string;
  summary: string;
  tasksCreated: number;
  l1Executed: number;
  l1Skipped: number;
  l3Pending: number;
  l3PendingTasks: L3Confirmation[];
  failedTasks: number;
  error: string | null;
  tokensUsed: number;
  retries: number;
  cached: boolean;
}

export async function buildDAG(
  input: DecompositionInput,
  opts: BuildDagOptions,
): Promise<BuildDagResult> {
  const maxRetries = opts.maxRetries ?? 2;
  let retries = 0;
  let lastError: Error | null = null;
  let l3PendingTasks: L3Confirmation[] = [];

  const db = getDb(opts.dbPath);
  initializeSchema(db);

  // 1. Pre-process
  const repoContext = scanRepoContext(opts.repoRoot, db);
  const moduleMap = extractModuleMap(repoContext, opts.repoRoot);
  const fullInput: DecompositionInput = {
    userRequest: input.userRequest,
    repoContext,
    moduleMap,
  };

  // 2. LLM Decompose (with retry)
  let decomposerResult = await decomposeViaClaude(fullInput, { apiKey: opts.apiKey });
  while (!decomposerResult.parsed && retries < maxRetries) {
    retries++;
    lastError = new Error(`LLM decomposition failed (attempt ${retries})`);
    opts.onRetry?.(retries, lastError.message);
    decomposerResult = await decomposeViaClaude(fullInput, { apiKey: opts.apiKey });
  }

  if (!decomposerResult.parsed) {
    return {
      dagId: '', summary: '', tasksCreated: 0, l1Executed: 0, l1Skipped: 0,
      l3Pending: 0, l3PendingTasks: [], failedTasks: 0,
      error: `Failed after ${retries} retries: ${lastError?.message ?? 'parse error'}`,
      tokensUsed: decomposerResult.tokensUsed, retries, cached: decomposerResult.cached,
    };
  }

  // 3. Validation
  const dagId = `dag-${Date.now()}`;
  let tasksCreated = 0;
  let l1Executed = 0;
  let l1Skipped = 0;
  let l3Pending = 0;
  let failedTasks = 0;

  // DAG topology
  const dagCheck = validateDAG(decomposerResult.parsed);
  if (!dagCheck.acyclic) {
    return {
      dagId, summary: '', tasksCreated: 0, l1Executed: 0, l1Skipped: 0,
      l3Pending: 0, l3PendingTasks: [], failedTasks: decomposerResult.parsed.length,
      error: 'DAG validation failed: circular dependencies detected',
      tokensUsed: decomposerResult.tokensUsed, retries, cached: decomposerResult.cached,
    };
  }

  // Path validation
  const allFiles = decomposerResult.parsed.flatMap(t => t.expected_touch_files);
  const pathCheck = validatePaths(allFiles, repoContext, moduleMap, opts.repoRoot);
  if (pathCheck.invalid.length > 0) {
    return {
      dagId, summary: '', tasksCreated: 0, l1Executed: 0, l1Skipped: 0,
      l3Pending: 0, l3PendingTasks: [], failedTasks: pathCheck.invalid.length,
      error: `Path validation failed: ${pathCheck.invalid.join(', ')}`,
      tokensUsed: decomposerResult.tokensUsed, retries, cached: decomposerResult.cached,
    };
  }

  // Build lock set from active tasks
  const lockedFiles = new Set<string>();
  const running = queryTasksByStatus(db, ['RUNNING', 'SLEEP_PENDING']);
  for (const t of running) {
    for (const f of t.expected_touch_files ?? []) lockedFiles.add(f);
  }

  // 4. Process each task draft
  for (const draft of decomposerResult.parsed) {
    const rule = enforceHardRules(draft, repoContext, opts.repoRoot);

    switch (rule.action) {
      case 'DIRECT_EXECUTE': {
        const result = await executeL1Directly(draft, opts.repoRoot, opts.apiKey, lockedFiles);
        if (result.success) l1Executed++;
        else l1Skipped++;
        break;
      }
      case 'HUMAN_CONFIRM': {
        const task = createTask(db, {
          id: `task-${dagId}-${String(tasksCreated + 1).padStart(3, '0')}`,
          title: draft.title,
          expected_touch_files: draft.expected_touch_files,
          level: 'L3',
          snapshot_version: dagId,
        });
        l3Pending++;
        l3PendingTasks.push({
          taskId: task.id,
          taskTitle: draft.title,
          reason: rule.warnings.join('; '),
          files: draft.expected_touch_files,
        });
        recordPrediction(db, task.id, draft.expected_touch_files);
        tasksCreated++;
        break;
      }
      case 'CREATE_TASK': {
        const task = createTask(db, {
          id: `task-${dagId}-${String(tasksCreated + 1).padStart(3, '0')}`,
          title: draft.title,
          expected_touch_files: draft.expected_touch_files,
          level: rule.level,
          snapshot_version: dagId,
        });
        recordPrediction(db, task.id, draft.expected_touch_files);
        tasksCreated++;
        break;
      }
    }
  }

  return {
    dagId,
    summary: `${tasksCreated} tasks created`,
    tasksCreated, l1Executed, l1Skipped, l3Pending, l3PendingTasks,
    failedTasks, error: null,
    tokensUsed: decomposerResult.tokensUsed, retries, cached: decomposerResult.cached,
  };
}
