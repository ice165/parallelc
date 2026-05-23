import type { ChildProcess } from 'child_process';
import type { Task } from '@parallelc/shared';
import { KeyPool } from '@parallelc/keypool';
import { spawnWorker, spawnMcpWorker } from '@parallelc/worker';

export interface WorkerEntry {
  workerId: string;
  taskId: string;
  process: ChildProcess;
  startedAt: Date;
  writeRoot: string;
  apiKey: string;
}

export class WorkerPool {
  private workers = new Map<string, WorkerEntry>();
  private keyPool: KeyPool;

  constructor(apiKeys: string[], private maxWorkers: number = 4) {
    this.keyPool = new KeyPool(apiKeys);
  }

  get activeCount(): number {
    return this.workers.size;
  }

  hasCapacity(): boolean {
    return this.workers.size < this.maxWorkers;
  }

  getKeyPool(): KeyPool {
    return this.keyPool;
  }

  async spawn(task: Task, repoRoot: string): Promise<WorkerEntry> {
    if (!this.hasCapacity()) {
      throw new Error(`Worker pool full (${this.workers.size}/${this.maxWorkers})`);
    }

    const workerId = `worker-${task.id}`;
    const apiKey = this.keyPool.nextKey();

    // 1. 创建双 Worktree
    const result = await spawnWorker({
      workerId,
      expectedTouchFiles: task.expected_touch_files ?? [],
      repoRoot,
      apiKey,
    });

    // 2. 启动 MCP 子进程
    //    环境变量通过 spawnMcpWorker 内部 env 传递，
    //    validateWriteHook（Phase 1）从 process.env 读取 WORKER_ID / WORKER_WRITE_ROOT
    const childProcess = spawnMcpWorker(
      {
        apiKey,
        cwd: result.writeRoot,
        readonlyRoot: result.readonlyRoot,
      },
      {
        taskId: task.id,
        snapshotVersion: task.snapshot_version ?? 'unknown',
        dependencies: task.dependencies,
      },
    );

    const entry: WorkerEntry = {
      workerId,
      taskId: task.id,
      process: childProcess,
      startedAt: new Date(),
      writeRoot: result.writeRoot,
      apiKey,
    };

    this.workers.set(workerId, entry);
    return entry;
  }

  reap(): WorkerEntry[] {
    const exited: WorkerEntry[] = [];
    for (const [workerId, entry] of this.workers) {
      if (entry.process.exitCode !== null) {
        exited.push(entry);
        this.workers.delete(workerId);
      }
    }
    return exited;
  }

  kill(workerId: string): void {
    const entry = this.workers.get(workerId);
    if (entry) {
      entry.process.kill('SIGTERM');
      setTimeout(() => {
        if (entry.process.exitCode === null) {
          entry.process.kill('SIGKILL');
        }
      }, 5000);
    }
  }

  async shutdownAll(): Promise<void> {
    for (const [workerId] of this.workers) {
      this.kill(workerId);
    }
  }
}
