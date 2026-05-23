#!/usr/bin/env node

import Database from 'better-sqlite3';
import { queryTasksByStatus } from '@parallelc/taskboard';
import { startScheduler } from './dispatch-loop.js';

const command = process.argv[2];

if (command === 'start') {
  const args = process.argv.slice(3);
  const getArg = (name: string) => {
    const idx = args.indexOf(name);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const dbPath = getArg('--db') ?? '.parallelc/taskboard.db';
  const repoRoot = getArg('--repo');
  const apiKeysStr = getArg('--api-keys');
  const maxWorkers = parseInt(getArg('--max-workers') ?? '4', 10);

  if (!repoRoot) {
    console.error('Usage: parallelc-scheduler start --repo <path> [--db <path>] [--api-keys <keys>] [--max-workers <n>]');
    process.exit(1);
  }

  if (!apiKeysStr) {
    console.error('Error: --api-keys is required (comma-separated Anthropic API keys)');
    process.exit(1);
  }

  const apiKeys = apiKeysStr.split(',').map((k) => k.trim());

  startScheduler({ dbPath, repoRoot, apiKeys, maxWorkers });

} else if (command === 'status') {
  const dbPath = process.argv.slice(3).find((a) => a.startsWith('--db='))
    ?.split('=')[1] ?? '.parallelc/taskboard.db';

  try {
    const db = new Database(dbPath, { readonly: true });
    db.pragma('journal_mode = WAL');

    const statuses = [
      'RUNNING' as const, 'SLEEP_PENDING' as const,
      'READY' as const, 'PENDING' as const,
      'DONE' as const, 'FAILED' as const,
    ];

    const counts: Record<string, number> = {};
    for (const s of statuses) {
      counts[s] = queryTasksByStatus(db, s).length;
    }

    console.log(`Tick: - | Pool: -/${counts['RUNNING']} | Ready: ${counts['READY']} | Running: ${counts['RUNNING']} | Sleep: ${counts['SLEEP_PENDING']} | Done: ${counts['DONE']} | Failed: ${counts['FAILED']}`);
    console.log('─'.repeat(80));

    // RUNNING 任务明细
    const running = queryTasksByStatus(db, 'RUNNING');
    if (running.length > 0) {
      console.log('RUNNING');
      for (const t of running) {
        const elapsed = Math.floor((Date.now() - new Date(t.updated_at).getTime()) / 1000);
        console.log(`  worker-${t.id.padEnd(20)} ${t.id.padEnd(20)} ${elapsed}s`);
      }
    }

    // SLEEP_PENDING 明细
    const sleeping = queryTasksByStatus(db, 'SLEEP_PENDING');
    if (sleeping.length > 0) {
      console.log('SLEEP_PENDING');
      for (const t of sleeping) {
        console.log(`  ${t.id.padEnd(20)} 429 rate-limit  唤醒: ${t.sleep_until ?? 'unknown'}`);
      }
    }

    // READY 明细
    const ready = queryTasksByStatus(db, 'READY');
    if (ready.length > 0) {
      console.log(`READY（待派发: ${ready.length}）`);
      for (const t of ready) {
        const waited = t.ready_at
          ? Math.floor((Date.now() - new Date(t.ready_at).getTime()) / 1000)
          : 0;
        console.log(`  ${t.id.padEnd(20)} 等待: ${waited}s`);
      }
    }

    // 最近 FAILED
    const failed = queryTasksByStatus(db, 'FAILED', 'updated_at DESC');
    if (failed.length > 0) {
      console.log('FAILED（最近 3 条）');
      for (const t of failed.slice(0, 3)) {
        console.log(`  ${t.id.padEnd(20)} ${t.updated_at}`);
      }
    }

    db.close();
  } catch (err) {
    console.error('Error reading taskboard:', (err as Error).message);
    process.exit(1);
  }

} else {
  console.log('ParallelC Scheduler v0.1.0');
  console.log('  start  --repo <path> --api-keys <keys> [--db <path>] [--max-workers <n>]');
  console.log('  status [--db <path>]');
  process.exit(0);
}
