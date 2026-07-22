import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  advanceRunBranch,
  createArtifact,
  createAttemptWorkspace,
  evaluateAcceptance,
  freezeCandidate,
  loadConfig,
  loadGithubTasks,
  parseArgs,
  prepareProject,
  removeAttemptWorkspace,
  runCli,
  runProcess,
  selectTasks,
  sha256,
  shouldPolish,
  validateArtifact,
  validateRunIdentity,
  validateTasks,
} from '../scripts/orchestrator-core.mjs';

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runGit(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'generic-harness-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function createRepository(t) {
  const root = temporaryRoot(t);
  const repository = join(root, 'project');
  mkdirSync(join(repository, 'src'), { recursive: true });
  const init = spawnSync('git', ['init', '-q', repository], { encoding: 'utf8', shell: false });
  assert.equal(init.status, 0, init.stderr);
  runGit(repository, ['config', 'user.name', 'Harness Test']);
  runGit(repository, ['config', 'user.email', 'harness-test@localhost']);
  writeFileSync(join(repository, 'README.md'), '# Test project\n');
  writeFileSync(join(repository, 'src', 'app.js'), 'export const value = 1;\n');
  runGit(repository, ['add', '-A']);
  runGit(repository, ['commit', '-q', '-m', 'Initial commit']);
  return { root, repository };
}

function task(id = 'task-a', overrides = {}) {
  return {
    id,
    title: `Task ${id}`,
    description: 'Make one bounded change.',
    acceptanceCriteria: ['The requested behavior works'],
    editablePaths: ['src'],
    requiredChecks: ['test'],
    dependsOn: [],
    ...overrides,
  };
}

function acceptedEvidence(overrides = {}) {
  return {
    coder: { success: true, payload: { ready: true } },
    candidateSha: 'abc123',
    changedFiles: ['src/app.js'],
    task: task(),
    reviewer: { success: true, payload: { blockingIssues: [] } },
    checks: [{ id: 'test', passed: true }],
    scorer: {
      success: true,
      payload: {
        score: 90,
        functionalChecks: [{ criterionIndex: 0, passed: true, evidence: 'covered' }],
      },
    },
    scoreThreshold: 70,
    ...overrides,
  };
}

test('CLI parsing is strict and has no project-specific defaults', () => {
  assert.deepEqual(parseArgs(['--tasks', 'one,two', '--hours', '2', '--dry-run']), {
    config: 'harness.config.json',
    projectRoot: null,
    tasks: ['one', 'two'],
    hours: 2,
    resume: null,
    dryRun: true,
    help: false,
  });
  assert.throws(() => parseArgs(['--hours', '0']), /positive number/);
  assert.throws(() => parseArgs(['--hours', '-1']), /positive number/);
  assert.throws(() => parseArgs(['--unknown']), /Unknown option/);
  assert.throws(() => parseArgs(['--resume', 'run-1', '--tasks', 'one']), /cannot be combined/);
});

test('task validation rejects unsafe inputs and orders dependencies', () => {
  const checks = [{ id: 'test' }];
  const ordered = validateTasks([
    task('second', { dependsOn: ['first'] }),
    task('first'),
  ], checks);
  assert.deepEqual(ordered.map(item => item.id), ['first', 'second']);

  assert.throws(() => validateTasks([task('same'), task('same')], checks), /Duplicate task id/);
  assert.throws(() => validateTasks([task('bad', { editablePaths: ['src/../../outside'] })], checks), /cannot contain \.\./);
  assert.throws(() => validateTasks([task('bad', { requiredChecks: ['missing'] })], checks), /unknown check/);
  assert.throws(() => validateTasks([
    task('one', { dependsOn: ['two'] }),
    task('two', { dependsOn: ['one'] }),
  ], checks), /cycle/);
});

test('task selection is exact and requires selected dependencies', () => {
  const tasks = validateTasks([
    task('first'),
    task('second', { dependsOn: ['first'] }),
  ], [{ id: 'test' }]);
  assert.deepEqual(selectTasks(tasks, ['first']).map(item => item.id), ['first']);
  assert.throws(() => selectTasks(tasks, ['second']), /requires selected dependency/);
  assert.throws(() => selectTasks(tasks, ['unknown']), /Unknown task selection/);
});

