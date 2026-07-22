# Generic Multi-Agent Development Harness

一个零运行时依赖的通用开发 Harness。它把任务冻结为明确的验收契约，在独立 Git worktree 中让 Agent 修改代码，再由只读审查、确定性命令和只读评分共同决定是否接受候选提交。

```text
Scout（校验并冻结任务）
  → Coder（隔离 worktree 内修改）
  → Reviewer（只读审查）
  → Scorer（确定性 checks + 只读验收）
  → 接受，或进入同一任务的 Polish 循环
```

Harness 不内置任何业务项目、技术栈、仓库地址或任务。目标仓库、检查命令和任务都来自配置文件。

## 运行要求

- Node.js 20+
- Git
- Claude Code CLI（默认命令为 `claude`）
- 使用 GitHub Issue 任务源时还需要 GitHub CLI `gh`

## 快速开始

1. 复制示例配置和任务清单：

   ```bash
   cp harness.config.example.json harness.config.json
   cp tasks.example.json tasks.json
   ```

2. 修改 `harness.config.json` 中的 `projectRoot`、模型和确定性检查；修改 `tasks.json` 中的任务、验收标准和可编辑路径。

3. 先验证计划，不运行 Agent、不创建状态或分支：

   ```bash
   node scripts/orchestrator.mjs --dry-run
   ```

4. 正式运行：

   ```bash
   node scripts/orchestrator.mjs
   ```

常用选项：

```bash
# 只运行清单中的指定任务；依赖任务也必须显式选中
node scripts/orchestrator.mjs --tasks add-health-endpoint

# 临时覆盖目标仓库和总时限
node scripts/orchestrator.mjs --project-root /absolute/path/to/project --hours 2

# 只恢复一个明确且输入完全一致的运行
node scripts/orchestrator.mjs --resume 20260722T120000Z-acde1234
```

运行 `node scripts/orchestrator.mjs --help` 可查看完整参数。

## 配置

`harness.config.example.json` 是完整的最小示例：

```json
{
  "schemaVersion": 1,
  "projectRoot": "../your-project",
  "stateDir": ".harness",
  "taskSource": {
    "type": "manifest",
    "path": "./tasks.json"
  },
  "agent": {
    "command": "claude",
    "model": "sonnet",
    "bare": true,
    "maxTurns": 50,
    "maxBudgetUsd": 5,
    "timeoutsMs": {
      "coder": 1200000,
      "reviewer": 900000,
      "scorer": 600000
    }
  },
  "passEnv": ["ANTHROPIC_API_KEY"],
  "checks": [
    {
      "id": "test",
      "command": "npm",
      "args": ["test"],
      "cwd": ".",
      "timeoutMs": 600000
    }
  ],
  "policy": {
    "scoreThreshold": 70,
    "maxCoderAttempts": 3,
    "maxPolishPerTask": 3,
    "maxTotalPolish": 15,
    "minImprovement": 2,
    "maxConsecutiveFailures": 3,
    "maxRunMinutes": 120
  }
}
```

所有外部命令都由 `command` 和 `args` 数组表达，不接受 shell 命令字符串。配置中的相对路径以配置文件所在目录为基准。

`bare: true` 是默认安全模式：Agent 使用隔离的临时主目录，只能看到 `passEnv` 中显式列出的环境变量。确定性 checks 使用另一个临时主目录，并且不会继承 `passEnv`。若改为 `bare: false`，Claude Code 会读取用户级设置，隔离边界也会相应减弱。

## 任务清单

Manifest 是推荐任务源。每次运行会把选中的标准化任务冻结到运行目录：

```json
{
  "schemaVersion": 1,
  "tasks": [
    {
      "id": "add-health-endpoint",
      "title": "Add a health endpoint",
      "description": "Implement the requested behavior without changing unrelated APIs.",
      "acceptanceCriteria": [
        "GET /health returns HTTP 200",
        "The response body contains status=ok",
        "Existing tests continue to pass"
      ],
      "editablePaths": ["src/", "test/", "package.json"],
      "requiredChecks": ["test"],
      "dependsOn": []
    }
  ]
}
```

约束如下：

