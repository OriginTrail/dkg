import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceFingerprint } from '../coverage-artifacts.mjs';
import { sharedTestInputs, validateSharedTestInputs } from '../test-fixture-inputs.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
test('every real shared-fixture import is declared by its consumer', () => validateSharedTestInputs(repo));

test('fixture edits invalidate only consumer fingerprints and Turbo tasks', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-fixture-inputs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, contents) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, contents); };
  write('package.json', JSON.stringify({ name: 'fixture-root', private: true, packageManager: 'pnpm@10.28.1' }));
  write('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
  write('pnpm-lock.yaml', 'lockfileVersion: 9.0\nimporters: {}\n');
  write('turbo.json', fs.readFileSync(path.join(repo, 'turbo.json')));
  const packages = ['core', 'agent', 'publisher', 'cli', 'node-ui', 'adapter-hermes'];
  for (const name of packages) {
    write(`packages/${name}/package.json`, JSON.stringify({ name, scripts: { build: 'node -e ""', test: 'node -e ""' } }));
    write(`packages/${name}/src/main.ts`, 'export const value = 1;');
    const config = `packages/${name}/turbo.json`;
    if (fs.existsSync(path.join(repo, config))) write(config, fs.readFileSync(path.join(repo, config)));
    for (const input of sharedTestInputs(root, name)) write(input, fs.readFileSync(path.join(repo, input)));
  }
  write('scripts/testing/oxigraph.ts', fs.readFileSync(path.join(repo, 'scripts/testing/oxigraph.ts')));
  execFileSync('git', ['init', '-q', root]);
  const fingerprint = () => Object.fromEntries(packages.map((name) => [name, sourceFingerprint(root, name)]));
  const turbo = path.join(repo, 'node_modules/.bin', process.platform === 'win32' ? 'turbo.cmd' : 'turbo');
  const hashes = () => Object.fromEntries(JSON.parse(execFileSync(turbo, ['run', 'build', 'test', '--dry=json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).tasks.map(({ taskId, hash }) => [taskId, hash]));
  for (const [fixture, consumers, buildConsumers] of [
    ['property-options', ['core', 'agent', 'publisher'], []],
    ['ka-vm-publish', ['publisher'], ['publisher']],
    ['snapshot-storage', ['agent', 'cli'], []],
    ['oxigraph', [], []],
  ]) {
    const before = fingerprint(); const beforeHashes = hashes();
    fs.appendFileSync(path.join(root, `scripts/testing/${fixture}.ts`), '\n// fixture change\n');
    const after = fingerprint(); const afterHashes = hashes();
    for (const name of packages) {
      assert.equal(before[name] !== after[name], consumers.includes(name), `${fixture}: ${name} coverage`);
      for (const task of ['test', 'build']) assert.equal(beforeHashes[`${name}#${task}`] !== afterHashes[`${name}#${task}`], (task === 'test' ? consumers : buildConsumers).includes(name), `${fixture}: ${name}#${task}`);
    }
  }
  write('packages/core/test/new.test.ts', "import '../../../scripts/testing/snapshot-storage.js';");
  assert.throws(() => validateSharedTestInputs(root), /undeclared shared test input/);
});