test('the unified acceptance gate enforces every hard requirement', () => {
  assert.equal(evaluateAcceptance(acceptedEvidence()).accepted, true);

  const cases = [
    ['coder_failed', { coder: { success: false, payload: null } }],
    ['candidate_missing', { candidateSha: null }],
    ['out_of_scope_changes', { changedFiles: ['docs/notes.md'] }],
    ['review_invalid', { reviewer: { success: false, payload: null } }],
    ['review_blocked', { reviewer: { success: true, payload: { blockingIssues: [{ file: 'src/app.js', message: 'bug' }] } } }],
    ['check_missing:test', { checks: [] }],
    ['check_invalid:test', { checks: [{ id: 'test', passed: false, error: 'spawn ENOENT', timedOut: false }] }],
    ['check_failed:test', { checks: [{ id: 'test', passed: false }] }],
    ['score_invalid', { scorer: { success: false, payload: null } }],
    ['criteria_incomplete', {
      scorer: { success: true, payload: { score: 90, functionalChecks: [] } },
    }],
    ['functional_check_failed', {
      scorer: { success: true, payload: { score: 90, functionalChecks: [{ criterionIndex: 0, passed: false, evidence: 'missing' }] } },
    }],
    ['score_below_threshold', {
      scorer: { success: true, payload: { score: 69, functionalChecks: [{ criterionIndex: 0, passed: true, evidence: 'covered' }] } },
    }],
  ];

  for (const [reason, override] of cases) {
    const result = evaluateAcceptance(acceptedEvidence(override));
    assert.equal(result.accepted, false, reason);
    assert.ok(result.reasons.includes(reason), `${reason}: ${result.reasons.join(', ')}`);
  }
});

test('Polish includes zero and hard-gate failures, but not missing evidence', () => {
  const policy = { scoreThreshold: 70, maxPolishPerTask: 3 };
  assert.equal(shouldPolish({ accepted: false, score: 0, polishCount: 0 }, policy), true);
  assert.equal(shouldPolish({ accepted: false, score: 95, polishCount: 0 }, policy), true);
  assert.equal(shouldPolish({ accepted: false, score: null, polishCount: 0 }, policy), false);
  assert.equal(shouldPolish({ accepted: false, score: 60, polishCount: 0, evidenceValid: false }, policy), false);
  assert.equal(shouldPolish({ accepted: true, score: 60, polishCount: 0 }, policy), false);
  assert.equal(shouldPolish({ accepted: false, score: 60, polishCount: 3 }, policy), false);
});

test('artifact identity rejects stale or cross-task evidence', () => {
  const identity = {
    runId: 'run-1',
    taskId: 'task-a',
    stage: 'reviewer',
    attempt: 1,
    inputCommit: 'abc123',
  };
  const artifact = createArtifact(identity, { success: true });
  assert.deepEqual(validateArtifact(artifact, identity), { success: true });
  assert.throws(() => validateArtifact(artifact, { ...identity, taskId: 'task-b' }), /taskId mismatch/);
  assert.throws(() => validateArtifact(artifact, { ...identity, inputCommit: 'old' }), /inputCommit mismatch/);
});

test('subprocess arguments cannot be interpreted as shell syntax', t => {
  const root = temporaryRoot(t);
  const marker = join(root, 'owned');
  const payload = [
    `$(touch ${marker})`,
    `; touch ${marker}`,
    `\`touch ${marker}\``,
    'plain value with spaces',
  ];
  const result = runProcess(process.execPath, [
    '-e',
    'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
    ...payload,
  ]);
  assert.equal(result.success, true, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), payload);
  assert.equal(existsSync(marker), false);
});

test('GitHub task loading fails closed', () => {
  const source = {
    repository: 'owner/repository',
    state: 'open',
    limit: 20,
    requiredLabels: ['agent-ready'],
    allowedAuthors: ['trusted-author'],
    editablePaths: ['src'],
    requiredChecks: ['test'],
    dependencies: {},
  };
  let capturedArgs;
  const emptyRunner = (_command, args) => {
    capturedArgs = args;
    return { success: true, stderr: '', stdout: '[]', error: null };
  };
  assert.deepEqual(loadGithubTasks(source, null, emptyRunner), []);
  assert.deepEqual(capturedArgs.slice(capturedArgs.indexOf('--label'), capturedArgs.indexOf('--label') + 2), ['--label', 'agent-ready']);
  assert.deepEqual(capturedArgs.slice(capturedArgs.indexOf('--author'), capturedArgs.indexOf('--author') + 2), ['--author', 'trusted-author']);
  const failingRunner = () => ({ success: false, stderr: 'network unavailable', stdout: '', error: null });
  assert.throws(() => loadGithubTasks(source, null, failingRunner), /network unavailable/);
});

