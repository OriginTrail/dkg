// Unit tests for the wizard pure-logic.
//   node --test agent-scope/lib/wizard.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverPackages,
  deriveTaskId,
  suggestPackagesFromDescription,
  draftGlobs,
  buildManifest,
} from './wizard.mjs';

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'agent-scope-wizard-'));
  mkdirSync(join(root, 'agent-scope/tasks'), { recursive: true });
  return root;
}

function writePkg(root, relPath, name) {
  const full = join(root, relPath);
  mkdirSync(full, { recursive: true });
  writeFileSync(join(full, 'package.json'), JSON.stringify({ name }, null, 2));
}

// --- discoverPackages -----------------------------------------------------

test('discoverPackages: pnpm-workspace.yaml with packages/*', () => {
  const root = makeRepo();
  try {
    writeFileSync(join(root, 'pnpm-workspace.yaml'),
      'packages:\n  - "packages/*"\n  - "demo"\n');
    writePkg(root, 'packages/agent', '@x/agent');
    writePkg(root, 'packages/core',  '@x/core');
    writePkg(root, 'demo',           '@x/demo');
    // A directory without package.json should be skipped.
    mkdirSync(join(root, 'packages/no-pkg'));

    const pkgs = discoverPackages(root);
    const names = pkgs.map(p => p.name).sort();
    assert.deepEqual(names, ['agent', 'core', 'demo']);
    assert.ok(pkgs.every(p => typeof p.path === 'string' && p.path.length > 0));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('discoverPackages: falls back to package.json workspaces', () => {
  const root = makeRepo();
  try {
    writeFileSync(join(root, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['libs/*'] }));
    writePkg(root, 'libs/alpha', 'alpha');
    writePkg(root, 'libs/beta',  'beta');

    const pkgs = discoverPackages(root);
    assert.deepEqual(pkgs.map(p => p.name).sort(), ['alpha', 'beta']);
    assert.ok(pkgs.every(p => p.path.startsWith('libs/')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('discoverPackages: falls back to packages/* scan when nothing declared', () => {
  const root = makeRepo();
  try {
    writePkg(root, 'packages/lone', 'lone');
    const pkgs = discoverPackages(root);
    assert.deepEqual(pkgs.map(p => p.name), ['lone']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('discoverPackages: empty repo → empty', () => {
  const root = makeRepo();
  try {
    assert.deepEqual(discoverPackages(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('discoverPackages: ignores dotfile subdirs when expanding globs', () => {
  const root = makeRepo();
  try {
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    writePkg(root, 'packages/real', 'real');
    mkdirSync(join(root, 'packages/.hidden'), { recursive: true });
    const pkgs = discoverPackages(root);
    assert.deepEqual(pkgs.map(p => p.name), ['real']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- deriveTaskId ---------------------------------------------------------

test('deriveTaskId: kebab-cases a description', () => {
  assert.equal(deriveTaskId('Refactor Peer Sync'), 'refactor-peer-sync');
});

test('deriveTaskId: strips leading/trailing dashes', () => {
  assert.equal(deriveTaskId('  -- hello world -- '), 'hello-world');
});

test('deriveTaskId: truncates to 48 chars', () => {
  const long = 'a'.repeat(100);
  const id = deriveTaskId(long);
  assert.ok(id.length <= 48, `got ${id.length}`);
  assert.match(id, /^a+$/);
});

test('deriveTaskId: empty → task-<stamp>', () => {
  const id = deriveTaskId('');
  assert.match(id, /^task-\d{8,14}$/);
});

test('deriveTaskId: colon-only → task-<stamp>', () => {
  const id = deriveTaskId('!!!');
  assert.match(id, /^task-\d{8,14}$/);
});

test('deriveTaskId: collision → appends -2, -3', () => {
  const existing = ['fix-auth', 'fix-auth-2'];
  const id = deriveTaskId('fix auth', { existingIds: existing });
  assert.equal(id, 'fix-auth-3');
});

// --- suggestPackagesFromDescription ---------------------------------------

const SAMPLE_PKGS = [
  { path: 'packages/agent',     name: 'agent' },
  { path: 'packages/core',      name: 'core' },
  { path: 'packages/publisher', name: 'publisher' },
  { path: 'packages/storage',   name: 'storage' },
  { path: 'packages/evm-module',name: 'evm-module' },
  { path: 'packages/cli',       name: 'cli' },
];

test('suggestPackages: exact name match wins', () => {
  const s = suggestPackagesFromDescription('refactor peer sync in agent and core', SAMPLE_PKGS);
  const names = s.map(p => p.name);
  assert.ok(names.includes('agent'), names.join(','));
  assert.ok(names.includes('core'),  names.join(','));
});

test('suggestPackages: token inside compound name (evm)', () => {
  const s = suggestPackagesFromDescription('improve evm deployment', SAMPLE_PKGS);
  assert.ok(s.some(p => p.name === 'evm-module'), s.map(x => x.name).join(','));
});

test('suggestPackages: empty description → empty', () => {
  assert.deepEqual(suggestPackagesFromDescription('', SAMPLE_PKGS), []);
});

test('suggestPackages: no match → empty', () => {
  const s = suggestPackagesFromDescription('write unrelated documentation for readme', SAMPLE_PKGS);
  assert.equal(s.length, 0);
});

test('suggestPackages: ignores 1-char / stopword tokens', () => {
  // 'a' 'to' 'the' would otherwise match 'agent', 'storage', 'publisher'
  const s = suggestPackagesFromDescription('a to the', SAMPLE_PKGS);
  assert.equal(s.length, 0);
});

test('suggestPackages: caps at ceil(n/2) by default', () => {
  const s = suggestPackagesFromDescription(
    'agent core publisher storage evm cli',
    SAMPLE_PKGS,
  );
  assert.ok(s.length <= Math.ceil(SAMPLE_PKGS.length / 2),
    `suggestions: ${s.map(p => p.name).join(',')}`);
});

// --- draftGlobs -----------------------------------------------------------

test('draftGlobs: one package → one allowed entry plus deny negations', () => {
  const { allowed, exemptions } = draftGlobs(
    [{ path: 'packages/agent', name: 'agent' }],
    { includeBuildArtifacts: false },
  );
  assert.deepEqual(allowed, [
    'packages/agent/**',
    '!**/secrets.*',
    '!**/.env*',
  ]);
  assert.deepEqual(exemptions, []);
});

test('draftGlobs: multiple packages + build exemptions', () => {
  const { allowed, exemptions } = draftGlobs(
    [{ path: 'packages/agent' }, { path: 'packages/core' }],
    { includeBuildArtifacts: true },
  );
  assert.ok(allowed.includes('packages/agent/**'));
  assert.ok(allowed.includes('packages/core/**'));
  assert.ok(allowed.includes('!**/secrets.*'));
  assert.deepEqual(exemptions, ['**/dist/**', '**/*.tsbuildinfo', 'pnpm-lock.yaml']);
});

test('draftGlobs: extraAllowed + extraDeny', () => {
  const { allowed } = draftGlobs([], {
    includeBuildArtifacts: false,
    extraAllowed: ['scripts/my-tool.ts'],
    extraDeny:    ['config/**', '!already/!prefixed.ts'],
  });
  assert.ok(allowed.includes('scripts/my-tool.ts'));
  assert.ok(allowed.includes('!config/**'));
  assert.ok(allowed.includes('!already/!prefixed.ts'));
});

test('draftGlobs: deduplicates identical entries', () => {
  const { allowed } = draftGlobs(
    [{ path: 'packages/agent' }, { path: 'packages/agent/' }],
    { includeBuildArtifacts: false },
  );
  assert.equal(allowed.filter(a => a === 'packages/agent/**').length, 1);
});

test('draftGlobs: accepts raw path strings as well as {path} objects', () => {
  const { allowed } = draftGlobs(
    ['packages/mixed', { path: 'packages/object' }],
    { includeBuildArtifacts: false },
  );
  assert.ok(allowed.includes('packages/mixed/**'));
  assert.ok(allowed.includes('packages/object/**'));
});

// --- buildManifest --------------------------------------------------------

test('buildManifest: composes a valid-looking manifest', () => {
  const m = buildManifest({
    id: 'my-task',
    description: 'Refactor sync',
    selectedPackages: [{ path: 'packages/agent' }],
    includeBuildArtifacts: true,
    inheritBase: true,
    now: () => '2026-01-01T00:00:00.000Z',
  });
  assert.equal(m.id, 'my-task');
  assert.equal(m.description, 'Refactor sync');
  assert.equal(m.created, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(m.inherits, ['base']);
  assert.ok(m.allowed.includes('packages/agent/**'));
  assert.ok(m.exemptions.includes('**/dist/**'));
});

test('buildManifest: invalid id → derives from description', () => {
  const m = buildManifest({
    id: '---bad---',
    description: 'Fix staking flow',
    selectedPackages: [{ path: 'packages/chain' }],
  });
  assert.match(m.id, /^fix-staking-flow/);
});

test('buildManifest: no inheritBase → no inherits field', () => {
  const m = buildManifest({
    id: 'isolated',
    description: 'd',
    selectedPackages: [{ path: 'packages/x' }],
    inheritBase: false,
  });
  assert.equal(m.inherits, undefined);
});
