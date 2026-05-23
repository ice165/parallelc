import fs from 'fs';
import path from 'path';

/**
 * 判断写入操作是否允许。
 * 关键：对 filePath 先与 writeRoot 拼接后再规范化（path.resolve(writeRoot, filePath)），
 * 确保相对路径以 writeRoot 为基准解析，而非 CWD。
 */
export function isWriteAllowed(
  filePath: string,
  _workerId: string,
  writeRoot: string,
): boolean {
  const resolvedRoot = fs.realpathSync(writeRoot);
  let resolvedPath: string;

  try {
    resolvedPath = fs.realpathSync(path.resolve(writeRoot, filePath));
  } catch {
    // 路径不存在时（如新建文件），回退到 resolve
    resolvedPath = path.resolve(writeRoot, filePath);
  }

  if (
    !resolvedPath.startsWith(resolvedRoot + path.sep) &&
    resolvedPath !== resolvedRoot
  ) {
    return false;
  }

  if (resolvedPath.includes('-readonly')) {
    return false;
  }

  return true;
}
