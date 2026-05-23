import fs from 'fs';
import path from 'path';
import type { RepoContext } from './repo-scanner.js';

export interface ModuleBoundary {
  dir: string;
  files: string[];
  imports: string[];
  exportedSymbols: string[];
}

export function extractModuleMap(ctx: RepoContext, repoRoot: string): ModuleBoundary[] {
  const pathAliases = new Map<string, string>();
  try {
    const tsconfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tsconfig.json'), 'utf-8'));
    const paths = tsconfig.compilerOptions?.paths ?? {};
    for (const [alias, targets] of Object.entries(paths) as [string, string[]][]) {
      const target = targets[0]?.replace('/*', '');
      if (target) pathAliases.set(alias.replace('/*', ''), target);
    }
  } catch {}

  const modules = new Map<string, ModuleBoundary>();
  for (const file of ctx.fileTree) {
    const parts = file.split('/');
    const moduleDir = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0]!;
    let mod = modules.get(moduleDir);
    if (!mod) {
      mod = { dir: moduleDir, files: [], imports: [], exportedSymbols: [] };
      modules.set(moduleDir, mod);
    }
    mod.files.push(file);

    try {
      const content = fs.readFileSync(path.join(repoRoot, file), 'utf-8');
      const importMatches = content.matchAll(/from\s+['"]([^'"]+)['"]/g);
      for (const m of importMatches) {
        if (!m[1]!.startsWith('.') && !m[1]!.startsWith('@parallelc')) {
          mod.imports.push(m[1]!);
        }
      }
      const exportMatches = content.matchAll(/export\s+(?:const|function|class|interface|type)\s+(\w+)/g);
      for (const m of exportMatches) {
        mod.exportedSymbols.push(m[1]!);
      }
    } catch {}
  }

  return [...modules.values()];
}
