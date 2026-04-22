import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  suggestGlob, suggestTightGlob, findAlternativeTasks,
  buildOutOfScopeOptions, buildProtectedOptions, buildLoadErrorOptions,
  buildPreToolUseDenial, buildLoadErrorDenial,
  buildShellPrecheckDenial, buildAfterShellContext,
  classifyProtected,
  DENIAL_FENCE_START, DENIAL_FENCE_END,
} from './denial.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempRepo() {
  const root = mkdtempSync(join(tmpdir(), 'as-denial-'));
  mkdirSync(join(root, 'agent-scope/tasks'), { recursive: true });
  mkdirSync(join(root, 'agent-scope/lib'), { recursive: true });
  return root;
}
function writeTask(root, id, manifest) {
  writeFileSync(
    join(root, 'agent-scope/tasks', `${id}.json`),
    JSON.stringify({ id, description: manifest.description || '', ...manifest }, null, 2)
  );
}
function cleanup(root) { rmSync(root, { recursive: true, force: true }); }

function extractJson(message) {
  const start = message.indexOf(DENIAL_FENCE_START);
  const end = message.indexOf(DENIAL_FENCE_END);
  assert.ok(start >= 0, 'message has begin fence');
  assert.ok(end > start, 'message has end fence');
  const body = message.slice(start + DENIAL_FENCE_START.length, end).trim();
  return JSON.parse(body);
}

// ---------------------------------------------------------------------------
// suggestGlob
// ---------------------------------------------------------------------------

test('suggestGlob: typical nested file', () => {
  assert.equal(suggestGlob('packages/foo/src/bar.ts'), 'packages/foo/src/**');
});

test('suggestGlob: top-level file', () => {
  assert.equal(suggestGlob('README.md'), 'README.md');
});

test('suggestGlob: empty / invalid', () => {
  assert.equal(suggestGlob(''),        null);
  assert.equal(suggestGlob(undefined), null);
  assert.equal(suggestGlob(null),      null);
  assert.equal(suggestGlob(42),        null);
});

test('suggestGlob: trailing slash is stripped', () => {
  assert.equal(suggestGlob('packages/foo/src/'), 'packages/foo/**');
});

// ---------------------------------------------------------------------------
// suggestTightGlob
// ---------------------------------------------------------------------------

test('suggestTightGlob: basename stem + sibling extensions', () => {
  assert.equal(suggestTightGlob('packages/foo/src/bar.ts'), 'packages/foo/src/bar*');
});

test('suggestTightGlob: multi-dot filename uses first-dot stem', () => {
  assert.equal(suggestTightGlob('packages/foo/bar.test.ts'), 'packages/foo/bar*');
});

test('suggestTightGlob: extensionless', () => {
  assert.equal(suggestTightGlob('scripts/build'), 'scripts/build*');
});

test('suggestTightGlob: dotfile keeps the full basename', () => {
  // leading-dot filenames have no conventional "stem + ext" split; use as-is
  assert.equal(suggestTightGlob('.env'), '.env*');
});

test('suggestTightGlob: empty input returns null', () => {
  assert.equal(suggestTightGlob(''),        null);
  assert.equal(suggestTightGlob(undefined), null);
});

// ---------------------------------------------------------------------------
// findAlternativeTasks
// ---------------------------------------------------------------------------

test('findAlternativeTasks: finds a task that covers the path', () => {
  const root = makeTempRepo();
  try {
    writeTask(root, 'staking', { description: 'Staking work', allowed: ['packages/evm-module/contracts/**'] });
    writeTask(root, 'sync',    { description: 'Sync work',    allowed: ['packages/sync/**'] });
    const r = findAlternativeTasks('packages/evm-module/contracts/Stk.sol', root, 'sync');
    assert.equal(r.length, 1);
    assert.equal(r[0].id, 'staking');
    assert.equal(r[0].description, 'Staking work');
  } finally { cleanup(root); }
});

test('findAlternativeTasks: excludes the current task', () => {
  const root = makeTempRepo();
  try {
    writeTask(root, 'wide', { allowed: ['**/*'] });
    const r = findAlternativeTasks('any/file.ts', root, 'wide');
    assert.equal(r.length, 0);
  } finally { cleanup(root); }
});

