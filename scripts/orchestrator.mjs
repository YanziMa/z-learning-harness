/**
 * Orchestrator v1 — Z-Learning Multi-Agent Closed-Loop Pipeline
 *
 * 5-Agent Flow per task:
 *   1. Scout  — Load GitHub Issue → generate implementation brief
 *   2. Coder  — Implement feature based on brief
 *   3. Reviewer — Code quality review + fix systemic issues
 *   4. Scorer — Build + test + functional verification
 *   5. Polish — Bounded rework loop (max 3/task, decline/flat → skip)
 *
 * Usage:
 *   node scripts/orchestrator.mjs                          # full run
 *   node scripts/orchestrator.mjs --dry-run                # validate config only
 *   node scripts/orchestrator.mjs --hours 2                # max runtime
 *   node scripts/orchestrator.mjs --start-at 3             # start from task index
 *   node scripts/orchestrator.mjs --tasks phase4-path      # run specific tasks only
 *   node scripts/orchestrator.mjs --repo-owner YanziMa     # GitHub repo owner
 *   node scripts/orchestrator.mjs --repo-name z-learning   # GitHub repo name
 *
 * Project root defaults to the z-learning repo at:
 *   C:\Users\13681\z-learning (can override with --project-root)
 */
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = __dirname;
const DEFAULT_PROJECT_ROOT = 'C:\\Users\\13681\\z-learning';

const PROGRESS_FILE = join(HARNESS_ROOT, 'orchestrator', 'progress.json');
const BRIEFS_DIR = join(HARNESS_ROOT, 'orchestrator', 'briefs');
const STATUS_FILE = join(HARNESS_ROOT, 'orchestrator-status.json');

// ── Safety Configuration ──
const SCORE_THRESHOLD = 70;
const MAX_POLISH_PER_TASK = 3;
const MAX_TOTAL_POLISH = 15;
const MIN_IMPROVEMENT = 2;   // score points
const MAX_CODER_RETRIES = 2;
const MAX_CONSECUTIVE_FAILS = 3;

// ── Parse CLI Args ──
const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf('--' + name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
};
const PROJECT_ROOT = getArg('project-root') || DEFAULT_PROJECT_ROOT;
const MAX_HOURS = parseFloat(getArg('hours')) || Infinity;
const DRY_RUN = args.includes('--dry-run');
const START_AT = parseInt(getArg('start-at')) || 0;
const SPECIFIC_TASKS = getArg('tasks')?.split(',').map(s => s.trim()) || null;
const REPO_OWNER = getArg('repo-owner') || 'YanziMa';
const REPO_NAME = getArg('repo-name') || 'z-learning';

