import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = dirname(SCRIPT_DIR);
const AGENTS_DIR = join(HARNESS_ROOT, '.claude', 'agents');
const SCHEMA_VERSION = 1;
const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;

const DEFAULT_POLICY = {
  scoreThreshold: 70,
  maxCoderAttempts: 3,
  maxPolishPerTask: 3,
  maxTotalPolish: 15,
  minImprovement: 2,
  maxConsecutiveFailures: 3,
  maxRunMinutes: 120,
};

const DEFAULT_TIMEOUTS = {
  coder: 20 * 60 * 1000,
  reviewer: 15 * 60 * 1000,
  scorer: 10 * 60 * 1000,
};

const SAFE_BASE_ENV = [
  'PATH',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
];

const ROLE_CONFIG = {
  coder: {
    tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write'],
    allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write'],
    permissionMode: 'acceptEdits',
  },
  reviewer: {
    tools: ['Read', 'Glob', 'Grep'],
    allowedTools: ['Read', 'Glob', 'Grep'],
    permissionMode: 'dontAsk',
  },
  scorer: {
    tools: ['Read', 'Glob', 'Grep'],
    allowedTools: ['Read', 'Glob', 'Grep'],
    permissionMode: 'dontAsk',
  },
};

const ROLE_SCHEMAS = {
  coder: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ready: { type: 'boolean' },
      summary: { type: 'string' },
      notes: { type: 'array', items: { type: 'string' } },
    },
    required: ['ready', 'summary', 'notes'],
  },
  reviewer: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      blockingIssues: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            file: { type: 'string' },
            line: { type: 'integer', minimum: 1 },
            message: { type: 'string' },
          },
          required: ['file', 'message'],
        },
      },
      observations: { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'blockingIssues', 'observations'],
  },
  scorer: {
    type: 'object',
    additionalProperties: false,
    properties: {
      score: { type: 'number', minimum: 0, maximum: 100 },
      functionalChecks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            criterionIndex: { type: 'integer', minimum: 0 },
            passed: { type: 'boolean' },
            evidence: { type: 'string' },
          },
          required: ['criterionIndex', 'passed', 'evidence'],
        },
      },
      issues: { type: 'array', items: { type: 'string' } },
    },
    required: ['score', 'functionalChecks', 'issues'],
  },
};

const HELP = `Generic multi-agent development harness

Usage:
  node scripts/orchestrator.mjs [options]

Options:
  --config <path>        Config file (default: harness.config.json)
  --project-root <path>  Override config.projectRoot
  --tasks <ids>          Comma-separated task IDs or GitHub issue numbers
  --hours <number>       Override the positive run time limit
  --resume <run-id>      Explicitly resume one compatible run
  --dry-run              Validate and print the frozen plan without writing
  --help                 Show this help
`;

export class HarnessError extends Error {}

function invariant(condition, message) {
  if (!condition) throw new HarnessError(message);
}

function nowIso() {
  return new Date().toISOString();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
}

function readJson(path, label = path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new HarnessError(`Cannot read ${label}: ${error.message}`);
  }
}

export function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function appendEvent(runDir, event) {
  appendFileSync(join(runDir, 'events.jsonl'), `${JSON.stringify({ at: nowIso(), ...event })}\n`, { mode: 0o600 });
}

function positiveNumber(value, label) {
  const number = Number(value);
  invariant(Number.isFinite(number) && number > 0, `${label} must be a positive number`);
  return number;
}

function nonNegativeNumber(value, label) {
  const number = Number(value);
  invariant(Number.isFinite(number) && number >= 0, `${label} must be a non-negative number`);
  return number;
}

function safeId(value, label = 'id') {
  invariant(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value), `${label} is invalid`);
  return value;
}

function cleanRelativePath(value, label) {
  invariant(typeof value === 'string' && value.length > 0, `${label} must be a non-empty path`);
  const portable = value.replaceAll('\\', '/');
  invariant(!isAbsolute(value) && !portable.startsWith('/') && !/^[A-Za-z]:\//.test(portable) && !value.includes('\0'), `${label} must be relative`);
  const stripped = portable.replace(/^\.\//, '').replace(/\/+$/, '') || '.';
  invariant(!stripped.split('/').includes('..'), `${label} cannot contain ..`);
  const normalized = posix.normalize(stripped);
  return normalized;
}

function canonicalFuturePath(value) {
  const absolute = resolve(value);
  let ancestor = absolute;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    invariant(parent !== ancestor, `Cannot resolve path: ${value}`);
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), relative(ancestor, absolute));
}

function stringArray(value, label, { allowEmpty = false } = {}) {
  invariant(Array.isArray(value), `${label} must be an array`);
  const result = value.map((item, index) => {
    invariant(typeof item === 'string' && item.trim(), `${label}[${index}] must be a non-empty string`);
    return item.trim();
  });
  invariant(allowEmpty || result.length > 0, `${label} cannot be empty`);
  return result;
}

export function parseArgs(argv) {
  const parsed = {
    config: 'harness.config.json',
    projectRoot: null,
    tasks: null,
    hours: null,
    resume: null,
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--dry-run') parsed.dryRun = true;
    else if (flag === '--help' || flag === '-h') parsed.help = true;
    else if (['--config', '--project-root', '--tasks', '--hours', '--resume'].includes(flag)) {
      invariant(index + 1 < argv.length && !argv[index + 1].startsWith('--'), `${flag} requires a value`);
      const value = argv[++index];
      if (flag === '--config') parsed.config = value;
      if (flag === '--project-root') parsed.projectRoot = value;
      if (flag === '--tasks') {
        parsed.tasks = value.split(',').map(item => item.trim()).filter(Boolean);
        invariant(parsed.tasks.length > 0, '--tasks cannot be empty');
      }
      if (flag === '--hours') parsed.hours = positiveNumber(value, '--hours');
      if (flag === '--resume') parsed.resume = safeId(value, '--resume');
    } else {
      throw new HarnessError(`Unknown option: ${flag}`);
    }
  }

  invariant(!(parsed.resume && parsed.tasks), '--resume cannot be combined with --tasks');
  return parsed;
}

function normalizePolicy(raw = {}, hoursOverride = null) {
  const policy = { ...DEFAULT_POLICY, ...raw };
  policy.scoreThreshold = nonNegativeNumber(policy.scoreThreshold, 'policy.scoreThreshold');
  invariant(policy.scoreThreshold <= 100, 'policy.scoreThreshold must be at most 100');
  for (const key of ['maxCoderAttempts', 'maxPolishPerTask', 'maxTotalPolish', 'maxConsecutiveFailures']) {
    policy[key] = positiveNumber(policy[key], `policy.${key}`);
    invariant(Number.isInteger(policy[key]), `policy.${key} must be an integer`);
  }
  policy.minImprovement = nonNegativeNumber(policy.minImprovement, 'policy.minImprovement');
  policy.maxRunMinutes = hoursOverride ? hoursOverride * 60 : positiveNumber(policy.maxRunMinutes, 'policy.maxRunMinutes');
  return policy;
}

