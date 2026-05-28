import Database from 'better-sqlite3';
import type { Task, CeoReviewInput, CeoReviewResult } from '@parallelc/shared';
import { queryTasksByStatus } from '@parallelc/taskboard';
import { ceoReview } from './ceo-agent.js';
import { shouldReview } from './iteration-tracker.js';

export interface BatchReviewResult {
  reviewed: number;
  passed: number;
  revision: number;
  escalated: number;
  skipped: number;
  totalCost: number;
  results: CeoReviewResult[];
}

function getTaskDiff(repoRoot: string): string {
  try {
    const { execSync } = require('child_process');
    return execSync('git diff HEAD', {
      cwd: repoRoot, encoding: 'utf-8', timeout: 10_000,
    });
  } catch {
    return '(diff unavailable)';
  }
}

export async function ceoBatchReview(
  db: Database.Database,
  repoRoot: string,
  apiKey: string,
  clarityScore: number,
  f1BetaAvg: number,
  remainingCeoBudget: number,
  userRequest: string,
): Promise<BatchReviewResult> {
  const reviewTasks = queryTasksByStatus(db, 'REVIEW_PENDING');
  const batchResult: BatchReviewResult = {
    reviewed: 0, passed: 0, revision: 0, escalated: 0, skipped: 0,
    totalCost: 0, results: [],
  };

  for (const task of reviewTasks) {
    if (!shouldReview(task, clarityScore, f1BetaAvg, remainingCeoBudget)) {
      batchResult.skipped++;
      batchResult.results.push({
        taskId: task.id,
        feedback: {
          verdict: 'PASS', score: 100,
          summary: 'Auto-passed (CEO review skipped)',
          gaps: [], excess: [], sideEffects: [], suggestions: [],
        },
        model: 'sonnet', tokensUsed: 0, cost: 0,
      });
      continue;
    }

    const diff = getTaskDiff(repoRoot);
    const input: CeoReviewInput = {
      userRequest,
      taskTitle: task.title,
      taskReasoning: '',
      diff,
      modifiedFiles: task.modified_files ?? [],
      iteration: task.ceo_iteration,
    };

    const result = await ceoReview(input, task.id, {
      apiKey,
      level: task.level,
    });

    batchResult.results.push(result);
    batchResult.totalCost += result.cost;
    batchResult.reviewed++;

    switch (result.feedback.verdict) {
      case 'PASS': batchResult.passed++; break;
      case 'REVISION': batchResult.revision++; break;
      case 'ESCALATE': batchResult.escalated++; break;
    }
  }

  return batchResult;
}
