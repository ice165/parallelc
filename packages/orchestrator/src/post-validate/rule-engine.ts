import type { TaskLevel } from '@parallelc/shared';
import type { TaskDraft } from '../decompose/response-parser.js';
import type { RepoContext } from '../pre-process/repo-scanner.js';
import { estimateTokens, type TokenEstimate } from '../pre-process/token-estimator.js';

export interface RuleResult {
  passed: boolean;
  level: TaskLevel;
  warnings: string[];
  action: 'CREATE_TASK' | 'DIRECT_EXECUTE' | 'HUMAN_CONFIRM';
  tokenEstimate?: TokenEstimate;
}

export function enforceHardRules(
  task: TaskDraft,
  repoContext: RepoContext,
  repoRoot: string,
): RuleResult {
  const warnings: string[] = [];
  const files = task.expected_touch_files;
  const tokenEst = estimateTokens(files, repoRoot);

  const newFiles = files.filter(f => !repoContext.fileTree.includes(f));
  const dirs = new Set(files.map(f => f.split('/').slice(0, 2).join('/')));
  const sameDir = dirs.size <= 1;
  const crossModule = files.some(f => {
    const modDir = f.split('/').slice(0, 2).join('/');
    return !repoContext.moduleDirs.includes(modDir) && repoContext.moduleDirs.length > 0;
  });

  let actualLevel: TaskLevel = 'L1';
  let action: RuleResult['action'] = 'DIRECT_EXECUTE';

  if (files.length > 10 || tokenEst.estimatedTokens > 50000) {
    actualLevel = 'L3';
    action = 'HUMAN_CONFIRM';
    warnings.push(`Files=${files.length}, tokens=${tokenEst.estimatedTokens} -> L3`);
  } else if (files.length >= 3 || !sameDir || newFiles.length > 0 || crossModule || tokenEst.estimatedTokens >= 10000) {
    actualLevel = 'L2';
    action = 'CREATE_TASK';
  }

  const levelOrder: Record<TaskLevel, number> = { L1: 0, L2: 1, L3: 2 };
  const finalLevel = levelOrder[task.level] > levelOrder[actualLevel] ? task.level : actualLevel;

  if (levelOrder[task.level] > levelOrder[actualLevel]) {
    warnings.push(`LLM marked ${task.level}, actual minimum ${actualLevel} - kept LLM level`);
    action = task.level === 'L2' ? 'CREATE_TASK' : 'HUMAN_CONFIRM';
  }

  return {
    passed: warnings.filter(w => !w.includes('kept LLM level')).length === 0,
    level: finalLevel,
    warnings,
    action,
    tokenEstimate: tokenEst,
  };
}