function normalizeAgent(raw = {}) {
  invariant(raw && typeof raw === 'object' && !Array.isArray(raw), 'agent must be an object');
  const command = raw.command || 'claude';
  invariant(typeof command === 'string' && command.trim(), 'agent.command must be a non-empty string');
  invariant(typeof raw.model === 'string' && raw.model.trim(), 'agent.model must be set explicitly');
  const timeoutsMs = { ...DEFAULT_TIMEOUTS, ...(raw.timeoutsMs || {}) };
  for (const role of Object.keys(DEFAULT_TIMEOUTS)) timeoutsMs[role] = positiveNumber(timeoutsMs[role], `agent.timeoutsMs.${role}`);
  const maxTurns = positiveNumber(raw.maxTurns ?? 50, 'agent.maxTurns');
  invariant(Number.isInteger(maxTurns), 'agent.maxTurns must be an integer');
  const maxBudgetUsd = raw.maxBudgetUsd == null ? null : positiveNumber(raw.maxBudgetUsd, 'agent.maxBudgetUsd');
  return {
    command: command.trim(),
    model: raw.model.trim(),
    bare: raw.bare !== false,
    maxTurns,
    maxBudgetUsd,
    timeoutsMs,
  };
}

function normalizeChecks(raw) {
  invariant(Array.isArray(raw) && raw.length > 0, 'checks must contain at least one deterministic check');
  const ids = new Set();
  return raw.map((check, index) => {
    invariant(check && typeof check === 'object' && !Array.isArray(check), `checks[${index}] must be an object`);
    const id = safeId(check.id, `checks[${index}].id`);
    invariant(!ids.has(id), `Duplicate check id: ${id}`);
    ids.add(id);
    invariant(typeof check.command === 'string' && check.command.trim(), `checks[${index}].command is required`);
    const args = check.args == null ? [] : stringArray(check.args, `checks[${index}].args`, { allowEmpty: true });
    return {
      id,
      command: check.command.trim(),
      args,
      cwd: cleanRelativePath(check.cwd || '.', `checks[${index}].cwd`),
      timeoutMs: positiveNumber(check.timeoutMs ?? 10 * 60 * 1000, `checks[${index}].timeoutMs`),
    };
  });
}

function normalizeTaskSource(raw, configDir, checkIds) {
  invariant(raw && typeof raw === 'object' && !Array.isArray(raw), 'taskSource must be an object');
  invariant(['manifest', 'github'].includes(raw.type), 'taskSource.type must be manifest or github');
  if (raw.type === 'manifest') {
    invariant(typeof raw.path === 'string' && raw.path.trim(), 'taskSource.path is required');
    return { type: 'manifest', path: resolve(configDir, raw.path) };
  }

  invariant(typeof raw.repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw.repository), 'taskSource.repository must be owner/name');
  const requiredChecks = raw.requiredChecks == null ? [...checkIds] : stringArray(raw.requiredChecks, 'taskSource.requiredChecks');
  for (const id of requiredChecks) invariant(checkIds.has(id), `Unknown taskSource check: ${id}`);
  const dependencies = raw.dependencies || {};
  invariant(dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies), 'taskSource.dependencies must be an object');
  const state = raw.state || 'open';
  invariant(['open', 'closed', 'all'].includes(state), 'taskSource.state must be open, closed, or all');
  const limit = positiveNumber(raw.limit ?? 20, 'taskSource.limit');
  invariant(Number.isInteger(limit), 'taskSource.limit must be an integer');
  const allowedAuthors = stringArray(raw.allowedAuthors || [], 'taskSource.allowedAuthors', { allowEmpty: true });
  invariant(allowedAuthors.length <= 1, 'taskSource.allowedAuthors supports at most one author');
  return {
    type: 'github',
    repository: raw.repository,
    state,
    limit,
    requiredLabels: stringArray(raw.requiredLabels || [], 'taskSource.requiredLabels', { allowEmpty: true }),
    allowedAuthors,
    editablePaths: stringArray(raw.editablePaths || [], 'taskSource.editablePaths').map((path, index) => cleanRelativePath(path, `taskSource.editablePaths[${index}]`)),
    requiredChecks,
    dependencies,
  };
}

export function loadConfig(configPath, options = {}) {
  const absolutePath = resolve(options.cwd || process.cwd(), configPath);
  const configDir = dirname(absolutePath);
  const raw = readJson(absolutePath, 'config');
  invariant(raw.schemaVersion === SCHEMA_VERSION, `config.schemaVersion must be ${SCHEMA_VERSION}`);
  const projectRootValue = options.projectRoot || raw.projectRoot;
  invariant(typeof projectRootValue === 'string' && projectRootValue.trim(), 'projectRoot must be set in config or CLI');
  const checks = normalizeChecks(raw.checks);
  const checkIds = new Set(checks.map(check => check.id));
  const config = {
    schemaVersion: SCHEMA_VERSION,
    configPath: absolutePath,
    configDir,
    projectRoot: resolve(configDir, projectRootValue),
    stateDir: canonicalFuturePath(resolve(configDir, raw.stateDir || '.harness')),
    taskSource: normalizeTaskSource(raw.taskSource, configDir, checkIds),
    agent: normalizeAgent(raw.agent),
    checks,
    passEnv: stringArray(raw.passEnv || [], 'passEnv', { allowEmpty: true }),
    rolePrompts: Object.fromEntries(Object.keys(ROLE_CONFIG).map(role => [role, readRolePrompt(role)])),
    policy: normalizePolicy(raw.policy, options.hours),
  };
  for (const name of config.passEnv) invariant(/^[A-Za-z_][A-Za-z0-9_]*$/.test(name), `Invalid passEnv name: ${name}`);
  config.hash = sha256({ ...config, hash: undefined });
  return config;
}

function normalizeTask(task, index, checkIds) {
  invariant(task && typeof task === 'object' && !Array.isArray(task), `tasks[${index}] must be an object`);
  const id = safeId(task.id, `tasks[${index}].id`);
  invariant(typeof task.title === 'string' && task.title.trim(), `Task ${id} needs a title`);
  invariant(typeof task.description === 'string' && task.description.trim(), `Task ${id} needs a description`);
  const acceptanceCriteria = stringArray(task.acceptanceCriteria, `Task ${id} acceptanceCriteria`);
  const editablePaths = stringArray(task.editablePaths, `Task ${id} editablePaths`).map((path, pathIndex) => cleanRelativePath(path, `Task ${id} editablePaths[${pathIndex}]`));
  const requiredChecks = stringArray(task.requiredChecks, `Task ${id} requiredChecks`);
  for (const check of requiredChecks) invariant(checkIds.has(check), `Task ${id} references unknown check ${check}`);
  const dependsOn = stringArray(task.dependsOn || [], `Task ${id} dependsOn`, { allowEmpty: true });
  for (const dependency of dependsOn) safeId(dependency, `Task ${id} dependency`);
  return {
    id,
    title: task.title.trim(),
    description: task.description.trim(),
    acceptanceCriteria,
    editablePaths,
    requiredChecks,
    dependsOn,
    source: task.source || { type: 'manifest' },
    sourceHash: task.sourceHash || sha256(task),
    order: index,
  };
}

export function validateTasks(rawTasks, checks) {
  invariant(Array.isArray(rawTasks) && rawTasks.length > 0, 'Task source returned no tasks');
  const checkIds = new Set(checks.map(check => check.id));
  const tasks = rawTasks.map((task, index) => normalizeTask(task, index, checkIds));
  const byId = new Map();
  for (const task of tasks) {
    invariant(!byId.has(task.id), `Duplicate task id: ${task.id}`);
    byId.set(task.id, task);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      invariant(dependency !== task.id, `Task ${task.id} cannot depend on itself`);
      invariant(byId.has(dependency), `Task ${task.id} has unknown dependency ${dependency}`);
    }
  }

  const ordered = [];
  const remaining = [...tasks];
  while (remaining.length) {
    const readyIndex = remaining.findIndex(task => task.dependsOn.every(id => ordered.some(done => done.id === id)));
    invariant(readyIndex >= 0, 'Task dependencies contain a cycle');
    ordered.push(remaining.splice(readyIndex, 1)[0]);
  }
  return ordered.map(({ order: _order, ...task }) => task);
}

