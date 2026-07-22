# Z-Learning Multi-Agent Closed-Loop Harness

> 基于 Scout-Coder-Reviewer-Scorer-Orchestrator 模式，适配 Z-Learning 项目

## 架构

```
Scout(读Issue→生成Brief) → Coder(写代码) → Reviewer(审质量+修系统bug) → Scorer(跑构建+测试+验收)
                                      ↑                                        │
                                      └──── Orchestrator 调度 Polish Loop ──────┘
```

## 和 linear-clone 的区别

| | linear-clone | z-learning |
|---|---|---|
| **Scorer 打分方式** | Playwright 截图 + pixelmatch 视觉比对 | npm run build + node test-engine.mjs + 功能验收 |
| **Review 维度** | 8维（build/TS/样式/无障碍…） | 8维（build/tests/接口契约/边界case/代码风格…） |
| **Brief 来源** | PRD 文档 → 页面规格 | GitHub Issue → 实现规格 |
| **Polish 触发** | 视觉相似度 < 70% | Review/Scorer 分数 < 70 |
| **项目根目录** | 自身 | 指向 C:\Users\13681\z-learning |

## 用法

```bash
# 完整运行
node scripts/orchestrator.mjs

# 只跑特定任务
node scripts/orchestrator.mjs --tasks phase4-pathplanner,phase5-mastery-loop

# 限时 2 小时
node scripts/orchestrator.mjs --hours 2

# 从第 3 步恢复
node scripts/orchestrator.mjs --start-at 3

# 空跑（不执行 agent）
node scripts/orchestrator.mjs --dry-run

# 指定项目路径
node scripts/orchestrator.mjs --project-root /path/to/z-learning

# 从 GitHub Issue 加载任务（默认）
node scripts/orchestrator.mjs --repo-owner YanziMa --repo-name z-learning
```

## 安全机制

| 机制 | 说明 |
|------|------|
| **Polish 上限** | 每个任务最多 3 次，总共最多 15 次 |
| **衰减保护** | 分数变差 → 立刻停此任务的 Polish |
| **平台保护** | 改进 < 2 分 → 停此任务的 Polish |
| **断路器** | 连续 3 个任务失败 → 停整个 Pipeline |
| **Coder 重试** | 最多重试 2 次 |
| **时间限制** | `--hours` 设置总时长 |
| **进度恢复** | `--start-at` 从任意步骤恢复 |

## 目录结构

```
z-learning/  (harness 根目录)
├── scripts/
│   └── orchestrator.mjs     主调度脚本
├── .claude/agents/
│   ├── coder.md             Coder Agent 规则
│   ├── reviewer.md          Reviewer Agent 规则
│   └── scorer.md            Scorer Agent 规则
├── orchestrator/
│   ├── progress.json        进度追踪（可恢复）
│   └── briefs/              Scout 生成的实现规格
├── coder/reports/           Coder 产出报告
├── reviewer/reports/        Reviewer 产出报告
├── scorer/
│   └── latest-score.json    最新评分
└── README.md                本文件
```

## 给同事用

1. 复制这个目录到新位置
2. 修改 `.claude/agents/*.md` 里的技术栈和规则
3. 修改 `scripts/orchestrator.mjs` 里的 `DEFAULT_TASKS` 和 `DEFAULT_PROJECT_ROOT`
4. 运行 `node scripts/orchestrator.mjs`
