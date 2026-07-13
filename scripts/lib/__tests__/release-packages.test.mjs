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
  findMissingCliPackAssets,
  findReleaseVersionMismatches,
  verifyReleaseTag,
  writeBuildInfo,
} from '../../release-packages.mjs';
import { cliRuntimeAssetManifest, copyCliRuntimeAssets } from '../../copy-cli-runtime-assets.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const COPY_SCRIPT = path.join(REPO_ROOT, 'scripts', 'copy-cli-runtime-assets.mjs');
const BLAZEGRAPH_METADATA_PARSER = path.join(REPO_ROOT, 'packages', 'cli', 'blazegraph-image-metadata.cjs');

const NPM_AVAILABLE = (() => {
  try {
    return spawnSync('npm', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' }).status === 0;
  } catch {
    return false;
  }
})();

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

function writeCliPackFixture(root) {
  fs.mkdirSync(path.join(root, 'network'), { recursive: true });
  fs.writeFileSync(path.join(root, 'network', 'testnet.json'), '{}\n');
  fs.writeFileSync(path.join(root, 'network', 'mainnet-base.json'), '{}\n');
  fs.writeFileSync(path.join(root, 'project.json'), '{}\n');
  fs.writeFileSync(path.join(root, 'blazegraph-image.json'), '{"image":"example/blazegraph@sha256:test","containerPort":80}\n');
}

test('flags a cli tarball missing required runtime assets (the 10.0.4 drop)', () => withFixture((root) => {
  writeCliPackFixture(root);
  const packReport = () => JSON.stringify([{ files: [{ path: 'dist/cli.js' }, { path: 'package.json' }] }]);
  const missing = findMissingCliPackAssets(root, packReport);
  assert.deepEqual(
    [...missing].sort(),
    [
      'blazegraph-image-metadata.cjs',
      'blazegraph-image.json',
      'build-info.json',
      'network/mainnet-base.json',
      'network/testnet.json',
      'project.json',
    ],
  );
}));

test('passes when the cli tarball includes every required runtime asset', () => withFixture((root) => {
  writeCliPackFixture(root);
  // npm reports Windows paths with backslashes — the check must normalize them.
  const packReport = () => JSON.stringify([{ files: [
    { path: 'project.json' },
    { path: 'blazegraph-image.json' },
    { path: 'blazegraph-image-metadata.cjs' },
    { path: 'build-info.json' },
    { path: 'network\\testnet.json' },
    { path: 'network/mainnet-base.json' },
    { path: 'dist/cli.js' },
  ] }]);
  assert.deepEqual(findMissingCliPackAssets(root, packReport), []);
}));

test('copyCliRuntimeAssets materializes package-local assets and mirrors (drops stale overlays)', () => withFixture((root) => {
  fs.mkdirSync(path.join(root, 'network'), { recursive: true });
  fs.writeFileSync(path.join(root, 'network', 'testnet.json'), '{"a":1}\n');
  fs.writeFileSync(path.join(root, 'network', 'mainnet-base.json'), '{"b":2}\n');
  fs.writeFileSync(path.join(root, 'project.json'), '{"name":"x"}\n');
  fs.writeFileSync(path.join(root, 'blazegraph-image.json'), '{"image":"example/blazegraph@sha256:test","containerPort":80}\n');
  // A stale overlay left in the package from an earlier build/branch.
  fs.mkdirSync(path.join(root, 'packages', 'cli', 'network'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages', 'cli', 'network', 'devnet.json'), '{"stale":true}\n');

  const { networkJsonFiles } = copyCliRuntimeAssets({ rootDir: root });

  const cliNetwork = path.join(root, 'packages', 'cli', 'network');
  assert.deepEqual(networkJsonFiles, ['mainnet-base.json', 'testnet.json']);
  assert.ok(fs.existsSync(path.join(cliNetwork, 'testnet.json')), 'testnet.json copied');
  assert.ok(fs.existsSync(path.join(cliNetwork, 'mainnet-base.json')), 'mainnet-base.json copied');
  assert.ok(fs.existsSync(path.join(root, 'packages', 'cli', 'project.json')), 'project.json copied');
  assert.ok(
    fs.existsSync(path.join(root, 'packages', 'cli', 'blazegraph-image.json')),
    'blazegraph-image.json copied',
  );
  assert.equal(fs.existsSync(path.join(cliNetwork, 'devnet.json')), false, 'stale overlay removed (mirror, not append)');
}));

test('copyCliRuntimeAssets fails loudly when a source asset is missing', () => withFixture((root) => {
  // network/ present but project.json absent
  fs.mkdirSync(path.join(root, 'network'), { recursive: true });
  fs.writeFileSync(path.join(root, 'network', 'testnet.json'), '{}\n');
  assert.throws(() => copyCliRuntimeAssets({ rootDir: root }), /project\.json not found/);
}));

test('packages/cli lifecycle is wired to the copy script (build + prepack)', () => {
  const cliPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages', 'cli', 'package.json'), 'utf8'));
  assert.match(cliPkg.scripts.prepack ?? '', /copy-cli-runtime-assets\.mjs/, 'prepack must run the copy script');
  assert.match(cliPkg.scripts.build ?? '', /copy-cli-runtime-assets\.mjs/, 'build must run the copy script');
});

test('the copy and the verifier consume one shared asset manifest', () => withFixture((root) => {
  writeCliPackFixture(root);
  const { relPaths } = cliRuntimeAssetManifest({ rootDir: root });
  // What the copy materializes (project/image metadata + every network overlay)…
  assert.deepEqual(relPaths, [
    'project.json',
    'blazegraph-image.json',
    'blazegraph-image-metadata.cjs',
    'network/mainnet-base.json',
    'network/testnet.json',
  ]);
  // …is exactly what the verifier requires, plus the generated build-info.json.
  const spyReport = () => JSON.stringify([{ files: [...relPaths, 'build-info.json'].map((p) => ({ path: p })) }]);
  assert.deepEqual(findMissingCliPackAssets(root, spyReport), []);
}));

test('the shared manifest is fail-closed — matches the copier, not best-effort', () => withFixture((root) => {
  // no network/ dir at all
  assert.throws(() => cliRuntimeAssetManifest({ rootDir: root }), /network\/ directory not found/);
  // empty network/
  fs.mkdirSync(path.join(root, 'network'), { recursive: true });
  assert.throws(() => cliRuntimeAssetManifest({ rootDir: root }), /no network\/\*\.json overlays/);
  // overlays present but project.json missing
  fs.writeFileSync(path.join(root, 'network', 'testnet.json'), '{}\n');
  assert.throws(() => cliRuntimeAssetManifest({ rootDir: root }), /project\.json not found/);
  fs.writeFileSync(path.join(root, 'project.json'), '{}\n');
  assert.throws(() => cliRuntimeAssetManifest({ rootDir: root }), /blazegraph-image\.json not found/);
  fs.writeFileSync(path.join(root, 'blazegraph-image.json'), '{"image":"example/blazegraph"}\n');
  assert.throws(() => cliRuntimeAssetManifest({ rootDir: root }), /blazegraph-image\.json not found/);
}));

test('findMissingCliPackAssets cannot silently build a required list without network overlays', () => withFixture((root) => {
  // A source tree with no network/ + a lenient pack report must NOT pass — the
  // fail-closed manifest throws instead of requiring only project.json/build-info.
  fs.writeFileSync(path.join(root, 'project.json'), '{}\n');
  const lenientReport = () => JSON.stringify([{ files: [{ path: 'project.json' }, { path: 'build-info.json' }] }]);
  assert.throws(() => findMissingCliPackAssets(root, lenientReport), /network\/ directory not found/);
}));

test('packages/cli ships the runtime assets in its published files list', () => {
  // Guards the REAL package manifest contract — the integration test uses its
  // own fixture files, so this is what fails if production `files` drops one.
  const cliPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages', 'cli', 'package.json'), 'utf8'));
  for (const entry of [
    'network',
    'project.json',
    'blazegraph-image.json',
    'blazegraph-image-metadata.cjs',
    'build-info.json',
  ]) {
    assert.ok((cliPkg.files ?? []).includes(entry), `packages/cli#files must ship ${entry}`);
  }
});

test('findMissingCliPackAssets runs npm pack in the cli package dir (correct cwd)', () => withFixture((root) => {
  writeCliPackFixture(root);
  let seenCwd;
  const spyRunner = (_cmd, _args, opts) => {
    seenCwd = opts.cwd;
    return JSON.stringify([{ files: [] }]);
  };
  findMissingCliPackAssets(root, spyRunner);
  assert.equal(seenCwd, path.join(root, 'packages', 'cli'));
}));

// The integration test the mocked-runner unit tests can't give: run the REAL
// copy script through the REAL npm pack lifecycle and observe the tarball. The
// fixture embeds a copy of the real script so it resolves the fixture as its
// root (no production test-seam). Catches prepack-logs-to-stdout and
// prepack/cwd/lifecycle regressions the mocks would hide. (The production
// packages/cli#files contract is guarded separately by the files-list test
// above — this fixture defines its own files array, so it can't protect that.)
test('real npm pack --dry-run runs prepack and includes every runtime asset', { skip: NPM_AVAILABLE ? false : 'npm not available' }, () => withFixture((root) => {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(COPY_SCRIPT, path.join(root, 'scripts', 'copy-cli-runtime-assets.mjs'));
  fs.mkdirSync(path.join(root, 'network'), { recursive: true });
  fs.writeFileSync(path.join(root, 'network', 'testnet.json'), '{}\n');
  fs.writeFileSync(path.join(root, 'network', 'mainnet-base.json'), '{}\n');
  fs.writeFileSync(path.join(root, 'project.json'), '{}\n');
  fs.writeFileSync(path.join(root, 'blazegraph-image.json'), '{"image":"example/blazegraph@sha256:test","containerPort":80}\n');
  const cliDir = path.join(root, 'packages', 'cli');
  fs.mkdirSync(cliDir, { recursive: true });
  fs.copyFileSync(BLAZEGRAPH_METADATA_PARSER, path.join(cliDir, 'blazegraph-image-metadata.cjs'));
  fs.writeFileSync(path.join(cliDir, 'build-info.json'), '{}\n'); // generated by release:build-info
  fs.writeFileSync(path.join(cliDir, 'package.json'), `${JSON.stringify({
    name: '@origintrail-official/dkg', version: '0.0.0-fixture', private: true,
    files: [
      'network',
      'project.json',
      'blazegraph-image.json',
      'blazegraph-image-metadata.cjs',
      'build-info.json',
    ],
    scripts: { prepack: 'node ../../scripts/copy-cli-runtime-assets.mjs' },
  }, null, 2)}\n`);

  const res = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: cliDir, encoding: 'utf8', shell: process.platform === 'win32',
  });
  assert.equal(res.status, 0, `npm pack failed: ${res.stderr}`);
  // JSON.parse fails if prepack polluted stdout — that is the regression guard.
  const report = JSON.parse(res.stdout);
  const packed = new Set(
    (Array.isArray(report) ? report : [report])
      .flatMap((entry) => entry.files ?? [])
      .map((file) => file.path.replace(/\\/g, '/')),
  );
  for (const asset of [
    'project.json',
    'blazegraph-image.json',
    'blazegraph-image-metadata.cjs',
    'build-info.json',
    'network/testnet.json',
    'network/mainnet-base.json',
  ]) {
    assert.ok(packed.has(asset), `real tarball missing ${asset}`);
  }
}));
