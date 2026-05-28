import fs from 'fs';
import path from 'path';

export class StaticAnalyzer {
  analyze(targetFiles: string[], repoRoot: string): string[] {
    if (targetFiles.length === 0) return [];

    const affected = new Set<string>(targetFiles);
    const importRe = /(?:import|from)\s+['"]([^'"]+)['"]/g;

    for (const file of targetFiles) {
      const fullPath = path.join(repoRoot, file);
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        let match: RegExpExecArray | null;
        while ((match = importRe.exec(content)) !== null) {
          const importPath = match[1]!;
          if (importPath.startsWith('.')) {
            const resolved = path.normalize(path.join(path.dirname(file), importPath));
            const extensions = ['.ts', '.js', '.tsx', '.jsx', ''];
            const found = extensions
              .map(ext => resolved + ext)
              .find(f => {
                try { fs.accessSync(path.join(repoRoot, f)); return true; } catch { return false; }
              });
            if (found) {
              affected.add(found.replace(/\\/g, '/'));
            }
          }
        }
      } catch {
        // file unreadable, skip
      }
    }

    // Expand by 10% for indirect dependencies
    const base = [...affected];
    const expansion = Math.ceil(base.length * 0.1);
    return [...base, ...base.slice(0, expansion)];
  }
}
