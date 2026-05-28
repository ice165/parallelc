import fs from 'fs';
import { createHash } from 'crypto';

export type AuditEventType =
  | 'TASK_CREATED' | 'TASK_STARTED' | 'TASK_COMPLETED' | 'TASK_FAILED'
  | 'TASK_CANCELLED' | 'TASK_SLEEPING' | 'FILE_LOCK_ACQUIRED'
  | 'FILE_LOCK_RELEASED' | 'MERGE_AUTO' | 'MERGE_STRUCTURED'
  | 'MERGE_BLOCKED' | 'MERGE_CONFIRMED' | 'KEY_RATE_LIMITED'
  | 'KEY_RECOVERED' | 'COST_BUDGET_EXCEEDED' | 'GHOST_WORKER_DETECTED';

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

export class AuditLogger {
  private seq = 0;

  constructor(private logPath: string) {
    // Resume seq from existing file
    try {
      const existing = fs.readFileSync(logPath, 'utf-8').trim();
      if (existing) {
        this.seq = existing.split('\n').length;
      }
    } catch {
      // New file
    }
  }

  log(type: AuditEventType, data: Record<string, unknown> = {}): void {
    this.seq++;

    const ts = Date.now();
    const entry = { type, ...data };
    const checksum = createHash('sha256')
      .update(`${this.seq}:${ts}:${JSON.stringify(entry)}`)
      .digest('hex')
      .slice(0, 8);

    const record = JSON.stringify({ seq: this.seq, ts, entry, checksum });
    fs.appendFileSync(this.logPath, record + '\n');

    // Auto-archive: rename when >100MB
    try {
      const stat = fs.statSync(this.logPath);
      if (stat.size > MAX_FILE_SIZE) {
        const archive = this.logPath.replace('.log', `-${Date.now()}.log`);
        fs.renameSync(this.logPath, archive);
        this.seq = 0;
      }
    } catch { /* ignore stat errors */ }
  }

  close(): void {
    // No-op: appendFileSync writes immediately, no stream to close
  }
}