test('config rejects unsafe environment names and invalid GitHub selection', t => {
  const root = temporaryRoot(t);
  const base = {
    schemaVersion: 1,
    projectRoot: './project',
    stateDir: './state',
    taskSource: { type: 'manifest', path: './tasks.json' },
    agent: { model: 'test-model' },
    checks: [{ id: 'test', command: 'node', args: ['--version'] }],
  };
  const configPath = join(root, 'config.json');
  writeJson(configPath, { ...base, passEnv: ['BAD=VALUE'] });
  assert.throws(() => loadConfig(configPath), /Invalid passEnv name/);

  writeJson(configPath, {
    ...base,
    passEnv: [],
    taskSource: {
      type: 'github',
      repository: 'owner/repository',
      state: 'pending',
      editablePaths: ['src'],
    },
  });
  assert.throws(() => loadConfig(configPath), /state must be open, closed, or all/);
});

test('dry-run validates a real repository without writing state, refs, or files', async t => {
  const { root, repository } = createRepository(t);
  const manifestPath = join(root, 'tasks.json');
  const configPath = join(root, 'harness.config.json');
  const stateDir = join(root, 'state');
  writeJson(manifestPath, { schemaVersion: 1, tasks: [task()] });
  writeJson(configPath, {
    schemaVersion: 1,
    projectRoot: repository,
    stateDir,
    taskSource: { type: 'manifest', path: manifestPath },
    agent: { command: 'claude', model: 'test-model', bare: true },
    passEnv: [],
    checks: [{ id: 'test', command: process.execPath, args: ['--version'], cwd: '.' }],
    policy: { maxRunMinutes: 5 },
  });
  const before = readFileSync(join(repository, 'src', 'app.js'), 'utf8');
  const result = await runCli(['--config', configPath, '--dry-run'], { cwd: root, log: () => {} });
  assert.equal(result.exitCode, 0);
  assert.equal(result.tasks.length, 1);
  assert.equal(existsSync(stateDir), false);
  assert.equal(runGit(repository, ['branch', '--list', 'harness/*']), '');
  assert.equal(readFileSync(join(repository, 'src', 'app.js'), 'utf8'), before);
  assert.equal(runGit(repository, ['status', '--porcelain']), '');
});

