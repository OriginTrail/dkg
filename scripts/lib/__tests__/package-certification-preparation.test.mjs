import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePackages } from '../package-certification/prepare.mjs';
import { expectedPolicy } from '../package-certification/source.mjs';
import { verifyBundle, BUILD_INPUTS, CLI } from '../package-certification/bundle.mjs';
import { cliRuntimeAssetManifest } from '../../copy-cli-runtime-assets.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
function preparationFixture(t, change) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-provenance-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), bin = path.join(root, 'bin'), output = path.join(root, 'bundle');
  fs.mkdirSync(source); fs.mkdirSync(bin);
  const write = (name, bytes) => {
    const file = path.join(source, name);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  };
  const version = '10.0.25';
  for (const name of BUILD_INPUTS) write(name, name === 'package.json'
    ? JSON.stringify({ name: 'source-fixture', private: true, version, scripts: { preinstall: 'node packages/cli/scripts/verify-node-sqlite-runtime.mjs' } })
    : name === 'pnpm-lock.yaml' ? 'packages:\n  libp2p@3.5.1: {}\nsnapshots: {}\n' : 'fixture');
  write('packages/cli/package.json', JSON.stringify({ name: CLI, version,
    scripts: { preinstall: 'node ./scripts/verify-node-sqlite-runtime.mjs' }, dependencies: { libp2p: '3.5.1' },
  }));
  write('packages/cli/scripts/verify-node-sqlite-runtime.mjs', '// controlled fixture guard');
  write('packages/cli/scripts/bundle-markitdown-binaries.mjs', '// controlled fixture asset');
  write('packages/cli/blazegraph-runtime-contract.d.cts', '// controlled fixture asset');
  for (const file of ['blazegraph-image.json', 'packages/cli/blazegraph-image-metadata.cjs', 'packages/storage/blazegraph-namespace-contract.cjs']) {
    write(file, fs.readFileSync(path.join(repository, file)));
  }
  write('project.json', '{}'); write('network/test.json', '{}'); write('tracked.txt', 'original source');
  write('.gitignore', ['generated.txt', 'packages/cli/dist/', 'packages/cli/build-info.json', 'packages/cli/network/',
    'packages/cli/project.json', 'packages/cli/blazegraph-image.json', 'packages/cli/blazegraph-namespace-contract.cjs', ''].join('\n'));
  const git = args => {
    const result = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: source, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git(['init', '-q']); git(['add', '.']); git(['commit', '-qm', 'clean candidate fixture']);
  const commit = git(['rev-parse', 'HEAD']);
  if (change === 'build-hidden') git(['update-index', '--assume-unchanged', 'tracked.txt']);
  if (change === 'dirty') write('tracked.txt', 'dirty before preparation');
  const assets = [...cliRuntimeAssetManifest({ rootDir: source }).requiredPackAssets,
    'build-info.json', 'scripts/verify-node-sqlite-runtime.mjs', 'scripts/bundle-markitdown-binaries.mjs', 'dist/cli.js'];
  const calls = path.join(root, 'commands.jsonl');
  const script = path.join(bin, 'pnpm.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';
import path from 'node:path';
import { archive } from ${JSON.stringify(new URL('./package-certification-fixture.mjs', import.meta.url).href)};
const root = ${JSON.stringify(source)}, change = ${JSON.stringify(change)};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'install') {
  if (args.join(' ') !== 'install --frozen-lockfile') throw new Error('unexpected install');
} else if (args[0] === 'build') {
  fs.mkdirSync(path.join(root, 'packages/cli/dist'));
  fs.writeFileSync(path.join(root, 'packages/cli/dist/cli.js'), 'export {};');
  fs.writeFileSync(path.join(root, 'generated.txt'), 'ignored generated output');
  fs.writeFileSync(path.join(root, 'packages/cli/build-info.json'), JSON.stringify({
    commit: ${JSON.stringify(commit)}, commitShort: ${JSON.stringify(commit.slice(0, 8))},
    dirty: false, buildTime: new Date().toISOString(), distTag: 'monorepo', ciRun: null,
  }));
  // Leave a valid captured identity so the real final provenance guards must reject the later change.
  if (change.startsWith('build')) fs.appendFileSync(path.join(root, 'tracked.txt'), ' changed during build');
} else if (args[0] === 'pack') {
  const names = ['package.json', ...${JSON.stringify(assets)}];
  const files = Object.fromEntries(names.map(name => [name, fs.readFileSync(path.join(process.cwd(), name))]));
  fs.writeFileSync(path.join(args[2], 'candidate.tgz'), archive(files));
  if (change === 'pack') fs.appendFileSync(path.join(root, 'tracked.txt'), ' changed during packing');
} else if (args[0] === '--version') process.stdout.write('10.28.1');
else throw new Error('unexpected pnpm command');
`);
  fs.writeFileSync(path.join(bin, 'pnpm'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 });
  return { source, bin, output, version, commit, calls, git };
}

for (const [change, failure] of [
  ['dirty', /requires clean tracked source/],
  ['build', /requires clean tracked source/],
  ['pack', /requires clean tracked source/],
  ['build-hidden', /tracked build inputs changed/],
  ['none', null],
]) test(`preparation provenance: ${change === 'none' ? 'permits ignored generated outputs' : `rejects ${change} source changes`}`, async t => {
  const f = preparationFixture(t, change), previousPath = process.env.PATH;
  try {
    process.env.PATH = `${f.bin}${path.delimiter}${previousPath}`;
    const prepare = () => preparePackages({ rootDir: f.source, output: f.output, version: f.version });
    if (failure) {
      await assert.rejects(prepare, failure);
      assert.equal(fs.existsSync(path.join(f.output, 'manifest.json')), false, 'changed source must not produce a certified manifest');
      if (change === 'dirty') assert.equal(fs.existsSync(f.calls), false, 'initially dirty source must not run pnpm');
      else assert.ok(fs.readFileSync(f.calls, 'utf8').includes('pack'), 'exercise the final provenance guard after packing');
      if (change === 'build-hidden') assert.equal(f.git(['status', '--porcelain']), '', 'snapshot must reject changes hidden from Git status');
    } else {
      const manifest = await prepare();
      assert.equal(manifest.source.commit, f.commit);
      assert.equal(f.git(['status', '--porcelain']), '');
      assert.equal(fs.existsSync(path.join(f.source, 'generated.txt')), true);
      const expected = await expectedPolicy(f.source, { commit: f.commit, version: f.version });
      assert.deepEqual(verifyBundle(f.output, expected), manifest);
    }
  } finally { process.env.PATH = previousPath; }
});
