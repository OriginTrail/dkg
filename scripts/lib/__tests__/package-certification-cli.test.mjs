import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { expectedPolicy } from '../package-certification/source.mjs';
import { BUILD_INPUTS, CLI, PROFILE } from '../package-certification/bundle.mjs';
import { fixture } from './package-certification-fixture.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
async function cliFixture(t, mode) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-cli-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'candidate'), bin = path.join(root, 'bin');
  fs.mkdirSync(source); fs.mkdirSync(bin);
  const tracked = [];
  const write = (name, bytes) => {
    const target = path.join(source, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes); tracked.push(name);
  };
  for (const name of [
    'scripts/release-packages.mjs', 'scripts/copy-cli-runtime-assets.mjs',
    'scripts/lib/release-policy.mjs', 'scripts/lib/release-process.mjs', 'scripts/lib/build-info.mjs',
    'scripts/lib/libp2p-pins.mjs', 'scripts/lib/package-certification/source.mjs',
    'scripts/lib/package-certification/bundle.mjs', 'scripts/lib/package-certification/publish.mjs',
    'packages/cli/blazegraph-image-metadata.cjs', 'packages/storage/blazegraph-namespace-contract.cjs',
    'blazegraph-image.json',
  ]) write(name, fs.readFileSync(path.join(repository, name)));
  fs.symlinkSync(path.join(repository, 'node_modules'), path.join(source, 'node_modules'), 'dir');
  const commit = 'a'.repeat(40), version = '10.0.25', core = '@origintrail-official/dkg-core';
  for (const name of BUILD_INPUTS) write(name, name === 'package.json'
    ? JSON.stringify({ name: 'candidate', private: true, version })
    : name === 'pnpm-lock.yaml' ? 'packages:\n  libp2p@3.5.1: {}\nsnapshots: {}\n' : 'fixture');
  write('packages/cli/package.json', JSON.stringify({ name: CLI, version, dependencies: { [core]: 'workspace:*' } }));
  write('packages/core/package.json', JSON.stringify({ name: core, version, dependencies: { libp2p: '3.5.1' } }));
  write('network/test.json', '{}'); write('project.json', '{}');
  const tag = `v${version}`, object = 'c'.repeat(40);
  const gitResults = {
    'status --porcelain --untracked-files=no': '', 'rev-parse HEAD': commit,
    'ls-files -z': [...new Set(tracked)].sort().join('\0') + '\0',
    [`rev-parse --verify refs/tags/${tag}`]: object,
    [`cat-file -t refs/tags/${tag}`]: 'tag',
    [`cat-file tag refs/tags/${tag}`]: '-----BEGIN SSH SIGNATURE-----',
    [`merge-base --is-ancestor ${tag}^{commit} origin/main`]: '',
    [`ls-remote origin refs/tags/${tag}`]: `${object}\trefs/tags/${tag}`,
    [`rev-parse ${tag}^{commit}`]: commit,
  };
  const shim = (name, code) => {
    const script = path.join(bin, `${name}.cjs`);
    fs.writeFileSync(script, code);
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 });
  };
  shim('git', `const results = ${JSON.stringify(gitResults)};
const key = process.argv.slice(2).join(' ');
if (!(key in results)) throw new Error('unexpected git call: ' + key);
process.stdout.write(results[key]);`);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const previousPath = process.env.PATH;
  let expected;
  try {
    process.env.PATH = env.PATH;
    expected = await expectedPolicy(source, { commit, version, profile: PROFILE });
  } finally { process.env.PATH = previousPath; }
  const f = fixture(t, { expected, inputRoot: source });
  const calls = path.join(root, 'npm-calls.jsonl');
  const integrity = Object.fromEntries(f.manifest.packages.map(pkg => [`${pkg.name}@${pkg.version}`, pkg.integrity]));
  shim('npm', `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] !== 'view') process.exit(91);
if (${JSON.stringify(mode)} === 'publish-prepared') {
  process.stdout.write(JSON.stringify({ error: { code: 'E404' } })); process.exitCode = 1;
} else process.stdout.write(JSON.stringify({ integrity: ${JSON.stringify(integrity)}[args[1]] }));`);
  return { ...f, source, env, calls, tag };
}

for (const mode of ['publish-prepared', 'promote']) for (const mismatch of [false, true]) {
  test(`${mode} CLI ${mismatch ? 'rejects the wrong candidate before registry access' : 'forwards dry-run through real policy and registry reads'}`, async t => {
    const f = await cliFixture(t, mode);
    const result = spawnSync(process.execPath, [path.join(f.source, 'scripts/release-packages.mjs'), mode,
      '--bundle', f.bundle, '--certificate', f.receiptFile,
      '--commit', mismatch ? 'b'.repeat(40) : f.expected.commit,
      '--version', f.expected.version, '--profile', PROFILE, '--tag', f.tag,
      ...(mode === 'promote' ? ['--tags', 'testnet,mainnet'] : ['--dist-tag', 'canary']), '--dry-run',
    ], { cwd: f.source, env: f.env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, mismatch ? 1 : 0, result.stderr);
    const calls = fs.existsSync(f.calls) ? fs.readFileSync(f.calls, 'utf8').trim().split('\n').map(JSON.parse) : [];
    assert.equal(calls.length, mismatch ? 0 : f.manifest.packages.length);
    assert.ok(calls.every(args => args[0] === 'view'), 'dry-run must never publish or change dist-tags');
    if (mismatch) assert.match(result.stderr, /intended candidate checkout/);
    else {
      const progress = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
      assert.equal(progress.dryRun, true);
      assert.deepEqual(progress.completed, []);
      assert.equal(progress.planned.length, f.manifest.packages.length * (mode === 'promote' ? 2 : 1));
    }
  });
}
