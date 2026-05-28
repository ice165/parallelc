import { evaluateClarity } from '../src/decompose/clarity-engine';

describe('evaluateClarity', () => {
  test('清晰需求得分 > 90', () => {
    const result = evaluateClarity('在 src/api/auth.ts 中添加 JWT 登录接口');
    expect(result.score).toBeGreaterThan(90);
    expect(result.zone).toBe('PASS');
  });

  test('模糊需求得分 < 70', () => {
    const result = evaluateClarity('优化一下性能');
    expect(result.score).toBeLessThan(70);
    expect(result.zone).toBe('BRAINSTORM');
  });

  test('中等清晰度得分 70-90', () => {
    const result = evaluateClarity('添加用户认证功能，修改 src/api/auth.ts 实现 JWT 登录');
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.score).toBeLessThanOrEqual(90);
  });

  test('检测到歧义词扣分', () => {
    const result = evaluateClarity('大概修改一下那个登录相关的功能');
    expect(result.score).toBeLessThan(70);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some(w => w.includes('歧义'))).toBe(true);
  });

  test('检测到目标动词加分', () => {
    const result = evaluateClarity('重构 UserService 类，提取接口');
    expect(result.verbScore).toBeGreaterThan(0);
  });

  test('检测到范围边界加分', () => {
    const result = evaluateClarity('修改 src/api/auth.ts 文件的 login 函数');
    expect(result.scopeScore).toBeGreaterThan(0);
  });

  test('检测到约束表达式加分', () => {
    const result = evaluateClarity('必须保持向后兼容，不能修改 public API');
    expect(result.constraintScore).toBeGreaterThan(0);
  });

  test('空输入返回 0', () => {
    const result = evaluateClarity('');
    expect(result.score).toBe(0);
  });
});
