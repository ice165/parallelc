import type { ClarityResult } from '@parallelc/orchestrator';

export interface StructuredSpec {
  title: string;
  requirement: string;
  acceptanceCriteria: string[];
  fileScope: string;
  constraints: string[];
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  estimatedFiles: number;
  suggestedLevel: 'L1' | 'L2' | 'L3';
}

export function generateSpec(
  userRequest: string,
  clarity: ClarityResult,
): string {
  const spec = buildStructuredSpec(userRequest, clarity);
  return formatSpec(spec);
}

function buildStructuredSpec(
  userRequest: string,
  clarity: ClarityResult,
): StructuredSpec {
  const filePaths = userRequest.match(/(?:src|packages|lib|tests?|docs?)\/[\w\/\-+.]+\.(?:ts|js|tsx|jsx|py|rs|go|java|sql)/g) ?? [];

  const constraints: string[] = [];
  if (/必须/.test(userRequest)) constraints.push('Must: 必须实现');
  if (/不能/.test(userRequest)) constraints.push('Must Not: 不能违反');
  if (/确保/.test(userRequest)) constraints.push('Ensure: 确保满足');
  if (/保持/.test(userRequest)) constraints.push('Maintain: 保持兼容');

  const estimatedFiles = filePaths.length || 3;
  let suggestedLevel: StructuredSpec['suggestedLevel'] = 'L2';
  if (estimatedFiles <= 2 && constraints.length === 0) suggestedLevel = 'L1';
  if (estimatedFiles > 10 || /schema|migration|database/i.test(userRequest)) suggestedLevel = 'L3';

  let riskLevel: StructuredSpec['riskLevel'] = 'MEDIUM';
  if (suggestedLevel === 'L1') riskLevel = 'LOW';
  if (suggestedLevel === 'L3') riskLevel = 'HIGH';

  const titleMatch = userRequest.match(/^.{0,50}/);
  const title = titleMatch ? titleMatch[0].trim() : userRequest.slice(0, 50);

  return {
    title,
    requirement: userRequest,
    acceptanceCriteria: generateAcceptanceCriteria(userRequest, clarity),
    fileScope: filePaths.length > 0 ? filePaths.join(', ') : '待确定（根据仓库结构）',
    constraints,
    riskLevel,
    estimatedFiles,
    suggestedLevel,
  };
}

function generateAcceptanceCriteria(
  userRequest: string,
  _clarity: ClarityResult,
): string[] {
  const criteria: string[] = [];
  const verbs = userRequest.match(/\b(创建|修复|添加|移除|删除|重构|优化|实现|编写|修改|更新|迁移|合并|拆分|提取|重命名|配置|集成|替换|回滚|升级|降级)\b/g) ?? [];

  for (const verb of verbs) {
    criteria.push(`${verb}功能已正确实现`);
  }
  if (criteria.length === 0) {
    criteria.push('功能按需求描述正确实现');
  }
  criteria.push('未修改需求范围外的文件');
  criteria.push('现有功能未受影响（无回归）');

  return criteria;
}

function formatSpec(spec: StructuredSpec): string {
  return `# 需求方案：${spec.title}

## 需求描述
${spec.requirement}

## 验收标准
${spec.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

## 文件范围
${spec.fileScope}

## 约束条件
${spec.constraints.length > 0 ? spec.constraints.join('\n') : '无特殊约束'}

## 风险评估
- 风险等级：${spec.riskLevel}
- 预估修改文件数：${spec.estimatedFiles}
- 建议任务级别：${spec.suggestedLevel}

---
*此方案由 CEO 层自动生成，请确认后交给 Orchestrator 拆解执行。*
`;
}

export { buildStructuredSpec };
export type { StructuredSpec as SpecResult };