test('findAlternativeTasks: returns [] when no manifests match', () => {
  const root = makeTempRepo();
  try {
    writeTask(root, 'narrow', { allowed: ['packages/only/**'] });
    const r = findAlternativeTasks('totally/unrelated/file.ts', root, null);
    assert.equal(r.length, 0);
  } finally { cleanup(root); }
});

test('findAlternativeTasks: skips broken manifests silently', () => {
  const root = makeTempRepo();
  try {
    writeTask(root, 'good', { allowed: ['**/*'] });
    writeFileSync(join(root, 'agent-scope/tasks/broken.json'), '{ not valid json');
    const r = findAlternativeTasks('x/y.ts', root, null);
    assert.equal(r.length, 1);
    assert.equal(r[0].id, 'good');
  } finally { cleanup(root); }
});

// ---------------------------------------------------------------------------
// buildOutOfScopeOptions
// ---------------------------------------------------------------------------

test('buildOutOfScopeOptions: base menu has add_file, add_glob, skip, cancel, custom_instruction', () => {
  const opts = buildOutOfScopeOptions({
    deniedPath: 'packages/foo/bar.ts', activeTaskId: 'my-task', alternatives: [],
  });
  const ids = opts.map(o => o.id);
  assert.ok(ids.includes('add_file'));
  assert.ok(ids.includes('add_glob'));
  assert.ok(ids.includes('skip'));
  assert.ok(ids.includes('cancel'));
  assert.ok(ids.includes('custom_instruction'));
});

test('buildOutOfScopeOptions: custom_instruction is the free-text fallback', () => {
  const opts = buildOutOfScopeOptions({
    deniedPath: 'x/y.ts', activeTaskId: 't', alternatives: [],
  });
  const custom = opts.find(o => o.id === 'custom_instruction');
  assert.ok(custom, 'custom option present');
  assert.equal(custom.action.kind, 'custom');
  assert.match(custom.label, /type/i);
});

test('buildOutOfScopeOptions: add_file action has the exact path', () => {
  const opts = buildOutOfScopeOptions({
    deniedPath: 'packages/foo/bar.ts', activeTaskId: 'my-task', alternatives: [],
  });
  const addFile = opts.find(o => o.id === 'add_file');
  assert.equal(addFile.action.kind, 'add_to_manifest');
  assert.equal(addFile.action.task, 'my-task');
  assert.deepEqual(addFile.action.patterns, ['packages/foo/bar.ts']);
});

test('buildOutOfScopeOptions: add_glob uses suggestGlob', () => {
  const opts = buildOutOfScopeOptions({
    deniedPath: 'packages/foo/bar.ts', activeTaskId: 't', alternatives: [],
  });
  const addGlob = opts.find(o => o.id === 'add_glob');
  assert.deepEqual(addGlob.action.patterns, ['packages/foo/**']);
});

test('buildOutOfScopeOptions: switch options are added per alternative (max 3)', () => {
  const alternatives = [
    { id: 'a', description: 'A' },
    { id: 'b', description: 'B' },
    { id: 'c', description: 'C' },
    { id: 'd', description: 'D' },
  ];
  const opts = buildOutOfScopeOptions({
    deniedPath: 'x/y.ts', activeTaskId: 't', alternatives,
  });
  const switchIds = opts.filter(o => o.id.startsWith('switch_task_')).map(o => o.id);
  assert.equal(switchIds.length, 3);
  assert.deepEqual(switchIds, ['switch_task_a', 'switch_task_b', 'switch_task_c']);
});

// ---------------------------------------------------------------------------
// buildProtectedOptions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// classifyProtected — explains WHY a specific protected file is guarded
// ---------------------------------------------------------------------------

test('classifyProtected: cursor hook', () => {
  assert.equal(classifyProtected('.cursor/hooks/scope-guard.mjs').kind, 'cursor-hook');
  assert.equal(classifyProtected('.cursor/hooks.json').kind, 'cursor-hook');
});
test('classifyProtected: scope library / CLI / schema', () => {
  assert.equal(classifyProtected('agent-scope/lib/scope.mjs').kind, 'scope-library');
  assert.equal(classifyProtected('agent-scope/bin/task.mjs').kind, 'scope-cli');
  assert.equal(classifyProtected('agent-scope/schema/task.schema.json').kind, 'scope-schema');
});
test('classifyProtected: manifests, active, token, rule', () => {
  assert.equal(classifyProtected('agent-scope/tasks/sync.json').kind, 'task-manifest');
  assert.equal(classifyProtected('agent-scope/active').kind, 'active-pointer');
  assert.equal(classifyProtected('agent-scope/.bootstrap-token').kind, 'bootstrap-token');
  assert.equal(classifyProtected('.cursor/rules/agent-scope.mdc').kind, 'cursor-rule');
});
test('classifyProtected: unknown input yields safe default', () => {
  assert.equal(classifyProtected(null).kind, 'unknown');
  assert.equal(classifyProtected('').kind, 'unknown');
});