test('a complete five-stage run accepts only the frozen candidate branch', async t => {
  const { root, repository } = createRepository(t);
  const manifestPath = join(root, 'tasks.json');
  const configPath = join(root, 'harness.config.json');
  const stateDir = join(root, 'state');
  const fakeAgent = join(root, 'fake-agent.mjs');
  const previousSecret = process.env.HARNESS_TEST_SECRET;
  process.env.HARNESS_TEST_SECRET = 'agent-only-secret';
  t.after(() => {
    if (previousSecret == null) delete process.env.HARNESS_TEST_SECRET;
    else process.env.HARNESS_TEST_SECRET = previousSecret;
  });
  writeFileSync(fakeAgent, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const prompt = readFileSync(0, 'utf8');
const args = process.argv.slice(2);
const name = args[args.indexOf('--name') + 1] || '';
let payload;
if (name.endsWith('-reviewer')) {
  if (!prompt.includes('"candidateCommit"') || !prompt.includes('"candidateDiff"') || !prompt.includes('value = 2')) process.exit(2);
  payload = { summary: 'No blockers', blockingIssues: [], observations: [] };
} else if (name.endsWith('-scorer')) {
  if (!prompt.includes('"deterministicChecks"') || !prompt.includes('"passed": true')) process.exit(3);
  payload = { score: 90, functionalChecks: [{ criterionIndex: 0, passed: true, evidence: 'check passed' }], issues: [] };
} else {
  if (!prompt.includes('"taskId": "task-a"') || !prompt.includes('Make one bounded change.')) process.exit(4);
  writeFileSync(join(process.cwd(), 'src', 'app.js'), 'export const value = 2;\\n');
  payload = { ready: true, summary: 'Implemented the task', notes: [] };
}
process.stdout.write(JSON.stringify({ structured_output: payload }));
`);
  chmodSync(fakeAgent, 0o755);
  writeJson(manifestPath, { schemaVersion: 1, tasks: [task()] });
  writeJson(configPath, {
    schemaVersion: 1,
    projectRoot: repository,
    stateDir,
    taskSource: { type: 'manifest', path: manifestPath },
    agent: {
      command: fakeAgent,
      model: 'test-model',
      bare: true,
      maxTurns: 2,
      timeoutsMs: { coder: 10_000, reviewer: 10_000, scorer: 10_000 },
    },
    passEnv: ['HARNESS_TEST_SECRET'],
    checks: [{
      id: 'test',
      command: process.execPath,
      args: ['-e', "if (process.env.HARNESS_TEST_SECRET) process.exit(9); const fs = require('node:fs'); if (!fs.readFileSync('src/app.js', 'utf8').includes('value = 2')) process.exit(8);"],
      cwd: '.',
    }],
    policy: { maxRunMinutes: 5 },
  });

  const result = await runCli(['--config', configPath], { cwd: root, log: () => {} });
  assert.equal(result.exitCode, 0);
  assert.equal(result.state.status, 'completed');
  assert.equal(result.state.tasks['task-a'].status, 'accepted');
  assert.equal(runGit(repository, ['rev-parse', 'HEAD']), result.state.project.baseSha);
  assert.equal(readFileSync(join(repository, 'src', 'app.js'), 'utf8'), 'export const value = 1;\n');
  assert.equal(runGit(repository, ['show', `${result.state.project.outputBranch}:src/app.js`]), 'export const value = 2;');
  assert.equal(runGit(repository, ['status', '--porcelain']), '');
  assert.equal(existsSync(join(result.runDir, 'tasks', 'task-a', 'attempt-001', 'scorer.json')), true);
  assert.equal(existsSync(join(prepareProject(repository).gitCommonDir, 'agent-harness.lock')), false);

  const interruptedState = structuredClone(result.state);
  interruptedState.status = 'running';
  interruptedState.endedAt = null;
  interruptedState.project.headSha = interruptedState.project.baseSha;
  interruptedState.pendingAdvance = {
    taskId: 'task-a',
    expectedSha: interruptedState.project.baseSha,
    candidateSha: interruptedState.tasks['task-a'].acceptedSha,
  };
  interruptedState.tasks['task-a'].status = 'running';
  interruptedState.tasks['task-a'].phase = 'scorer';
  interruptedState.tasks['task-a'].acceptedSha = null;
  writeJson(join(result.runDir, 'state.json'), interruptedState);
  const recovered = await runCli(['--config', configPath, '--resume', result.runId], { log: () => {} });
  assert.equal(recovered.exitCode, 0);
  assert.equal(recovered.state.status, 'completed');
  assert.equal(recovered.state.pendingAdvance, null);
  assert.equal(recovered.state.tasks['task-a'].acceptedSha, result.state.project.headSha);
});

test('a check cannot replace the frozen commit observed by Scorer', async t => {
  const { root, repository } = createRepository(t);
  const manifestPath = join(root, 'tasks.json');
  const configPath = join(root, 'harness.config.json');
  const stateDir = join(root, 'state');
  const scorerMarker = join(root, 'scorer-ran');
  const fakeAgent = join(root, 'fake-agent.mjs');
  const mutatingCheck = join(root, 'mutating-check.mjs');
  writeFileSync(fakeAgent, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
readFileSync(0, 'utf8');
const args = process.argv.slice(2);
const name = args[args.indexOf('--name') + 1] || '';
let payload;
if (name.endsWith('-reviewer')) payload = { summary: 'No blockers', blockingIssues: [], observations: [] };
else if (name.endsWith('-scorer')) {
  writeFileSync(${JSON.stringify(scorerMarker)}, 'ran');
  payload = { score: 100, functionalChecks: [{ criterionIndex: 0, passed: true, evidence: 'wrong tree' }], issues: [] };
} else {
  writeFileSync(join(process.cwd(), 'src', 'app.js'), 'export const value = 2;\\n');
  payload = { ready: true, summary: 'candidate', notes: [] };
}
process.stdout.write(JSON.stringify({ structured_output: payload }));
`);
  writeFileSync(mutatingCheck, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(join(process.cwd(), 'src', 'app.js'), 'export const value = 999;\\n');
let result = spawnSync('git', ['add', '-A']);
if (result.status === 0) result = spawnSync('git', ['-c', 'user.name=Bad Check', '-c', 'user.email=bad-check@localhost', 'commit', '-q', '-m', 'mutate candidate']);
process.exit(result.status ?? 1);
`);
  chmodSync(fakeAgent, 0o755);
  chmodSync(mutatingCheck, 0o755);
  writeJson(manifestPath, { schemaVersion: 1, tasks: [task()] });
  writeJson(configPath, {
    schemaVersion: 1,
    projectRoot: repository,
    stateDir,
    taskSource: { type: 'manifest', path: manifestPath },
    agent: { command: fakeAgent, model: 'test-model', maxTurns: 2 },
    passEnv: [],
    checks: [{ id: 'test', command: mutatingCheck, args: [], cwd: '.' }],
    policy: { maxCoderAttempts: 1, maxRunMinutes: 5 },
  });

  const result = await runCli(['--config', configPath], { log: () => {} });
  assert.equal(result.exitCode, 1);
  assert.equal(result.state.status, 'failed');
  assert.match(result.state.tasks['task-a'].failure, /changed the attempt base commit/);
  assert.equal(existsSync(scorerMarker), false);
  assert.equal(runGit(repository, ['rev-parse', result.state.project.outputBranch]), result.state.project.baseSha);
  assert.equal(readFileSync(join(repository, 'src', 'app.js'), 'utf8'), 'export const value = 1;\n');
});

test('a real zero-score candidate enters Polish and advances only the improved commit', async t => {
  const { root, repository } = createRepository(t);
  const fakeAgent = join(root, 'fake-agent.mjs');
  writeFileSync(fakeAgent, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const prompt = readFileSync(0, 'utf8');
const args = process.argv.slice(2);
const name = args[args.indexOf('--name') + 1] || '';
let payload;
if (name.endsWith('-reviewer')) payload = { summary: 'reviewed', blockingIssues: [], observations: [] };
else if (name.endsWith('-scorer')) {
  const polished = readFileSync(join(process.cwd(), 'src', 'app.js'), 'utf8').includes('value = 3');
  payload = { score: polished ? 90 : 0, functionalChecks: [{ criterionIndex: 0, passed: polished, evidence: polished ? 'fixed' : 'not fixed' }], issues: polished ? [] : ['needs polish'] };
} else {
  const polish = prompt.includes('"mode": "polish"');
  writeFileSync(join(process.cwd(), 'src', 'app.js'), 'export const value = ' + (polish ? 3 : 2) + ';\\n');
  payload = { ready: true, summary: polish ? 'polished' : 'initial', notes: [] };
}
process.stdout.write(JSON.stringify({ structured_output: payload }));
`);
  chmodSync(fakeAgent, 0o755);
  const manifestPath = join(root, 'tasks.json');
  const configPath = join(root, 'harness.config.json');
  writeJson(manifestPath, { schemaVersion: 1, tasks: [task()] });
  writeJson(configPath, {
    schemaVersion: 1,
    projectRoot: repository,
    stateDir: join(root, 'state'),
    taskSource: { type: 'manifest', path: manifestPath },
    agent: { command: fakeAgent, model: 'test-model', maxTurns: 2 },
    passEnv: [],
    checks: [{ id: 'test', command: process.execPath, args: ['--check', 'src/app.js'] }],
    policy: { maxCoderAttempts: 1, maxPolishPerTask: 2, minImprovement: 2, maxRunMinutes: 5 },
  });

  const result = await runCli(['--config', configPath], { log: () => {} });
  const taskState = result.state.tasks['task-a'];
  assert.equal(result.exitCode, 0);
  assert.equal(taskState.status, 'accepted');
  assert.equal(taskState.polishCount, 1);
  assert.equal(result.state.totalPolish, 1);
  assert.deepEqual(taskState.attempts.map(attempt => attempt.kind), ['initial', 'polish']);
  assert.equal(taskState.attempts[1].baseSha, taskState.attempts[0].candidateSha);
  assert.equal(runGit(repository, ['show', `${result.state.project.outputBranch}:src/app.js`]), 'export const value = 3;');
  assert.equal(runGit(repository, ['rev-parse', 'HEAD']), result.state.project.baseSha);
});