export function selectTasks(tasks, requestedIds) {
  if (!requestedIds) return tasks;
  const requested = new Set(requestedIds.map(String));
  const selected = tasks.filter(task => requested.has(task.id) || requested.has(task.id.replace(/^issue-/, '')));
  invariant(selected.length === requested.size, `Unknown task selection; available: ${tasks.map(task => task.id).join(', ')}`);
  const selectedIds = new Set(selected.map(task => task.id));
  for (const task of selected) {
    for (const dependency of task.dependsOn) invariant(selectedIds.has(dependency), `Task ${task.id} requires selected dependency ${dependency}`);
  }
  return selected;
}

function extractCriteria(body) {
  const checklist = body.split(/\r?\n/)
    .map(line => line.match(/^\s*[-*]\s+\[[ xX]\]\s+(.+)$/)?.[1]?.trim())
    .filter(Boolean);
  return checklist.length ? checklist : [body.trim()];
}

function issueToTask(issue, source) {
  const body = typeof issue.body === 'string' ? issue.body.trim() : '';
  invariant(body, `GitHub issue #${issue.number} has no body or acceptance context`);
  const id = `issue-${issue.number}`;
  const labels = (issue.labels || []).map(label => typeof label === 'string' ? label : label.name).filter(Boolean);
  const author = issue.author?.login || issue.author || '';
  return {
    id,
    title: issue.title,
    description: body,
    acceptanceCriteria: extractCriteria(body),
    editablePaths: source.editablePaths,
    requiredChecks: source.requiredChecks,
    dependsOn: source.dependencies[id] || [],
    source: {
      type: 'github',
      repository: source.repository,
      number: issue.number,
      url: issue.url || null,
      updatedAt: issue.updatedAt || null,
      author,
      labels,
    },
    sourceHash: sha256({ number: issue.number, title: issue.title, body, labels, author, updatedAt: issue.updatedAt }),
  };
}

function parseProcessJson(result, label) {
  invariant(result.success, `${label} failed: ${(result.stderr || result.error || 'unknown error').trim()}`);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new HarnessError(`${label} returned invalid JSON: ${error.message}`);
  }
}

export function loadGithubTasks(source, requestedIds, runner = runProcess) {
  const fields = 'number,title,body,labels,author,assignees,updatedAt,state,url';
  let issues;
  if (requestedIds) {
    issues = requestedIds.map(requested => {
      const match = String(requested).match(/^(?:issue-)?(\d+)$/);
      invariant(match, `GitHub task must be an issue number: ${requested}`);
      const result = runner('gh', ['issue', 'view', match[1], '--repo', source.repository, '--json', fields], { timeoutMs: 30_000 });
      return parseProcessJson(result, `GitHub issue ${match[1]}`);
    });
  } else {
    invariant(source.requiredLabels.length > 0 || source.allowedAuthors.length > 0, 'Automatic GitHub selection requires requiredLabels or allowedAuthors');
    const args = [
      'issue', 'list',
      '--repo', source.repository,
      '--state', source.state,
      '--limit', String(source.limit),
    ];
    for (const label of source.requiredLabels) args.push('--label', label);
    if (source.allowedAuthors.length) args.push('--author', source.allowedAuthors[0]);
    args.push('--json', fields);
    const result = runner('gh', args, { timeoutMs: 30_000 });
    issues = parseProcessJson(result, 'GitHub issue list');
    invariant(Array.isArray(issues), 'GitHub issue list must be an array');
    issues = issues.filter(issue => {
      const labels = new Set((issue.labels || []).map(label => typeof label === 'string' ? label : label.name));
      const author = issue.author?.login || issue.author || '';
      const labelsMatch = source.requiredLabels.every(label => labels.has(label));
      const authorMatches = source.allowedAuthors.length === 0 || source.allowedAuthors.includes(author);
      return labelsMatch && authorMatches;
    });
  }
  issues.sort((left, right) => Number(left.number) - Number(right.number));
  return issues.map(issue => issueToTask(issue, source));
}

export function loadTasks(config, requestedIds, runner = runProcess) {
  let tasks;
  if (config.taskSource.type === 'manifest') {
    const manifest = readJson(config.taskSource.path, 'task manifest');
    invariant(manifest.schemaVersion === SCHEMA_VERSION && Array.isArray(manifest.tasks), `task manifest schemaVersion must be ${SCHEMA_VERSION}`);
    tasks = manifest.tasks;
  } else {
    tasks = loadGithubTasks(config.taskSource, requestedIds, runner);
    requestedIds = null;
  }
  return selectTasks(validateTasks(tasks, config.checks), requestedIds);
}

export function runProcess(command, args = [], options = {}) {
  invariant(typeof command === 'string' && command.length > 0, 'runProcess command is required');
  invariant(Array.isArray(args) && args.every(arg => typeof arg === 'string'), 'runProcess args must be strings');
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    input: options.input,
    encoding: 'utf8',
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer || MAX_CAPTURE_BYTES,
    shell: false,
    windowsHide: true,
  });
  return {
    success: result.status === 0 && !result.error,
    status: result.status,
    signal: result.signal,
    timedOut: result.error?.code === 'ETIMEDOUT',
    error: result.error?.message || null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    durationMs: Date.now() - started,
  };
}

function git(projectRoot, args, options = {}) {
  return runProcess('git', ['-C', projectRoot, ...args], { ...options, env: process.env });
}

function requireProcess(result, label) {
  invariant(result.success, `${label} failed: ${(result.stderr || result.error || '').trim()}`);
  return result.stdout.trim();
}

function samePath(left, right) {
  return realpathSync(left) === realpathSync(right);
}

export function prepareProject(projectRoot) {
  const root = realpathSync(projectRoot);
  invariant(statSync(root).isDirectory(), 'projectRoot must be a directory');
  invariant(root !== realpathSync(resolve('/')), 'projectRoot cannot be the filesystem root');
  invariant(root !== realpathSync(homedir()), 'projectRoot cannot be the user home directory');
  invariant(!samePath(root, HARNESS_ROOT), 'projectRoot cannot be the harness repository');
  const topLevel = requireProcess(git(root, ['rev-parse', '--show-toplevel']), 'Git repository check');
  invariant(samePath(root, topLevel), 'projectRoot must be the Git repository root');
  const dirty = requireProcess(git(root, ['status', '--porcelain']), 'Git status');
  invariant(!dirty, 'projectRoot must have a clean working tree');
  const baseSha = requireProcess(git(root, ['rev-parse', 'HEAD']), 'Git HEAD');
  const commonDir = requireProcess(git(root, ['rev-parse', '--git-common-dir']), 'Git common directory');
  const branchResult = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const remoteResult = git(root, ['remote', 'get-url', 'origin']);
  return {
    root,
    baseSha,
    gitCommonDir: realpathSync(resolve(root, commonDir)),
    branch: branchResult.success ? branchResult.stdout.trim() : null,
    remote: remoteResult.success ? remoteResult.stdout.trim() : null,
  };
}

function buildSafeEnv(passEnv, temporaryHome = null) {
  const env = {};
  for (const name of new Set([...SAFE_BASE_ENV, ...passEnv])) {
    if (process.env[name] != null) env[name] = process.env[name];
  }
  if (temporaryHome) {
    mkdirSync(temporaryHome, { recursive: true });
    env.HOME = temporaryHome;
    env.USERPROFILE = temporaryHome;
    env.XDG_CONFIG_HOME = join(temporaryHome, '.config');
  }
  return env;
}

