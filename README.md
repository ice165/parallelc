# ParallelC

> 对 Claude Code 说一句话，自动拆成多个任务并行执行，自动审查质量，结果自动合并——就像有多个 Claude 同时为你工作。

## 它是什么

ParallelC 是 Claude Code 的并行执行引擎。你只需要描述想要完成的功能，它自动将任务拆解、在隔离环境中并行执行、CEO 层审查质量、最后把代码安全合并回主分支。

**一个指令，多条流水线，自动协同。**

## 核心架构

```
你的一句话需求
      │
      ▼
┌──────────────┐
│ Orchestrator │  清晰度评估 → 仓库扫描 → DAG 拆解 → 文件预测三层兜底 → 写入 TaskBoard
│  (LLM 大脑)   │  L1 简单任务直接执行 / L2 进入流水线 / L3 人工确认
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Scheduler   │  幽灵Worker恢复 → 死锁检测 → F1-β降级 → 成本控制 → 审计日志
│  (调度管家)   │  跨轮 DB 重建锁 + 本轮 CAS 后更新锁（两层保护）
└──────┬───────┘
       │ 双 Worktree 隔离 + HMAC 防篡改
       ▼
┌──────────────┐
│   Worker N   │  只读区（全量代码）+ 稀疏写区（仅预测目录）
│  (执行工人)   │  HMAC 验证 → 快照校验 → 越权写拦截（退出码 12/14）
└──────┬───────┘
       │
       ▼
┌──────────────┐
│     CEO      │  意图对齐审查（4维评分：覆盖/缺失/多余/副作用）
│  (质量门禁)   │  PASS→合并 / REVISION→Worker修改(≤3轮) / ESCALATE→人工
└──────┬───────┘
       │ CEO 批准
       ▼
┌──────────────┐
│  Coordinator  │  git rebase（2次重试+延迟）→ AST 冲突检测
│  (合并大师)   │  AUTO → STRUCTURED → MERGE_BLOCKED 三级合并
└──────────────┘
```

## v2.1 核心特性

### 正确性与安全 (P0)
- **文件预测三层兜底**：LLM 预测 → 静态分析（import graph）→ git diff 兜底，确保安全边界不依赖 LLM 单点
- **清晰度评估引擎**：中文需求评分 0-100，<50 分建议细化，50-90 双引擎评估，>90 直接通过
- **幽灵 Worker 恢复**：启动时检测僵尸进程，区分 Alive/Zombie/Dead，上游依赖检查后智能恢复
- **路径穿越防御**：`realpathSync` 父目录链验证 + symlink 检测，防御 TOCTOU 竞态

### 健壮性与调度智能 (P1)
- **Rebase 合并**：替代 git merge，2 次重试 + 5s/10s 延迟，AST 语义冲突检测，失败转人工不重调 LLM
- **依赖图死锁打断**：检测 FAILED/CANCELLED 上游 → 自动取消下游，运行时持续监控
- **F1-β 滑动窗口**：β=0.5 偏重精确率，窗口=10，冷启动 20 轮保护 + ×1.5 扩展，连续低分自动降级串行

### CEO 质量门禁 (v2.1 新增)
- **意图对齐审查**：检查 Worker 产出是否与用户原始需求对齐（不审查代码语法）
- **4 维评分引擎**：功能覆盖(35) + 缺失检测(25) + 多余修改(20) + 副作用风险(20)
- **审查-修改迭代**：PASS→合并 / REVISION→Worker 增量修改(最多3轮) / ESCALATE→人工
- **分层信任模型**：L1 跳过 / L2 Sonnet 审查 / L3 Opus 审查
- **跳过策略**：F1-β>0.85 或清晰度>95 或单文件纯增量 → 自动跳过

### 运营与可观测性 (P2)
- **成本三层预算**：单次调用 (8192 tokens) / 单任务 ($3) / 单会话 ($20)，Anthropic 2026 实时定价
- **审计日志**：JSONL append-only + SHA256 校验，16 种事件类型，>100MB 自动归档
- **失败复现脚本**：自动生成 `.sh` 复现脚本 + context.json，含 git commit + 退出码 + stdout

### 安全加固 (P3)
- **HMAC 密钥验证**：每次 spawn 随机 32B 密钥，SHA-256 HMAC 防任务数据篡改，timingSafeEqual 防时序攻击
- **命令注入防御**：全局 `execFileSync` 替代 `execSync`，参数数组避免 shell 解析
- **Mock 模式**：`PARALLELC_MOCK_CLAUDE_RESPONSE` 加载预录制响应，跳过真实 API 调用

