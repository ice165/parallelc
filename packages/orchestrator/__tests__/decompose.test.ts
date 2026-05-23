import { buildOrchestratorPrompt, type DecompositionInput } from '../src/decompose/prompt-builder';
import { parseTaskDAG } from '../src/decompose/response-parser';

const makeInput = (): DecompositionInput => ({
  userRequest: 'Add user login API with JWT auth',
  repoContext: {
    fileTree: ['src/api/auth.ts', 'src/models/user.ts', 'src/utils/jwt.ts'],
    moduleDirs: ['src/api', 'src/models', 'src/utils'],
    packageJson: { name: 'test', scripts: {}, dependencies: {} },
    existingTasks: [],
  },
  moduleMap: [
    { dir: 'src/api', files: ['src/api/auth.ts'], imports: [], exportedSymbols: ['login'] },
    { dir: 'src/models', files: ['src/models/user.ts'], imports: ['../api/auth'], exportedSymbols: ['User'] },
    { dir: 'src/utils', files: ['src/utils/jwt.ts'], imports: [], exportedSymbols: ['sign'] },
  ],
});

describe('buildOrchestratorPrompt', () => {
  test('包含用户需求', () => {
    const prompt = buildOrchestratorPrompt(makeInput());
    expect(prompt).toContain('Add user login API');
  });

  test('包含仓库上下文', () => {
    const prompt = buildOrchestratorPrompt(makeInput());
    expect(prompt).toContain('src/api/auth.ts');
    expect(prompt).toContain('src/models/user.ts');
  });

  test('包含 L1/L2/L3 分级规则', () => {
    const prompt = buildOrchestratorPrompt(makeInput());
    expect(prompt).toContain('L1');
    expect(prompt).toContain('L2');
    expect(prompt).toContain('L3');
    expect(prompt).toContain('expected_touch_files');
  });

  test('包含 JSON 输出格式', () => {
    const prompt = buildOrchestratorPrompt(makeInput());
    expect(prompt).toContain('JSON');
    expect(prompt).toContain('"tasks"');
  });

  test('包含模块依赖信息', () => {
    const prompt = buildOrchestratorPrompt(makeInput());
    expect(prompt).toContain('src/api');
    expect(prompt).toContain('src/models');
  });
});

describe('parseTaskDAG', () => {
  test('解析合法 JSON', () => {
    const json = `{
  "dagId": "dag-test",
  "summary": "Add login API",
  "tasks": [
    {"title":"Create auth route","level":"L2","expected_touch_files":["src/api/auth.ts"],"dependencies":[],"reasoning":"New route"},
    {"title":"Add JWT middleware","level":"L2","expected_touch_files":["src/utils/jwt.ts"],"dependencies":["Create auth route"],"reasoning":"JWT helpers"}
  ]
}`;
    const result = parseTaskDAG(json);
    expect(result).not.toBeNull();
    expect(result!.dagId).toBe('dag-test');
    expect(result!.tasks).toHaveLength(2);
    expect(result!.tasks[0]!.level).toBe('L2');
    expect(result!.tasks[1]!.dependencies).toContain('Create auth route');
  });

  test('无效 JSON 返回 null', () => {
    expect(parseTaskDAG('not json {')).toBeNull();
  });

  test('缺少 tasks 字段返回 null', () => {
    expect(parseTaskDAG('{"dagId":"test","summary":"test"}')).toBeNull();
  });

  test('解析 markdown code block 中的 JSON', () => {
    const json = '```json\n{"dagId":"dag-test","summary":"test","tasks":[]}\n```';
    const result = parseTaskDAG(json);
    expect(result).not.toBeNull();
  });
});