test('buildProtectedOptions: bootstrap + cancel + skip + custom_instruction', () => {
  const opts = buildProtectedOptions({ deniedPath: '.cursor/hooks/x.mjs' });
  assert.deepEqual(
    opts.map(o => o.id),
    ['bootstrap', 'cancel', 'skip', 'custom_instruction'],
  );
  assert.equal(opts[0].action.kind, 'bootstrap');
  assert.ok(opts[0].action.instruction.includes('bootstrap-token'));
  // Yes / No framing — `bootstrap` label leads with "Yes", `cancel`/`skip` with "No".
  assert.ok(opts[0].label.startsWith('Yes'), 'bootstrap label should start with Yes');
  assert.ok(opts[1].label.startsWith('No'),  'cancel label should start with No');
  assert.ok(opts[2].label.startsWith('No'),  'skip label should start with No');
});

// ---------------------------------------------------------------------------
// buildLoadErrorOptions
// ---------------------------------------------------------------------------

test('buildLoadErrorOptions: fix, clear, cancel, custom_instruction', () => {
  const opts = buildLoadErrorOptions({ taskId: 'broken', error: 'syntax' });
  assert.deepEqual(
    opts.map(o => o.id),
    ['fix_manifest', 'clear_task', 'cancel', 'custom_instruction'],
  );
  assert.equal(opts[0].action.task, 'broken');
});

// ---------------------------------------------------------------------------
// buildPreToolUseDenial
// ---------------------------------------------------------------------------

test('buildPreToolUseDenial: protected → structured protected menu', () => {
  const root = makeTempRepo();
  try {
    const { message, structured } = buildPreToolUseDenial({
      tool: 'Write', deniedPath: '.cursor/hooks/x.mjs',
      decision: 'protected', task: null, taskId: null, root,
    });
    const parsed = extractJson(message);
    assert.equal(parsed.hook, 'preToolUse');
    assert.equal(parsed.reason, 'protected');
    assert.equal(parsed.deniedPath, '.cursor/hooks/x.mjs');
    assert.ok(parsed.protectedPatterns.length > 0);
    assert.deepEqual(
      parsed.options.map(o => o.id),
      ['bootstrap', 'cancel', 'skip', 'custom_instruction'],
    );
    assert.equal(parsed.recommendedOptionId, 'cancel');
    assert.equal(parsed.agentReasoning, null, 'agent fills this in when surfacing');
    assert.equal(structured.reason, 'protected');
    // Human summary is short, natural, contains the denied path, and is
    // surfaced in the rendered prose so the agent can quote it verbatim.
    assert.ok(typeof parsed.humanSummary === 'string');
    assert.ok(parsed.humanSummary.length > 0 && parsed.humanSummary.length < 400,
      'humanSummary stays concise');
    assert.ok(parsed.humanSummary.includes('.cursor/hooks/x.mjs'));
    assert.ok(message.includes(parsed.humanSummary),
      'rendered prose includes the humanSummary verbatim');
    // No more ALL-CAPS banners or agent-directed meta copy in the prose.
    assert.ok(!message.includes('PROTECTED PATH'), 'prose is banner-free');
    assert.ok(!message.includes('STOP'),           'prose is banner-free');
    assert.ok(!/surface the menu below/i.test(message),
      'prose has no "surface the menu" agent-directed copy');
    // Structured payload carries the classification so downstream tools can use it.
    assert.equal(parsed.protectedKind, 'cursor-hook');
    assert.ok(typeof parsed.protectedRole === 'string' && parsed.protectedRole.length > 0);
  } finally { cleanup(root); }
});

