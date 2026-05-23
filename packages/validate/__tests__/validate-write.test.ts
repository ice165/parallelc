import { isWriteAllowed } from '../src/validate-write';
import path from 'path';
import fs from 'fs';
import os from 'os';

let writeRoot: string;
let readonlyRoot: string;

beforeEach(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallelc-validate-'));
  writeRoot = path.join(tmpDir, 'w1-write');
  readonlyRoot = path.join(tmpDir, 'w1-readonly');
  fs.mkdirSync(writeRoot, { recursive: true });
  fs.mkdirSync(readonlyRoot, { recursive: true });
});

describe('isWriteAllowed', () => {
  test('允许在写区内写入绝对路径', () => {
    expect(isWriteAllowed(path.join(writeRoot, 'src/a.ts'), 'w1', writeRoot)).toBe(true);
  });

  test('拒绝写入只读区', () => {
    expect(isWriteAllowed(path.join(readonlyRoot, 'src/a.ts'), 'w1', writeRoot)).toBe(false);
  });

  test('允许相对路径（以 writeRoot 为基准解析）', () => {
    expect(isWriteAllowed('src/a.ts', 'w1', writeRoot)).toBe(true);
  });
});
