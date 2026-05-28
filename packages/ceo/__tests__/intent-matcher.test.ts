import { matchIntent } from '../src/intent-matcher';
import type { CeoReviewInput } from '@parallelc/shared';

const makeInput = (overrides?: Partial<CeoReviewInput>): CeoReviewInput => ({
  userRequest: '在 src/api/auth.ts 中添加 JWT 登录接口',
  taskTitle: '实现 JWT 登录 API',
  taskReasoning: '创建登录路由和 JWT 签发逻辑',
  diff: `+export function login(req: LoginRequest): LoginResponse {
+  const token = jwt.sign({ userId: user.id }, secret);
+  return { token, user };
+}`,
  modifiedFiles: ['src/api/auth.ts'],
  iteration: 0,
  ...overrides,
});

describe('matchIntent', () => {
  test('完全对齐 → verdict PASS', () => {
    const result = matchIntent(makeInput());
    expect(result.verdict).toBe('PASS');
    expect(result.score).toBeGreaterThanOrEqual(80);
  });

  test('缺失关键功能 → verdict REVISION', () => {
    const input = makeInput({
      userRequest: '添加 JWT 登录接口和密码重置功能',
      diff: '+export function login() { return { token: "xxx" }; }',
    });
    const result = matchIntent(input);
    expect(result.verdict).toBe('REVISION');
  });

  test('修改了无关文件 → excess 非空', () => {
    const input = makeInput({
      modifiedFiles: ['src/api/auth.ts', 'src/utils/random.ts'],
    });
    const result = matchIntent(input);
    expect(result.excess.length).toBeGreaterThan(0);
  });

  test('迭代轮次 ≥ 3 → 强制 ESCALATE', () => {
    const input = makeInput({ iteration: 2 });
    const result = matchIntent(input);
    expect(result.verdict).toBe('ESCALATE');
  });

  test('分数 < 50 → verdict ESCALATE', () => {
    const input = makeInput({
      userRequest: '重写整个认证系统，支持 OAuth2.0、SAML、LDAP',
      diff: '+console.log("hello");',
    });
    const result = matchIntent(input);
    expect(result.verdict).toBe('ESCALATE');
    expect(result.score).toBeLessThan(50);
  });

  test('空 diff → 低分 ESCALATE', () => {
    const input = makeInput({ diff: '' });
    const result = matchIntent(input);
    expect(result.score).toBeLessThan(50);
  });
});