test('resume skips accepted tasks and continues from their accepted commit', async t => {
  const { root, repository } = createRepository(t);
  const allowSecond = join(root, 'allow-second');
  const coderCalls = join(root, 'coder-calls.log');
  const fakeAgent = join(root, 'fake-agent.mjs');
  writeFileSync(fakeAgent, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const prompt = readFileSync(0, 'utf8');
const args = process.argv.slice(2);
const name = args[args.indexOf('--name') + 1] || '';
let payload;
if (name.endsWith('-reviewer')) payload = { summary: 'reviewed', blockingIssues: [], observations: [] };
else if (name.endsWith('-scorer')) payload = { score: 90, functionalChecks: [{ criterionIndex: 0, passed: true, evidence: 'done' }], issues: [] };
else {
  const taskId = prompt.match(/"taskId": "([^"]+)"/)?.[1];
  appendFileSync(${JSON.stringify(coderCalls)}, taskId + '\\n');
  const ready = taskId === 'task-a' || existsSync(${JSON.stringify(allowSecond)});
  if (ready) writeFileSync(join(process.cwd(), 'src', taskId + '.js'), "export const id = '" + taskId + "';\\n");
  payload = { ready, summary: ready ? 'done' : 'blocked for test', notes: [] };
}
process.stdout.write(JSON.stringify({ structured_output: payload }));
`);
  chmodSync(fakeAgent, 0o755);
  const manifestPath = join(root, 'tasks.json');
  const configPath = join(root, 'harness.config.json');
  writeJson(manifestPath, {
    schemaVersion: 1,
    tasks: [
      task('task-a'),
      task('task-b', { dependsOn: ['task-a'] }),
    ],
  });
  writeJson(configPath, {
    schemaVersion: 1,
    projectRoot: repository,
    stateDir: join(root, 'state'),
    taskSource: { type: 'manifest', path: manifestPath },
    agent: { command: fakeAgent, model: 'test-model', maxTurns: 2 },
    passEnv: [],
    checks: [{ id: 'test', command: process.execPath, args: ['--check', 'src/app.js'] }],
    policy: { maxCoderAttempts: 1, maxRunMinutes: 5 },
  });

  const first = await runCli(['--config', configPath], { log: () => {} });
  assert.equal(first.exitCode, 1);
  assert.equal(first.state.tasks['task-a'].status, 'accepted');
  assert.equal(first.state.tasks['task-b'].status, 'failed');
  const firstAcceptedSha = first.state.tasks['task-a'].acceptedSha;
  assert.equal(runGit(repository, ['rev-parse', first.state.project.outputBranch]), firstAcceptedSha);

  const expiredState = JSON.parse(readFileSync(join(first.runDir, 'state.json'), 'utf8'));
  expiredState.deadlineAt = '2000-01-01T00:00:00.000Z';
  writeJson(join(first.runDir, 'state.json'), expiredState);
  writeFileSync(allowSecond, 'continue\n');
  const resumed = await runCli(['--config', configPath, '--resume', first.runId], { log: () => {} });
  assert.equal(resumed.exitCode, 0);
  assert.equal(resumed.state.status, 'completed');
  assert.equal(resumed.state.tasks['task-a'].attempts.length, 1);
  assert.equal(resumed.state.tasks['task-b'].attempts.length, 2);
  assert.equal(resumed.state.resumeCount, 1);
  assert.ok(new Date(resumed.state.deadlineAt).getTime() > Date.now());
  assert.equal(resumed.state.tasks['task-b'].attempts[1].baseSha, firstAcceptedSha);
  assert.deepEqual(readFileSync(coderCalls, 'utf8').trim().split('\n'), ['task-a', 'task-b', 'task-b']);
  assert.equal(runGit(repository, ['show', `${resumed.state.project.outputBranch}:src/task-a.js`]), "export const id = 'task-a';");
  assert.equal(runGit(repository, ['show', `${resumed.state.project.outputBranch}:src/task-b.js`]), "export const id = 'task-b';");
  assert.equal(runGit(repository, ['rev-parse', 'HEAD']), resumed.state.project.baseSha);
});

test('a later task cannot rewrite history and discard an accepted task', async t => {
  const { root, repository } = createRepository(t);
  const originalBase = runGit(repository, ['rev-parse', 'HEAD']);
  const fakeAgent = join(root, 'fake-agent.mjs');
  writeFileSync(fakeAgent, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const prompt = readFileSync(0, 'utf8');
const args = process.argv.slice(2);
const name = args[args.indexOf('--name') + 1] || '';
let payload;
if (name.endsWith('-reviewer')) payload = { summary: 'reviewed', blockingIssues: [], observations: [] };
else if (name.endsWith('-scorer')) payload = { score: 90, functionalChecks: [{ criterionIndex: 0, passed: true, evidence: 'done' }], issues: [] };
else {
  const taskId = prompt.match(/"taskId": "([^"]+)"/)?.[1];
  if (taskId === 'task-b') {
    const reset = spawnSync('git', ['reset', '--hard', ${JSON.stringify(originalBase)}]);
    if (reset.status !== 0) process.exit(5);
  }
  writeFileSync(join(process.cwd(), 'src', taskId + '.js'), "export const id = '" + taskId + "';\\n");
  payload = { ready: true, summary: 'candidate', notes: [] };
}
process.stdout.write(JSON.stringify({ structured_output: payload }));
`);
  chmodSync(fakeAgent, 0o755);
  const manifestPath = join(root, 'tasks.json');
  const configPath = join(root, 'harness.config.json');
  writeJson(manifestPath, {
    schemaVersion: 1,
    tasks: [task('task-a'), task('task-b', { dependsOn: ['task-a'] })],
  });
  writeJson(configPath, {
    schemaVersion: 1,
    projectRoot: repository,
    stateDir: join(root, 'state'),
    taskSource: { type: 'manifest', path: manifestPath },
    agent: { command: fakeAgent, model: 'test-model', maxTurns: 2 },
    passEnv: [],
    checks: [{ id: 'test', command: process.execPath, args: ['--check', 'src/app.js'] }],
    policy: { maxCoderAttempts: 1, maxRunMinutes: 5 },
  });

  const result = await runCli(['--config', configPath], { log: () => {} });
  assert.equal(result.exitCode, 1);
  assert.equal(result.state.tasks['task-a'].status, 'accepted');
  assert.equal(result.state.tasks['task-b'].status, 'failed');
  assert.match(result.state.tasks['task-b'].failure, /Coder changed the attempt base commit/);
  const branchFiles = runGit(repository, ['ls-tree', '-r', '--name-only', result.state.project.outputBranch]).split('\n');
  assert.ok(branchFiles.includes('src/task-a.js'));
  assert.equal(branchFiles.includes('src/task-b.js'), false);
  assert.equal(runGit(repository, ['rev-parse', result.state.project.outputBranch]), result.state.tasks['task-a'].acceptedSha);
  assert.equal(runGit(repository, ['rev-parse', 'HEAD']), originalBase);
});