test('buildPreToolUseDenial: out-of-scope → full metadata + alternatives', () => {
  const root = makeTempRepo();
  try {
    writeTask(root, 'staking', { description: 'stk', allowed: ['packages/evm-module/**'] });
    const task = { id: 'sync', description: 'Sync',
      allowed: ['packages/sync/**'], exemptions: ['**/dist/**'] };
    const { message } = buildPreToolUseDenial({
      tool: 'StrReplace', deniedPath: 'packages/evm-module/contracts/S.sol',
      decision: 'deny', task, taskId: 'sync', root,
    });
    const p = extractJson(message);
    assert.equal(p.reason, 'out-of-scope');
    assert.equal(p.deniedPath, 'packages/evm-module/contracts/S.sol');
    assert.equal(p.activeTask, 'sync');
    assert.deepEqual(p.allowed, ['packages/sync/**']);
    assert.deepEqual(p.exemptions, ['**/dist/**']);
    assert.equal(p.suggestedGlob, 'packages/evm-module/contracts/**');
    assert.equal(p.alternativeTasks.length, 1);
    assert.equal(p.alternativeTasks[0].id, 'staking');
    const ids = p.options.map(o => o.id);
    assert.ok(ids.includes('add_file'));
    assert.ok(ids.includes('switch_task_staking'));
    assert.ok(ids.includes('custom_instruction'));
    assert.equal(p.recommendedOptionId, 'add_glob');
    assert.equal(p.agentReasoning, null);
    // Human-sounding summary instead of the old ALL-CAPS banner.
    assert.ok(!message.includes('OUT OF TASK SCOPE'),
      'prose no longer uses the ALL-CAPS banner');
    assert.ok(typeof p.humanSummary === 'string' && p.humanSummary.length < 400);
    assert.ok(p.humanSummary.includes('packages/evm-module/contracts/S.sol'));
    assert.ok(p.humanSummary.includes('sync'), 'summary mentions the active task');
  } finally { cleanup(root); }
});

test('buildPreToolUseDenial: message has both fences and is JSON-parseable', () => {
  const root = makeTempRepo();
  try {
    const { message } = buildPreToolUseDenial({
      tool: 'Write', deniedPath: '.cursor/hooks/y.mjs',
      decision: 'protected', task: null, taskId: null, root,
    });
    assert.ok(message.includes(DENIAL_FENCE_START));
    assert.ok(message.includes(DENIAL_FENCE_END));
    const p = extractJson(message);
    assert.equal(p.version, 1);
  } finally { cleanup(root); }
});

// ---------------------------------------------------------------------------
// buildLoadErrorDenial
// ---------------------------------------------------------------------------

test('buildLoadErrorDenial: structured with error + menu', () => {
  const { message, structured } = buildLoadErrorDenial({
    taskId: 'my-task', error: 'Unexpected token',
  });
  const p = extractJson(message);
  assert.equal(p.hook, 'preToolUse');
  assert.equal(p.reason, 'manifest-load-error');
  assert.equal(p.activeTask, 'my-task');
  assert.equal(p.error, 'Unexpected token');
  assert.deepEqual(
    p.options.map(o => o.id),
    ['fix_manifest', 'clear_task', 'cancel', 'custom_instruction'],
  );
  assert.equal(p.recommendedOptionId, 'fix_manifest');
  assert.equal(structured.error, 'Unexpected token');
});

// ---------------------------------------------------------------------------
// buildShellPrecheckDenial
// ---------------------------------------------------------------------------

test('buildShellPrecheckDenial: protected violation → protected menu', () => {
  const root = makeTempRepo();
  try {
    const task = null;
    const violations = [
      { sub: 'rm -rf .cursor/hooks', cmd: 'rm', path: '.cursor/hooks', decision: 'protected (covers)' },
    ];
    const { message } = buildShellPrecheckDenial({
      command: 'rm -rf .cursor/hooks', violations, task, taskId: null, root,
    });
    const p = extractJson(message);
    assert.equal(p.hook, 'beforeShellExecution');
    assert.equal(p.reason, 'protected');
    assert.equal(p.command, 'rm -rf .cursor/hooks');
    assert.equal(p.violations.length, 1);
    assert.deepEqual(
      p.options.map(o => o.id),
      ['bootstrap', 'cancel', 'skip', 'custom_instruction'],
    );
    assert.equal(p.recommendedOptionId, 'cancel');
  } finally { cleanup(root); }
});

