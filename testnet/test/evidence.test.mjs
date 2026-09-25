// Hermetic tests for lib/evidence.mjs — temp dirs only, no fleet, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EvidenceWriter,
  FAILURE_CLASSES,
  FORBIDDEN_RECORD_KEYS,
  SCHEMA_VERSION,
  buildManifest,
  makeRunId,
} from '../lib/evidence.mjs';
import { sha256 } from '../lib/util.mjs';

function tempRunsDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rfc61-evidence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function readJsonl(path) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ── EvidenceWriter ───────────────────────────────────────────────────────────

test('EvidenceWriter: creates runsDir recursively and round-trips JSONL', (t) => {
  const base = tempRunsDir(t);
  const runsDir = join(base, 'deep', 'nested', 'runs'); // does not exist yet
  const w = new EvidenceWriter({ runId: 'certify-aaaaaaaa-20260714T190000Z', runsDir });
  assert.equal(w.path, join(runsDir, 'certify-aaaaaaaa-20260714T190000Z.jsonl'));

  w.write('run_start', { mode: 'certify', scenario: 'certify-100' });
  w.write('op_result', { op: 'publish', lane: 'public', index: 0, outcome: 'success' });

  const records = readJsonl(w.path);
  assert.equal(records.length, 2);
  for (const r of records) {
    assert.equal(r.schema_version, SCHEMA_VERSION);
    assert.equal(r.run_id, 'certify-aaaaaaaa-20260714T190000Z');
    assert.match(r.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }
  assert.equal(records[0].type, 'run_start');
  assert.equal(records[0].mode, 'certify');
  assert.equal(records[1].type, 'op_result');
  assert.equal(records[1].outcome, 'success');
});

test('EvidenceWriter: injected envelope fields win over record fields', (t) => {
  const w = new EvidenceWriter({ runId: 'r1', runsDir: tempRunsDir(t) });
  const line = w.write('real_type', {
    type: 'spoofed', run_id: 'spoofed', schema_version: 999, ts: '1970-01-01T00:00:00Z',
  });
  assert.equal(line.type, 'real_type');
  assert.equal(line.run_id, 'r1');
  assert.equal(line.schema_version, SCHEMA_VERSION);
  assert.notEqual(line.ts, '1970-01-01T00:00:00Z');
  const [rec] = readJsonl(w.path);
  assert.equal(rec.type, 'real_type');
});

test('EvidenceWriter: missing type throws; nothing is appended', (t) => {
  const w = new EvidenceWriter({ runId: 'r1', runsDir: tempRunsDir(t) });
  assert.throws(() => w.write('', { a: 1 }), /type required/);
  assert.throws(() => w.write(undefined, { a: 1 }), /type required/);
  assert.equal(existsSync(w.path), false);
});

test('EvidenceWriter: constructor validates opts', (t) => {
  const dir = tempRunsDir(t);
  assert.throws(() => new EvidenceWriter(), /runId required/);
  assert.throws(() => new EvidenceWriter({ runsDir: dir }), /runId required/);
  assert.throws(() => new EvidenceWriter({ runId: 'r1' }), /runsDir required/);
});

test('EvidenceWriter S6 hygiene: forbidden keys throw at any depth, file untouched', (t) => {
  const w = new EvidenceWriter({ runId: 'r1', runsDir: tempRunsDir(t) });
  assert.throws(() => w.write('fleet_snapshot', { host: 'core-1.internal' }), /forbidden key "host"/);
  assert.throws(() => w.write('fleet_snapshot', { a: { b: { ip: '10.0.0.1' } } }), /forbidden key "a\.b\.ip"/);
  assert.throws(() => w.write('fleet_snapshot', { cores: [{ alias: 'core-1' }, { sshUser: 'admin' }] }), /forbidden key "cores\[1\]\.sshUser"/);
  assert.throws(() => w.write('preflight', { sshIdentity: '/home/x/.ssh/id' }), /forbidden key "sshIdentity"/);
  assert.equal(existsSync(w.path), false); // hygiene failures never reach disk

  // alias-shaped records pass — exact key match only, no false positives
  w.write('fleet_snapshot', { alias: 'core-1', hostAlias: 'core-1', reachable: true, chip: 'm3' });
  assert.equal(readJsonl(w.path).length, 1);
});

test('EvidenceWriter: sidecar created only on first writeSidecar, hygiene NOT enforced there', (t) => {
  const w = new EvidenceWriter({ runId: 'r1', runsDir: tempRunsDir(t) });
  w.write('run_start', { mode: 'monitor' });
  assert.equal(existsSync(w.sidecarPath), false); // main writes never touch the sidecar

  w.writeSidecar('journal_raw', { host: 'core-1.internal', raw: 'Jul 14 core-1 sshd[1]: ...' });
  assert.equal(existsSync(w.sidecarPath), true);
  const [side] = readJsonl(w.sidecarPath);
  assert.equal(side.type, 'journal_raw');
  assert.equal(side.host, 'core-1.internal'); // raw material allowed in local-only sidecar
  assert.equal(side.run_id, 'r1');
  assert.equal(side.schema_version, SCHEMA_VERSION);

  // sidecar records never leak into the main stream
  const main = readJsonl(w.path);
  assert.equal(main.length, 1);
  assert.equal(main[0].type, 'run_start');
});

test('FAILURE_CLASSES: frozen closed enum matching EVIDENCE.md', () => {
  assert.ok(Object.isFrozen(FAILURE_CLASSES));
  for (const c of ['too_low_allowance', 'publisher_wedge', 'transport_error', 'quorum_or_backoff',
    'admission_shed', 'rpc_exhaustion', 'timeout', 'readback_mismatch', 'query_result_mismatch',
    'propagation_timeout', 'arrived_during_gap', 'finalized_unverified', 'caught_up_unverified', 'aborted']) {
    assert.ok(FAILURE_CLASSES.includes(c), `missing failure class: ${c}`);
  }
  assert.equal(FAILURE_CLASSES.length, 14); // error:<class> is composed, never listed
  assert.deepEqual(FORBIDDEN_RECORD_KEYS, ['host', 'ip', 'sshUser', 'sshIdentity']);
});

// ── makeRunId ────────────────────────────────────────────────────────────────

test('makeRunId: full form matches the EVIDENCE.md example shape', () => {
  const now = new Date('2026-07-14T19:00:00Z');
  assert.equal(
    makeRunId({ phase: 'certify', sha8: '06419722', attempt: 1, now }),
    'certify-06419722-r1-20260714T190000Z',
  );
  assert.equal(
    makeRunId({ phase: 'certify', sha8: '06419722', qualifier: 'soak', attempt: 2, now }),
    'certify-06419722-soak-r2-20260714T190000Z',
  );
});

test('makeRunId: omits missing parts cleanly — no double dashes', () => {
  const now = new Date('2026-07-14T19:00:00Z');
  assert.equal(makeRunId({ phase: 'monitor', now }), 'monitor-20260714T190000Z');
  assert.equal(makeRunId({ phase: 'certify', qualifier: 'q', now }), 'certify-q-20260714T190000Z');
  assert.equal(makeRunId({ phase: 'certify', sha8: 'deadbeef', now }), 'certify-deadbeef-20260714T190000Z');
  for (const id of [
    makeRunId({ phase: 'monitor', now }),
    makeRunId({ phase: 'certify', attempt: 3, now }),
  ]) {
    assert.ok(!id.includes('--'), `double dash in run id: ${id}`);
  }
  assert.throws(() => makeRunId({}), /phase required/);
});

// ── buildManifest ────────────────────────────────────────────────────────────

test('buildManifest: binds digests, gates, notRun; defaults spend and bytes', () => {
  const scenario = { name: 'certify-100', waves: 2 };
  const m = buildManifest({
    attested: { edge: { commit: 'abc123' }, cores: [{ alias: 'core-1', commit: 'abc123' }] },
    scenario,
    scenarioDigest: sha256(JSON.stringify(scenario)),
    fleetDigest: 'f'.repeat(64),
    policyDigest: 'p'.repeat(64),
    gates: [
      { id: 'publish.success_rate', outcome: 'PASS', observed: 1, threshold: 1 },
      { id: 'soak.forbidden_signatures', outcome: 'NOT_RUN' },
    ],
    notRun: ['soak.forbidden_signatures'],
  });
  assert.equal(m.scenario, scenario); // verbatim
  assert.equal(m.scenarioDigest, sha256(JSON.stringify(scenario)));
  assert.equal(m.fleetDigest, 'f'.repeat(64));
  assert.equal(m.policyDigest, 'p'.repeat(64));
  assert.deepEqual(m.notRun, ['soak.forbidden_signatures']);
  assert.deepEqual(m.spend, {});
  assert.equal(m.permanentBytesWritten, 0);
  assert.equal(m.gates.length, 2);
  assert.equal(m.gates[0].id, 'publish.success_rate');
  assert.equal(m.gates[0].outcome, 'PASS');
});

test('buildManifest: preserves explicit spend/bytes and rejects missing required fields', () => {
  const ok = {
    attested: {}, scenario: {}, scenarioDigest: 'd', fleetDigest: 'f', policyDigest: 'p',
    gates: [], notRun: [],
  };
  const m = buildManifest({ ...ok, spend: { trac: '1.5', eth: '0.01' }, permanentBytesWritten: 4096 });
  assert.deepEqual(m.spend, { trac: '1.5', eth: '0.01' });
  assert.equal(m.permanentBytesWritten, 4096);

  for (const missing of ['attested', 'scenario', 'scenarioDigest', 'fleetDigest', 'policyDigest']) {
    const bad = { ...ok };
    delete bad[missing];
    assert.throws(() => buildManifest(bad), new RegExp(`${missing} required`));
  }
  assert.throws(() => buildManifest({ ...ok, gates: 'nope' }), /gates must be an array/);
  assert.throws(() => buildManifest({ ...ok, notRun: 'nope' }), /notRun must be an array/);
});

test('buildManifest + EvidenceWriter: manifest record round-trips through the main stream', (t) => {
  const w = new EvidenceWriter({ runId: makeRunId({ phase: 'certify', sha8: 'abcd1234' }), runsDir: tempRunsDir(t) });
  const manifest = buildManifest({
    attested: { cores: [{ alias: 'core-1', commit: 'abc' }] },
    scenario: { name: 'certify-100' },
    scenarioDigest: 'd', fleetDigest: 'f', policyDigest: 'p',
    gates: [{ id: 'g1', outcome: 'PASS' }],
    notRun: [],
  });
  w.write('run_manifest', manifest); // passes S6 hygiene: aliases + digests only
  const records = readJsonl(w.path);
  assert.equal(records.at(-1).type, 'run_manifest');
  assert.equal(records.at(-1).fleetDigest, 'f');
  assert.deepEqual(records.at(-1).gates, [{ id: 'g1', outcome: 'PASS' }]);
});
