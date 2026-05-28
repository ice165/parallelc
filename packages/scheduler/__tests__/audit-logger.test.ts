import { AuditLogger } from '../src/audit-logger';
import fs from 'fs';
import path from 'path';
import os from 'os';

let logDir: string;
let logger: AuditLogger;

beforeEach(() => {
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallelc-audit-'));
  logger = new AuditLogger(path.join(logDir, 'audit.log'));
});

afterEach(() => {
  logger.close();
  fs.rmSync(logDir, { recursive: true, force: true });
});

describe('AuditLogger', () => {
  test('写入一条日志条目', () => {
    logger.log('TASK_STARTED', { taskId: 'task-001', workerPid: 12345 });
    const content = fs.readFileSync(path.join(logDir, 'audit.log'), 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.entry.type).toBe('TASK_STARTED');
    expect(parsed.entry.taskId).toBe('task-001');
    expect(parsed.seq).toBe(1);
  });

  test('seq 递增', () => {
    logger.log('TASK_STARTED', { taskId: 't1' });
    logger.log('TASK_COMPLETED', { taskId: 't1' });
    const lines = fs.readFileSync(path.join(logDir, 'audit.log'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const seq1 = JSON.parse(lines[0]!).seq;
    const seq2 = JSON.parse(lines[1]!).seq;
    expect(seq2).toBe(seq1 + 1);
  });

  test('包含 CRC32 校验', () => {
    logger.log('TASK_FAILED', { taskId: 't1', reason: 'timeout' });
    const content = fs.readFileSync(path.join(logDir, 'audit.log'), 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.crc32).toBeDefined();
    expect(parsed.crc32).toHaveLength(8);
  });
});
