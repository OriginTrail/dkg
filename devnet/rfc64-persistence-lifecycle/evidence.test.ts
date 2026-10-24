import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
  atomicWriteStableJson,
  readCleanRepositoryHead,
  stableJson,
} from './evidence.js';

const temporaryDirectories: string[] = [];

test.afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

test('stableJson sorts keys and preserves supported plain data exactly', () => {
  const value = {
    z: [true, null, 17.25, 'plain'],
    a: { second: 2, first: 1 },
  };
  const encoded = stableJson(value);
  assert.equal(
    encoded,
    '{\n  "a": {\n    "first": 1,\n    "second": 2\n  },\n  "z": [\n    true,\n    null,\n    17.25,\n    "plain"\n  ]\n}\n',
  );
  assert.deepEqual(JSON.parse(encoded), value);
});

test('stableJson rejects values that JSON would omit, coerce, or reshape', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const shared = { value: true };
  const symbolKeyed = { visible: true } as Record<PropertyKey, unknown>;
  symbolKeyed[Symbol('hidden')] = false;
  const hidden = { visible: true };
  Object.defineProperty(hidden, 'hidden', { value: false, enumerable: false });
  const sparse = new Array(1);
  const accessor = {};
  Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 1 });

  for (const value of [
    undefined,
    { value: undefined },
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -0,
    1n,
    new Date(0),
    Object.create(null),
    sparse,
    symbolKeyed,
    hidden,
    accessor,
    cyclic,
    [shared, shared],
  ]) {
    assert.throws(() => stableJson(value));
  }
});

test('readCleanRepositoryHead returns HEAD, permits untracked files, and rejects tracked dirt', () => {
  const repo = temporaryDirectory('dkg-rfc64-gate0-git-');
  git(repo, ['init', '-q']);
  writeFileSync(join(repo, 'tracked.txt'), 'committed\n');
  git(repo, ['add', 'tracked.txt']);
  git(repo, [
    '-c',
    'user.name=Gate 0 Test',
    '-c',
    'user.email=gate0@example.invalid',
    'commit',
    '-qm',
    'initial',
  ]);
  const expectedHead = git(repo, ['rev-parse', 'HEAD']);

  assert.equal(readCleanRepositoryHead(repo), expectedHead);
  writeFileSync(join(repo, 'untracked.txt'), 'ignored by tracked-source check\n');
  assert.equal(readCleanRepositoryHead(repo), expectedHead);

  writeFileSync(join(repo, 'tracked.txt'), 'modified\n');
  assert.throws(
    () => readCleanRepositoryHead(repo),
    /refuses to spawn with tracked source changes/u,
  );
  git(repo, ['add', 'tracked.txt']);
  assert.throws(
    () => readCleanRepositoryHead(repo),
    /refuses to spawn with tracked source changes/u,
  );
});

test('atomicWriteStableJson replaces through a 0600 sibling temp and returns final SHA-256', () => {
  const root = temporaryDirectory('dkg-rfc64-gate0-artifact-');
  const parent = join(root, 'artifacts');
  const artifact = join(parent, 'gate0-result.json');
  const first = atomicWriteStableJson(artifact, { z: 2, a: 1 });
  const firstBytes = readFileSync(artifact);
  assert.equal(first.sha256, sha256(firstBytes));
  assert.deepEqual(JSON.parse(firstBytes.toString('utf8')), { a: 1, z: 2 });
  assert.deepEqual(readdirSync(parent), ['gate0-result.json']);
  if (process.platform !== 'win32') {
    assert.equal(lstatSync(artifact).mode & 0o777, 0o600);
  }

  chmodSync(artifact, 0o644);
  const second = atomicWriteStableJson(artifact, { replacement: true });
  const secondBytes = readFileSync(artifact);
  assert.equal(second.sha256, sha256(secondBytes));
  assert.deepEqual(JSON.parse(secondBytes.toString('utf8')), { replacement: true });
  assert.deepEqual(readdirSync(parent), ['gate0-result.json']);
  if (process.platform !== 'win32') {
    assert.equal(lstatSync(artifact).mode & 0o777, 0o600);
    assert.equal(second.durability, 'posix-file-fsync-rename-directory-fsync-v1');
  } else {
    assert.equal(second.durability, 'windows-file-fsync-rename-topology-validated-v1');
  }
});

test(
  'atomicWriteStableJson rejects a symlink artifact target',
  { skip: process.platform === 'win32' },
  () => {
    const root = temporaryDirectory('dkg-rfc64-gate0-target-link-');
    const victim = join(root, 'victim.json');
    const artifact = join(root, 'gate0-result.json');
    writeFileSync(victim, 'do not replace through link\n');
    symlinkSync(victim, artifact);
    assert.throws(
      () => atomicWriteStableJson(artifact, { safe: true }),
      /non-symlink regular file/u,
    );
    assert.equal(readFileSync(victim, 'utf8'), 'do not replace through link\n');
  },
);

test(
  'atomicWriteStableJson rejects a symlink parent directory',
  { skip: process.platform === 'win32' },
  () => {
    const root = temporaryDirectory('dkg-rfc64-gate0-parent-link-');
    const realParent = join(root, 'real');
    const linkedParent = join(root, 'linked');
    mkdirSync(realParent);
    symlinkSync(realParent, linkedParent, 'dir');
    assert.throws(
      () => atomicWriteStableJson(join(linkedParent, 'gate0-result.json'), { safe: true }),
      /non-symlink directory/u,
    );
    assert.deepEqual(readdirSync(realParent), []);
  },
);

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function sha256(bytes: Uint8Array): string {
  return `0x${createHash('sha256').update(bytes).digest('hex')}`;
}
