import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ROOT_PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

const REQUIRED_RUNTIME_PACKAGES = [
  '@origintrail-official/dkg',
  '@origintrail-official/dkg-adapter-hermes',
  '@origintrail-official/dkg-adapter-openclaw',
  '@origintrail-official/dkg-agent',
  '@origintrail-official/dkg-chain',
  '@origintrail-official/dkg-core',
  '@origintrail-official/dkg-epcis',
  '@origintrail-official/dkg-graph-viz',
  '@origintrail-official/dkg-mcp',
  '@origintrail-official/dkg-node-ui',
  '@origintrail-official/dkg-okf',
  '@origintrail-official/dkg-publisher',
  '@origintrail-official/dkg-query',
  '@origintrail-official/dkg-random-sampling',
  '@origintrail-official/dkg-rdf-utils',
  '@origintrail-official/dkg-storage',
  '@origintrail-official/kafka-plugin',
];

function shellTokens(command) {
  return [...command.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)]
    .map((match) => match[1] ?? match[2] ?? match[3]);
}

test('release runtime build plan includes workspace dependencies but excludes Hardhat', () => {
  const rootPackage = JSON.parse(fs.readFileSync(ROOT_PACKAGE_JSON, 'utf8'));
  const buildCommand = rootPackage.scripts?.['build:runtime:packages'];

  assert.equal(typeof buildCommand, 'string');
  const tokens = shellTokens(buildCommand);
  assert.deepEqual(tokens.slice(0, 2), ['pnpm', '-r']);
  assert.deepEqual(tokens.slice(-2), ['run', 'build']);
  assert.ok(
    tokens.includes('!@origintrail-official/dkg-evm-module'),
    'runtime dependency closure must explicitly subtract evm-module',
  );

  // Resolve the exact filters used by the release build, replacing only the
  // mutating `run build` operation with pnpm's read-only workspace listing.
  const planArgs = [
    ...tokens.slice(1, -2),
    'list',
    '--depth',
    '-1',
    '--json',
  ];
  const selected = JSON.parse(execFileSync(PNPM, planArgs, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  }));
  const selectedNames = new Set(selected.map((workspace) => workspace.name));

  for (const packageName of REQUIRED_RUNTIME_PACKAGES) {
    assert.ok(selectedNames.has(packageName), `${packageName} must remain in the runtime build`);
  }
  assert.equal(
    selectedNames.has('@origintrail-official/dkg-evm-module'),
    false,
    'node-host releases must use committed ABIs instead of compiling Solidity',
  );

  for (const workspace of selected) {
    const packageJson = JSON.parse(fs.readFileSync(path.join(workspace.path, 'package.json'), 'utf8'));
    assert.doesNotMatch(
      packageJson.scripts?.build ?? '',
      /hardhat/i,
      `${workspace.name} must not invoke Hardhat in the release runtime build`,
    );
  }
});
