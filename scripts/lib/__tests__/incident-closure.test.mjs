import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateIncidentClosure, incidentDiscoveryInvocation } from '../regressions/incident-closure.mjs';
const root = path.resolve(import.meta.dirname, '../../..');
const records = JSON.parse(fs.readFileSync(path.join(root, 'test-policy/incidents/release-10.0.26.json'), 'utf8'));
const discover = () => records.flatMap(row => row.detectors.map(d => ({ file: d.file, name: d.anchor })));
const options = { discover };
const inventory = records.flatMap(row => row.detectors.map(d => ({ file: d.file, execution: [{ lane: d.lane, cadence: 'required' }] })));
test('discovery uses the required config and never treats a test as a JSON output path', () => {
  const { args } = incidentDiscoveryInvocation(records);
  assert.equal(args.at(-1), '--json');
  assert.equal(args[args.indexOf('--config') + 1], 'vitest.unit.config.ts');
  for (const { detectors } of records) for (const { file } of detectors) {
    assert.ok(args.indexOf(file.replace('packages/agent/', '')) < args.indexOf('--json'));
  }
});
test('observed mutation proofs verify and unresolved incidents remain explicit', () => {
  const status = validateIncidentClosure(root, records, inventory, options);
  assert.deepEqual(status.filter(row => row.status === 'detector-proven').map(row => row.id), ['GH-3502','GH-3475','GH-3467']);
  assert.deepEqual(status.filter(row => row.status === 'open').map(row => row.id), ['GH-3421','GH-3408']);
});
for (const [name, damage] of [
  ['deleted detector', r => { r[0].detectors[0].anchor = 'never declared test'; }],
  ['changed proof hash', r => { r[0].proof.sha256 = 'bad'; }],
  ['silent closure', r => { r[3].status = 'detector-proven'; }],
  ['unknown classification', r => { r[0].classification = 'all-fixes-are-regressions'; }],
  ['lost ownership', r => { r[0].owner = ''; }],
  ['hidden gap', r => { delete r[4].gap; }],
]) test(`incident register rejects ${name}`, () => {
  const changed = structuredClone(records); damage(changed);
  assert.throws(() => validateIncidentClosure(root, changed, inventory, options));
});
test('optional-only routes cannot close incidents', () => {
  assert.throws(() => validateIncidentClosure(root, records, inventory.map(row => ({ ...row, execution: [{ lane: 'tornado-agent', cadence: 'optional' }] })), options), /required lane/);
});
test('changed production bytes invalidate a formerly passing mutation proof', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'incident-closure-')); t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const row = records[0]; const receipt = JSON.parse(fs.readFileSync(path.join(root, row.proof.file), 'utf8'));
  for (const file of [row.proof.file, receipt.production.file, receipt.test.file, receipt.red.file, receipt.green.file]) {
    fs.mkdirSync(path.dirname(path.join(scratch, file)), { recursive: true }); fs.copyFileSync(path.join(root, file), path.join(scratch, file));
  }
  fs.appendFileSync(path.join(scratch, receipt.production.file), '\n// changed\n');
  assert.throws(() => validateIncidentClosure(scratch, [row], inventory, options), /stale incident evidence/);
});


test('undiscovered and ambiguous detector names cannot close an incident', () => {
  assert.throws(() => validateIncidentClosure(root, records, inventory, { discover: () => [] }), /executable detector/);
  assert.throws(() => validateIncidentClosure(root, records, inventory, { discover: () => [...discover(), ...discover()] }), /executable detector/);
});