test('tracked symlinks cannot escape an attempt worktree', async t => {
  const { root, repository } = createRepository(t);
  const sentinel = join(root, 'sentinel.txt');
  const link = join(repository, 'src', 'external-link');
  writeFileSync(sentinel, 'safe\n');
  try {
    symlinkSync(sentinel, link);
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`symlinks unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  runGit(repository, ['add', 'src/external-link']);
  runGit(repository, ['commit', '-q', '-m', 'Add external symlink']);
  const marker = join(root, 'agent-ran');
  const fakeAgent = join(root, 'fake-agent.mjs');
  writeFileSync(fakeAgent, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'ran');
process.stdout.write(JSON.stringify({ structured_output: { ready: true, summary: 'ran', notes: [] } }));
`);
  chmodSync(fakeAgent, 0o755);
  const manifestPath = join(root, 'tasks.json');
  const configPath = join(root, 'harness.config.json');
  writeJson(manifestPath, { schemaVersion: 1, tasks: [task()] });
  writeJson(configPath, {
    schemaVersion: 1,
    projectRoot: repository,
    stateDir: join(root, 'state'),
    taskSource: { type: 'manifest', path: manifestPath },
    agent: { command: fakeAgent, model: 'test-model' },
    passEnv: [],
    checks: [{ id: 'test', command: process.execPath, args: ['--version'] }],
    policy: { maxCoderAttempts: 1, maxRunMinutes: 5 },
  });

  const result = await runCli(['--config', configPath], { log: () => {} });
  assert.equal(result.exitCode, 1);
  assert.match(result.state.tasks['task-a'].failure, /symlink escapes the worktree/);
  assert.equal(existsSync(marker), false);
  assert.equal(readFileSync(sentinel, 'utf8'), 'safe\n');
  assert.equal(runGit(repository, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)?.length, 1);
});

