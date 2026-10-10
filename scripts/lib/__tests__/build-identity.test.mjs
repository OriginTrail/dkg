import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { captureDevnetBuild, ensureDevnetBuildInfo } from '../build-info.mjs';

const root = resolve(import.meta.dirname, '../../..');
const cli = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8'));
function run(command, args, cwd, env = {}) {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return r.stdout.trim();
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-build-identity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'packages/cli'), { recursive: true });
  writeFileSync(join(dir, 'packages/cli/package.json'), JSON.stringify({ name: cli.name, scripts: { 'build:compile': cli.scripts['build:compile'] } }));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'packages/storage'), { recursive: true });
  cpSync(join(root, 'packages/storage/blazegraph-namespace-contract.cjs'), join(dir, 'packages/storage/blazegraph-namespace-contract.cjs'));
  cpSync(join(root, 'scripts'), join(dir, 'scripts'), { recursive: true });
  cpSync(join(root, 'packages/cli/blazegraph-image-metadata.cjs'), join(dir, 'packages/cli/blazegraph-image-metadata.cjs'));
  writeFileSync(join(dir, '.gitignore'), 'bin/\npackages/cli/build-info.json\npackages/cli/dist/\n');
  writeFileSync(join(dir, 'source.txt'), 'A\n');
  run('git', ['init', '-q'], dir);
  run('git', ['add', '.'], dir);
  run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'A'], dir);
  writeFileSync(join(dir, 'bin/tsc'), '#!/bin/sh\nmkdir -p dist\ncp ../../source.txt dist/source.txt\n', { mode: 0o755 });
  return dir;
}
function compile(dir) {
  // Invoke the declared compilation phase used by the prepared production build.
  run('pnpm', ['run', 'build:compile'], join(dir, 'packages/cli'), { PATH: `${join(dir, 'bin')}:${process.env.PATH}` });
  return JSON.parse(readFileSync(join(dir, 'packages/cli/build-info.json'), 'utf8'));
}

test('compiled identity remains A after HEAD moves to B without rebuilding', t => {
  const dir = fixture(t);
  const a = run('git', ['rev-parse', 'HEAD'], dir);
  assert.equal(compile(dir).commit, a);
  writeFileSync(join(dir, 'source.txt'), 'B\n');
  run('git', ['add', 'source.txt'], dir);
  run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'B'], dir);
  assert.notEqual(run('git', ['rev-parse', 'HEAD'], dir), a);
  assert.equal(JSON.parse(readFileSync(join(dir, 'packages/cli/build-info.json'), 'utf8')).commit, a);
  assert.equal(readFileSync(join(dir, 'packages/cli/dist/source.txt'), 'utf8'), 'A\n');
  assert.equal(compile(dir).commit, run('git', ['rev-parse', 'HEAD'], dir));
});

test('dirty source builds cannot claim a clean exact commit', t => {
  const dir = fixture(t);
  const head = run('git', ['rev-parse', 'HEAD'], dir);
  writeFileSync(join(dir, 'source.txt'), 'uncommitted\n');
  const info = compile(dir);
  assert.equal(info.dirty, true);
  assert.equal(info.commit, `${head}-dirty`);
});

test('devnet preserves an existing compiler identity instead of restamping live HEAD', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'packages/cli/build-info.json'), JSON.stringify({ commit: '0'.repeat(40) }));
  run('bash', ['-c', 'source "$1"; write_devnet_version_build_info "$2"', 'bash', join(root, 'scripts/devnet.sh'), dir], root, { DEVNET_SOURCE_ONLY: '1' });
  assert.equal(JSON.parse(readFileSync(join(dir, 'packages/cli/build-info.json'), 'utf8')).commit, '0'.repeat(40));
});