function makeRunId() {
  const timestamp = nowIso().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

function runPath(config, runId) {
  return join(config.stateDir, 'runs', safeId(runId, 'run id'));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function acquireLock(gitCommonDir, runId) {
  const path = join(gitCommonDir, 'agent-harness.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const descriptor = openSync(path, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, runId, startedAt: nowIso() }));
      closeSync(descriptor);
      return path;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existing = null;
      try { existing = JSON.parse(readFileSync(path, 'utf8')); } catch {}
      if (existing?.pid && isProcessAlive(existing.pid)) throw new HarnessError(`Harness is already running (pid ${existing.pid})`);
      unlinkSync(path);
    }
  }
  throw new HarnessError('Cannot acquire harness lock');
}

function releaseLock(path) {
  try { unlinkSync(path); } catch {}
}

function createTaskState(task) {
  return {
    id: task.id,
    status: 'pending',
    phase: null,
    baseSha: null,
    acceptedSha: null,
    bestCandidateSha: null,
    bestScore: null,
    polishCount: 0,
    failure: null,
    attempts: [],
  };
}

function createRunState(config, tasks, project, runId) {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    status: 'running',
    stopReason: null,
    configHash: config.hash,
    tasksHash: sha256(tasks),
    taskOrder: tasks.map(task => task.id),
    currentTaskId: null,
    pendingAdvance: null,
    resumeCount: 0,
    totalPolish: 0,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    endedAt: null,
    deadlineAt: new Date(Date.now() + config.policy.maxRunMinutes * 60_000).toISOString(),
    project: {
      root: project.root,
      remote: project.remote,
      baseSha: project.baseSha,
      headSha: project.baseSha,
      outputBranch: `harness/${runId}`,
    },
    tasks: Object.fromEntries(tasks.map(task => [task.id, createTaskState(task)])),
  };
}

function saveState(runDir, state) {
  state.updatedAt = nowIso();
  atomicWriteJson(join(runDir, 'state.json'), state);
}

export function validateRunIdentity(state, { config, tasks, project }) {
  invariant(state.schemaVersion === SCHEMA_VERSION, 'Run state schema is incompatible');
  invariant(state.configHash === config.hash, 'Run config changed; start a new run');
  invariant(state.tasksHash === sha256(tasks), 'Frozen task input changed; start a new run');
  invariant(state.project.root === project.root, 'Run projectRoot changed');
  invariant(state.project.baseSha === project.baseSha, 'Project HEAD changed since the run started');
  const branchHead = git(project.root, ['rev-parse', `refs/heads/${state.project.outputBranch}`]);
  invariant(branchHead.success, 'Run output branch is missing');
  const actualHead = branchHead.stdout.trim();
  if (state.pendingAdvance) {
    invariant(state.pendingAdvance.expectedSha === state.project.headSha, 'Pending branch advance has an invalid base');
    const pendingTask = state.tasks[state.pendingAdvance.taskId];
    invariant(pendingTask, 'Pending branch advance references an unknown task');
    invariant(pendingTask.attempts?.some(attempt => attempt.status === 'accepted' && attempt.candidateSha === state.pendingAdvance.candidateSha), 'Pending branch advance has no accepted attempt');
    invariant(git(project.root, ['cat-file', '-e', `${state.pendingAdvance.candidateSha}^{commit}`]).success, 'Pending branch advance candidate is missing');
    invariant(git(project.root, ['merge-base', '--is-ancestor', state.pendingAdvance.expectedSha, state.pendingAdvance.candidateSha]).success, 'Pending branch advance is not a fast-forward');
    invariant([state.pendingAdvance.expectedSha, state.pendingAdvance.candidateSha].includes(actualHead), 'Run output branch no longer matches pending state');
  } else {
    invariant(actualHead === state.project.headSha, 'Run output branch no longer matches saved state');
  }
  return true;
}

function reconcilePendingAdvance(state, project, runDir) {
  const pending = state.pendingAdvance;
  if (!pending) return;
  const actualHead = requireProcess(git(project.root, ['rev-parse', `refs/heads/${state.project.outputBranch}`]), 'Read pending output branch');
  if (actualHead === pending.expectedSha) {
    advanceRunBranch(project, state.project.outputBranch, pending.expectedSha, pending.candidateSha);
  } else {
    invariant(actualHead === pending.candidateSha, 'Cannot reconcile pending branch advance');
  }
  const taskState = state.tasks[pending.taskId];
  state.project.headSha = pending.candidateSha;
  taskState.status = 'accepted';
  taskState.phase = 'done';
  taskState.acceptedSha = pending.candidateSha;
  taskState.failure = null;
  state.pendingAdvance = null;
  appendEvent(runDir, { type: 'branch_advance_reconciled', taskId: taskState.id, candidateSha: taskState.acceptedSha });
  saveState(runDir, state);
}

function createOutputBranch(project, branch, baseSha) {
  const ref = `refs/heads/${branch}`;
  const existing = git(project.root, ['show-ref', '--verify', '--quiet', ref]);
  invariant(!existing.success, `Output branch already exists: ${branch}`);
  requireProcess(git(project.root, ['update-ref', ref, baseSha]), 'Create output branch');
}

function validateWorkspacePath(workspacesRoot, workspace) {
  const pathFromRoot = relative(workspacesRoot, workspace);
  invariant(pathFromRoot && !pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot), 'Unsafe workspace path');
}

export function createAttemptWorkspace(project, workspacesRoot, taskId, attempt, baseSha) {
  mkdirSync(workspacesRoot, { recursive: true });
  const workspace = join(workspacesRoot, `${safeId(taskId)}-${attempt}-${randomUUID().slice(0, 8)}`);
  validateWorkspacePath(workspacesRoot, workspace);
  requireProcess(git(project.root, ['worktree', 'add', '--detach', workspace, baseSha], { timeoutMs: 60_000 }), 'Create attempt worktree');
  return workspace;
}

export function removeAttemptWorkspace(project, workspacesRoot, workspace) {
  validateWorkspacePath(workspacesRoot, workspace);
  git(project.root, ['worktree', 'remove', '--force', workspace], { timeoutMs: 60_000 });
  if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
}

function pathIsEditable(path, editablePaths) {
  const normalized = path.replaceAll('\\', '/');
  return editablePaths.some(base => base === '.' || normalized === base || normalized.startsWith(`${base}/`));
}

function pathIsInside(root, target) {
  const fromRoot = relative(root, target);
  return fromRoot === '' || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !isAbsolute(fromRoot));
}

function assertTrackedSymlinksContained(workspace) {
  const root = realpathSync(workspace);
  const files = splitNulls(requireProcess(git(workspace, ['ls-files', '-z']), 'List tracked files'));
  for (const file of files) {
    const path = join(workspace, file);
    let stats;
    try {
      stats = lstatSync(path);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!stats.isSymbolicLink()) continue;
    let target;
    try {
      target = realpathSync(path);
    } catch (error) {
      throw new HarnessError(`Tracked symlink must resolve inside the worktree: ${file} (${error.message})`);
    }
    invariant(pathIsInside(root, target), `Tracked symlink escapes the worktree: ${file}`);
  }
}

function splitNulls(value) {
  return value.split('\0').filter(Boolean);
}

