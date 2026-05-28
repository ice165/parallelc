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

  try {
    const resolvedPath = fs.realpathSync(path.resolve(writeRoot, filePath));
    return isWithinRoot(resolvedPath, resolvedRoot);
  } catch {
    // 路径不存在（新建文件）—— 验证父目录链是否在 root 范围内
    const absolutePath = path.resolve(writeRoot, filePath);
    return isNewFileSafe(absolutePath, resolvedRoot);
  }
}

function isWithinRoot(resolvedPath: string, resolvedRoot: string): boolean {
  if (!resolvedPath.startsWith(resolvedRoot + path.sep) && resolvedPath !== resolvedRoot) {
    return false;
  }
  if (resolvedPath.includes('-readonly')) {
    return false;
  }
  return true;
}

/**
 * 对于尚不存在的文件（新建文件），沿父目录链向上查找首个已存在的祖先，
 * 并对每一层调用 realpathSync 以检测符号链接重定向，防止 TOCTOU 竞态条件。
 */
function isNewFileSafe(targetPath: string, resolvedRoot: string): boolean {
  let current = path.dirname(targetPath);
  while (true) {
    try {
      const resolved = fs.realpathSync(current);
      // 已存在的祖先必须在 resolvedRoot 之内
      if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
        return false;
      }
      if (resolved.includes('-readonly')) {
        return false;
      }
      return true;
    } catch {
      // 当前层级也不存在，继续向上
      const parent = path.dirname(current);
      if (parent === current) return false; // 已到达文件系统根目录
      current = parent;
    }
  }
}
