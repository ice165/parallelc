#!/usr/bin/env node

import { getDb, initializeSchema } from '@parallelc/taskboard';
import { scanRepoContext } from './pre-process/repo-scanner.js';
import { extractModuleMap } from './pre-process/module-map.js';
import { buildDAG } from './dag-builder.js';
import { confirmL3Tasks } from './post-validate/l3-confirm.js';
import { getPredictionAccuracy } from './metrics-collector.js';

const command = process.argv[2];

if (command === 'decompose') {
  const args = process.argv.slice(3);
  const getArg = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i+1] : undefined; };
  const userRequest = args.find(a => !a.startsWith('--'));
  const repoRoot = getArg('--repo') ?? process.cwd();
  const apiKey = getArg('--api-key') ?? process.env['ANTHROPIC_API_KEY'];
  const dbPath = getArg('--db') ?? '.parallelc/taskboard.db';

  if (!userRequest || !apiKey) {
    console.error('Usage: parallelc-orchestrate decompose <request> --repo <path> --api-key <key>');
    process.exit(1);
  }

  const db = getDb(dbPath);
  initializeSchema(db);

  const repoContext = scanRepoContext(repoRoot, db);
  const moduleMap = extractModuleMap(repoContext, repoRoot);

  console.log(`[Orchestrator] Scanned ${repoContext.fileTree.length} files, ${moduleMap.length} modules`);

  buildDAG(
    { userRequest, repoContext, moduleMap },
    { repoRoot, dbPath, apiKey },
  ).then(result => {
    if (result.error) {
      console.error(`[Orchestrator] Failed: ${result.error}`);
      process.exit(1);
    }

    console.log(`[Orchestrator] Validated: ${result.tasksCreated} L2, ${result.l3Pending} L3 pending, ${result.l1Executed} L1 executed`);
    console.log(`[Orchestrator] DAG ${result.dagId} written to TaskBoard`);
    console.log(`\nSummary: ${result.summary}`);

    if (result.l3PendingTasks.length > 0) {
      console.log(`\nPending L3 tasks (${result.l3Pending}):`);
      for (const l3 of result.l3PendingTasks) {
        console.log(`  npx parallelc-orchestrate confirm --dag ${result.dagId} --task ${l3.taskId}`);
        console.log(`    ${l3.taskTitle}`);
      }
    }

    db.close();
  });

} else if (command === 'confirm') {
  const args = process.argv.slice(3);
  const getArg = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i+1] : undefined; };
  const dagId = getArg('--dag');
  const taskId = getArg('--task');
  const dbPath = getArg('--db') ?? '.parallelc/taskboard.db';

  if (!dagId || !taskId) {
    console.error('Usage: parallelc-orchestrate confirm --dag <id> --task <id>');
    process.exit(1);
  }

  const db = getDb(dbPath);
  const count = confirmL3Tasks(db, dagId, [taskId]);
  console.log(`[Orchestrator] Confirmed ${count} L3 task(s) (PENDING -> READY)`);
  db.close();

} else if (command === 'accuracy') {
  const dbPath = process.argv.slice(3).find(a => a.startsWith('--db='))?.split('=')[1] ?? '.parallelc/taskboard.db';
  const db = getDb(dbPath);
  const { overall, details } = getPredictionAccuracy(db);
  console.log(`Prediction accuracy: ${(overall * 100).toFixed(1)}% (${details.length} records)`);
  for (const d of details.slice(0, 10)) {
    const acc = d.accuracy !== null ? `${(d.accuracy * 100).toFixed(0)}%` : 'pending';
    console.log(`  ${d.taskId}  expected=${d.expectedFiles.length} actual=${d.actualFiles?.length ?? '?'} accuracy=${acc}`);
  }
  db.close();

} else {
  console.log('ParallelC Orchestrator v0.1.0');
  console.log('  decompose <request> --repo <path> --api-key <key>');
  console.log('  confirm --dag <id> --task <id>');
  console.log('  accuracy [--db <path>]');
  process.exit(0);
}