test('real Turbo reuses dependencies while recompiling and restamping the CLI', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', private: true, packageManager: 'pnpm@10.28.1' }));
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  cpSync(join(root, 'turbo.json'), join(dir, 'turbo.json'));
  mkdirSync(join(dir, 'packages/dependency'));
  writeFileSync(join(dir, 'packages/dependency/package.json'), JSON.stringify({ name: '@fixture/dep', version: '1.0.0', scripts: { build: 'mkdir -p dist && echo dependency > dist/value' } }));
  const compilation = cli.scripts['build:compile'];
  writeFileSync(join(dir, 'packages/cli/package.json'), JSON.stringify({ name: cli.name, version: '1.0.0', dependencies: { '@fixture/dep': 'workspace:*' }, scripts: { build: 'pnpm run build:compile', 'build:compile': compilation } }));
  writeFileSync(join(dir, '.gitignore'), 'bin/\nnode_modules/\n.turbo/\npackages/*/dist/\npackages/*/.turbo/\npackages/cli/build-info.json\n');
  run('pnpm', ['install', '--lockfile-only', '--ignore-scripts'], dir);
  run('git', ['add', '.'], dir);
  run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'workspace'], dir);
  const turbo = join(root, 'node_modules/.bin/turbo');
  const args = ['run', 'build', '--filter=' + cli.name];
  const env = { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, TURBO_TELEMETRY_DISABLED: '1' };
  run(turbo, args, dir, env);
  writeFileSync(join(dir, 'source.txt'), 'B\n');
  run('git', ['add', 'source.txt'], dir);
  run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'B'], dir);
  const second = run(turbo, args, dir, env);
  assert.match(second, /@fixture\/dep:build: cache hit/);
  assert.match(second, /dkg:build: cache bypass/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'packages/cli/build-info.json'), 'utf8')).commit, run('git', ['rev-parse', 'HEAD'], dir));
  assert.equal(readFileSync(join(dir, 'packages/cli/dist/source.txt'), 'utf8'), 'B\n');
});

test('missing Git metadata is explicitly unknown instead of a live checkout claim', t => {
  const dir = fixture(t);
  rmSync(join(dir, '.git'), { recursive: true });
  const info = compile(dir);
  assert.equal(info.commit, 'unknown');
  assert.equal(info.dirty, null);
});

function pausedStatusCheck(statusBody) {
  return spawnSync('bash', ['-c', `
    set -euo pipefail
    source "$1"
    healthy_count=123
    status_body() { ${statusBody}
    }
    say() { :; }
    fail() { echo "$*" >&2; exit 1; }
    check_paused_store_status
  `, 'bash', join(root, 'scripts/devnet-lib.sh')], { encoding: 'utf8' });
}

test('store outage accepts a count refreshed between the healthy baseline and SIGSTOP', () => {
  const r = pausedStatusCheck(`
    if [ "$1" = '/api/status?probeStore=true' ]; then
      printf '%s' '{"storeReachability":"no-answer"}'
    else
      printf '%s' '{"storeQuadsStatus":"ready","storeQuads":124}'
    fi
  `);
  assert.equal(r.status, 0, r.stderr);
});

test('paused status rejects an ordinary read that probes the store', () => {
  const r = pausedStatusCheck(`printf '%s' '{"storeQuadsStatus":"ready","storeQuads":124,"storeReachability":"reachable"}'`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ordinary status unexpectedly probed/);
});