export function freezeCandidate({ workspace, hooksDir, task, taskBaseSha, candidateBaseSha = taskBaseSha, message }) {
  mkdirSync(hooksDir, { recursive: true });
  requireProcess(git(workspace, ['add', '-A']), 'Stage candidate');
  assertTrackedSymlinksContained(workspace);
  const changed = splitNulls(requireProcess(git(workspace, ['diff', '--cached', '--name-only', '-z']), 'List candidate files'));
  invariant(changed.length > 0, 'Coder produced no changes');
  const outside = changed.filter(path => !pathIsEditable(path, task.editablePaths));
  invariant(outside.length === 0, `Candidate changed files outside editablePaths: ${outside.join(', ')}`);
  requireProcess(git(workspace, [
    '-c', `core.hooksPath=${hooksDir}`,
    '-c', 'user.name=Agent Harness',
    '-c', 'user.email=agent-harness@localhost',
    'commit', '--no-gpg-sign', '-m', message,
  ], { timeoutMs: 60_000 }), 'Commit candidate');
  const candidateSha = requireProcess(git(workspace, ['rev-parse', 'HEAD']), 'Candidate SHA');
  const parents = requireProcess(git(workspace, ['rev-list', '--parents', '-n', '1', candidateSha]), 'Candidate parents').split(/\s+/);
  invariant(parents.length === 2 && parents[1] === candidateBaseSha, 'Candidate must be one orchestrator commit on its attempt base');
  const allChanged = splitNulls(requireProcess(git(workspace, ['diff', '--name-only', '-z', taskBaseSha, candidateSha]), 'List task changes'));
  const allOutside = allChanged.filter(path => !pathIsEditable(path, task.editablePaths));
  invariant(allOutside.length === 0, `Candidate history changed files outside editablePaths: ${allOutside.join(', ')}`);
  return { candidateSha, changedFiles: allChanged };
}

function assertHeadAt(workspace, expectedSha, label) {
  const head = requireProcess(git(workspace, ['rev-parse', 'HEAD']), `${label} HEAD`);
  invariant(head === expectedSha, `${label} changed the attempt base commit`);
}

function assertCandidateUnchanged(workspace, candidateSha, label) {
  assertHeadAt(workspace, candidateSha, label);
  const unstaged = git(workspace, ['diff', '--quiet', 'HEAD', '--']);
  const staged = git(workspace, ['diff', '--cached', '--quiet']);
  invariant(unstaged.status === 0 && staged.status === 0, `${label} modified the frozen candidate`);
}

function cleanIgnoredOutputs(workspace) {
  requireProcess(git(workspace, ['clean', '-ffdx']), 'Clean deterministic check outputs');
}

export function advanceRunBranch(project, branch, expectedSha, candidateSha) {
  invariant(git(project.root, ['merge-base', '--is-ancestor', expectedSha, candidateSha]).success, 'Output branch can only fast-forward');
  requireProcess(git(project.root, ['update-ref', `refs/heads/${branch}`, candidateSha, expectedSha]), 'Advance output branch');
}

function keepBestCandidate(project, runId, taskId, candidateSha) {
  requireProcess(git(project.root, ['update-ref', `refs/harness/${runId}/${safeId(taskId)}/best`, candidateSha]), 'Save best candidate');
}

function remainingMs(state) {
  return new Date(state.deadlineAt).getTime() - Date.now();
}

function boundedTimeout(state, configuredMs) {
  const remaining = remainingMs(state);
  invariant(remaining > 0, 'Run deadline reached');
  return Math.max(1, Math.min(configuredMs, remaining));
}

function readRolePrompt(role) {
  return readFileSync(join(AGENTS_DIR, `${role}.md`), 'utf8').trim();
}

export function parseAgentEnvelope(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch (error) {
    throw new HarnessError(`Agent returned invalid JSON: ${error.message}`);
  }
  if (envelope?.structured_output && typeof envelope.structured_output === 'object') return envelope.structured_output;
  if (envelope?.result && typeof envelope.result === 'object') return envelope.result;
  if (typeof envelope?.result === 'string') {
    try { return JSON.parse(envelope.result); } catch {}
  }
  if (envelope && typeof envelope === 'object' && !Array.isArray(envelope) && !envelope.type) return envelope;
  throw new HarnessError('Agent JSON did not contain structured_output');
}

function validateRolePayload(role, payload, criteriaCount = 0) {
  invariant(payload && typeof payload === 'object' && !Array.isArray(payload), `${role} payload must be an object`);
  if (role === 'coder') {
    invariant(typeof payload.ready === 'boolean' && typeof payload.summary === 'string' && Array.isArray(payload.notes), 'Invalid coder payload');
  }
  if (role === 'reviewer') {
    invariant(typeof payload.summary === 'string' && Array.isArray(payload.blockingIssues) && Array.isArray(payload.observations), 'Invalid reviewer payload');
    for (const issue of payload.blockingIssues) invariant(issue && typeof issue.file === 'string' && typeof issue.message === 'string', 'Invalid reviewer blocking issue');
  }
  if (role === 'scorer') {
    invariant(Number.isFinite(payload.score) && payload.score >= 0 && payload.score <= 100, 'Invalid scorer score');
    invariant(Array.isArray(payload.functionalChecks) && Array.isArray(payload.issues), 'Invalid scorer payload');
    const indices = new Set();
    for (const check of payload.functionalChecks) {
      invariant(Number.isInteger(check.criterionIndex) && check.criterionIndex >= 0 && check.criterionIndex < criteriaCount, 'Invalid scorer criterion index');
      invariant(!indices.has(check.criterionIndex), 'Duplicate scorer criterion index');
      indices.add(check.criterionIndex);
      invariant(typeof check.passed === 'boolean' && typeof check.evidence === 'string', 'Invalid scorer functional check');
    }
    invariant(indices.size === criteriaCount, 'Scorer did not evaluate every acceptance criterion');
  }
  return payload;
}

function runAgent({ role, context, workspace, config, state, name }) {
  const roleConfig = ROLE_CONFIG[role];
  const systemPrompt = config.rolePrompts[role];
  const prompt = `<task_context>\n${JSON.stringify(context, null, 2)}\n</task_context>`;
  const args = [
    '-p',
    '--append-system-prompt', systemPrompt,
    '--model', config.agent.model,
    '--max-turns', String(config.agent.maxTurns),
    '--tools', roleConfig.tools.join(','),
    '--allowedTools', roleConfig.allowedTools.join(','),
    '--permission-mode', roleConfig.permissionMode,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(ROLE_SCHEMAS[role]),
    '--no-session-persistence',
    '--disable-slash-commands',
    '--no-chrome',
    '--strict-mcp-config',
    '--name', name,
  ];
  if (config.agent.bare) args.push('--bare');
  else args.push('--setting-sources', 'user');
  if (config.agent.maxBudgetUsd != null) args.push('--max-budget-usd', String(config.agent.maxBudgetUsd));
  const processResult = runProcess(config.agent.command, args, {
    cwd: workspace,
    env: buildSafeEnv(config.passEnv, join(config.stateDir, 'runs', state.runId, 'agent-home')),
    input: prompt,
    timeoutMs: boundedTimeout(state, config.agent.timeoutsMs[role]),
  });
  let payload = null;
  let parseError = null;
  if (processResult.success) {
    try {
      payload = validateRolePayload(role, parseAgentEnvelope(processResult.stdout), context.acceptanceCriteria?.length || 0);
    } catch (error) {
      parseError = error.message;
    }
  }
  return {
    success: processResult.success && !parseError,
    payload,
    parseError,
    promptHash: sha256({ systemPrompt, prompt }),
    process: processResult,
  };
}

export function createArtifact(identity, payload) {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: identity.runId,
    taskId: identity.taskId,
    stage: identity.stage,
    attempt: identity.attempt,
    inputCommit: identity.inputCommit,
    createdAt: nowIso(),
    payload,
  };
}