test('buildShellPrecheckDenial: pure out-of-scope → full menu', () => {
  const root = makeTempRepo();
  try {
    writeTask(root, 'other', { allowed: ['packages/evm-module/**'] });
    const task = { id: 'sync', allowed: ['packages/sync/**'] };
    const violations = [
      { sub: 'rm packages/evm-module/contracts/x.sol', cmd: 'rm',
        path: 'packages/evm-module/contracts/x.sol', decision: 'deny' },
    ];
    const { message } = buildShellPrecheckDenial({
      command: 'rm packages/evm-module/contracts/x.sol',
      violations, task, taskId: 'sync', root,
    });
    const p = extractJson(message);
    assert.equal(p.reason, 'out-of-scope');
    assert.equal(p.suggestedFix.includes('packages/evm-module/contracts/**'), true);
    const ids = p.options.map(o => o.id);
    assert.ok(ids.includes('add_file'));
    assert.ok(ids.includes('switch_task_other'));
  } finally { cleanup(root); }
});

test('buildShellPrecheckDenial: mixed protected+out-of-scope → protected wins', () => {
  const root = makeTempRepo();
  try {
    const task = { id: 'x', allowed: ['only/**'] };
    const violations = [
      { sub: '1', cmd: 'rm', path: 'other/file.ts', decision: 'deny' },
      { sub: '2', cmd: 'rm', path: '.cursor/hooks/x.mjs', decision: 'protected' },
    ];
    const { message } = buildShellPrecheckDenial({
      command: '...', violations, task, taskId: 'x', root,
    });
    const p = extractJson(message);
    assert.equal(p.reason, 'protected');
    assert.deepEqual(
      p.options.map(o => o.id),
      ['bootstrap', 'cancel', 'skip', 'custom_instruction'],
    );
  } finally { cleanup(root); }
});

// ---------------------------------------------------------------------------
// buildAfterShellContext
// ---------------------------------------------------------------------------

test('buildAfterShellContext: reverted + deleted in message', () => {
  const root = makeTempRepo();
  try {
    const { message } = buildAfterShellContext({
      command: 'whatever', task: { id: 'sync' }, taskId: 'sync', root,
      reverted: ['packages/other/x.ts'],
      deleted:  ['.cursor/hooks/bad.mjs'],
      unreverted: [],
    });
    assert.ok(message.includes('Reverted:'));
    assert.ok(message.includes('Deleted:'));
    assert.ok(message.includes('packages/other/x.ts'));
    assert.ok(message.includes('.cursor/hooks/bad.mjs'));
    const p = extractJson(message);
    assert.equal(p.hook, 'afterShellExecution');
    assert.equal(p.reason, 'protected');        // protected detected in deleted[]
    assert.deepEqual(p.reverted, ['packages/other/x.ts']);
    assert.deepEqual(p.deleted,  ['.cursor/hooks/bad.mjs']);
  } finally { cleanup(root); }
});

test('buildAfterShellContext: no protected → out-of-scope menu', () => {
  const root = makeTempRepo();
  try {
    const { message } = buildAfterShellContext({
      command: 'x', task: { id: 'sync' }, taskId: 'sync', root,
      reverted: ['packages/other/x.ts'],
      deleted: [], unreverted: [],
    });
    const p = extractJson(message);
    assert.equal(p.reason, 'out-of-scope');
    assert.ok(p.options.some(o => o.id === 'add_file'));
  } finally { cleanup(root); }
});

test('buildAfterShellContext: nothing touched → unknown menu', () => {
  const root = makeTempRepo();
  try {
    const { message } = buildAfterShellContext({
      command: 'x', task: null, taskId: null, root,
      reverted: [], deleted: [], unreverted: [],
    });
    const p = extractJson(message);
    assert.equal(p.reason, 'unknown');
    assert.ok(p.options.some(o => o.id === 'acknowledge'));
  } finally { cleanup(root); }
});

// ---------------------------------------------------------------------------
// Structural invariants (all builders)
// ---------------------------------------------------------------------------

