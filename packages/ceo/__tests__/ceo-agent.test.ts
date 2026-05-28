import { ceoReview } from '../src/ceo-agent';
import type { CeoReviewInput } from '@parallelc/shared';

const makeInput = (): CeoReviewInput => ({
  userRequest: '在 src/api/auth.ts 中添加 JWT 登录接口',
  taskTitle: '实现 JWT 登录 API',
  taskReasoning: '创建登录路由和 JWT 签发逻辑',
  diff: '+export function login() { return { token: "xxx" }; }',
  modifiedFiles: ['src/api/auth.ts'],
  iteration: 0,
});

describe('ceoReview', () => {
  test('Mock 模式使用规则引擎评分', async () => {
    const result = await ceoReview(makeInput(), 'task-001', {
      apiKey: 'sk-test', level: 'L2', useMock: true,
    });
    expect(result.feedback.verdict).toBeDefined();
    expect(result.model).toBe('sonnet');
    expect(result.tokensUsed).toBe(0);
    expect(result.cost).toBe(0);
  });

  test('L3 任务使用 Opus', async () => {
    const result = await ceoReview(makeInput(), 'task-002', {
      apiKey: 'sk-test', level: 'L3', useMock: true,
    });
    expect(result.model).toBe('opus');
  });

  test('空 diff → ESCALATE 低分', async () => {
    const input = { ...makeInput(), diff: '' };
    const result = await ceoReview(input, 'task-003', {
      apiKey: 'sk-test', level: 'L2', useMock: true,
    });
    expect(result.feedback.verdict).toBe('ESCALATE');
    expect(result.feedback.score).toBeLessThan(50);
  });
});