- `id` 必须唯一且只包含字母、数字、点、下划线和连字符。
- 验收标准、可编辑路径、必跑检查均不能为空。
- 可编辑路径只能位于目标仓库内，不能包含 `..`；用 `"."` 表示允许修改全仓库。
- `requiredChecks` 必须引用配置中存在的检查。
- 依赖必须存在、不能自依赖或成环。
- 任务文本是不可信数据，只会被编码为 JSON 结构化上下文并通过标准输入传递，不会拼进 shell；角色约束通过独立的 system prompt 提供。

## GitHub Issue 任务源

也可以把 `taskSource` 改为：

```json
{
  "type": "github",
  "repository": "owner/repository",
  "state": "open",
  "limit": 20,
  "requiredLabels": ["agent-ready"],
  "allowedAuthors": [],
  "editablePaths": ["src/", "test/"],
  "requiredChecks": ["test"],
  "dependencies": {
    "issue-42": ["issue-41"]
  }
}
```

自动加载时必须至少配置 `requiredLabels` 或一个 `allowedAuthors`，避免把仓库中所有 Issue 当作可执行指令。标签和作者过滤会下推给 GitHub CLI，再在本地复核。获取失败、过滤后为空或 Issue 正文为空都会直接失败，不会退回隐藏的默认任务。

显式执行 Issue 时使用编号：

```bash
node scripts/orchestrator.mjs --tasks 41,42
```

此时会逐个读取指定 Issue，不受列表上限和 open/closed 状态影响。Issue 正文中的 checklist 会成为验收标准；没有 checklist 时，整个正文作为一个验收标准。

## 隔离、验收与产物

正式运行要求目标仓库存在提交、主工作区干净，并且目标仓库不能是 Harness 自身。状态目录也不能放进目标仓库；指向 worktree 外部的 tracked 符号链接会被拒绝。

每个候选实现都在独立 detached worktree 中完成。Harness 会：

1. 校验所有改动都位于 `editablePaths`。
2. 使用空 hooks 目录冻结候选提交。
3. 让 Reviewer 只读审查候选。
4. 直接执行任务声明的确定性 checks，并记录真实退出码和输出；checks 产生的临时文件会在 Scorer 前清理。
5. 让 Scorer 逐条判断冻结的验收标准。
6. 只有 Coder 成功、无审查阻断、所有 checks 通过、所有验收标准通过且分数达到阈值时才接受候选。

失败候选不会修改用户当前分支或主工作区。已接受候选按顺序推进本地输出分支：

```text
harness/<run-id>
```

Harness 不会自动推送目标项目的输出分支。运行状态、冻结输入、逐阶段结构化证据和候选 patch 位于：

```text
.harness/runs/<run-id>/
```

状态采用原子写入；同一目标仓库同时只能有一个 Harness 运行。三个角色 Prompt 会随配置一起冻结。恢复时会核对配置与 Prompt 哈希、任务哈希、目标仓库路径、初始提交和输出分支，任一不一致都会拒绝复用旧状态。每次显式恢复会按原配置获得一段新的执行时限，已接受任务和累计 Polish 次数不会重置。

## 安全边界

- 所有子进程使用参数数组启动，禁用 shell 解释。
- 不使用 `--dangerously-skip-permissions`。
- Coder 只有文件读取和编辑工具；Reviewer 与 Scorer 只有文件读取工具。
- Agent 环境默认不继承 GitHub、SSH、云服务或其他凭据。
- Checks 不继承 Agent 的 `passEnv`，因此目标代码拿不到为 Agent 配置的 API key。
- Reviewer、checks、Scorer 针对同一个已冻结 commit；每个阶段都会重新核对 `HEAD` 和 tracked tree，checks 的生成物会在 Scorer 前移除。
- 真实 build/test 结果是硬门槛，模型分数不能覆盖失败的检查。

Git worktree 是版本隔离，不是操作系统沙箱。目标仓库及配置的 checks 仍然属于信任边界：执行构建或测试本质上会运行目标仓库中的代码。不要对不可信仓库直接使用带敏感权限的宿主环境；需要运行不可信代码时，应把整个 Harness 放进容器或专用虚拟机。

## 开发与验证

本项目不依赖第三方 npm 包：

```bash
npm run check
npm test
```

成功运行退出码为 `0`。存在失败、阻断、超时或断路器停止时退出码为非零；只有全部选中任务被接受，运行状态才会写成 `completed`。
