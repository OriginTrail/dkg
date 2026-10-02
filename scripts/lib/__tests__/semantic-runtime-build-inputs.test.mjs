import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

test('semantic runtime Turbo hashes include Rust and build recipes but exclude generated targets', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-semantic-build-inputs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, contents) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  };
  write('package.json', JSON.stringify({ name: 'fixture-root', private: true, packageManager: 'pnpm@10.28.1' }));
  write('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
  write('pnpm-lock.yaml', 'lockfileVersion: 9.0\nimporters: {}\n');
  write('turbo.json', fs.readFileSync(path.join(repo, 'turbo.json')));
  for (const name of ['semantic-runtime', 'unrelated']) {
    write(`packages/${name}/package.json`, JSON.stringify({
      name: `@origintrail-official/dkg-${name}`,
      scripts: { build: 'node -e ""' },
    }));
    write(`packages/${name}/src/index.ts`, 'export const value = 1;\n');
  }
  const inputs = [
    'rust/crates/dkg-runtime-component/src/lib.rs',
    'rust/crates/dkg-runtime-component/wit/semantic-runtime.wit',
    'rust/Cargo.toml',
    'rust/Cargo.lock',
    'scripts/build-semantic-runtime.mjs',
    'scripts/semantic-runtime-rustc.mjs',
    'packages/semantic-runtime/src/index.ts',
  ];
  for (const input of inputs) write(input, 'initial source\n');
  // Keep target files unignored here so the test verifies the explicit Turbo
  // exclusion, independently of the repository's .gitignore defaults.
  write('rust/target/wasm32-wasip2/release/dkg_runtime_component.wasm', 'initial output');
  execFileSync('git', ['init', '-q', root]);
  const hashes = () => Object.fromEntries(JSON.parse(execFileSync(process.execPath, [
    path.join(repo, 'node_modules/turbo/bin/turbo'), 'run', 'build', '--dry=json',
  ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).tasks
    .map(({ taskId, hash }) => [taskId, hash]));
  const runtime = '@origintrail-official/dkg-semantic-runtime#build';
  const unrelated = '@origintrail-official/dkg-unrelated#build';
  for (const input of inputs) {
    const before = hashes();
    fs.appendFileSync(path.join(root, input), 'changed source\n');
    const after = hashes();
    assert.notEqual(after[runtime], before[runtime], `${input} must invalidate semantic-runtime`);
    assert.equal(after[unrelated], before[unrelated], `${input} must not invalidate an unrelated package`);
  }
  for (const output of [
    'rust/target/wasm32-wasip2/release/dkg_runtime_component.wasm',
    'rust/target/release/build/new-build-script/output',
    'scripts/unrelated.mjs',
  ]) {
    const before = hashes();
    write(output, 'new generated or unrelated content');
    assert.deepEqual(hashes(), before, `${output} must not invalidate package builds`);
  }
});
