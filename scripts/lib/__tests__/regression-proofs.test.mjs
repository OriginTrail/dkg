import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileFor } from '../regressions/profiles.mjs';
import { inspectExecution, verifyDiscovery } from '../regressions/results.mjs';
import { proofIdentity, sha256, verifyIdentity } from '../regressions/identity.mjs';
import { validateRecord, validateRegressions, validateEvidence } from '../regressions/registry.mjs';
import { analyzeTestSource } from '../disabled-test-scanner.mjs';
import { runCommand } from '../regressions/proof.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const record = JSON.parse(fs.readFileSync(path.join(root, 'test-policy/regressions/GH-2782.json'), 'utf8'));
const profile = profileFor(record);
const discovered = [{ file: profile.file, name: profile.discoveryName }];
const inventory = [{ file: profile.file, execution: [{ lane: 'tornado-agent', cadence: 'required' }] }];
const shards = [{ files: [profile.file.replace('packages/agent/', '')], config: 'vitest.unit.config.ts', inventory: 'unit', index: 5, report: 'agent-5.xml' }];
const clone = (value) => structuredClone(value);

test('registry resolves exact assertion through discovered required inventory and shard', () => {
  assert.equal(validateRecord(record, 'GH-2782.json', inventory, discovered, shards).shard, 5);
});
for (const [name, edit, inv, disc, plans, reason] of [
  ['missing owner', (r) => { delete r.owner; }, inventory, discovered, shards, /ownership/],
  ['missing file', () => {}, [], discovered, shards, /inventory/],
  ['undiscovered assertion', () => {}, inventory, [], shards, /undiscovered/],
  ['ambiguous assertion', () => {}, inventory, [...discovered, ...discovered], shards, /ambiguous/],
  ['optional-only route', () => {}, [{ file: profile.file, execution: [{ lane: 'tornado-agent', cadence: 'manual' }] }], discovered, shards, /inventory/],
  ['optional case claimed as required', (r) => { r.execution.cadence = 'manual'; }, inventory, discovered, shards, /optional/],
  ['disabled/discovery-excluded lane', () => {}, inventory, discovered, [], /exactly one/],
  ['renamed assertion', (r) => { r.test.fullName = 'a new title'; }, inventory, discovered, shards, /test binding/],
]) test(`registry rejects ${name}`, () => {
  const changed = clone(record); edit(changed);
  assert.throws(() => validateRecord(changed, 'GH-2782.json', inv, disc, plans), reason);
});
test('registry rejects duplicate stable IDs before discovery', () => {
  assert.throws(() => validateRegressions(root, inventory, { records: [{ file: 'GH-2782.json', record }, { file: 'other.json', record }] }), /duplicate/);
});
test('discovery rejects zero and ambiguous matches', () => {
  assert.throws(() => verifyDiscovery([], profile, root), /undiscovered/);
  const row = { file: path.join(root, profile.file), name: profile.discoveryName };
  assert.throws(() => verifyDiscovery([row, row], profile, root), /ambiguous/);
});

