import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { REQUIRED_ROUTE, withDerivedNames } from '../regressions/profile-contract.mjs';
import { sha256 } from '../regressions/identity.mjs';
import { loadIncidentRecords, validateIncidentClosure, incidentDiscoveryInvocation } from '../regressions/incident-closure.mjs';
const root = path.resolve(import.meta.dirname, '../../..');
const records = JSON.parse(fs.readFileSync(path.join(root, 'test-policy/incidents/release-10.0.26.json'), 'utf8'));
const discover = () => records.flatMap(row => row.detectors.map(d => ({ file: d.file, name: withDerivedNames(d).discoveryName })));
const shards = [{ files: records.flatMap(row => row.detectors.map(d => d.file.replace('packages/agent/', ''))),
  config: REQUIRED_ROUTE.config, inventory: 'unit', index: 1, report: 'agent-1.xml' }];
const options = { discover, shards };
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
  ['deleted detector', r => { r[0].detectors[0].title = 'never declared test'; }],
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
  assert.throws(() => validateIncidentClosure(root, records, inventory, { ...options, discover: () => [] }), /executable detector/);
  assert.throws(() => validateIncidentClosure(root, records, inventory, { ...options, discover: () => [...discover(), ...discover()] }), /executable detector/);
});

test('incident evidence cannot escape through a path or a symlink', t => {
  for (const file of ['../outside.ts', '/tmp/outside.ts', 'packages\\agent\\outside.ts']) {
    const changed = structuredClone(records); changed[0].detectors[0].file = file;
    assert.throws(() => validateIncidentClosure(root, changed, inventory, options), /unsafe detector path/);
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'incident-symlink-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const checkout = path.join(scratch, 'checkout'); fs.mkdirSync(checkout);
  const outside = path.join(scratch, 'outside.ts'); fs.writeFileSync(outside, 'untrusted');
  const row = structuredClone(records[0]);
  const target = path.join(checkout, row.detectors[0].file); fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(outside, target);
  assert.throws(() => validateIncidentClosure(checkout, [row], inventory, options), /symlink escapes repository/);
});

test('incident discovery requires the exact derived suite and title', () => {
  for (const change of [name => `prefix ${name}`, name => `${name} suffix`]) {
    assert.throws(() => validateIncidentClosure(root, records, inventory,
      { ...options, discover: () => discover().map(row => ({ ...row, name: change(row.name) })) }), /executable detector/);
  }
});

test('proof assertion identities cannot extend or truncate the registered title', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'incident-name-proof-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const row = structuredClone(records[0]);
  const proof = JSON.parse(fs.readFileSync(path.join(root, row.proof.file), 'utf8'));
  for (const file of [proof.production.file, proof.test.file, proof.red.file, proof.green.file]) {
    fs.mkdirSync(path.dirname(path.join(scratch, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(scratch, file));
  }
  const write = (file, data) => { const bytes = JSON.stringify(data); fs.writeFileSync(path.join(scratch, file), bytes); return sha256(bytes); };
  proof.test.fullName += ' different assertion';
  for (const side of ['red', 'green']) {
    const report = JSON.parse(fs.readFileSync(path.join(scratch, proof[side].file), 'utf8'));
    report.assertions[0].fullName = proof.test.fullName;
    proof[side].sha256 = write(proof[side].file, report);
  }
  row.proof.sha256 = write(row.proof.file, proof);
  assert.throws(() => validateIncidentClosure(scratch, [row], inventory, options), /proof tests another detector/);
});


test('incident registers share required shard eligibility with historical proofs', () => {
  for (const assigned of [[], [...shards, ...shards], [{ ...shards[0], config: 'optional.config.ts' }]]) {
    assert.throws(() => validateIncidentClosure(root, records, inventory, { ...options, shards: assigned }), /exactly one required agent unit shard/);
  }
});

test('incident loader includes two release registers and ignores nested proof JSON', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'incident-registers-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const directory = path.join(scratch, 'test-policy/incidents');
  fs.mkdirSync(path.join(directory, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'release-10.0.27.json'), JSON.stringify(records.slice(3)));
  fs.writeFileSync(path.join(directory, 'release-10.0.26.json'), JSON.stringify(records.slice(0, 3)));
  fs.writeFileSync(path.join(directory, 'evidence/release-not-a-register.json'), 'not JSON');
  const loaded = loadIncidentRecords(scratch);
  assert.deepEqual(loaded, records);
  assert.deepEqual(validateIncidentClosure(root, loaded, inventory, options), validateIncidentClosure(root, records, inventory, options));
  fs.writeFileSync(path.join(directory, 'release-10.0.28.json'), '{}');
  assert.throws(() => loadIncidentRecords(scratch), /empty or invalid incident register/);
});

test('incident detectors cannot bypass shared source or inventory eligibility', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'incident-eligibility-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const row = records[0], file = row.detectors[0].file;
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const target = path.join(scratch, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const declaration = `it('${row.detectors[0].title}'`;
  assert.ok(source.includes(declaration));
  for (const modifier of ['skip', 'only']) {
    fs.writeFileSync(target, source.replace(declaration, `it.${modifier}('${row.detectors[0].title}'`));
    assert.throws(() => validateIncidentClosure(scratch, [row], inventory, options), /disabled or focused regression test/);
  }
  assert.throws(() => validateIncidentClosure(root, records, [...inventory, inventory[0]], options), /current test inventory/);
});
