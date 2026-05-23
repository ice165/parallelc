import type { TaskDraft } from '../decompose/response-parser.js';

export interface DagValidation {
  acyclic: boolean;
  orphanNodes: string[];
  circularDeps: string[][];
  missingRoots: boolean;
}

export function validateDAG(tasks: TaskDraft[]): DagValidation {
  const titles = new Set(tasks.map(t => t.title));
  const orphanNodes: string[] = [];
  const circularDeps: string[][] = [];

  for (const t of tasks) {
    for (const dep of t.dependencies) {
      if (!titles.has(dep)) orphanNodes.push(dep);
    }
  }

  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const t of tasks) {
    inDegree.set(t.title, t.dependencies.length);
    adjacency.set(t.title, []);
  }
  for (const t of tasks) {
    for (const dep of t.dependencies) {
      adjacency.get(dep)?.push(t.title);
    }
  }

  const queue = [...inDegree.entries()].filter(([,d]) => d === 0).map(([n]) => n);
  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited++;
    for (const neighbor of adjacency.get(node) ?? []) {
      const d = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, d);
      if (d === 0) queue.push(neighbor);
    }
  }

  const acyclic = visited === tasks.length;
  if (!acyclic) {
    circularDeps.push([...inDegree.entries()].filter(([,d]) => d > 0).map(([n]) => n));
  }

  return {
    acyclic,
    orphanNodes,
    circularDeps,
    missingRoots: tasks.length > 0 && !tasks.some(t => t.dependencies.length === 0),
  };
}