test('cached devnet dist at A is rebuilt at B rather than relabeled without compilation', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'package.json'), '{}');
  run('git', ['add', 'package.json'], dir);
  run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'root manifest'], dir);
  compile(dir);
  writeFileSync(join(dir, 'packages/cli/dist/cli.js'), '// compiled A');
  writeFileSync(join(dir, 'source.txt'), 'B\n');
  run('git', ['add', 'source.txt'], dir);
  run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'B'], dir);
  const compilation = cli.scripts['build:compile'];
  writeFileSync(join(dir, 'bin/pnpm'), `#!/bin/bash\nif [ "$1" = run ] && [ "$2" = build ]; then cd packages/cli; ${compilation}; fi\n`, { mode: 0o755 });
  run('bash', ['-c', 'source "$1"; DEVNET_VERSIONS_DIR="$2"; prepare_version "$3"', 'bash', join(root, 'scripts/devnet.sh'), resolve(dir, '..'), dir.split('/').at(-1)], root,
    { DEVNET_SOURCE_ONLY: '1', PATH: `${join(dir, 'bin')}:${process.env.PATH}` });
  assert.equal(readFileSync(join(dir, 'packages/cli/dist/source.txt'), 'utf8'), 'B\n');
  assert.equal(JSON.parse(readFileSync(join(dir, 'packages/cli/build-info.json'), 'utf8')).commit, run('git', ['rev-parse', 'HEAD'], dir));
});

