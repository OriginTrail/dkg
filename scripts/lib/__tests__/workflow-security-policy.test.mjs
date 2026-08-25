import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runZizmorSarifGate } from '../../ci/enforce-zizmor-sarif.mjs';
import { validateTrustedControllerPins } from '../../ci/trusted-controller-pins.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CONTROLLER_SHA = '780f14aa60c39bdca788967121085c3c0d82d85c';

function checkout({ pathName = 'trusted-ci', ref = CONTROLLER_SHA, repository = 'OriginTrail/dkg' } = {}) {
  return `
    steps:
      - name: Checkout trusted CI controller
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0
        with:
          repository: ${repository}
          ref: ${ref}
          path: ${pathName}
  `;
}

test('trusted controller validation ignores unrelated pinned checkouts', () => {
  const unrelated = checkout({ pathName: 'tooling', ref: '1'.repeat(40), repository: 'example/tool' });
  const result = validateTrustedControllerPins([{
    sourceName: 'ci.yml',
    source: `${unrelated}\n${checkout()}`,
    expectedCount: 1,
  }]);
  assert.equal(result.ref, CONTROLLER_SHA);
  assert.equal(result.checkouts.length, 1);
});

test('trusted controller validation rejects missing and inconsistent pins', () => {
  const missingRef = checkout().replace(`          ref: ${CONTROLLER_SHA}\n`, '');
  assert.throws(
    () => validateTrustedControllerPins([{
      sourceName: 'ci.yml', source: missingRef, expectedCount: 1,
    }]),
    /immutable 40-character ref/,
  );
  assert.throws(
    () => validateTrustedControllerPins([{
      sourceName: 'ci.yml',
      source: `${checkout()}\n${checkout({ ref: '2'.repeat(40) })}`,
      expectedCount: 2,
    }]),
    /different refs/,
  );
});

test('repository workflows expose one canonical trusted controller pin', () => {
  const result = validateTrustedControllerPins([
    {
      sourceName: 'ci.yml',
      source: fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'),
      expectedCount: 2,
    },
    {
      sourceName: 'evm-integration.yml',
      source: fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/evm-integration.yml'), 'utf8'),
      expectedCount: 2,
    },
  ]);
  assert.equal(result.ref, CONTROLLER_SHA);
});

test('zizmor SARIF gate accepts clean output and rejects findings and scan failures', (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-zizmor-gate-'));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const sarifPath = path.join(temporaryDirectory, 'zizmor.sarif');
  const writeSarif = (results) => fs.writeFileSync(sarifPath, JSON.stringify({
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'zizmor' } }, results }],
  }));

  writeSarif([]);
  assert.equal(runZizmorSarifGate(['--sarif', sarifPath, '--scan-outcome', 'success']), 0);

  writeSarif([{ ruleId: 'unpinned-uses', message: { text: 'mutable action ref' } }]);
  assert.equal(runZizmorSarifGate(['--sarif', sarifPath, '--scan-outcome', 'success']), 1);

  writeSarif([]);
  assert.equal(runZizmorSarifGate(['--sarif', sarifPath, '--scan-outcome', 'failure']), 1);
  fs.writeFileSync(sarifPath, '{not-json');
  assert.equal(runZizmorSarifGate(['--sarif', sarifPath, '--scan-outcome', 'success']), 2);
});

test('supply-chain workflow preserves SARIF upload and gates findings plus audit events', () => {
  const workflow = fs.readFileSync(
    path.join(REPO_ROOT, '.github/workflows/supply-chain-scan.yml'),
    'utf8',
  );
  assert.match(workflow, /^        id: zizmor_scan$/m);
  assert.match(workflow, /^        continue-on-error: true$/m);
  assert.match(workflow, /if: \|\n\s+always\(\)/);
  assert.match(workflow, /SCAN_OUTCOME: \$\{\{ steps\.zizmor_scan\.outcome \}\}/);
  assert.match(workflow, /node scripts\/ci\/enforce-zizmor-sarif\.mjs/);
  assert.match(workflow, /- 'pnpm-lock\.yaml'/);
  assert.match(workflow, /- '\*\*\/package\.json'/);
  assert.match(workflow, /^  schedule:$/m);
  assert.match(workflow, /^  workflow_dispatch:$/m);

  const auditStart = workflow.indexOf('  npm-audit:\n');
  const auditRemainder = workflow.slice(auditStart + '  npm-audit:\n'.length);
  const auditEnd = auditRemainder.search(/^  [a-zA-Z0-9_-]+:\n/m);
  const auditBlock = auditEnd === -1 ? auditRemainder : auditRemainder.slice(0, auditEnd);
  assert.doesNotMatch(auditBlock, /^    if:/m);
});
