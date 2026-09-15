import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const yaml = (name) => parse(readFileSync(new URL(`../../../.github/${name}`, import.meta.url), 'utf8'));
const setup = './.github/actions/setup-semantic-runtime';

test('shared Linux build artifacts restore the executable safe-LLM runner for CLI tests', () => {
  const { jobs } = yaml('workflows/ci.yml');
  const steps = jobs.build.steps;
  const nativeBuild = steps.findIndex((step) => step.name === 'Build native safe-LLM runner for downstream CLI tests');
  assert.ok(nativeBuild > steps.findIndex((step) => step.uses === setup));
  assert.ok(nativeBuild < steps.findIndex((step) => step.name === 'Test repository scripts'));
  assert.ok(nativeBuild < steps.findIndex((step) => step.name === 'Package build outputs'));
  assert.equal(steps[nativeBuild].if, undefined, 'native output must also be built after a Turbo cache hit');
  assert.match(steps[nativeBuild].run, /cargo \+nightly-2026-08-18 build --manifest-path rust\/Cargo.toml --package dkg-safe-llm-runner --release --locked/);
  const packageOutputs = jobs.build.steps.find((step) => step.name === 'Package build outputs').run;
  const runner = 'rust/target/release/dkg-safe-llm-runner';
  const explicitPaths = [...packageOutputs.matchAll(/PATHS\+=\(([^)]*)\)/g)]
    .flatMap((match) => match[1].trim().split(/\s+/));
  assert.ok(explicitPaths.includes(runner), 'CLI artifacts must contain the native runner');
  assert.ok(packageOutputs.includes(`test -x ${runner}`), 'producer must require an executable');
  assert.deepEqual(jobs['bura-cli']['runs-on'], jobs.build['runs-on'], 'native runner consumers must use the producer OS');
  const restore = jobs['bura-cli'].steps.find((step) => step.name === 'Restore build outputs');
  assert.match(restore.run, /tar -xzf \/tmp\/build-outputs.tgz/);

  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'semantic-ci-runner-artifact-'));
  try {
    const produced = path.join(fixture, 'produced');
    const restored = path.join(fixture, 'restored');
    mkdirSync(path.join(produced, path.dirname(runner)), { recursive: true });
    mkdirSync(path.join(produced, 'packages/semantic-runtime/generated'), { recursive: true });
    writeFileSync(path.join(produced, 'packages/semantic-runtime/generated/fixture.txt'), 'portable');
    copyFileSync(path.join(root, runner), path.join(produced, runner));
    mkdirSync(restored);
    const archive = path.join(fixture, 'build-outputs.tgz');
    execFileSync('tar', ['-czf', archive, ...explicitPaths], { cwd: produced });
    execFileSync('tar', ['-xzf', archive], { cwd: restored });
    assert.notEqual(statSync(path.join(restored, runner)).mode & 0o111, 0, 'tar must preserve executable mode');
    assert.deepEqual(readFileSync(path.join(restored, runner)), readFileSync(path.join(root, runner)));
    // Invalid startup input exercises the restored native executable without
    // sending a model request or depending on external provider credentials.
    const result = spawnSync(path.join(restored, runner), [], {
      input: '{}\n', encoding: 'utf8', timeout: 10_000, env: {},
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).type, 'error');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('CI build producers install the pinned semantic toolchain before compiling', () => {
  const ci = yaml('workflows/ci.yml');
  const evm = yaml('workflows/evm-integration.yml');
  for (const job of [ci.jobs.build, ci.jobs['semantic-runtime'], evm.jobs.build]) {
    const toolStep = job.steps.findIndex((step) => step.uses === setup);
    const buildStep = job.steps.findIndex((step) =>
      /pnpm run (?:build:packages|check:semantic-runtime)|node scripts\/ci\/build-evm-integration.mjs/.test(step.run ?? ''));
    assert.ok(toolStep >= 0 && buildStep > toolStep, 'build must follow tool installation');
  }
  const action = yaml('actions/setup-semantic-runtime/action.yml');
  const commands = action.runs.steps.map((step) => step.run ?? '').join('\n');
  assert.match(commands, /nightly-2026-08-18/);
  assert.match(commands, /--target wasm32-unknown-unknown/);
  assert.match(commands, /--target wasm32-wasip2/);
  assert.match(commands, /install wasm-bindgen-cli --version 0\.2\.127 --locked/);
});

test('component execution lanes use a JSPI-capable runtime while ordinary builds retain the baseline', () => {
  const { jobs } = yaml('workflows/ci.yml');
  const nodeSetup = (job) => job.steps.find((step) => step.uses?.startsWith('actions/setup-node@')).with;
  assert.equal(nodeSetup(jobs.build)['node-version-file'], '.nvmrc');
  assert.equal(nodeSetup(jobs['semantic-runtime'])['node-version'], '26.8.2');
  assert.equal(nodeSetup(jobs['bura-cli'])['node-version'], '26.8.2');
  assert.match(nodeSetup(jobs['kosava-supporting'])['node-version'], /semantic-runtime.*26\.8\.2.*22/);
});

test('native WSL fixture compiles real CLI modules without starting or building a semantic engine', () => {
  const { steps } = yaml('workflows/mcp-config-native.yml').jobs.metadata;
  const prepare = steps.find((step) => step.name === 'Prepare native WSL fixture').run;
  const prerequisites = prepare.indexOf('pnpm exec tsc --build packages/random-sampling packages/adapter-hermes packages/adapter-prime-agent');
  const cliBuild = prepare.indexOf('pnpm exec tsc --build packages/cli');
  assert.ok(prerequisites >= 0 && cliBuild > prerequisites, 'compile dependencies omitted from tsconfig references before the CLI');
  assert.match(prepare, /node scripts\/copy-cli-runtime-assets.mjs/);
  assert.doesNotMatch(prepare, /build-runtime-packages|build:runtime/);
  const fixture = readFileSync(new URL('../../../packages/cli/test/fixtures/mcp-config-wsl.fixture.ts', import.meta.url), 'utf8');
  assert.match(fixture, /from '..\/..\/dist\/mcp-setup.js'/);
  assert.match(fixture, /startDaemon: unexpected/);
});
