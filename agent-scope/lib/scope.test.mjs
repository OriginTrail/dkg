// Unit tests for the scope-check library. Run with:
//   node --test agent-scope/lib/scope.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync, statSync, existsSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkPath,
  checkProtected,
  coversProtected,
  validateManifest,
  normalizeToRepoPath,
  loadTask,
  resolveActiveTaskId,
  listTasks,
  explainDeny,
  checkNodeVersion,
  PROTECTED_PATTERNS,
  isBootstrapActive,
} from './scope.mjs';
import { logDenial, logDecision, MAX_BYTES } from './log.mjs';

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'agent-scope-test-'));
  mkdirSync(join(root, 'agent-scope/tasks'), { recursive: true });
  return root;
}

function writeTask(root, id, body) {
  writeFileSync(join(root, 'agent-scope/tasks', `${id}.json`), JSON.stringify(body, null, 2));
}

// --- core decision --------------------------------------------------------

test('checkPath: no task → allow for non-protected path', () => {
  assert.equal(checkPath(null, 'any/file.ts'), 'allow');
});

test('checkPath: basic allow', () => {
  const t = { id: 't', allowed: ['src/**/*.ts'] };
  assert.equal(checkPath(t, 'src/foo/bar.ts'), 'allow');
});

test('checkPath: deny when not matched', () => {
  const t = { id: 't', allowed: ['src/**/*.ts'] };
  assert.equal(checkPath(t, 'lib/other.ts'), 'deny');
});

test('checkPath: exemption', () => {
  const t = { id: 't', allowed: ['src/**/*.ts'], exemptions: ['**/dist/**'] };
  assert.equal(checkPath(t, 'anything/dist/bundle.js'), 'exempt');
});

test('checkPath: explicit deny (!) overrides allowed', () => {
  const t = { id: 't', allowed: ['src/**', '!src/**/secrets.*'] };
  assert.equal(checkPath(t, 'src/config/secrets.ts'), 'deny');
  assert.equal(checkPath(t, 'src/config/public.ts'), 'allow');
});

test('checkPath: explicit deny in exemptions overrides exemption', () => {
  const t = { id: 't', allowed: ['src/**'], exemptions: ['**/dist/**', '!**/dist/secret.js'] };
  assert.equal(checkPath(t, 'foo/dist/secret.js'), 'deny');
  assert.equal(checkPath(t, 'foo/dist/bundle.js'), 'exempt');
});

test('checkPath: path traversal denied', () => {
  const t = { id: 't', allowed: ['**'] };
  assert.equal(checkPath(t, '../etc/passwd'), 'deny');
});

// --- protected paths ------------------------------------------------------

test('checkProtected: matches a known protected path', () => {
  const isolated = makeRepo(); // no bootstrap token
  try {
    assert.equal(checkProtected('.cursor/hooks.json', isolated), 'deny');
    assert.equal(checkProtected('.cursor/hooks/scope-guard.mjs', isolated), 'deny');
    assert.equal(checkProtected('agent-scope/lib/scope.mjs', isolated), 'deny');
    assert.equal(checkProtected('agent-scope/tasks/base.json', isolated), 'deny');
    assert.equal(checkProtected('agent-scope/active', isolated), 'deny');
    assert.equal(checkProtected('agent-scope/.bootstrap-token', isolated), 'deny');
  } finally { rmSync(isolated, { recursive: true, force: true }); }
});

test('checkProtected: normal paths pass through', () => {
  const isolated = makeRepo();
  try {
    assert.equal(checkProtected('packages/core/src/index.ts', isolated), 'allow');
    assert.equal(checkProtected('README.md', isolated), 'allow');
  } finally { rmSync(isolated, { recursive: true, force: true }); }
});

test('checkProtected: bootstrap env bypass', () => {
  process.env.AGENT_SCOPE_BOOTSTRAP = '1';
  try {
    assert.equal(checkProtected('.cursor/hooks.json'), 'allow');
  } finally { delete process.env.AGENT_SCOPE_BOOTSTRAP; }
});