test('every builder emits version:1 and well-formed options', () => {
  const root = makeTempRepo();
  try {
    const cases = [
      buildPreToolUseDenial({ tool: 'Write', deniedPath: 'a/b.ts', decision: 'deny',
        task: { id: 't', allowed: ['c/**'] }, taskId: 't', root }),
      buildPreToolUseDenial({ tool: 'Write', deniedPath: '.cursor/hooks/x.mjs',
        decision: 'protected', task: null, taskId: null, root }),
      buildLoadErrorDenial({ taskId: 't', error: 'bad' }),
      buildShellPrecheckDenial({ command: 'rm x',
        violations: [{ cmd: 'rm', path: 'x', decision: 'deny' }],
        task: { id: 't' }, taskId: 't', root }),
      buildAfterShellContext({ command: 'x',
        task: { id: 't' }, taskId: 't', root,
        reverted: ['a.ts'], deleted: [], unreverted: [] }),
    ];
    for (const { message, structured } of cases) {
      const p = extractJson(message);
      assert.equal(p.version, 1);
      assert.ok(Array.isArray(p.options));
      assert.ok(p.options.length >= 2);
      for (const opt of p.options) {
        assert.ok(typeof opt.id === 'string' && opt.id.length > 0);
        assert.ok(typeof opt.label === 'string' && opt.label.length > 0);
        assert.ok(opt.action && typeof opt.action.kind === 'string');
      }
      assert.equal(structured.version, 1);
    }
  } finally { cleanup(root); }
});

test('every denial builder sets recommendedOptionId to a valid option', () => {
  const root = makeTempRepo();
  try {
    const cases = [
      buildPreToolUseDenial({ tool: 'Write', deniedPath: 'a/b.ts', decision: 'deny',
        task: { id: 't', allowed: ['c/**'] }, taskId: 't', root }),
      buildPreToolUseDenial({ tool: 'Write', deniedPath: '.cursor/hooks/x.mjs',
        decision: 'protected', task: null, taskId: null, root }),
      buildLoadErrorDenial({ taskId: 't', error: 'bad' }),
      buildShellPrecheckDenial({ command: 'rm x',
        violations: [{ cmd: 'rm', path: 'x', decision: 'deny' }],
        task: { id: 't' }, taskId: 't', root }),
      buildAfterShellContext({ command: 'x',
        task: { id: 't' }, taskId: 't', root,
        reverted: ['a.ts'], deleted: [], unreverted: [] }),
    ];
    for (const { message } of cases) {
      const p = extractJson(message);
      assert.ok(
        typeof p.recommendedOptionId === 'string' && p.recommendedOptionId.length,
        'recommendedOptionId is a non-empty string',
      );
      const ids = p.options.map(o => o.id);
      assert.ok(
        ids.includes(p.recommendedOptionId),
        `recommended "${p.recommendedOptionId}" must be in the options list`,
      );
      assert.equal(p.agentReasoning, null,
        'agentReasoning is a null placeholder the agent fills in via AskQuestion prompt');
    }
  } finally { cleanup(root); }
});

// ---------------------------------------------------------------------------
// simpleOptions — the two-option plan-mode surface
// ---------------------------------------------------------------------------

test('simpleOptions: exactly two entries (recommended + custom) on every builder', () => {
  const root = makeTempRepo();
  try {
    const cases = [
      buildPreToolUseDenial({ tool: 'Write', deniedPath: 'a/b.ts', decision: 'deny',
        task: { id: 't', allowed: ['c/**'] }, taskId: 't', root }),
      buildPreToolUseDenial({ tool: 'Write', deniedPath: '.cursor/hooks/x.mjs',
        decision: 'protected', task: null, taskId: null, root }),
      buildLoadErrorDenial({ taskId: 't', error: 'bad' }),
      buildShellPrecheckDenial({ command: 'rm x',
        violations: [{ cmd: 'rm', path: 'x', decision: 'deny' }],
        task: { id: 't' }, taskId: 't', root }),
      buildAfterShellContext({ command: 'x',
        task: { id: 't' }, taskId: 't', root,
        reverted: ['a.ts'], deleted: [], unreverted: [] }),
    ];
    for (const { message } of cases) {
      const p = extractJson(message);
      assert.ok(Array.isArray(p.simpleOptions), 'simpleOptions is an array');
      assert.equal(p.simpleOptions.length, 2,
        'simpleOptions always has exactly two entries (recommended + custom)');
      const [rec, custom] = p.simpleOptions;
      assert.equal(rec.id, p.recommendedOptionId,
        'first simple option matches recommendedOptionId');
      assert.equal(custom.id, 'custom_instruction',
        'second simple option is the custom free-text fallback');
      assert.equal(custom.action.kind, 'custom');
      for (const opt of p.simpleOptions) {
        assert.ok(typeof opt.id === 'string' && opt.id.length);
        assert.ok(typeof opt.label === 'string' && opt.label.length);
        assert.ok(opt.action && typeof opt.action.kind === 'string');
      }
    }
  } finally { cleanup(root); }
});