export function validateArtifact(artifact, expected) {
  invariant(artifact?.schemaVersion === SCHEMA_VERSION, 'Artifact schema mismatch');
  for (const [key, value] of Object.entries(expected)) invariant(artifact[key] === value, `Artifact ${key} mismatch`);
  invariant(artifact.payload && typeof artifact.payload === 'object', 'Artifact payload missing');
  return artifact.payload;
}

function writeArtifact(path, identity, payload) {
  const artifact = createArtifact(identity, payload);
  atomicWriteJson(path, artifact);
  return artifact;
}

function processSummary(result) {
  return {
    success: result.success,
    status: result.status,
    signal: result.signal,
    timedOut: result.timedOut,
    error: result.error,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runChecks({ config, task, workspace, state }) {
  const byId = new Map(config.checks.map(check => [check.id, check]));
  const realWorkspace = realpathSync(workspace);
  return task.requiredChecks.map(id => {
    const check = byId.get(id);
    const cwd = resolve(workspace, check.cwd);
    const fromWorkspace = relative(workspace, cwd);
    invariant(!fromWorkspace.startsWith(`..${sep}`) && fromWorkspace !== '..' && !isAbsolute(fromWorkspace), `Check ${id} cwd escapes the workspace`);
    invariant(existsSync(cwd), `Check ${id} cwd does not exist`);
    invariant(pathIsInside(realWorkspace, realpathSync(cwd)), `Check ${id} cwd resolves outside the workspace`);
    const result = runProcess(check.command, check.args, {
      cwd,
      env: buildSafeEnv([], join(config.stateDir, 'runs', state.runId, 'check-home')),
      timeoutMs: boundedTimeout(state, check.timeoutMs),
    });
    return { id, ...processSummary(result), passed: result.success };
  });
}

function tail(value, length = 4000) {
  return value.length <= length ? value : value.slice(-length);
}

function compactMiddle(value, length = 60_000) {
  if (value.length <= length) return value;
  const half = Math.floor(length / 2);
  return `${value.slice(0, half)}\n... candidate diff truncated ...\n${value.slice(-half)}`;
}

export function evaluateAcceptance({ coder, candidateSha, changedFiles, task, reviewer, checks, scorer, scoreThreshold }) {
  const reasons = [];
  if (!coder?.success || !coder.payload?.ready) reasons.push('coder_failed');
  if (!candidateSha) reasons.push('candidate_missing');
  if (!changedFiles?.length) reasons.push('no_changes');
  if (changedFiles?.some(path => !pathIsEditable(path, task.editablePaths))) reasons.push('out_of_scope_changes');
  if (!reviewer?.success) reasons.push('review_invalid');
  if (reviewer?.payload?.blockingIssues?.length) reasons.push('review_blocked');
  const checksById = new Map((checks || []).map(check => [check.id, check]));
  for (const id of task.requiredChecks) {
    const check = checksById.get(id);
    if (!check) reasons.push(`check_missing:${id}`);
    else if (check.error && !check.timedOut) reasons.push(`check_invalid:${id}`);
    else if (!check.passed) reasons.push(`check_failed:${id}`);
  }
  if (!scorer?.success) reasons.push('score_invalid');
  const functionalChecks = scorer?.payload?.functionalChecks || [];
  const criterionIndices = new Set(functionalChecks.map(check => check.criterionIndex));
  if (functionalChecks.length !== task.acceptanceCriteria.length
    || criterionIndices.size !== task.acceptanceCriteria.length
    || [...criterionIndices].some(index => !Number.isInteger(index) || index < 0 || index >= task.acceptanceCriteria.length)) reasons.push('criteria_incomplete');
  if (functionalChecks.some(check => !check.passed)) reasons.push('functional_check_failed');
  const score = scorer?.payload?.score;
  if (!Number.isFinite(score) || score < 0 || score > 100) reasons.push('score_invalid');
  else if (score < scoreThreshold) reasons.push('score_below_threshold');
  return {
    accepted: reasons.length === 0,
    reasons: [...new Set(reasons)],
    score: Number.isFinite(score) && score >= 0 && score <= 100 ? score : null,
  };
}

export function shouldPolish({ accepted, score, polishCount, evidenceValid = true }, policy) {
  return !accepted
    && evidenceValid
    && Number.isFinite(score)
    && polishCount < policy.maxPolishPerTask;
}

function evidenceSupportsPolish(acceptance) {
  return !acceptance.reasons.some(reason => [
    'coder_failed',
    'review_invalid',
    'score_invalid',
    'candidate_missing',
  ].includes(reason) || reason.startsWith('check_invalid:'));
}

function feedbackFrom(evaluation) {
  const feedback = [];
  for (const issue of evaluation.reviewer.payload?.blockingIssues || []) feedback.push(`${issue.file}${issue.line ? `:${issue.line}` : ''}: ${issue.message}`);
  for (const check of evaluation.checks.filter(check => !check.passed)) feedback.push(`Check ${check.id} failed:\n${tail(check.stderr || check.stdout)}`);
  for (const check of evaluation.scorer.payload?.functionalChecks || []) if (!check.passed) feedback.push(`Criterion ${check.criterionIndex} failed: ${check.evidence}`);
  for (const issue of evaluation.scorer.payload?.issues || []) feedback.push(issue);
  return feedback;
}

function attemptDirectory(runDir, taskId, attempt) {
  return join(runDir, 'tasks', safeId(taskId), `attempt-${String(attempt).padStart(3, '0')}`);
}

function taskContext(task, state, mode, feedback = [], inputCommit = state.project.headSha) {
  return {
    mode,
    runId: state.runId,
    taskId: task.id,
    title: task.title,
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    editablePaths: task.editablePaths,
    requiredChecks: task.requiredChecks,
    inputCommit,
    feedback,
    constraints: [
      'Do not commit, push, or write reports; the orchestrator owns those actions.',
      'Do not modify files outside editablePaths.',
      'Do not change tests merely to hide a product defect.',
    ],
  };
}

function evaluateCandidate({ config, state, task, taskState, attemptState, workspace, candidateSha, candidatePatch, coder, attemptDir }) {
  const identity = { runId: state.runId, taskId: task.id, attempt: attemptState.number, inputCommit: candidateSha };
  assertCandidateUnchanged(workspace, candidateSha, 'Frozen candidate');
  taskState.phase = 'reviewer';
  const reviewer = runAgent({
    role: 'reviewer',
    context: {
      ...taskContext(task, state, 'review', [], candidateSha),
      taskBaseCommit: taskState.baseSha,
      candidateCommit: candidateSha,
      changedFiles: attemptState.changedFiles,
      candidateDiff: compactMiddle(candidatePatch),
    },
    workspace,
    config,
    state,
    name: `${state.runId}-${task.id}-reviewer`,
  });
  writeArtifact(join(attemptDir, 'reviewer.json'), { ...identity, stage: 'reviewer' }, {
    success: reviewer.success,
    payload: reviewer.payload,
    parseError: reviewer.parseError,
    promptHash: reviewer.promptHash,
    process: processSummary(reviewer.process),
  });
  assertCandidateUnchanged(workspace, candidateSha, 'Reviewer');
  cleanIgnoredOutputs(workspace);
  assertCandidateUnchanged(workspace, candidateSha, 'Reviewer cleanup');

  taskState.phase = 'scorer';
  const checks = runChecks({ config, task, workspace, state });
  atomicWriteJson(join(attemptDir, 'checks.json'), checks);
  assertCandidateUnchanged(workspace, candidateSha, 'Deterministic checks');
  cleanIgnoredOutputs(workspace);
  assertCandidateUnchanged(workspace, candidateSha, 'Deterministic check cleanup');

  const scorerContext = {
    ...taskContext(task, state, 'score', [], candidateSha),
    candidateCommit: candidateSha,
    changedFiles: attemptState.changedFiles,
    deterministicChecks: checks.map(check => ({
      id: check.id,
      passed: check.passed,
      status: check.status,
      stdoutTail: tail(check.stdout),
      stderrTail: tail(check.stderr),
    })),
  };
  const scorer = runAgent({
    role: 'scorer',
    context: scorerContext,
    workspace,
    config,
    state,
    name: `${state.runId}-${task.id}-scorer`,
  });
  writeArtifact(join(attemptDir, 'scorer.json'), { ...identity, stage: 'scorer' }, {
    success: scorer.success,
    payload: scorer.payload,
    parseError: scorer.parseError,
    promptHash: scorer.promptHash,
    process: processSummary(scorer.process),
  });
  assertCandidateUnchanged(workspace, candidateSha, 'Scorer');
  cleanIgnoredOutputs(workspace);
  assertCandidateUnchanged(workspace, candidateSha, 'Scorer cleanup');

  const acceptance = evaluateAcceptance({
    coder,
    candidateSha,
    changedFiles: attemptState.changedFiles,
    task,
    reviewer,
    checks,
    scorer,
    scoreThreshold: config.policy.scoreThreshold,
  });
  atomicWriteJson(join(attemptDir, 'acceptance.json'), acceptance);
  return { reviewer, checks, scorer, acceptance };
}

function runCandidateCycle({ config, state, task, taskState, project, runDir, baseSha, taskBaseSha, mode, feedback }) {
  const workspacesRoot = join(config.stateDir, 'workspaces', state.runId);
  const hooksDir = join(runDir, 'empty-hooks');
  let lastFailure = null;

  for (let coderTry = 1; coderTry <= config.policy.maxCoderAttempts; coderTry++) {
    const attempt = taskState.attempts.length + 1;
    const attemptDir = attemptDirectory(runDir, task.id, attempt);
    mkdirSync(attemptDir, { recursive: true });
    const workspace = createAttemptWorkspace(project, workspacesRoot, task.id, attempt, baseSha);
    const attemptState = {
      number: attempt,
      kind: mode,
      status: 'running',
      baseSha,
      candidateSha: null,
      changedFiles: [],
      startedAt: nowIso(),
      endedAt: null,
      artifacts: relative(runDir, attemptDir),
    };
    taskState.attempts.push(attemptState);
    saveState(runDir, state);
    try {
      assertTrackedSymlinksContained(workspace);
      taskState.phase = mode === 'polish' ? 'polish' : 'coder';
      const context = taskContext(task, state, mode, feedback, baseSha);
      const coder = runAgent({
        role: 'coder',
        context,
        workspace,
        config,
        state,
        name: `${state.runId}-${task.id}-${mode}-${coderTry}`,
      });
      writeArtifact(join(attemptDir, 'coder.json'), {
        runId: state.runId,
        taskId: task.id,
        stage: mode === 'polish' ? 'polish' : 'coder',
        attempt,
        inputCommit: baseSha,
      }, {
        success: coder.success,
        payload: coder.payload,
        parseError: coder.parseError,
        promptHash: coder.promptHash,
        process: processSummary(coder.process),
      });
      if (!coder.success || !coder.payload?.ready) throw new HarnessError(coder.parseError || coder.process.stderr || 'Coder did not complete the task');
      assertHeadAt(workspace, baseSha, 'Coder');

      const frozen = freezeCandidate({
        workspace,
        hooksDir,
        task,
        taskBaseSha,
        candidateBaseSha: baseSha,
        message: `harness(${task.id}): ${mode} candidate`,
      });
      attemptState.candidateSha = frozen.candidateSha;
      attemptState.changedFiles = frozen.changedFiles;
      const patchResult = git(workspace, ['diff', '--binary', taskBaseSha, frozen.candidateSha]);
      invariant(patchResult.success, `Create candidate patch failed: ${(patchResult.stderr || patchResult.error || '').trim()}`);
      const patch = patchResult.stdout;
      writeFileSync(join(attemptDir, 'candidate.patch'), patch, { mode: 0o600 });

      const evaluation = evaluateCandidate({
        config,
        state,
        task,
        taskState,
        attemptState,
        workspace,
        candidateSha: frozen.candidateSha,
        candidatePatch: patch,
        coder,
        attemptDir,
      });
      attemptState.status = evaluation.acceptance.accepted ? 'accepted' : 'rejected';
      attemptState.score = evaluation.acceptance.score;
      attemptState.reasons = evaluation.acceptance.reasons;
      attemptState.endedAt = nowIso();
      saveState(runDir, state);
      return { ...frozen, coder, ...evaluation, attemptState };
    } catch (error) {
      lastFailure = error;
      attemptState.status = 'failed';
      attemptState.failure = error.message;
      attemptState.endedAt = nowIso();
      atomicWriteJson(join(attemptDir, 'failure.json'), { message: error.message });
      saveState(runDir, state);
    } finally {
      removeAttemptWorkspace(project, workspacesRoot, workspace);
    }
  }
  throw lastFailure || new HarnessError('Coder failed');
}

function acceptCandidate({ state, taskState, project, candidateSha, runDir }) {
  state.pendingAdvance = {
    taskId: taskState.id,
    expectedSha: state.project.headSha,
    candidateSha,
  };
  saveState(runDir, state);
  advanceRunBranch(project, state.project.outputBranch, state.project.headSha, candidateSha);
  state.project.headSha = candidateSha;
  taskState.status = 'accepted';
  taskState.phase = 'done';
  taskState.acceptedSha = candidateSha;
  taskState.failure = null;
  state.pendingAdvance = null;
  saveState(runDir, state);
}

function processTask({ config, state, task, project, runDir }) {
  const taskState = state.tasks[task.id];
  state.currentTaskId = task.id;
  taskState.status = 'running';
  taskState.phase = 'scout';
  taskState.baseSha = state.project.headSha;
  const brief = {
    schemaVersion: SCHEMA_VERSION,
    runId: state.runId,
    task,
    baseSha: taskState.baseSha,
    frozenAt: nowIso(),
  };
  const taskDir = join(runDir, 'tasks', task.id);
  mkdirSync(taskDir, { recursive: true });
  atomicWriteJson(join(taskDir, 'brief.json'), brief);
  appendEvent(runDir, { type: 'task_started', taskId: task.id, baseSha: taskState.baseSha });
  saveState(runDir, state);

  let best;
  try {
    best = runCandidateCycle({
      config,
      state,
      task,
      taskState,
      project,
      runDir,
      baseSha: taskState.baseSha,
      taskBaseSha: taskState.baseSha,
      mode: 'initial',
      feedback: [],
    });
  } catch (error) {
    taskState.status = 'failed';
    taskState.failure = error.message;
    taskState.phase = 'done';
    appendEvent(runDir, { type: 'task_failed', taskId: task.id, reason: error.message });
    saveState(runDir, state);
    return false;
  }

  if (best.acceptance.accepted) {
    acceptCandidate({ state, taskState, project, candidateSha: best.candidateSha, runDir });
    appendEvent(runDir, { type: 'task_accepted', taskId: task.id, candidateSha: best.candidateSha, score: best.acceptance.score });
    saveState(runDir, state);
    return true;
  }

  taskState.bestCandidateSha = best.candidateSha;
  taskState.bestScore = best.acceptance.score;
  keepBestCandidate(project, state.runId, task.id, best.candidateSha);
  saveState(runDir, state);

  while (shouldPolish({
    accepted: false,
    score: taskState.bestScore,
    polishCount: taskState.polishCount,
    evidenceValid: evidenceSupportsPolish(best.acceptance),
  }, config.policy)
    && state.totalPolish < config.policy.maxTotalPolish) {
    taskState.polishCount++;
    state.totalPolish++;
    const feedback = feedbackFrom(best);
    appendEvent(runDir, { type: 'polish_started', taskId: task.id, count: taskState.polishCount, score: taskState.bestScore });
    let candidate;
    try {
      candidate = runCandidateCycle({
        config,
        state,
        task,
        taskState,
        project,
        runDir,
        baseSha: taskState.bestCandidateSha,
        taskBaseSha: taskState.baseSha,
        mode: 'polish',
        feedback,
      });
    } catch (error) {
      taskState.failure = error.message;
      break;
    }

    if (candidate.acceptance.accepted) {
      acceptCandidate({ state, taskState, project, candidateSha: candidate.candidateSha, runDir });
      appendEvent(runDir, { type: 'task_accepted', taskId: task.id, candidateSha: candidate.candidateSha, score: candidate.acceptance.score });
      saveState(runDir, state);
      return true;
    }

    if (!evidenceSupportsPolish(candidate.acceptance)) {
      taskState.failure = candidate.acceptance.reasons.join(', ');
      break;
    }

    const previousScore = taskState.bestScore;
    const nextScore = candidate.acceptance.score;
    const improvement = Number.isFinite(nextScore) && Number.isFinite(previousScore) ? nextScore - previousScore : -Infinity;
    if (improvement < 0 || improvement < config.policy.minImprovement) {
      taskState.failure = improvement < 0 ? 'Polish score declined' : 'Polish improvement was below the minimum';
      break;
    }
    best = candidate;
    taskState.bestCandidateSha = candidate.candidateSha;
    taskState.bestScore = nextScore;
    keepBestCandidate(project, state.runId, task.id, candidate.candidateSha);
    saveState(runDir, state);
  }

  taskState.status = 'failed';
  taskState.phase = 'done';
  taskState.failure ||= best.acceptance.reasons.join(', ') || 'Acceptance failed';
  appendEvent(runDir, { type: 'task_failed', taskId: task.id, reason: taskState.failure });
  saveState(runDir, state);
  return false;
}

function reconcileResumeState(state, config) {
  state.status = 'running';
  state.stopReason = null;
  state.endedAt = null;
  state.currentTaskId = null;
  state.resumeCount = (state.resumeCount || 0) + 1;
  state.deadlineAt = new Date(Date.now() + config.policy.maxRunMinutes * 60_000).toISOString();
  for (const task of Object.values(state.tasks)) {
    if (task.status !== 'accepted') {
      task.status = 'pending';
      task.phase = null;
      task.failure = null;
    }
  }
}

function printPlan(config, tasks, project, resume, log = console.log) {
  log(`Project: ${project.root}`);
  log(`Base: ${project.baseSha}`);
  log(`Source: ${config.taskSource.type}`);
  log(`Tasks (${tasks.length}):`);
  for (const task of tasks) log(`  - ${task.id}: ${task.title}`);
  if (resume) log(`Resume: ${resume}`);
}

function snapshotConfig(config) {
  const { configPath: _configPath, configDir: _configDir, hash: _hash, ...snapshot } = config;
  return snapshot;
}

export function runPipeline({ config, tasks, project, resumeRunId = null, log = console.log }) {
  const runId = resumeRunId || makeRunId();
  const runDir = runPath(config, runId);
  const lock = acquireLock(project.gitCommonDir, runId);
  let state;
  try {
    if (resumeRunId) {
      state = readJson(join(runDir, 'state.json'), 'run state');
      validateRunIdentity(state, { config, tasks, project });
      reconcilePendingAdvance(state, project, runDir);
      if (state.status === 'completed') return { exitCode: 0, runId, state, runDir };
      reconcileResumeState(state, config);
      appendEvent(runDir, { type: 'run_resumed', runId });
    } else {
      invariant(!existsSync(runDir), `Run already exists: ${runId}`);
      mkdirSync(runDir, { recursive: true });
      createOutputBranch(project, `harness/${runId}`, project.baseSha);
      state = createRunState(config, tasks, project, runId);
      atomicWriteJson(join(runDir, 'config.json'), snapshotConfig(config));
      atomicWriteJson(join(runDir, 'manifest.json'), { schemaVersion: SCHEMA_VERSION, tasks });
      appendEvent(runDir, { type: 'run_started', runId, outputBranch: state.project.outputBranch });
    }
    saveState(runDir, state);

    let consecutiveFailures = 0;
    for (const task of tasks) {
      const taskState = state.tasks[task.id];
      if (taskState.status === 'accepted') continue;
      if (remainingMs(state) <= 0) {
        state.status = 'stopped';
        state.stopReason = 'deadline';
        break;
      }
      const failedDependency = task.dependsOn.find(id => state.tasks[id]?.status !== 'accepted');
      if (failedDependency) {
        taskState.status = 'blocked';
        taskState.failure = `Dependency not accepted: ${failedDependency}`;
        consecutiveFailures++;
        continue;
      }
      log(`[${task.id}] ${task.title}`);
      const accepted = processTask({ config, state, task, project, runDir });
      consecutiveFailures = accepted ? 0 : consecutiveFailures + 1;
      if (!accepted && remainingMs(state) <= 0) {
        state.status = 'stopped';
        state.stopReason = 'deadline';
        break;
      }
      if (consecutiveFailures >= config.policy.maxConsecutiveFailures) {
        state.status = 'stopped';
        state.stopReason = 'circuit_breaker';
        break;
      }
    }

    const allAccepted = tasks.every(task => state.tasks[task.id].status === 'accepted');
    if (allAccepted) state.status = 'completed';
    else if (state.status === 'running') state.status = 'failed';
    state.currentTaskId = null;
    state.endedAt = nowIso();
    saveState(runDir, state);
    appendEvent(runDir, { type: 'run_finished', runId, status: state.status, stopReason: state.stopReason });
    log(`Run ${runId}: ${state.status}`);
    log(`Output branch: ${state.project.outputBranch}`);
    log(`Artifacts: ${runDir}`);
    return { exitCode: allAccepted ? 0 : 1, runId, state, runDir };
  } finally {
    releaseLock(lock);
  }
}

export async function runCli(argv, options = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    (options.log || console.log)(HELP);
    return { exitCode: 0, help: true };
  }
  const config = loadConfig(args.config, {
    cwd: options.cwd || process.cwd(),
    projectRoot: args.projectRoot,
    hours: args.hours,
  });
  const project = prepareProject(config.projectRoot);
  const stateFromProject = relative(project.root, config.stateDir);
  invariant(config.stateDir !== resolve('/') && config.stateDir !== homedir(), 'stateDir cannot be the filesystem root or user home');
  invariant(stateFromProject === '..' || stateFromProject.startsWith(`..${sep}`) || isAbsolute(stateFromProject), 'stateDir cannot be inside projectRoot');
  let requested = args.tasks;
  if (args.resume) {
    const saved = readJson(join(runPath(config, args.resume), 'state.json'), 'run state');
    requested = saved.taskOrder;
  }
  const tasks = loadTasks(config, requested, options.runner || runProcess);
  printPlan(config, tasks, project, args.resume, options.log || console.log);
  if (args.dryRun) return { exitCode: 0, dryRun: true, tasks, project };
  return runPipeline({
    config,
    tasks,
    project,
    resumeRunId: args.resume,
    log: options.log || console.log,
  });
}