// ── Default Task List (matches GitHub Issues) ──
const DEFAULT_TASKS = [
  {
    id: 'phase0-tenant',
    label: 'Phase 0: Tenant 架构搭建',
    priority: 'P0',
    assignee: 'YanziMa',
    brief: `搭建 tenant 配置机制，支持两版本独立构建部署。

实现清单：
1. core/engine/tenant.js — tenant 配置加载、品牌注入、localStorage key 隔离
2. variants/default/config.js — 标准版配置
3. variants/yangcong/config.js — 洋葱版配置（primaryColor: #FF6B35, features: adaptiveDiagnosis/learningPlan/pathLearning/masteryLoop 全开）
4. .env.yangcong — VITE_VARIANT=yangcong
5. package.json 新增 build:yangcong / dev:yangcong / build:default 脚本
6. wrangler.yangcong.toml 洋葱版部署配置
7. src/main.js 改造：init() 变成 async，先 initTenant() 再加载数据；所有 localStorage key 常量改为 let，init 中用 storageKey() 重映射

接口约定：
- initTenant() → 加载租户配置 + 注入品牌 CSS 变量 + 设置 storage 前缀
- getTenant() → 返回当前租户配置
- isTenant(id) → 判断当前租户
- hasFeature(name) → 判断功能开关
- storageKey(key) → 生成带租户前缀的 localStorage key

验收标准：
- npm run build 通过
- npm run build:yangcong 通过
- yangcong 构建产物包含 "洋葱学园智能学"
- 两个版本的 localStorage key 互不干扰`,
  },
  {
    id: 'phase1-knowledge-graph',
    label: 'Phase 1: 知识图谱数据 + KnowledgeGraph 引擎',
    priority: 'P0',
    assignee: 'YanziMa',
    brief: `整理初中数学知识点数据，实现 KnowledgeGraph 引擎类。

实现清单：
1. variants/yangcong/knowledge-data/math-junior.json — 50 个核心知识点（初一到初二），每个含 id/name/grade/chapter/section/prerequisites/difficulty/estimatedMinutes/tags
2. core/engine/knowledge-graph.js — KnowledgeGraph 类：
   - getNode(id), getPrerequisites(id), getDescendants(id)
   - getNodesByGrade(grade), getNodesByChapter(chapter), getGrades(), getChaptersByGrade(grade)
   - getTopologicalOrder() (Kahn 算法)
   - findPath(fromId, toId) (BFS)
   - getSubgraph(nodeIds), getRootNodes(), validate()
   - createKnowledgeGraph() 工厂函数
   - loadKnowledgeGraph(url) 异步加载

验收标准：
- npm run build 通过
- node test-engine.mjs 通过（图谱加载、拓扑排序、前置依赖递归）`,
  },
  {
    id: 'phase3-cat',
    label: 'Phase 3: CAT 自适应诊断算法',
    priority: 'P0',
    assignee: 'YanziMa',
    brief: `实现简化版 CAT 自适应选题算法。

实现清单：
1. core/engine/cat.js：
   - createDiagnosisSession({ grade, graph, questionPool, existingMastery, config }) → 诊断会话
   - selectNextQuestion(session) → { question, progress: { current, estimated }, isComplete }
   - submitAnswer(session, { questionId, userAnswer, correct }) → { updatedMastery, isComplete }
   - getDiagnosisResult(session) → 学生画像
   - serializeSession(session) / restoreSession(data, graph, questionPool)
   - 简化版选题策略：答对→后继知识点，答错→前置知识点
   - 置信度收敛：所有候选知识点置信度 > 阈值 → 诊断结束
   - 配置：maxQuestions(12), minQuestions(6), confidenceThreshold(0.75)

验收标准：
- npm run build 通过
- node test-engine.mjs 模拟诊断跑通（7-10 题出画像）
- 诊断结果包含红黄绿灯统计`,
  },
  {
    id: 'phase4-pathplanner',
    label: 'Phase 4: 学习路径规划引擎',
    priority: 'P0',
    assignee: 'YanziMa',
    brief: `实现学习计划生成算法。

实现清单：
1. core/engine/path-planner.js：
   - generatePlan(studentProfile, config) → { sessions: [{ index, duration, points: [{ id, name, minutes }] }] }
     - config = { frequency: 2, duration: 60, weeks: 4 }
     - 从薄弱点出发，拓扑排序确定学习顺序
     - 前置知识优先
     - 按时间分配知识点（每知识点估算 15-30 分钟）
     - 每个 session 留 10% 缓冲
   - adjustPlan(currentPlan, sessionResult, masteryMap) → 调整后的计划
     - MVP 简化：预留接口，暂不实现动态调整

验收标准：
- npm run build 通过
- generatePlan 输出符合接口约定
- 计划中知识点按拓扑序排列（前置在前）
- 计划时长不超过 config.duration`,
  },
  {
    id: 'phase5-mastery-loop',
    label: 'Phase 5: 互动教学 + Quiz 闭环引擎',
    priority: 'P0',
    assignee: 'YanziMa',
    brief: `实现互动教学内容生成 + Quiz→失败→重出题闭环。

实现清单：
1. core/engine/mastery-loop.js：
   - getLessonContent(knowledgePointId) → { steps: [{ type, title, body, quiz? }] }
     - 步骤类型：concept / example / micro-quiz / summary
     - 调用 LLM 生成教学内容
   - generateQuiz(knowledgePointId) → { questions: [{ content, options, correct, type }] }
   - checkMastery(quizResult) → { passed, masteryLevel, shouldRetry }
     - 正确率 ≥ 70% → 通过，点绿灯
     - 正确率 < 70% → 重出题（简化：不分析原因，直接换题）
     - 最多重试 2 次，仍未通过 → 点黄灯
   - 点灯逻辑：更新 masteryMap，通知 UI

验收标准：
- npm run build 通过
- checkMastery 对各种正确率返回正确等级
- 重试逻辑在最多 2 次后停止
- masteryMap 正确更新`,
  },
  {
    id: 'demo-question-bank',
    label: 'Demo 题库：50 知识点 × 4 道题',
    priority: 'P0',
    assignee: 'YanziMa',
    brief: `为知识图谱中的每个知识点准备 4 道选择题。

实现清单：
1. variants/yangcong/knowledge-data/questions.json
   - 每个知识点 4 道题：2 简单 + 1 中等 + 1 难
   - 题型：选择题为主
   - 格式：{ [pointId]: [{ id, content, options, correct, type, difficulty }] }

验收标准：
- JSON 格式正确
- 每道题的 correct 索引指向正确答案
- 所有 pointId 在 math-junior.json 中存在`,
  },
];

