import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export class GitDiffFallback {
  getFallback(repoRoot: string): string[] {
    try {
      const result = execSync('git diff --name-only HEAD', {
        cwd: repoRoot, encoding: 'utf-8', timeout: 5000,
      }).trim();
      if (result) return result.split('\n').filter(f => f.length > 0);
    } catch {
      // git unavailable, fall back to enumeration
    }

    return this.enumerateSrcFiles(repoRoot);
  }

  private enumerateSrcFiles(repoRoot: string): string[] {
    const files: string[] = [];
    const srcDir = path.join(repoRoot, 'src');
    if (!fs.existsSync(srcDir)) return files;

    const walk = (dir: string) => {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else files.push(path.relative(repoRoot, full).replace(/\\/g, '/'));
        }
      } catch { /* skip unreadable */ }
    };
    walk(srcDir);
    return files;
  }
}
