import { TASK_TABLE_DDL, VALID_STATUSES, ALLOWED_TRANSITIONS } from '../src/schema';

describe('TASK_TABLE_DDL', () => {
  test('包含 CREATE TABLE tasks 语句', () => {
    expect(TASK_TABLE_DDL).toContain('CREATE TABLE IF NOT EXISTS tasks');
  });

  test('包含所有关键字段', () => {
    expect(TASK_TABLE_DDL).toContain('status');
    expect(TASK_TABLE_DDL).toContain('version');
    expect(TASK_TABLE_DDL).toContain('expected_touch_files');
    expect(TASK_TABLE_DDL).toContain('modified_files');
    expect(TASK_TABLE_DDL).toContain('level');
    expect(TASK_TABLE_DDL).toContain('starvation_override');
    expect(TASK_TABLE_DDL).toContain('snapshot_version');
  });

  test('包含 4 个索引，其中 2 个为 partial index', () => {
    const indexCount = (TASK_TABLE_DDL.match(/CREATE INDEX/g) ?? []).length;
    expect(indexCount).toBe(4);
    expect(TASK_TABLE_DDL).toContain("WHERE status = 'SLEEP_PENDING'");
    expect(TASK_TABLE_DDL).toContain("WHERE status = 'MERGE_BLOCKED'");
  });
});

describe('VALID_STATUSES', () => {
  test('包含 9 个合法状态', () => {
    expect(VALID_STATUSES).toHaveLength(9);
  });

  test('包含 MERGE_BLOCKED', () => {
    expect(VALID_STATUSES).toContain('MERGE_BLOCKED');
  });
});

describe('ALLOWED_TRANSITIONS', () => {
  test('RUNNING 可转为 DONE', () => {
    expect(ALLOWED_TRANSITIONS['RUNNING']).toContain('DONE');
  });

  test('DONE 为终态，无可用转换', () => {
    expect(ALLOWED_TRANSITIONS['DONE']).toEqual([]);
  });

  test('READY 可转为 RUNNING', () => {
    expect(ALLOWED_TRANSITIONS['READY']).toContain('RUNNING');
  });
});
