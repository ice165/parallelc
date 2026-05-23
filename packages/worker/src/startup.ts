import fs from 'fs';
import type { StartupCheckOptions, StartupCheckResult } from '@parallelc/shared';

export function parseProjectContextHeader(content: string): {
  snapshotVersion: string;
  generatedAt: string;
  status: string;
} | null {
  const snapshotMatch = content.match(/^snapshot_version:\s*(.+)$/m);
  const generatedMatch = content.match(/^generated_at:\s*(.+)$/m);
  const statusMatch = content.match(/^status:\s*(.+)$/m);

  if (!snapshotMatch || !generatedMatch) {
    return null;
  }

  return {
    snapshotVersion: snapshotMatch[1]!.trim(),
    generatedAt: generatedMatch[1]!.trim(),
    status: statusMatch?.[1]?.trim() ?? 'FROZEN',
  };
}

export function verifySnapshotVersion(
  opts: StartupCheckOptions,
): StartupCheckResult {
  const warnings: string[] = [];

  if (!fs.existsSync(opts.projectContextPath)) {
    warnings.push('project_context.md not found');
    return {
      versionMatch: false,
      contextMismatch: true,
      actualVersion: null,
      warnings,
    };
  }

  const content = fs.readFileSync(opts.projectContextPath, 'utf-8');
  const header = parseProjectContextHeader(content);

  if (!header) {
    warnings.push('project_context.md header is malformed');
    return {
      versionMatch: false,
      contextMismatch: true,
      actualVersion: null,
      warnings,
    };
  }

  const versionMatch = header.snapshotVersion === opts.snapshotVersion;

  if (!versionMatch) {
    warnings.push(
      `Snapshot version mismatch: task=${opts.snapshotVersion}, context=${header.snapshotVersion}`,
    );
  }

  if (header.status !== 'FROZEN') {
    warnings.push(
      `project_context.md status is not FROZEN: ${header.status}`,
    );
  }

  return {
    versionMatch,
    contextMismatch: !versionMatch || header.status !== 'FROZEN',
    actualVersion: header.snapshotVersion,
    warnings,
  };
}
