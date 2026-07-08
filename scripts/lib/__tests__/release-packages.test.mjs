import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildInfoPayload,
  discoverPublishablePackages,
  findReleaseVersionMismatches,
  verifyReleaseTag,
  writeBuildInfo,
} from '../../release-packages.mjs';

const SCRIPT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../release-packages.mjs');

function writePackage(root, rel, pkg) {
  const filePath = path.join(root, rel, 'package.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(pkg, null, 2)}\n`);
}

function withFixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-release-packages-'));
  try {
    writePackage(root, '.', { name: 'dkg-v10', version: '1.2.3', private: true });
    writePackage(root, 'packages/cli', { name: '@origintrail-official/dkg', version: '1.2.3' });
    writePackage(root, 'packages/query', { name: '@origintrail-official/dkg-query', version: '1.2.3' });
    writePackage(root, 'packages/private-tool', { name: '@origintrail-official/private-tool', version: '1.2.3', private: true });
    writePackage(root, 'packages/other-scope', { name: '@example/other', version: '1.2.3' });
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('discovers public OriginTrail packages only', () => withFixture((root) => {
  assert.deepEqual(
    discoverPublishablePackages(root).map((pkg) => pkg.name),
    ['@origintrail-official/dkg', '@origintrail-official/dkg-query'],
  );
}));

test('finds every release package version mismatch, including private packages and the root', () => withFixture((root) => {
  writePackage(root, 'packages/private-tool', {
    name: '@origintrail-official/private-tool',
    version: '1.2.4',
    private: true,
  });
  const mismatches = findReleaseVersionMismatches('1.2.3', root);
  assert.deepEqual(mismatches.map((m) => m.path), ['packages/private-tool/package.json']);
  assert.equal(mismatches[0].actual, '1.2.4');
}));

test('flags a stale root package.json version', () => withFixture((root) => {
  writePackage(root, '.', { name: 'dkg-v10', version: '1.2.2', private: true });
  const mismatches = findReleaseVersionMismatches('1.2.3', root);
  assert.deepEqual(mismatches.map((m) => m.path), ['package.json']);
  assert.equal(mismatches[0].actual, '1.2.2');
}));

test('build-info payload matches the daemon manifest contract', () => {
  assert.deepEqual(buildInfoPayload({
    commit: 'abcdef1234567890',
    distTag: 'rc',
    ciRun: 'manual',
    buildTime: '2026-07-07T00:00:00.000Z',
  }), {
    commit: 'abcdef1234567890',
    commitShort: 'abcdef12',
    buildTime: '2026-07-07T00:00:00.000Z',
    distTag: 'rc',
    ciRun: 'manual',
  });
});

test('writeBuildInfo writes packages/cli/build-info.json', () => withFixture((root) => {
  const { outputPath, payload } = writeBuildInfo({
    rootDir: root,
    commit: '1234567890abcdef',
    distTag: 'latest',
    buildTime: '2026-07-07T00:00:00.000Z',
  });
  assert.equal(path.relative(root, outputPath), 'packages/cli/build-info.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), payload);
  assert.equal(payload.commitShort, '12345678');
}));

const TAG_OBJECT_SHA = 'a'.repeat(40);

function fakeGitRunner(overrides = {}) {
  const responses = {
    'rev-parse --verify refs/tags/v1.2.3': TAG_OBJECT_SHA,
    'cat-file -t refs/tags/v1.2.3': 'tag',
    'cat-file tag refs/tags/v1.2.3': 'object x\ntype commit\ntag v1.2.3\n\n-----BEGIN SSH SIGNATURE-----\nabc\n-----END SSH SIGNATURE-----',
    'merge-base --is-ancestor v1.2.3^{commit} origin/main': '',
    'ls-remote origin refs/tags/v1.2.3': `${TAG_OBJECT_SHA}\trefs/tags/v1.2.3\n${'b'.repeat(40)}\trefs/tags/v1.2.3^{}`,
    ...overrides,
  };
  return (cmd, args) => {
    assert.equal(cmd, 'git');
    const key = args.join(' ');
    const value = responses[key];
    if (value === undefined) throw new Error(`unexpected git invocation: ${key}`);
    if (value instanceof Error) throw value;
    return value;
  };
}

test('verifyReleaseTag passes a signed, pushed, main-reachable tag', () => {
  assert.deepEqual(verifyReleaseTag({ tag: 'v1.2.3', version: '1.2.3', runner: fakeGitRunner() }), []);
});

test('verifyReleaseTag flags a lightweight (peeled) tag', () => {
  const problems = verifyReleaseTag({
    tag: 'v1.2.3',
    runner: fakeGitRunner({ 'cat-file -t refs/tags/v1.2.3': 'commit' }),
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not an annotated tag/);
});

test('verifyReleaseTag flags a signature-less annotated tag', () => {
  const problems = verifyReleaseTag({
    tag: 'v1.2.3',
    runner: fakeGitRunner({ 'cat-file tag refs/tags/v1.2.3': 'object x\ntype commit\ntag v1.2.3\n\nunsigned message' }),
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no PGP\/SSH signature block/);
});

test('verifyReleaseTag flags a tag not reachable from the release base', () => {
  const problems = verifyReleaseTag({
    tag: 'v1.2.3',
    runner: fakeGitRunner({ 'merge-base --is-ancestor v1.2.3^{commit} origin/main': new Error('exit 1') }),
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not reachable from origin\/main/);
});

test('verifyReleaseTag flags an unpushed tag and a moved remote tag', () => {
  const unpushed = verifyReleaseTag({
    tag: 'v1.2.3',
    runner: fakeGitRunner({ 'ls-remote origin refs/tags/v1.2.3': '' }),
  });
  assert.equal(unpushed.length, 1);
  assert.match(unpushed[0], /not on origin/);

  const moved = verifyReleaseTag({
    tag: 'v1.2.3',
    runner: fakeGitRunner({ 'ls-remote origin refs/tags/v1.2.3': `${'c'.repeat(40)}\trefs/tags/v1.2.3` }),
  });
  assert.equal(moved.length, 1);
  assert.match(moved[0], /differs from origin/);
});

test('verifyReleaseTag flags a tag/version mismatch and a missing local tag', () => {
  const problems = verifyReleaseTag({
    tag: 'v1.2.3',
    version: '1.2.4',
    runner: fakeGitRunner(),
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /expected v1\.2\.4/);

  const missing = verifyReleaseTag({
    tag: 'v1.2.3',
    runner: fakeGitRunner({ 'rev-parse --verify refs/tags/v1.2.3': new Error('fatal: needed a single revision') }),
  });
  assert.equal(missing.length, 1);
  assert.match(missing[0], /not found locally/);
});

// Regression for the release-blocking promote crash: `run()` with stdio:'inherit'
// returned null stdout and threw AFTER the first successful `npm dist-tag add`,
// so a non-dry-run promote moved exactly one tag and exited 1. Exercise the real
// CLI end-to-end against a stubbed `npm` binary.
test('promote survives interactive npm calls for the whole package set', () => {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-npm-shim-'));
  try {
    const logPath = path.join(shimDir, 'calls.log');
    fs.writeFileSync(path.join(shimDir, 'npm'), '#!/bin/sh\necho "$@" >> "$NPM_SHIM_LOG"\n');
    fs.chmodSync(path.join(shimDir, 'npm'), 0o755);
    const result = spawnSync(process.execPath, [
      SCRIPT_PATH, 'promote', '--version', '0.0.0-shimtest', '--tags', 'faketag', '--otp', '000000',
    ], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, NPM_SHIM_LOG: logPath },
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const calls = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    assert.ok(calls.length >= 2, `expected one npm call per publishable package, got ${calls.length}`);
    for (const call of calls) {
      assert.match(call, /^dist-tag add @origintrail-official\/\S+@0\.0\.0-shimtest faketag --otp=000000$/);
    }
  } finally {
    fs.rmSync(shimDir, { recursive: true, force: true });
  }
});
