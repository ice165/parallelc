import type { TaskLevel } from '@parallelc/shared';

export interface TaskDraft {
  title: string;
  level: TaskLevel;
  expected_touch_files: string[];
  dependencies: string[];
  reasoning: string;
}

const VALID_LEVELS = new Set(['L1', 'L2', 'L3']);

export function parseTaskDAG(raw: string): { dagId: string; summary: string; tasks: TaskDraft[] } | null {
  const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const jsonStr = codeBlockMatch?.[1]?.trim() ?? raw.trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  if (typeof parsed['dagId'] !== 'string' || typeof parsed['summary'] !== 'string' || !Array.isArray(parsed['tasks'])) {
    return null;
  }

  const tasks: TaskDraft[] = [];
  for (const t of parsed['tasks'] as Record<string,unknown>[]) {
    const level = t['level'] as string;
    if (!VALID_LEVELS.has(level)) return null;
    if (typeof t['title'] !== 'string') return null;
    if (!Array.isArray(t['expected_touch_files'])) return null;
    if (!Array.isArray(t['dependencies'])) return null;

    tasks.push({
      title: t['title'],
      level: level as TaskLevel,
      expected_touch_files: t['expected_touch_files'] as string[],
      dependencies: t['dependencies'] as string[],
      reasoning: (t['reasoning'] as string) ?? '',
    });
  }

  return { dagId: parsed['dagId'], summary: parsed['summary'] as string, tasks };
}