test('stateDir inside the target repository is rejected without writing it', async t => {
  const { root, repository } = createRepository(t);
  const manifestPath = join(root, 'tasks.json');
  const configPath = join(root, 'harness.config.json');
  const unsafeState = join(repository, '.harness');
  writeJson(manifestPath, { schemaVersion: 1, tasks: [task()] });
  writeJson(configPath, {
    schemaVersion: 1,
    projectRoot: repository,
    stateDir: unsafeState,
    taskSource: { type: 'manifest', path: manifestPath },
    agent: { model: 'test-model' },
    passEnv: [],
    checks: [{ id: 'test', command: process.execPath, args: ['--version'] }],
  });
  await assert.rejects(runCli(['--config', configPath, '--dry-run'], { log: () => {} }), /stateDir cannot be inside projectRoot/);
  assert.equal(existsSync(unsafeState), false);
});

test('candidate worktrees isolate changes and only an explicit CAS advances the output branch', t => {
  const { root, repository } = createRepository(t);
  const project = prepareProject(repository);
  const workspacesRoot = join(root, 'workspaces');
  const hooksDir = join(root, 'empty-hooks');
  const workspace = createAttemptWorkspace(project, workspacesRoot, 'task-a', 1, project.baseSha);
  try {
    writeFileSync(join(workspace, 'src', 'app.js'), 'export const value = 2;\n');
    const candidate = freezeCandidate({
      workspace,
      hooksDir,
      task: task(),
      taskBaseSha: project.baseSha,
      message: 'test candidate',
    });
    assert.notEqual(candidate.candidateSha, project.baseSha);
    assert.deepEqual(candidate.changedFiles, ['src/app.js']);
    assert.equal(readFileSync(join(repository, 'src', 'app.js'), 'utf8'), 'export const value = 1;\n');

    const branch = 'harness/test-run';
    runGit(repository, ['update-ref', `refs/heads/${branch}`, project.baseSha]);
    assert.equal(runGit(repository, ['rev-parse', branch]), project.baseSha);
    advanceRunBranch(project, branch, project.baseSha, candidate.candidateSha);
    assert.equal(runGit(repository, ['rev-parse', branch]), candidate.candidateSha);
    assert.equal(runGit(repository, ['rev-parse', 'HEAD']), project.baseSha);
  } finally {
    removeAttemptWorkspace(project, workspacesRoot, workspace);
  }
});