test('checkProtected: token file bypass', () => {
  const root = makeRepo();
  try {
    writeFileSync(join(root, 'agent-scope/.bootstrap-token'), '');
    assert.equal(isBootstrapActive(root), true);
    assert.equal(checkProtected('agent-scope/lib/scope.mjs', root), 'allow');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkPath: protected even with active task that would allow it', () => {
  const t = { id: 't', allowed: ['**'] };
  const isolated = makeRepo();
  try {
    assert.equal(checkPath(t, '.cursor/hooks.json', isolated), 'protected');
  } finally { rmSync(isolated, { recursive: true, force: true }); }
});

test('coversProtected: directory that IS a protected tree root', () => {
  const isolated = makeRepo();
  try {
    assert.equal(coversProtected('.cursor/hooks', isolated), true);
    assert.equal(coversProtected('.cursor/hooks/', isolated), true);
    assert.equal(coversProtected('agent-scope/lib', isolated), true);
    assert.equal(coversProtected('agent-scope/tasks', isolated), true);
  } finally { rmSync(isolated, { recursive: true, force: true }); }
});

test('coversProtected: ancestor directory of a protected tree', () => {
  const isolated = makeRepo();
  try {
    assert.equal(coversProtected('.cursor', isolated), true); // contains hooks/, rules/, hooks.json
    assert.equal(coversProtected('agent-scope', isolated), true); // contains lib, bin, ...
  } finally { rmSync(isolated, { recursive: true, force: true }); }
});

test('coversProtected: unrelated directory', () => {
  const isolated = makeRepo();
  try {
    assert.equal(coversProtected('packages/agent', isolated), false);
    assert.equal(coversProtected('README.md', isolated), false);
  } finally { rmSync(isolated, { recursive: true, force: true }); }
});

test('coversProtected: bootstrap bypasses', () => {
  const root = makeRepo();
  try {
    writeFileSync(join(root, 'agent-scope/.bootstrap-token'), '');
    assert.equal(coversProtected('.cursor', root), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('PROTECTED_PATTERNS: covers all system surfaces', () => {
  // Sanity: make sure nothing is forgotten. The guard only protects its own
  // live surfaces (Cursor hooks + rule + scope library + bin CLI + task
  // manifests + active-task pointer + the bootstrap token itself).
  const required = [
    '.cursor/hooks/**',
    '.cursor/hooks.json',
    '.cursor/rules/agent-scope.mdc',
    'agent-scope/lib/**',
    'agent-scope/bin/**',
    'agent-scope/schema/**',
    'agent-scope/tasks/**',
    'agent-scope/active',
    'agent-scope/.bootstrap-token',
  ];
  for (const p of required) assert.ok(PROTECTED_PATTERNS.includes(p), `missing protection: ${p}`);
});

// --- glob -----------------------------------------------------------------

test('glob: ** crosses directory separators', () => {
  const t = { id: 't', allowed: ['pkg/**/test.ts'] };
  assert.equal(checkPath(t, 'pkg/a/b/c/test.ts'), 'allow');
  assert.equal(checkPath(t, 'pkg/test.ts'), 'allow');
});

test('glob: * does not cross /', () => {
  const t = { id: 't', allowed: ['pkg/*/test.ts'] };
  assert.equal(checkPath(t, 'pkg/a/test.ts'), 'allow');
  assert.equal(checkPath(t, 'pkg/a/b/test.ts'), 'deny');
});

test('glob: ? matches one char', () => {
  const t = { id: 't', allowed: ['file?.ts'] };
  assert.equal(checkPath(t, 'file1.ts'), 'allow');
  assert.equal(checkPath(t, 'file12.ts'), 'deny');
  assert.equal(checkPath(t, 'file.ts'), 'deny');
});

test('glob: literal dots', () => {
  const t = { id: 't', allowed: ['foo.bar.ts'] };
  assert.equal(checkPath(t, 'foo.bar.ts'), 'allow');
  assert.equal(checkPath(t, 'fooxbarxts'), 'deny');
});

// --- path normalization --------------------------------------------------

test('normalizeToRepoPath: absolute → relative', () => {
  assert.equal(normalizeToRepoPath('/tmp/repo', '/tmp/repo/a/b.ts'), 'a/b.ts');
});

test('normalizeToRepoPath: relative stays relative', () => {
  assert.equal(normalizeToRepoPath('/tmp/repo', 'a/b.ts'), 'a/b.ts');
});

// --- manifest validation --------------------------------------------------

test('validateManifest: rejects missing id', () => {
  const errs = validateManifest({ allowed: ['**'] });
  assert.ok(errs.some(e => /id/.test(e)));
});

test('validateManifest: requires allowed OR inherits OR exemptions', () => {
  const errs = validateManifest({ id: 'x' });
  assert.ok(errs.some(e => /allowed \/ inherits \/ exemptions/.test(e)));
});

test('validateManifest: inherits alone is ok', () => {
  const errs = validateManifest({ id: 'x', inherits: ['base'] });
  assert.deepEqual(errs, []);
});

test('validateManifest: rejects bad id chars', () => {
  const errs = validateManifest({ id: 'Bad Id!', allowed: ['**'] });
  assert.ok(errs.some(e => /id/.test(e)));
});

test('validateManifest: filename mismatch', () => {
  const errs = validateManifest({ id: 'foo', allowed: ['**'] }, 'bar');
  assert.ok(errs.some(e => /filename/.test(e)));
});

test('validateManifest: rejects unknown fields', () => {
  const errs = validateManifest({ id: 'x', allowed: ['**'], secret: 1 });
  assert.ok(errs.some(e => /unknown property/.test(e)));
});

test('validateManifest: rejects bad inherits', () => {
  const errs = validateManifest({ id: 'x', allowed: ['**'], inherits: ['Bad Id!'] });
  assert.ok(errs.some(e => /inherits/.test(e)));
});

test('validateManifest: accepts full valid doc', () => {
  const errs = validateManifest({
    id: 'sync',
    description: 'refactor sync',
    owner: 'bojan',
    inherits: ['base'],
    allowed: ['src/**/*.ts'],
    exemptions: ['**/dist/**'],
    notes: 'watch out for ...',
    dkg: { taskUri: 'urn:task:1' },
  });
  assert.deepEqual(errs, []);
});

// --- manifest loading + inheritance --------------------------------------

test('loadTask: returns parsed manifest', () => {
  const root = makeRepo();
  try {
    writeTask(root, 'x', { id: 'x', allowed: ['**/*.ts'] });
    const t = loadTask(root, 'x');
    assert.equal(t.id, 'x');
    assert.deepEqual(t.allowed, ['**/*.ts']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loadTask: throws on corrupt JSON', () => {
  const root = makeRepo();
  try {
    writeFileSync(join(root, 'agent-scope/tasks/x.json'), 'not json');
    assert.throws(() => loadTask(root, 'x'), /JSON/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loadTask: throws on schema violation', () => {
  const root = makeRepo();
  try {
    writeTask(root, 'x', { id: 'x' });
    assert.throws(() => loadTask(root, 'x'), /allowed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loadTask: merges allowed + exemptions from inherits', () => {
  const root = makeRepo();
  try {
    writeTask(root, 'base', { id: 'base', allowed: [], exemptions: ['**/dist/**'] });
    writeTask(root, 'child', {
      id: 'child', inherits: ['base'], allowed: ['src/**'], exemptions: ['pnpm-lock.yaml']
    });
    const t = loadTask(root, 'child');
    assert.deepEqual(t.allowed, ['src/**']);
    assert.deepEqual(t.exemptions.sort(), ['**/dist/**', 'pnpm-lock.yaml'].sort());
    assert.deepEqual(t.__inheritedFrom, ['base']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loadTask: inheritance cycle detected', () => {
  const root = makeRepo();
  try {
    writeTask(root, 'a', { id: 'a', inherits: ['b'], allowed: ['x'] });
    writeTask(root, 'b', { id: 'b', inherits: ['a'], allowed: ['y'] });
    assert.throws(() => loadTask(root, 'a'), /cycle/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loadTask: child deny overrides parent allow', () => {
  const root = makeRepo();
  try {
    writeTask(root, 'parent', { id: 'parent', allowed: ['src/**'] });
    writeTask(root, 'child', { id: 'child', inherits: ['parent'], allowed: ['!src/secrets.ts'] });
    const t = loadTask(root, 'child');
    assert.equal(checkPath(t, 'src/foo.ts'), 'allow');
    assert.equal(checkPath(t, 'src/secrets.ts'), 'deny');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- active task resolution -----------------------------------------------

test('resolveActiveTaskId: env beats file', () => {
  const root = makeRepo();
  try {
    writeFileSync(join(root, 'agent-scope/active'), 'from-file\n');
    process.env.AGENT_SCOPE_TASK = 'from-env';
    const r = resolveActiveTaskId(root, { noBranch: true, noGitConfig: true });
    assert.equal(r.id, 'from-env');
    assert.equal(r.source, 'env');
  } finally {
    delete process.env.AGENT_SCOPE_TASK;
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveActiveTaskId: file when env missing', () => {
  const root = makeRepo();
  try {
    writeFileSync(join(root, 'agent-scope/active'), 'from-file\n');
    delete process.env.AGENT_SCOPE_TASK;
    const r = resolveActiveTaskId(root, { noBranch: true, noGitConfig: true });
    assert.equal(r.id, 'from-file');
    assert.equal(r.source, 'file');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveActiveTaskId: none when nothing set', () => {
  const root = makeRepo();
  try {
    delete process.env.AGENT_SCOPE_TASK;
    const r = resolveActiveTaskId(root, { noBranch: true, noGitConfig: true });
    assert.equal(r.id, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('listTasks: returns sorted ids', () => {
  const root = makeRepo();
  try {
    writeTask(root, 'beta', { id: 'beta', allowed: ['**'] });
    writeTask(root, 'alpha', { id: 'alpha', allowed: ['**'] });
    assert.deepEqual(listTasks(root), ['alpha', 'beta']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- messages -------------------------------------------------------------

test('explainDeny: contains task id, path, and allowed patterns', () => {
  const t = { id: 'sync', description: 'sync work', allowed: ['pkg/**/sync*'] };
  const msg = explainDeny(t, 'pkg/other/x.ts', 'deny');
  assert.match(msg, /sync/);
  assert.match(msg, /pkg\/other\/x\.ts/);
  assert.match(msg, /pkg\/\*\*\/sync\*/);
});

test('explainDeny: protected path message mentions bootstrap', () => {
  const msg = explainDeny(null, '.cursor/hooks.json', 'protected');
  assert.match(msg, /PROTECTED PATH/);
  assert.match(msg, /bootstrap/i);
});

// --- node version ---------------------------------------------------------

test('checkNodeVersion: passes for current Node', () => {
  checkNodeVersion(16);
});

test('checkNodeVersion: throws for impossibly high version', () => {
  assert.throws(() => checkNodeVersion(999));
});

// --- logging rotation -----------------------------------------------------

test('log: rotates jsonl when file exceeds MAX_BYTES', () => {
  const root = makeRepo();
  try {
    const logsDir = join(root, 'agent-scope/logs');
    mkdirSync(logsDir, { recursive: true });
    const file = join(logsDir, 'denials.jsonl');
    // Pre-fill the log with ~MAX_BYTES of content so the next write triggers rotate.
    writeFileSync(file, 'x'.repeat(MAX_BYTES + 1024));
    logDenial(root, { event: 'test', path: 'a/b.ts', task: 'x' });
    // After rotation, denials.jsonl should exist and be small again.
    const after = statSync(file);
    assert.ok(after.size < 1024, `expected rotated file to be small, got ${after.size}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('log: writes jsonl with timestamp + fields', () => {
  const root = makeRepo();
  try {
    logDenial(root, { event: 'test', path: 'a/b.ts' });
    const content = readFileSync(join(root, 'agent-scope/logs/denials.jsonl'), 'utf8');
    const rec = JSON.parse(content.trim());
    assert.ok(rec.ts);
    assert.equal(rec.event, 'test');
    assert.equal(rec.path, 'a/b.ts');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('log: logDecision separate file', () => {
  const root = makeRepo();
  try {
    logDecision(root, { event: 'ok', path: 'a.ts' });
    assert.ok(existsSync(join(root, 'agent-scope/logs/decisions.jsonl')));
    assert.ok(!existsSync(join(root, 'agent-scope/logs/denials.jsonl')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