### v1.5 保留特性
- 预测性文件锁 + 两层锁保护 + 饥饿保护 (300s)
- 429 防共振：指数退避 [1,2,4,8,16] 分钟 + ±30s 随机抖动
- 双 Worktree 隔离 + L1/L2/L3 智能分级 + DAG 失败传播

## 快速开始

### 你需要

- **Node.js ≥ 20** · **pnpm ≥ 9** · **Git** · **[Claude Code CLI](https://claude.ai/code)** · **Anthropic API Key(s)**

### 安装

```bash
git clone https://github.com/ice165/parallelc.git
cd parallelc
corepack enable pnpm
pnpm install
pnpm build
```

### 使用（四步走）

**第 1 步 — 启动 Scheduler**

```bash
npx parallelc-scheduler start \
  --repo /path/to/your-project \
  --api-keys "sk-ant-xxx,sk-ant-yyy" \
  --max-workers 4
```

**第 2 步 — 拆解任务**

```bash
npx parallelc-orchestrate decompose "给商城加一个优惠券系统" \
  --repo /path/to/your-project \
  --api-key sk-ant-xxx
```

**第 3 步 — （自动）CEO 审查**

Worker 完成后自动进入 CEO 审查队列。也可手动触发：

```bash
npx parallelc-ceo review --repo /path/to/your-project --api-key sk-ant-xxx
npx parallelc-ceo status        # 查看审查状态
npx parallelc-ceo confirm --task task-xxx  # 确认 ESCALATED 任务
```

**第 4 步 — 确认 L3 任务（如有）**

```bash
npx parallelc-orchestrate confirm --dag dag-xxx --task task-xxx
```

### 监控

```bash
npx parallelc-scheduler status          # 调度面板
npx parallelc-orchestrate accuracy      # 预测准确率
npx parallelc-ceo status                # CEO 审查状态
```

## 对比 Claude Code Team 模式

| 维度 | Claude Code Team 模式 | ParallelC |
|------|----------------------|-----------|
| **分工方式** | 多个 Agent 讨论同一个任务 | Orchestrator 分析文件依赖，自动拆解为独立子任务 |
| **质量门禁** | 无（依赖 Agent 自律） | CEO 层 4 维评分 + 3 轮迭代 + ESCALATE 人工 |
| **执行环境** | 共享工作区，无文件隔离 | 每个 Worker 独立 Git Worktree + HMAC 防篡改 |
| **冲突处理** | 依赖 Agent 自身判断 | 预测性文件锁 + 三层兜底，提前阻止同文件并发写入 |
| **合并方式** | Agent 自行 git commit | git rebase + AST 冲突检测 + 三级合并 |
| **失败恢复** | 重新对话，手动重试 | 幽灵Worker恢复 + 429 退避 + Key 池轮转 + 复现脚本 |
| **可观测性** | 无 | 审计日志 (16 种事件) + 成本追踪 + F1-β 准确率 |

## 项目结构

```
packages/
├── shared/        共享类型、常量、错误类、HMAC 工具、OTel 辅助、Git 工具
├── validate/      写保护、路径穿越防御（realpath + TOCTOU）
├── taskboard/     SQLite 任务状态机、CAS 乐观锁、幽灵Worker检测
├── keypool/       API Key 池轮转、健康检查、指数退避
├── worker/        Worker 生命周期、MCP 客户端、HMAC 验证、启动校验
├── orchestrator/  清晰度评估、仓库扫描、DAG 拆解、文件预测、死锁检测
│                 成本追踪、复现脚本、规则校验、准确率追踪
├── coordinator/   git rebase + AST 冲突检测、三级合并策略、仲裁决策树
├── scheduler/     调度主循环、F1-β 追踪、审计日志、CEO 集成
└── ceo/           意图对齐审查、4维评分引擎、审查-修改迭代控制
```

## 退出码协议

| 退出码 | 语义 | Scheduler 响应 |
|--------|------|---------------|
| 0 | DONE | CEO 审查 → Coordinator 合并 |
| 10 | CHECKPOINT | 标记 SLEEP_PENDING，到期唤醒 |
| 11 | TIMEOUT | Watchdog SIGTERM → 5s后 SIGKILL |
| 12 | HOOK_BLOCKED | 越权写入被拦截，标记失败 |
| 13 | RATE_LIMIT | KeyPool 退避冷却 |
| 14 | TAMPER_DETECTED | HMAC 验证失败，标记失败 |

## 开发

```bash
pnpm build     # 构建全部 9 个包
pnpm test      # 运行全部测试
pnpm typecheck # 类型检查
```

## 技术栈

TypeScript · pnpm monorepo · better-sqlite3 · Jest · Git Worktree · Claude MCP · crypto (HMAC) · tsup

## 许可

MIT License — 详见 [LICENSE](LICENSE)