test('candidate freezing rejects changes outside editablePaths', t => {
  const { root, repository } = createRepository(t);
  const project = prepareProject(repository);
  const workspacesRoot = join(root, 'workspaces');
  const workspace = createAttemptWorkspace(project, workspacesRoot, 'task-a', 1, project.baseSha);
  try {
    writeFileSync(join(workspace, 'README.md'), '# Out of scope\n');
    assert.throws(() => freezeCandidate({
      workspace,
      hooksDir: join(root, 'empty-hooks'),
      task: task(),
      taskBaseSha: project.baseSha,
      message: 'unsafe candidate',
    }), /outside editablePaths/);
  } finally {
    removeAttemptWorkspace(project, workspacesRoot, workspace);
  }
  assert.equal(readFileSync(join(repository, 'README.md'), 'utf8'), '# Test project\n');
});

test('resume identity binds config, tasks, project, and output ref', t => {
  const { repository } = createRepository(t);
  const project = prepareProject(repository);
  const tasks = [task()];
  const config = { hash: 'config-hash' };
  const branch = 'harness/resume-test';
  runGit(repository, ['update-ref', `refs/heads/${branch}`, project.baseSha]);
  const state = {
    schemaVersion: 1,
    configHash: config.hash,
    tasksHash: sha256(tasks),
    project: {
      root: project.root,
      baseSha: project.baseSha,
      headSha: project.baseSha,
      outputBranch: branch,
    },
  };
  assert.equal(validateRunIdentity(state, { config, tasks, project }), true);
  assert.throws(() => validateRunIdentity(state, { config: { hash: 'changed' }, tasks, project }), /config changed/);
  assert.throws(() => validateRunIdentity(state, { config, tasks: [task('other')], project }), /task input changed/);
  assert.throws(() => validateRunIdentity({
    ...state,
    project: { ...state.project, headSha: '0000000000000000000000000000000000000000' },
  }, { config, tasks, project }), /output branch no longer matches/);
});
