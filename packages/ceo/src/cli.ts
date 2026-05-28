#!/usr/bin/env node

import { getDb, initializeSchema, queryTasksByStatus, casUpdateStatus } from '@parallelc/taskboard';
import { ceoBatchReview } from './batch-reviewer.js';
import { intakeRequirement } from './requirement-intake.js';

const command = process.argv[2];

if (command === 'review') {
  const args = process.argv.slice(3);
  const getArg = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i+1] : undefined; };
  const dagId = getArg('--dag');
  const dbPath = getArg('--db') ?? '.parallelc/taskboard.db';
  const repoRoot = getArg('--repo') ?? process.cwd();
  const apiKey = getArg('--api-key') ?? process.env['ANTHROPIC_API_KEY'];

  if (!apiKey) {
    console.error('Usage: parallelc-ceo review --repo <path> --api-key <key> [--dag <id>] [--db <path>]');
    process.exit(1);
  }

  const db = getDb(dbPath);
  initializeSchema(db);

  ceoBatchReview(db, repoRoot, apiKey, 70, 0.6, 10, '').then(result => {
    console.log(`CEO Review: ${result.passed} passed, ${result.revision} revision, ${result.escalated} escalated, ${result.skipped} skipped`);
    console.log(`Total cost: $${result.totalCost.toFixed(4)}`);

    for (const r of result.results) {
      const task = queryTasksByStatus(db, 'REVIEW_PENDING').find(t => t.id === r.taskId);
      if (!task) continue;

      // CAS retry: re-query if version changed (e.g., scheduler also processing)
      let updated = false;
      const toStatus = r.feedback.verdict === 'PASS' ? 'DONE' as const
        : r.feedback.verdict === 'REVISION' ? 'REVISION_NEEDED' as const
        : 'CEO_ESCALATED' as const;

      for (let retry = 0; retry < 2 && !updated; retry++) {
        const current = retry === 0 ? task
          : queryTasksByStatus(db, 'REVIEW_PENDING').find(t => t.id === r.taskId);
        if (!current) break;
        updated = casUpdateStatus(db, r.taskId, current.version, 'REVIEW_PENDING', toStatus);
      }
      if (!updated) {
        console.log(`  ${r.taskId}: skipped (version conflict)`);
        continue;
      }

      switch (r.feedback.verdict) {
        case 'PASS':
          console.log(`  ${r.taskId}: PASS (score=${r.feedback.score})`);
          break;
        case 'REVISION':
          console.log(`  ${r.taskId}: REVISION (score=${r.feedback.score}) — ${r.feedback.summary}`);
          break;
        case 'ESCALATE':
          casUpdateStatus(db, r.taskId, task.version, 'REVIEW_PENDING', 'CEO_ESCALATED');
          console.log(`  ${r.taskId}: ESCALATED (score=${r.feedback.score}) — ${r.feedback.summary}`);
          break;
      }
    }

    db.close();
  });

} else if (command === 'status') {
  const dbPath = process.argv.slice(3).find(a => a.startsWith('--db='))?.split('=')[1] ?? '.parallelc/taskboard.db';
  const db = getDb(dbPath);

  const reviewPending = queryTasksByStatus(db, 'REVIEW_PENDING');
  const revisionNeeded = queryTasksByStatus(db, 'REVISION_NEEDED');
  const escalated = queryTasksByStatus(db, 'CEO_ESCALATED');

  console.log('CEO Review Status:');
  console.log(`  REVIEW_PENDING:  ${reviewPending.length}`);
  console.log(`  REVISION_NEEDED: ${revisionNeeded.length}`);
  console.log(`  CEO_ESCALATED:   ${escalated.length}`);

  if (escalated.length > 0) {
    console.log('\nEscalated tasks:');
    for (const t of escalated) {
      console.log(`  ${t.id}: ${t.title} (score=${t.ceo_score}, iteration=${t.ceo_iteration})`);
    }
  }

  db.close();

} else if (command === 'confirm') {
  const args = process.argv.slice(3);
  const getArg = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i+1] : undefined; };
  const taskId = getArg('--task');
  const verdict = getArg('--verdict') ?? 'pass';
  const dbPath = getArg('--db') ?? '.parallelc/taskboard.db';

  if (!taskId) {
    console.error('Usage: parallelc-ceo confirm --task <id> [--verdict pass|revision]');
    process.exit(1);
  }

  const db = getDb(dbPath);
  const tasks = queryTasksByStatus(db, 'CEO_ESCALATED');
  const task = tasks.find(t => t.id === taskId);

  if (!task) {
    console.error(`Task ${taskId} not found or not in CEO_ESCALATED state`);
    process.exit(1);
  }

  const toStatus = verdict === 'pass' ? 'DONE' : 'READY';
  casUpdateStatus(db, taskId, task.version, 'CEO_ESCALATED', toStatus);
  console.log(`Task ${taskId}: CEO_ESCALATED → ${toStatus}`);
  db.close();

} else if (command === 'intake') {
  const args = process.argv.slice(3);
  const userRequest = args.find(a => !a.startsWith('--'));
  const interactive = args.includes('--interactive');

  if (!userRequest) {
    console.error('Usage: parallelc-ceo intake <requirement> [--interactive]');
    process.exit(1);
  }

  const result = intakeRequirement(userRequest);
  console.log(`[CEO] Clarity score: ${result.clarity.score}/100 (zone: ${result.clarity.zone})`);

  if (result.phase === 'CLARIFY') {
    console.log('\n需求不够清晰，请补充以下信息：');
    for (const q of result.clarifyingQuestions) {
      console.log(`  - ${q}`);
    }
    if (interactive) {
      console.log('\n请逐项补充（输入空行结束）：');
      // In interactive mode, we'd read stdin. For now, suggest re-running with clarifications.
      console.log('  使用: parallelc-ceo intake "原需求 + 补充说明"');
    }
    process.exit(0);
  }

  console.log('\n' + result.spec);
  console.log(`\n[CEO] 方案就绪，可交给 Orchestrator 拆解执行。`);

} else {
  console.log('ParallelC CEO v0.1.0');
  console.log('  intake   <requirement> [--interactive]   需求确认与方案生成');
  console.log('  review   --repo <path> --api-key <key>   批量审查 Worker 产出');
  console.log('  status   [--db <path>]                   查看审查状态');
  console.log('  confirm  --task <id> [--verdict pass]    确认 ESCALATED 任务');
  process.exit(0);
}