// ── GitHub Issue Integration ──
function loadIssuesAsTasks() {
  try {
    const cmd = `gh issue list --repo ${REPO_OWNER}/${REPO_NAME} --json number,title,labels,assignees --limit 20`;
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 30000 });
    const issues = JSON.parse(output);
    return issues.map(issue => ({
      id: `issue-${issue.number}`,
      label: issue.title,
      priority: issue.labels?.[0]?.name || 'P1',
      assignee: issue.assignees?.[0]?.login || '',
      brief: `Implement the feature described in GitHub Issue #${issue.number}: ${issue.title}.

Run: gh issue view ${issue.number} --repo ${REPO_OWNER}/${REPO_NAME}

Read the issue body for detailed requirements, acceptance criteria, and interface contracts.`,
      issueNumber: issue.number,
    }));
  } catch (err) {
    log(`Warning: Could not load GitHub issues: ${err.message?.slice(0, 80)}`);
    return null;
  }
}

// ── Progress Tracking ──
function loadProgress() {
  try {
    if (existsSync(PROGRESS_FILE)) {
      const data = JSON.parse(readFileSync(PROGRESS_FILE, 'utf-8'));
      if (typeof data.current_step_index === 'number') return data;
    }
  } catch {}
  return {
    current_step_index: 0,
    completed: [],
    failed: [],
    scores: {},
    start_time: new Date().toISOString(),
  };
}

function saveProgress(p) {
  mkdirSync(dirname(PROGRESS_FILE), { recursive: true });
  writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

// ── Helpers ──
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] ${msg}`);
}

function writeStatus(task, phase, elapsed, score) {
  writeFileSync(STATUS_FILE, JSON.stringify({
    current_task: task?.id || 'idle',
    phase,
    elapsed_minutes: Math.round(elapsed / 60000),
    latest_score: score,
    timestamp: new Date().toISOString(),
  }, null, 2));
}

// ── Scout Agent ──
function runScout(task) {
  const briefPath = join(BRIEFS_DIR, `${task.id}-scout.json`);
  if (existsSync(briefPath)) {
    try {
      const data = JSON.parse(readFileSync(briefPath, 'utf-8'));
      if (data.coder_brief) {
        log(`  Scout: brief exists for ${task.id}, reusing`);
        return data;
      }
    } catch {}
  }

  log(`  Scout: generating brief for ${task.id}...`);
  const brief = {
    task_id: task.id,
    label: task.label,
    priority: task.priority || 'P1',
    assignee: task.assignee || null,
    coder_brief: task.brief,
    project_root: PROJECT_ROOT,
    timestamp: new Date().toISOString(),
  };

  mkdirSync(BRIEFS_DIR, { recursive: true });
  writeFileSync(briefPath, JSON.stringify(brief, null, 2));
  log(`  Scout: brief saved for ${task.id}`);
  return brief;
}

// ── Agent Runner ──
function runAgent(agentRole, prompt, timeoutMs = 20 * 60 * 1000) {
  const fullPrompt = `[Role: ${agentRole}]\n\n${prompt}`;

  const escaped = fullPrompt
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\$/g, '\\$');

  const cmd = `claude -p "${escaped}" --dangerously-skip-permissions --max-turns 50`;

  log(`  Running ${agentRole}...`);
  try {
    execSync(cmd, { cwd: PROJECT_ROOT, stdio: 'inherit', timeout: timeoutMs, shell: true });
    log(`  ${agentRole} completed.`);
    return { success: true };
  } catch (err) {
    const msg = err.status === null ? 'timeout' : `exit code ${err.status}`;
    log(`  ${agentRole} ${msg}: ${err.message?.slice(0, 80) || ''}`);
    return { success: false, error: msg };
  }
}

// ── Coder Agent ──
function runCoder(task, scoutBrief, retryCount = 0) {
  const coderPrompt = `You are building the Z-Learning Agentic Learning engine. Implement the following feature.

PROJECT ROOT: ${PROJECT_ROOT}

TECH CONTEXT:
- Vite + vanilla JS (no framework)
- core/engine/ for engine modules, src/ for UI
- Cloudflare Pages + DeepSeek/GLM API backend
- Build: npm run build (default) or npm run build:yangcong (洋葱版)
- Test: node test-engine.mjs

