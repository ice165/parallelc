import Database from 'better-sqlite3';
import type { Task } from '@parallelc/shared';
import type { ConflictDetail } from './merge-strategy.js';
import fs from 'fs';
import path from 'path';

export interface MergeReport {
  triggeredAt: string;
  conflictFile: string;
  conflictLines: string;
  taskA: { taskId: string; title: string; waitedMs: number; diff: string; contextSummary: string };
  taskB: { taskId: string; title: string; waitedMs: number; diff: string; contextSummary: string };
  suggestedDirection: string;
}

export function generateBlockedReport(
  db: Database.Database,
  taskA: Task,
  taskB: Task,
  conflict: ConflictDetail,
  repoRoot: string,
): MergeReport {
  const now = new Date();
  const triggeredAt = now.toISOString();
  const reportDir = path.join(repoRoot, '.parallelc', 'reports');
  fs.mkdirSync(reportDir, { recursive: true });

  const filename = `MERGE_BLOCKED-${taskA.id}-${taskB.id}-${now.getTime()}.md`;
  const reportPath = path.join(reportDir, filename);

  const waitedMsA = taskA.ready_at ? now.getTime() - new Date(taskA.ready_at).getTime() : 0;
  const waitedMsB = taskB.ready_at ? now.getTime() - new Date(taskB.ready_at).getTime() : 0;

  const report: MergeReport = {
    triggeredAt,
    conflictFile: conflict.file,
    conflictLines: conflict.lines,
    taskA: {
      taskId: taskA.id,
      title: taskA.title,
      waitedMs: waitedMsA,
      diff: conflict.taskA.diff,
      contextSummary: `Worker output for ${taskA.id}`,
    },
    taskB: {
      taskId: taskB.id,
      title: taskB.title,
      waitedMs: waitedMsB,
      diff: conflict.taskB.diff,
      contextSummary: `Worker output for ${taskB.id}`,
    },
    suggestedDirection: '[人工填写] 采纳 A / 采纳 B / 手动合并',
  };

  const md = `## MERGE_BLOCKED 仲裁报告
**触发时间**：${triggeredAt}
**冲突文件**：${conflict.file}（${conflict.lines}）

### Task A（starvation_override=${taskA.starvation_override}）
- Task ID：${taskA.id}
- 标题：${taskA.title}
- 等待时长：${Math.floor(waitedMsA / 1000)}s
- 完整 diff：

\`\`\`diff
${conflict.taskA.diff}
\`\`\`

### Task B（starvation_override=${taskB.starvation_override}）
- Task ID：${taskB.id}
- 标题：${taskB.title}
- 等待时长：${Math.floor(waitedMsB / 1000)}s
- 完整 diff：

\`\`\`diff
${conflict.taskB.diff}
\`\`\`

**建议仲裁方向**：${report.suggestedDirection}
`;

  fs.writeFileSync(reportPath, md);

  db.prepare(
    'UPDATE tasks SET merge_report_path = ?, merge_blocked_at = ?, status = ?, version = version + 1 WHERE id = ?',
  ).run(reportPath, triggeredAt, 'MERGE_BLOCKED', taskA.id);

  return report;
}
