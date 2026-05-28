#!/usr/bin/env node

import { getDb, initializeSchema, queryTasksByStatus, casUpdateStatus } from '@parallelc/taskboard';
import { ceoBatchReview } from './batch-reviewer.js';

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

      switch (r.feedback.verdict) {
        case 'PASS':
          casUpdateStatus(db, r.taskId, task.version, 'REVIEW_PENDING', 'DONE');
          console.log(`  ${r.taskId}: PASS (score=${r.feedback.score})`);
          break;
        case 'REVISION':
          casUpdateStatus(db, r.taskId, task.version, 'REVIEW_PENDING', 'REVISION_NEEDED');
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

} else {
  console.log('ParallelC CEO v0.1.0');
  console.log('  review  --repo <path> --api-key <key> [--dag <id>]');
  console.log('  status  [--db <path>]');
  console.log('  confirm --task <id> [--verdict pass|revision]');
  process.exit(0);
}
