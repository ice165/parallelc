import { isWriteAllowed } from '../src/validate-write';
import path from 'path';
import fs from 'fs';
import os from 'os';

let writeRoot: string;
let readonlyRoot: string;

beforeEach(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallelc-traversal-'));
  writeRoot = path.join(tmpDir, 'w1-write');
  readonlyRoot = path.join(tmpDir, 'w1-readonly');
  fs.mkdirSync(writeRoot, { recursive: true });
  fs.mkdirSync(readonlyRoot, { recursive: true });
  fs.writeFileSync(path.join(readonlyRoot, 'secret.ts'), 'secret');
});

describe('路径穿越防御', () => {
  test('.. 穿越到只读区被拦截', () => {
    const traversalPath = path.join(writeRoot, '..', 'w1-readonly', 'secret.ts');
    expect(isWriteAllowed(traversalPath, 'w1', writeRoot)).toBe(false);
  });

  test('多级 .. 穿越被拦截', () => {
    const traversalPath = path.join(writeRoot, 'a', '..', '..', 'w1-readonly', 'secret.ts');
    expect(isWriteAllowed(traversalPath, 'w1', writeRoot)).toBe(false);
  });

  test('路径包含 -readonly 被拦截', () => {
    const trickyPath = path.join(writeRoot, 'subdir-w1-readonly-etc', 'file.ts');
    expect(isWriteAllowed(trickyPath, 'w1', writeRoot)).toBe(false);
  });

  test('新建文件（路径不存在）在写区内允许', () => {
    const newFilePath = path.join(writeRoot, 'new-dir', 'new-file.ts');
    expect(isWriteAllowed(newFilePath, 'w1', writeRoot)).toBe(true);
  });
});
