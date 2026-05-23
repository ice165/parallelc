import type { RepoContext } from '../pre-process/repo-scanner.js';
import type { ModuleBoundary } from '../pre-process/module-map.js';

export interface DecompositionInput {
  userRequest: string;
  repoContext: RepoContext;
  moduleMap: ModuleBoundary[];
}

export function buildOrchestratorPrompt(input: DecompositionInput): string {
  const fileTreeStr = input.repoContext.fileTree.map(f => `- ${f}`).join('\n');
  const modulesStr = input.moduleMap.map(m =>
    `  ${m.dir}: ${m.files.length} files, exports: [${m.exportedSymbols.join(', ')}], deps: [${m.imports.join(', ')}]`
  ).join('\n');
  const existingStr = input.repoContext.existingTasks.length > 0
    ? input.repoContext.existingTasks.map(t => `- ${t}`).join('\n')
    : '(none)';

  return `你是任务分解专家。将用户需求拆分为可并行/串行执行的子任务。

## 仓库上下文
**文件树 (${input.repoContext.fileTree.length} files):**
${fileTreeStr}

**模块边界:**
${modulesStr}

**已有未完成任务:**
${existingStr}

## 分级规则（必须严格遵守）
| 级别 | 条件 | 动作 |
|------|------|------|
| L1 | 修改文件数 <=2, 同一目录, 无新建文件, token预估 < 10K | 直接执行, 不创建Task |
| L2 | 修改文件数 3-10, 或跨模块, 或需新建文件 | 创建Task, 进入流水线 |
| L3 | 修改文件数 >10, 或涉及DB schema, 或跨仓库 | 创建Task, 需人工确认 |

**禁止降级**：满足L2条件的任务不可标记为L1。
**expected_touch_files**：必须是仓库中存在的路径。新建文件时填写目标路径。

## 用户需求
${input.userRequest}

## 输出格式（严格JSON）
{
  "dagId": "dag-<timestamp>",
  "summary": "一句话描述",
  "tasks": [
    {
      "title": "任务标题",
      "level": "L1|L2|L3",
      "expected_touch_files": ["path/to/file.ts"],
      "dependencies": ["依赖的task title"],
      "reasoning": "拆分理由"
    }
  ]
}

dependencies 中引用其他 task 的 title（非 ID）。
task 按执行顺序排列，dependencies 只引用排序在前的 task。`;
}
