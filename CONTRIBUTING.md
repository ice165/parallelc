# Contributing to ParallelC

## 开发环境

```bash
# 需要 Node.js >= 20 和 pnpm >= 9
pnpm install
```

## 开发流程

1. 每个 Phase 先写设计文档 (`docs/superpowers/specs/`) 再写实现计划 (`docs/superpowers/plans/`)
2. 实现遵循 TDD：先写测试 → 验证失败 → 实现 → 验证通过 → 提交
3. 代码审查后合并

## 项目结构

```
packages/
├── shared/          # 基础层 — 零依赖
├── validate/        # 安全层 — 依赖 shared
├── taskboard/       # 数据层 — 依赖 shared + better-sqlite3
├── worker/          # 执行层 — 依赖 shared
├── scheduler/       # 调度层 — 依赖 shared + taskboard + worker + keypool + coordinator
├── keypool/         # Key 管理层 — 依赖 shared
├── coordinator/     # 合并层 — 依赖 shared + taskboard
└── orchestrator/    # 编排层 — 依赖 shared + taskboard + worker
```

## 可用脚本

```bash
pnpm test          # 运行所有测试
pnpm typecheck     # TypeScript 类型检查
pnpm build         # 生产构建
pnpm test:ci       # CI 模式 (含覆盖率)
```

## 提交规范

```
feat(package): description
fix(package): description
docs: description
```

## 许可

MIT — 详见 [LICENSE](LICENSE)