test('failed real compilation preserves the prior emitted JavaScript, stamp and compiler status', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'packages/cli/tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ES2022', outDir: 'dist', skipLibCheck: true }, include: ['input.ts'],
  }));
  writeFileSync(join(dir, 'packages/cli/input.ts'), 'export const value = "A";\n');
  writeFileSync(join(dir, 'bin/tsc'), `#!/bin/sh\nexec "${process.execPath}" "${join(root, 'node_modules/typescript/bin/tsc')}" "$@"\n`, { mode: 0o755 });
  run('git', ['add', '.'], dir);
  run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'valid compiler input'], dir);
  const a = compile(dir).commit;
  const output = readFileSync(join(dir, 'packages/cli/dist/input.js'), 'utf8');
  writeFileSync(join(dir, 'packages/cli/input.ts'), 'export const value: number = "B";\n');
  run('git', ['add', '.'], dir);
  run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'invalid compiler input'], dir);
  const r = spawnSync('pnpm', ['run', 'build:compile'],
    { cwd: join(dir, 'packages/cli'), env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` }, encoding: 'utf8' });
  // TypeScript reports diagnostics with skipped output as exit 1.
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /TS2322/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'packages/cli/build-info.json'), 'utf8')).commit, a);
  assert.equal(readFileSync(join(dir, 'packages/cli/dist/input.js'), 'utf8'), output);
});

test('checkout changes during compilation cannot certify the captured clean commit', t => {
  const dir = fixture(t);
  const a = run('git', ['rev-parse', 'HEAD'], dir);
  writeFileSync(join(dir, 'bin/tsc'), '#!/bin/sh\necho changed >> ../../source.txt\nmkdir -p dist\ncp ../../source.txt dist/source.txt\n', { mode: 0o755 });
  const info = compile(dir);
  assert.equal(info.commit, `${a}-dirty`);
  assert.equal(info.dirty, true);
});


test('devnet post-build cannot recertify B after compilation began at A', t => {
  const dir = fixture(t);
  const a = run('git', ['rev-parse', 'HEAD'], dir);
  writeFileSync(join(dir, 'bin/tsc'), `#!/bin/sh
mkdir -p dist
cp ../../source.txt dist/source.txt
printf 'B\\n' > ../../source.txt
git -C ../.. add source.txt
git -C ../.. -c user.name=Test -c user.email=test@example.invalid commit -qm B
`, { mode: 0o755 });
  const compiled = compile(dir);
  assert.equal(compiled.commit, `${a}-dirty`);
  const b = run('git', ['rev-parse', 'HEAD'], dir);
  assert.notEqual(b, a);
  run('bash', ['-c', 'source "$1"; write_devnet_version_build_info "$2"', 'bash', join(root, 'scripts/devnet.sh'), dir], root, { DEVNET_SOURCE_ONLY: '1' });
  const ensured = JSON.parse(readFileSync(join(dir, 'packages/cli/build-info.json'), 'utf8'));
  assert.equal(ensured.commit, `${a}-dirty`);
  assert.equal(ensured.dirty, true);
  assert.equal(readFileSync(join(dir, 'packages/cli/dist/source.txt'), 'utf8'), 'A\n');
});

test('source archive nested under a clean parent repository has unknown identity', t => {
  const parent = fixture(t);
  writeFileSync(join(parent, '.gitignore'), readFileSync(join(parent, '.gitignore'), 'utf8') + 'archive/\n');
  run('git', ['add', '.gitignore'], parent);
  run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'ignore archive'], parent);
  const archive = join(parent, 'archive');
  mkdirSync(archive);
  for (const entry of ['scripts', 'packages', 'bin', 'source.txt']) cpSync(join(parent, entry), join(archive, entry), { recursive: true });
  const info = compile(archive);
  assert.equal(info.commit, 'unknown');
  assert.equal(info.dirty, null);
});


test('devnet preserves unknown compiler identity verbatim', t => {
  const dir = fixture(t);
  const unknown = { commit: 'unknown', dirty: null, distTag: 'monorepo', buildTime: '2026-10-10T00:00:00Z' };
  const text = JSON.stringify(unknown) + '\n';
  writeFileSync(join(dir, 'packages/cli/build-info.json'), text);
  run('bash', ['-c', 'source "$1"; write_devnet_version_build_info "$2"', 'bash', join(root, 'scripts/devnet.sh'), dir], root, { DEVNET_SOURCE_ONLY: '1' });
  assert.equal(readFileSync(join(dir, 'packages/cli/build-info.json'), 'utf8'), text);
});

test('linked worktree owns and certifies its clean source identity', t => {
  const parent = fixture(t);
  const linked = join(parent, 'linked');
  run('git', ['worktree', 'add', '--detach', linked, 'HEAD'], parent);
  cpSync(join(parent, 'bin'), join(linked, 'bin'), { recursive: true });
  const info = compile(linked);
  assert.equal(info.commit, run('git', ['rev-parse', 'HEAD'], linked));
  assert.equal(info.dirty, false);
});

test('legacy devnet build replaces an unchanged stale stamp only after rebuilding', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'package.json'), '{}');
  run('git', ['add', 'package.json'], dir);
  run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'root manifest'], dir);
  compile(dir);
  writeFileSync(join(dir, 'packages/cli/dist/cli.js'), '// compiled A');
  writeFileSync(join(dir, 'source.txt'), 'B\n');
  run('git', ['add', 'source.txt'], dir);
  run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'B'], dir);
  writeFileSync(join(dir, 'bin/pnpm'), '#!/bin/sh\nif [ "$1" = run ] && [ "$2" = build ]; then cp source.txt packages/cli/dist/source.txt; fi\n', { mode: 0o755 });
  run('bash', ['-c', 'source "$1"; DEVNET_VERSIONS_DIR="$2"; prepare_version "$3"', 'bash', join(root, 'scripts/devnet.sh'), resolve(dir, '..'), dir.split('/').at(-1)], root,
    { DEVNET_SOURCE_ONLY: '1', PATH: `${join(dir, 'bin')}:${process.env.PATH}` });
  assert.equal(readFileSync(join(dir, 'packages/cli/dist/source.txt'), 'utf8'), 'B\n');
  assert.equal(JSON.parse(readFileSync(join(dir, 'packages/cli/build-info.json'), 'utf8')).commit, run('git', ['rev-parse', 'HEAD'], dir));
});


test('unchanged uncertified compiler metadata cannot become a clean legacy stamp', t => {
  const dir = fixture(t);
  for (const commit of ['unknown', `${run('git', ['rev-parse', 'HEAD'], dir)}-dirty`]) {
    const text = JSON.stringify({ commit, dirty: commit === 'unknown' ? null : true }) + '\n';
    writeFileSync(join(dir, 'packages/cli/build-info.json'), text);
    const before = captureDevnetBuild(dir);
    ensureDevnetBuildInfo(dir, before);
    assert.equal(readFileSync(join(dir, 'packages/cli/build-info.json'), 'utf8'), text);
  }
});
