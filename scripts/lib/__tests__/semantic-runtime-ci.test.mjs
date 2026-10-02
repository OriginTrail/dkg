import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const yaml = (name) => parse(readFileSync(new URL(`../../../.github/${name}`, import.meta.url), 'utf8'));
const setup = './.github/actions/setup-semantic-runtime';

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
