import fs from 'fs';
import path from 'path';
import type { RepoContext } from '../pre-process/repo-scanner.js';
import type { ModuleBoundary } from '../pre-process/module-map.js';

export interface PathValidation {
  valid: string[];
  invalid: string[];
  withWarnings: string[];
}

export function validatePaths(
  files: string[],
  repoContext: RepoContext,
  moduleMap: ModuleBoundary[],
  repoRoot?: string,
): PathValidation {
  const result: PathValidation = { valid: [], invalid: [], withWarnings: [] };
  const moduleDirs = new Set(moduleMap.map(m => m.dir));

  for (const f of files) {
    const fullPath = repoRoot ? path.join(repoRoot, f) : f;

    if (repoRoot && fs.existsSync(fullPath)) {
      result.valid.push(f);
    } else if (repoRoot && !fs.existsSync(fullPath)) {
      const parentDir = path.dirname(fullPath);
      if (fs.existsSync(parentDir)) {
        result.valid.push(f);
      } else {
        result.invalid.push(f);
      }
    } else {
      result.valid.push(f);
    }

    if (repoRoot) {
      const modDir = f.split('/').slice(0, 2).join('/');
      if (!moduleDirs.has(modDir) && moduleDirs.size > 0) {
        if (!result.withWarnings.includes(f)) {
          result.withWarnings.push(f);
        }
      }
    }
  }

  return result;
}