EXISTING ARCHITECTURE:
- core/engine/tenant.js — tenant config management
- core/engine/knowledge-graph.js — knowledge graph engine
- core/engine/mastery-model.js — mastery level tracking
- core/engine/cat.js — adaptive diagnosis
- variants/yangcong/knowledge-data/ — math knowledge points + question bank
- src/main.js — main UI file (large, ~300KB)

CRITICAL RULES:
1. Match existing code style (vanilla JS, function-based, same comment density)
2. Always run npm run build after changes — fix any errors
3. Always run node test-engine.mjs after engine changes — fix any failures
4. Never delete existing functionality
5. Never modify files outside the scope of this task

IMPLEMENT: ${scoutBrief.coder_brief}

When done, write a JSON report to coder/reports/${task.id}.json with:
{ task, status, files_modified, files_created, build_passed, test_passed, changes_summary, blocker, interfaces_exposed }`;

  return runAgent('Coder' + (retryCount > 0 ? ` (retry ${retryCount})` : ''), coderPrompt, 20 * 60 * 1000);
}

// ── Reviewer Agent ──
function runReviewer(task) {
  const reviewerPrompt = `You are the Reviewer Agent for Z-Learning. Review the code for task: ${task.label} (${task.id}).

PROJECT ROOT: ${PROJECT_ROOT}

REVIEW CHECKLIST (score each 0-10):
1. Build: Does npm run build pass without errors?
2. Tests: Does node test-engine.mjs pass? (for engine changes)
3. Interface Contract: Does the code match the interface spec?
4. Edge Cases: Are null/undefined/empty inputs handled?
5. Code Style: Does it match existing patterns?
6. No Regressions: Does existing functionality still work?
7. Performance: No obvious issues (no N² loops, no memory leaks)
8. Documentation: Are new functions documented?

MODE 2 — FIX SYSTEMIC ISSUES:
If you find build errors, broken imports, interface mismatches, or shared module bugs, FIX THEM DIRECTLY.
After fixing, run npm run build and node test-engine.mjs again.

OUTPUT:
1. Score each criterion 0-10
2. Total = sum / 8 (max 80, scaled to 100)
3. Write report to reviewer/reports/${task.id}.json with: scores{}, total_scaled, passed, issues[], fixes_applied[], fix_brief`;

  return runAgent('Reviewer', reviewerPrompt, 15 * 60 * 1000);
}

function checkReviewScore(taskId) {
  const reportPath = join(HARNESS_ROOT, 'reviewer', 'reports', `${taskId}.json`);
  try {
    if (!existsSync(reportPath)) return { passed: false, score: 0 };
    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    const score = report.total_scaled ?? report.score ?? 0;
    return { passed: score >= SCORE_THRESHOLD, score };
  } catch {
    return { passed: false, score: 0 };
  }
}

// ── Scorer ──
function runScorer(task) {
  const scorerPrompt = `You are the Scorer Agent for Z-Learning. Verify that task "${task.label}" (${task.id}) is correctly implemented.

PROJECT ROOT: ${PROJECT_ROOT}

SCORING STEPS:
1. Run: cd ${PROJECT_ROOT} && npm run build — must pass
2. Run: cd ${PROJECT_ROOT} && npm run build:yangcong — must pass
3. Run: cd ${PROJECT_ROOT} && node test-engine.mjs — must pass (if engine changes)
4. Check specific acceptance criteria from the task brief

SCORE THRESHOLDS:
- ≥ 90%: Excellent (all checks pass, no warnings)
- 70-89%: Acceptable (critical checks pass, minor warnings)
- < 70%: Needs fix (critical check failed)

