import fs from 'fs';
import path from 'path';

export interface AstConflict {
  file: string;
  line: number;
  message: string;
}

export function detectAstConflicts(
  files: string[],
  repoRoot: string,
): AstConflict[] {
  const conflicts: AstConflict[] = [];

  for (const file of files) {
    const fullPath = path.join(repoRoot, file);
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.startsWith('<<<<<<<') || line.startsWith('=======') || line.startsWith('>>>>>>>')) {
          conflicts.push({ file, line: i + 1, message: 'Unresolved merge conflict marker' });
        }
      }

      // Detect duplicate exports
      const exportMatches = content.match(/export\s+(?:const|function|class|interface|type)\s+(\w+)/g) ?? [];
      const nameCounts = new Map<string, number>();
      for (const m of exportMatches) {
        const name = m.split(/\s+/)[2]!;
        nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
      }
      for (const [name, count] of nameCounts) {
        if (count > 1) {
          conflicts.push({ file, line: 1, message: `Duplicate export: ${name} (${count} occurrences)` });
        }
      }
    } catch {
      // file unreadable, skip
    }
  }

  return conflicts;
}