test('simpleOptions: recommended labels are short and natural', () => {
  const root = makeTempRepo();
  try {
    // out-of-scope → recommended is add_glob → "Add this folder..."
    const { message: m1 } = buildPreToolUseDenial({ tool: 'Write',
      deniedPath: 'packages/foo/bar.ts', decision: 'deny',
      task: { id: 't', allowed: ['other/**'] }, taskId: 't', root });
    const p1 = extractJson(m1);
    assert.equal(p1.simpleOptions[0].label, 'Add this folder to the task and try again');

    // protected → recommended is cancel → "Skip it"
    const { message: m2 } = buildPreToolUseDenial({ tool: 'Write',
      deniedPath: '.cursor/hooks/x.mjs', decision: 'protected',
      task: null, taskId: null, root });
    const p2 = extractJson(m2);
    assert.equal(p2.simpleOptions[0].label, 'Skip it');

    // custom label is the natural one too
    assert.equal(p2.simpleOptions[1].label, 'Something else — tell me what');
  } finally { cleanup(root); }
});

// ---------------------------------------------------------------------------
// humanSummary — short, natural, quotable by the agent
// ---------------------------------------------------------------------------

test('humanSummary: present, short, no banners, no agent-directed meta copy', () => {
  const root = makeTempRepo();
  try {
    const cases = [
      buildPreToolUseDenial({ tool: 'Write', deniedPath: 'a/b.ts', decision: 'deny',
        task: { id: 't', allowed: ['c/**'] }, taskId: 't', root }),
      buildPreToolUseDenial({ tool: 'Write', deniedPath: '.cursor/hooks/x.mjs',
        decision: 'protected', task: null, taskId: null, root }),
      buildLoadErrorDenial({ taskId: 't', error: 'bad' }),
      buildShellPrecheckDenial({ command: 'rm x',
        violations: [{ cmd: 'rm', path: 'x', decision: 'deny' }],
        task: { id: 't' }, taskId: 't', root }),
      buildAfterShellContext({ command: 'x',
        task: { id: 't' }, taskId: 't', root,
        reverted: ['a.ts'], deleted: [], unreverted: [] }),
    ];
    for (const { message } of cases) {
      const p = extractJson(message);
      assert.ok(typeof p.humanSummary === 'string' && p.humanSummary.length > 0);
      assert.ok(p.humanSummary.length <= 400,
        `humanSummary is concise (<= 400 chars): "${p.humanSummary}"`);
      // No ALL-CAPS banners.
      assert.ok(!/PROTECTED PATH|OUT OF TASK SCOPE|STOP\b/.test(p.humanSummary),
        'humanSummary has no ALL-CAPS banners');
      // No agent-directed meta copy.
      assert.ok(!/surface .* menu|via AskQuestion/i.test(p.humanSummary),
        'humanSummary is not agent-directed meta copy');
    }
  } finally { cleanup(root); }
});

test('custom_instruction option appears in every denial menu', () => {
  const root = makeTempRepo();
  try {
    const cases = [
      buildPreToolUseDenial({ tool: 'Write', deniedPath: 'a/b.ts', decision: 'deny',
        task: { id: 't', allowed: ['c/**'] }, taskId: 't', root }),
      buildPreToolUseDenial({ tool: 'Write', deniedPath: '.cursor/hooks/x.mjs',
        decision: 'protected', task: null, taskId: null, root }),
      buildLoadErrorDenial({ taskId: 't', error: 'bad' }),
      buildShellPrecheckDenial({ command: 'rm x',
        violations: [{ cmd: 'rm', path: 'x', decision: 'deny' }],
        task: { id: 't' }, taskId: 't', root }),
      buildAfterShellContext({ command: 'x',
        task: { id: 't' }, taskId: 't', root,
        reverted: ['a.ts'], deleted: [], unreverted: [] }),
    ];
    for (const { message } of cases) {
      const p = extractJson(message);
      const custom = p.options.find(o => o.id === 'custom_instruction');
      assert.ok(custom, 'custom_instruction present in every denial menu');
      assert.equal(custom.action.kind, 'custom');
    }
  } finally { cleanup(root); }
});