Write score to scorer/latest-score.json with:
{ task, timestamp, build_passed, tests_passed, functional_checks: {}, score, issues[] }`;

  return runAgent('Scorer', scorerPrompt, 10 * 60 * 1000);
}

function checkScorerScore(taskId) {
  const scorePath = join(HARNESS_ROOT, 'scorer', 'latest-score.json');
  try {
    if (!existsSync(scorePath)) return null;
    const data = JSON.parse(readFileSync(scorePath, 'utf-8'));
    if (data.task === taskId) return data.score;
    return null;
  } catch {
    return null;
  }
}

// ── Main Pipeline ──
async function main() {
  const startTime = Date.now();
  const maxMs = MAX_HOURS * 60 * 60 * 1000;

  // Load tasks: prefer GitHub Issues, fallback to defaults
  let tasks = loadIssuesAsTasks() || DEFAULT_TASKS;

  // Filter specific tasks if requested
  if (SPECIFIC_TASKS) {
    tasks = tasks.filter(t => SPECIFIC_TASKS.includes(t.id));
    if (tasks.length === 0) {
      console.error('ERROR: No matching tasks for --tasks filter');
      process.exit(1);
    }
  }

  // Resume from progress
  const progress = loadProgress();
  const resumeIndex = Math.max(START_AT, progress.current_step_index || 0);
  tasks = tasks.slice(resumeIndex);

  console.log('\n' + '='.repeat(60));
  console.log('  Z-LEARNING: Multi-Agent Closed-Loop Pipeline v1');
  console.log(`  Tasks: ${tasks.length} | Max: ${MAX_HOURS === Infinity ? '∞' : MAX_HOURS + 'h'}`);
  console.log(`  Resume from step ${resumeIndex} | Project: ${PROJECT_ROOT}`);
  if (DRY_RUN) console.log('  *** DRY RUN — no agents will execute ***');
  console.log('='.repeat(60) + '\n');

  // ── Phase 1: Build ──
  log('═══ PHASE 1: Build ═══\n');

  let consecutiveFails = 0;

  for (let i = 0; i < tasks.length; i++) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= maxMs) {
      log(`\nTime limit reached (${MAX_HOURS}h). Stopping.`);
      break;
    }

    const task = tasks[i];
    const stepNum = resumeIndex + i + 1;

    console.log(`\n${'='.repeat(50)}`);
    log(`[${stepNum}/${tasks.length + resumeIndex}] ${task.label} (${task.id})`);
    console.log(`${'='.repeat(50)}`);

    // Save progress
    progress.current_step_index = resumeIndex + i;
    saveProgress(progress);
    writeStatus(task, 'coding', Date.now() - startTime, null);

    // Step 1: Scout
    const scoutBrief = runScout(task);

    // Step 2: Coder (with retry)
    if (DRY_RUN) {
      log('(dry run — skipping coder)');
    } else {
      let coderOk = false;
      for (let retry = 0; retry <= MAX_CODER_RETRIES; retry++) {
        coderOk = runCoder(task, scoutBrief, retry).success;
        if (coderOk) break;
        if (retry < MAX_CODER_RETRIES) log(`  Coder retry ${retry + 1}/${MAX_CODER_RETRIES}`);
      }

      if (!coderOk) {
        log(`  SKIP: ${task.label} — Coder failed after ${MAX_CODER_RETRIES + 1} attempts`);
        progress.failed.push({ task: task.id, reason: 'coder_failed', step: stepNum });
        consecutiveFails++;
        if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
          log('Circuit breaker: 3 consecutive fails. Stopping Phase 1.');
          break;
        }
        saveProgress(progress);
        continue;
      }
    }

    // Step 3: Reviewer
    if (!DRY_RUN) {
      writeStatus(task, 'reviewing', Date.now() - startTime, null);
      runReviewer(task);
    }

    // Step 4: Scorer
    if (!DRY_RUN) {
      writeStatus(task, 'scoring', Date.now() - startTime, null);
      runScorer(task);
    }

    // Record result
    const review = DRY_RUN ? { passed: true, score: null } : checkReviewScore(task.id);
    const score = DRY_RUN ? null : checkScorerScore(task.id);

    if (review.passed || DRY_RUN) {
      progress.completed.push({ task: task.id, review_score: review.score, scorer_score: score, step: stepNum });
      consecutiveFails = 0;
    } else {
      consecutiveFails++;
      if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
        log('Circuit breaker: 3 consecutive fails. Stopping Phase 1.');
        break;
      }
    }
    progress.scores[task.id] = { review: review.score, scorer: score };
    saveProgress(progress);

    const min = Math.round((Date.now() - startTime) / 60000);
    log(`Progress: ${i + 1}/${tasks.length} | ${min}min elapsed`);
  }

  // ── Phase 2: Bounded Polish ──
  log('\n═══ PHASE 2: Polish Loop ═══\n');

  let totalPolishRounds = 0;

  if (!DRY_RUN && tasks.length > 0) {
    // Build candidate list: tasks below threshold
    function getCandidates() {
      return tasks
        .map(t => ({
          task: t,
          score: progress.scores[t.id]?.scorer ?? progress.scores[t.id]?.review ?? 0,
          polishCount: progress.scores[t.id]?.polish_count ?? 0,
        }))
        .filter(c => c.score < SCORE_THRESHOLD && c.polishCount < MAX_POLISH_PER_TASK && c.score > 0)
        .sort((a, b) => a.score - b.score);
    }

    while (totalPolishRounds < MAX_TOTAL_POLISH) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= maxMs) {
        log(`Time limit reached. Stopping polish after ${totalPolishRounds} rounds.`);
        break;
      }

      const candidates = getCandidates();
      if (candidates.length === 0) {
        log('All tasks above threshold or maxed out polish rounds. Done.');
        break;
      }

      const { task: target, score: prevScore, polishCount } = candidates[0];
      totalPolishRounds++;

      log(`\nPolish #${totalPolishRounds}/${MAX_TOTAL_POLISH}: ${target.label} (${prevScore}pts) [attempt ${polishCount + 1}/${MAX_POLISH_PER_TASK}]`);

      // Delete old scout brief to force regeneration
      const briefPath = join(BRIEFS_DIR, `${target.id}-scout.json`);
      try { unlinkSync(briefPath); } catch {}

      const scoutBrief = runScout(target);

      // Polish-specific coder prompt
      const polishPrompt = `Task "${target.label}" scored ${prevScore} (target: ${SCORE_THRESHOLD}).

Review the reviewer/reports/${target.id}.json and scorer/latest-score.json for specific issues.

PROJECT ROOT: ${PROJECT_ROOT}

Fix the issues. Focus on:
- Build errors
- Test failures
- Interface contract mismatches
- Missing edge case handling
- Code style violations

After fixing, run: npm run build && node test-engine.mjs`;

      const polishResult = runAgent('Coder (Polish)', polishPrompt, 15 * 60 * 1000);
      if (!polishResult.success) {
        log(`  Polish failed for ${target.label}, skipping`);
        progress.scores[target.id] = {
          ...progress.scores[target.id],
          polish_count: MAX_POLISH_PER_TASK,
        };
        saveProgress(progress);
        continue;
      }

      runReviewer(target);
      runScorer(target);

      const newReviewScore = checkReviewScore(target.id);
      const newScorerScore = checkScorerScore(target.id);
      const newScore = newScorerScore ?? newReviewScore.score ?? 0;
      const improvement = newScore - prevScore;

      log(`  Result: ${newScore}pts (Δ ${improvement >= 0 ? '+' : ''}${improvement.toFixed(1)})`);

      // Update progress
      const newPolishCount = polishCount + 1;
      progress.scores[target.id] = {
        ...progress.scores[target.id],
        review: newReviewScore.score,
        scorer: newScorerScore,
        polish_count: newPolishCount,
      };
      saveProgress(progress);

      // ── Safety: decline/flat → mark exhausted ──
      if (newScore < prevScore) {
        log(`  ↓ Score declined for ${target.label}. Stopping polish on this task.`);
        progress.scores[target.id].polish_count = MAX_POLISH_PER_TASK;
        saveProgress(progress);
        continue;
      }

      if (improvement < MIN_IMPROVEMENT) {
        log(`  → Improvement < ${MIN_IMPROVEMENT}pts. Stopping polish on this task.`);
        progress.scores[target.id].polish_count = MAX_POLISH_PER_TASK;
        saveProgress(progress);
        continue;
      }
    }
  }

  // ── Final Report ──
  const totalMin = Math.round((Date.now() - startTime) / 60000);

  console.log(`\n${'='.repeat(60)}`);
  log(`PIPELINE COMPLETE: ${totalMin} minutes | ${totalPolishRounds} polish rounds`);

  console.log('\n  Per-task scores:');
  for (const t of tasks) {
    const s = progress.scores[t.id];
    const review = s?.review ?? '-';
    const scorer = s?.scorer ?? '-';
    const pc = s?.polish_count ?? 0;
    const best = Math.max(Number(review) || 0, Number(scorer) || 0);
    const bar = '█'.repeat(Math.round(best / 2.5));
    console.log(`    ${t.label.padEnd(35)} review=${String(review).padStart(4)} scorer=${String(scorer).padStart(4)}  ${bar}  (polish: ${pc})`);
  }

  log(`Progress: ${PROGRESS_FILE}`);
  console.log('='.repeat(60) + '\n');

  // Save final progress
  progress.phase = 'complete';
  progress.end_time = new Date().toISOString();
  progress.total_minutes = totalMin;
  progress.total_polish_rounds = totalPolishRounds;
  saveProgress(progress);
}

main().catch(e => { console.error('Orchestrator Fatal:', e); process.exit(1); });