// Actual Vitest reports from disposable hermetic fixtures. These exercise the
// same classifier as the historical runner; no fabricated status-only reports.
test('proof classifier rejects actual empty, skipped, wrong and import-failed runs', { timeout: 60000 }, async () => {
  const fixture = fs.mkdtempSync(path.join(root, 'node_modules/.regression-runner-'));
  const file = path.join(fixture, profile.file);
  const config = path.join(fixture, 'vitest.config.mts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(config, `import { defineConfig } from 'vitest/config'; export default defineConfig({test:{include:['packages/agent/test/*.test.ts'],allowOnly:false,pool:'forks',maxWorkers:1}});`);
  const observation = { error: 'Cannot acknowledge join approval: durable subscription intent or host state is missing',
    current: false, subscriptionWatermark: 0, saves: 0, rows: 0, sameSubscription: true };
  const emit = `process.stdout.write('REGRESSION_RUNTIME GH-2782 ' + process.version + '\\n');process.stdout.write(${JSON.stringify(`REGRESSION_OBSERVATION GH-2782 ${JSON.stringify(observation)}\n`)});`;
  const body = `import { describe, it, expect } from 'vitest'; describe(${JSON.stringify(profile.suite)},()=>{it(${JSON.stringify(profile.title)},()=>{${emit}expect(1,${JSON.stringify(profile.assertion)}).toBe(2);});});`;
  try {
    let index = 0;
    const run = async (source, filter) => {
      fs.writeFileSync(file, source);
      const report = path.join(fixture, `report-${index}.json`);
      const result = await runCommand(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--root', fixture, '--config', config,
        ...(filter ? ['-t', filter] : []), '--reporter=json', `--outputFile=${report}`], root, path.join(fixture, `run-${index++}.log`), 15000);
      assert.equal(result.timedOut, false);
      assert.ok(fs.existsSync(report), 'real Vitest must produce its report');
      return { result, report: JSON.parse(fs.readFileSync(report, 'utf8')) };
    };
    const valid = await run(body);
    assert.equal(inspectExecution(valid.report, valid.result, profile, fixture, 'bad').status, 'failed');
    for (const [label, source, filter, reason] of [
      ['zero selected', body, '^no selected regression$', /skipped|zero selected/],
      ['skipped assertion', body.replace('it(', 'it.skip('), undefined, /skipped/],
      ['wrong failing assertion', body.replace(JSON.stringify(profile.title), '"unrelated failure"'), undefined, /wrong failing assertion/],
      ['import failure', "import 'does-not-exist-regression-fixture';\n" + body, undefined, /zero selected/],
      ['unrelated failure in named test', body.replace(JSON.stringify(profile.assertion), '"unrelated behavior"'), undefined, /intended behavioral/],
    ]) {
      const invalid = await run(source, filter);
      assert.throws(() => inspectExecution(invalid.report, invalid.result, profile, fixture, 'bad'), reason, label);
      if (label === 'skipped assertion') {
        assert.throws(() => validateRegressions(fixture, inventory, { records: [{ file: 'GH-2782.json', record }],
          discover: () => discovered, shards }), /disabled or focused/);
      }
    }
    const green = await run(body.replace('.toBe(2)', '.toBe(1)'));
    assert.equal(inspectExecution(green.report, green.result, profile, fixture, 'candidate').status, 'passed');
    assert.throws(() => inspectExecution(green.report, green.result, profile, fixture, 'bad'), /intended behavioral/);
    assert.throws(() => inspectExecution(valid.report, { ...valid.result, timedOut: true }, profile, fixture, 'bad'), /timeout/);
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

test('proof identity rejects stale test and runner bytes, and stale receipt digest', () => {
  const actual = proofIdentity(root, profile);
  for (const file of [profile.file, 'scripts/qa-prove-regression.mjs']) {
    const stale = { ...actual, [file]: sha256('previous bytes') };
    assert.throws(() => verifyIdentity(actual, stale), /stale test\/fixture or proof identity/);
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-identity-'));
  try {
    // The evidence validator must reach the input identity check and reject it.
    for (const [file, hash] of Object.entries(actual)) {
      const target = path.join(temp, file); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, file), target); assert.equal(sha256(fs.readFileSync(target)), hash);
    }
    const receipt = { schemaVersion: 1, caseId: record.id, status: 'proven', method: 'historical-replay',
      toolchain: { node: 'v22.23.2' }, cleanup: { bad: 'removed', candidate: 'removed' }, identity: actual };
    const bytes = JSON.stringify(receipt); fs.writeFileSync(path.join(temp, 'receipt.json'), bytes);
    const withProof = { ...record, proof: { status: 'proven', receipt: 'receipt.json', receiptSha256: sha256(bytes) } };
    fs.appendFileSync(path.join(temp, profile.file), '\n// stale fixture\n');
    assert.throws(() => validateEvidence(temp, withProof, profile), /stale test\/fixture or proof identity/);
    assert.throws(() => validateEvidence(temp, { ...withProof, proof: { ...withProof.proof, receiptSha256: sha256('old receipt') } }, profile), /stale proof receipt identity/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('bounded subprocess runner stops only its own timed-out or cancelled child', { timeout: 10000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-process-'));
  try {
    const args = ['-e', 'setInterval(() => {}, 1000)'];
    const timeout = await runCommand(process.execPath, args, root, path.join(directory, 'timeout.log'), 100);
    assert.equal(timeout.timedOut, true); assert.notEqual(timeout.code, 0);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    const cancelled = await runCommand(process.execPath, args, root, path.join(directory, 'cancelled.log'), 5000, controller.signal);
    clearTimeout(timer); assert.equal(cancelled.timedOut, false); assert.notEqual(cancelled.code, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('registry rejects skipped assertions even with a general disabled-test waiver', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-waiver-'));
  const pragma = ['test', 'disable', 'allow'].join('-') + ':';
  const source = `import { describe, it } from 'vitest';
describe(${JSON.stringify(profile.suite)}, () => {
// ${pragma} D1 #2782 -- owner=agent lane=tornado-agent expires=${new Date(Date.now() + 86400000).toISOString().slice(0, 10)} reviewed debt
it.skip(${JSON.stringify(profile.title)}, () => {});
});
`;
  try {
    const file = path.join(temp, profile.file); fs.mkdirSync(path.dirname(file), { recursive: true });
    const unproven = { ...record, proof: { status: 'unproven', method: 'historical-replay', receipt: null } };
    for (const text of [source, source.replace(pragma, pragma.toUpperCase())]) {
      fs.writeFileSync(file, text);
      assert.equal(analyzeTestSource(text, profile.file).disabled.length, 0, 'the general waiver would hide this disabled test');
      assert.throws(() => validateRegressions(temp, inventory, { records: [{ file: 'GH-2782.json', record: unproven }],
        discover: () => discovered, shards }), /disabled or focused/);
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
