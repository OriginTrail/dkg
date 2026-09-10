// Hermetic tests for lib/fleet.mjs + ledger.json — no real SSH, no external
// network. Fakes for transport; a local 127.0.0.1 node:http server for the
// /api/status path; the real awk binary (local, offline) for ledger parity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  snapshotCore, snapshotFleet, attestBuildIdentity, sameArtifact,
  captureJournalCursors, journalSignatureDeltas, loadLedger, validateLedger,
  signatureCountsFromText, composeSignatureAwk, scrubTargetRefs,
} from '../lib/fleet.mjs';

const LEDGER_PATH = fileURLToPath(new URL('../ledger.json', import.meta.url));
const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/journal-sample.txt', import.meta.url));
const ledger = loadLedger(LEDGER_PATH);
const fixture = readFileSync(FIXTURE_PATH, 'utf8');

const CURSOR = 's=abc123;i=1f4;b=cafe;m=1;t=2;x=3';

const CORE = {
  alias: 'core-1',
  host: '203.0.113.7',
  sshUser: 'observer',
  sshIdentity: '~/.ssh/id_test',
  systemdUnit: 'dkg-node',
  apiPort: 9200,
  listenPort: 9090,
  storeFilesystem: '/',
};
const FLEET = { cores: [CORE], sshConcurrency: 2, sshConnectTimeoutSec: 4 };

// Expected per-class counts for fixtures/journal-sample.txt. Update both the
// fixture and this table together — the ledger's teeth are proven against it.
const EXPECTED_COUNTS = {
  listgraphs_timeout: 2,
  sync_timeout: 2,
  scheduler_saturation: 3,
  quorum_terminal_failure: 3,
  oom_sigkill: 3,
  duplicate_publish: 2,
  forced_redial: 2,
  rpc_throttle: 2,
  accept_queue_marker: 1,
  ostore_scan_storm: 2,
  store_deadline_timeout: 1,
  probe_query_timeout: 1,
};

function expectedTotals() {
  let gated = 0;
  let recorded = 0;
  for (const cls of ledger.classes) {
    if (cls.disposition === 'gated') gated += EXPECTED_COUNTS[cls.id];
    else recorded += EXPECTED_COUNTS[cls.id];
  }
  return { gated, recorded };
}

function runAwk(program, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('awk', [program], (err, stdout, stderr) => {
      if (err) reject(new Error(`awk failed: ${err.message}\n${stderr}`));
      else resolve(stdout);
    });
    child.stdin.end(input);
  });
}

// ── ledger.json contract ─────────────────────────────────────────────────────

test('ledger.json is version 1 and carries the RFC §9.2 classes with dispositions', () => {
  assert.equal(ledger.version, 1);
  const byId = new Map(ledger.classes.map((c) => [c.id, c]));
  for (const id of ['listgraphs_timeout', 'sync_timeout', 'scheduler_saturation',
    'quorum_terminal_failure', 'oom_sigkill', 'duplicate_publish']) {
    assert.equal(byId.get(id)?.disposition, 'gated', `${id} must be gated`);
  }
  for (const id of ['forced_redial', 'rpc_throttle', 'accept_queue_marker']) {
    assert.equal(byId.get(id)?.disposition, 'recorded', `${id} must be recorded`);
  }
  for (const cls of ledger.classes) {
    assert.ok(cls.description.length > 20, `${cls.id}: description must actually document the class`);
    assert.ok(!cls.pattern.includes("'") && !cls.pattern.includes('/'),
      `${cls.id}: pattern must survive single-quoted awk embedding`);
    assert.doesNotThrow(() => new RegExp(cls.pattern));
  }
  // Every EXPECTED_COUNTS key must exist in the ledger and vice versa.
  assert.deepEqual([...byId.keys()].sort(), Object.keys(EXPECTED_COUNTS).sort());
});

test('validateLedger rejects malformed ledgers', () => {
  assert.throws(() => validateLedger({ version: 0, classes: [] }), /version/);
  assert.throws(() => validateLedger({
    version: 1,
    classes: [{ id: 'x', disposition: 'gated', pattern: "bad'quote", description: 'a description long enough' }],
  }), /single quotes/);
  assert.throws(() => validateLedger({
    version: 1,
    classes: [{ id: 'x', disposition: 'maybe', pattern: 'ok', description: 'a description long enough' }],
  }), /disposition/);
  assert.throws(() => validateLedger({
    version: 1,
    classes: [
      { id: 'x', disposition: 'gated', pattern: 'ok', description: 'a description long enough' },
      { id: 'x', disposition: 'gated', pattern: 'ok', description: 'a description long enough' },
    ],
  }), /duplicate/);
});

test('loadLedger surfaces JSON and shape problems with the path in the message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-test-'));
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{ not json');
  assert.throws(() => loadLedger(bad), /bad\.json/);
  writeFileSync(bad, JSON.stringify({ version: 1, classes: [{ id: 'x' }] }));
  assert.throws(() => loadLedger(bad), /pattern required/);
});

// ── signature counting: JS twin + awk parity ─────────────────────────────────

test('signatureCountsFromText counts every fixture class exactly (and only) once per line', () => {
  assert.deepEqual(signatureCountsFromText(fixture, ledger), EXPECTED_COUNTS);
});

test('the composed awk program produces identical counts to the JS twin (real awk)', async () => {
  const program = composeSignatureAwk(ledger);
  const stdout = await runAwk(program, fixture);
  const got = {};
  for (const line of stdout.trim().split('\n')) {
    const [k, v] = line.split('=');
    assert.ok(k.startsWith('sig_'), `unexpected awk output line: ${line}`);
    got[k.slice(4)] = Number(v);
  }
  assert.deepEqual(got, EXPECTED_COUNTS);
});

// ── journalSignatureDeltas ───────────────────────────────────────────────────

// Fake transport that actually executes the remote command's awk/grep stage
// against the fixture, so compose -> remote-shape -> parse is covered end to end.
function makeJournalFakeExec(journalText = fixture) {
  const calls = [];
  const fn = async (target, cmd, opts) => {
    calls.push({ target, cmd, opts });
    const awkMatch = cmd.match(/\| awk '([^]*)'; fi$/);
    if (awkMatch) {
      assert.ok(cmd.includes(`--after-cursor='${CURSOR}'`), 'counting pass must use the exact cursor');
      assert.ok(cmd.includes('-o cat'), 'counting pass must read raw message text');
      const out = await runAwk(awkMatch[1], journalText);
      return { ok: true, code: 0, stdout: `journal_status=0\ncursor_valid=1\n${out}`, stderr: '', timedOut: false };
    }
    const grepMatch = cmd.match(/grep -iE '([^]*)' \| head -c 65536$/);
    if (grepMatch) {
      const re = new RegExp(grepMatch[1], 'i');
      const lines = journalText.split('\n').filter((l) => l && re.test(l));
      return { ok: true, code: 0, stdout: `${lines.join('\n')}\n`, stderr: '', timedOut: false };
    }
    throw new Error(`unexpected remote command: ${cmd}`);
  };
  fn.calls = calls;
  return fn;
}

test('journalSignatureDeltas counts after the exact cursor and totals by disposition', async () => {
  const exec = makeJournalFakeExec();
  const [res] = await journalSignatureDeltas(FLEET, [{ alias: 'core-1', cursor: CURSOR }], {
    ledger, _sshExec: exec,
  });
  const totals = expectedTotals();
  assert.equal(res.alias, 'core-1');
  assert.equal(res.cursorValid, true);
  assert.deepEqual(res.counts, EXPECTED_COUNTS);
  assert.equal(res.gatedTotal, totals.gated);
  assert.equal(res.recordedTotal, totals.recorded);
  assert.equal(res.ledgerVersion, 1);
  assert.equal(exec.calls.length, 1, 'no sidecar callback -> no second raw-line pass');
});

test('journalSignatureDeltas runs the capped raw-line pass ONLY for a sidecar, and keeps raw text out of counts', async () => {
  const exec = makeJournalFakeExec();
  const sidecarCalls = [];
  const [res] = await journalSignatureDeltas(FLEET, [{ alias: 'core-1', cursor: CURSOR }], {
    ledger, _sshExec: exec, sidecar: (alias, lines) => sidecarCalls.push({ alias, lines }),
  });
  assert.equal(exec.calls.length, 2, 'sidecar -> exactly one extra pass');
  assert.ok(exec.calls[1].cmd.includes('head -c 65536'), 'raw-line pass must be byte-capped');
  assert.equal(sidecarCalls.length, 1);
  assert.equal(sidecarCalls[0].alias, 'core-1');
  const expectedLines = fixture.split('\n').filter((l) => l && ledger.classes.some(
    (cls) => new RegExp(cls.pattern).test(l.toLowerCase()),
  ));
  assert.deepEqual(sidecarCalls[0].lines, expectedLines);
  // Raw matched text never appears in the main-stream record.
  const serialized = JSON.stringify(res);
  assert.ok(!serialized.includes('listGraphs query timed out'), 'raw journal text leaked into counts record');
  assert.deepEqual(res.counts, EXPECTED_COUNTS);
});

test('journalSignatureDeltas refuses a missing or shell-unsafe cursor without touching the fleet', async () => {
  const exec = makeJournalFakeExec();
  const results = await journalSignatureDeltas(FLEET, [
    { alias: 'core-1', cursor: "s=1'; rm -rf /; echo '" },
    { alias: 'core-1', cursor: null },
  ], { ledger, _sshExec: exec });
  assert.equal(exec.calls.length, 0, 'invalid cursors must never reach ssh');
  for (const res of results) {
    assert.equal(res.cursorValid, false);
    assert.equal(res.gatedTotal, null, 'no silent zeroes');
    assert.equal(res.recordedTotal, null);
    assert.equal(res.error, 'missing_or_invalid_journal_cursor');
  }
});

test('journalSignatureDeltas maps a vacuumed cursor to cursorValid:false (never zeroes)', async () => {
  const exec = async () => ({ ok: true, code: 0, stdout: 'journal_status=1\ncursor_valid=0\n', stderr: '', timedOut: false });
  const [res] = await journalSignatureDeltas(FLEET, [{ alias: 'core-1', cursor: CURSOR }], { ledger, _sshExec: exec });
  assert.equal(res.cursorValid, false);
  assert.equal(res.gatedTotal, null);
  assert.equal(res.error, 'cursor_vacuumed_or_invalid');
});

test('journalSignatureDeltas treats incomplete signature output as breakage, not zeroes', async () => {
  const exec = async () => ({
    ok: true, code: 0, timedOut: false, stderr: '',
    stdout: 'journal_status=0\ncursor_valid=1\nsig_listgraphs_timeout=0\n', // missing the other classes
  });
  const [res] = await journalSignatureDeltas(FLEET, [{ alias: 'core-1', cursor: CURSOR }], { ledger, _sshExec: exec });
  assert.equal(res.cursorValid, false);
  assert.equal(res.error, 'signature_output_incomplete');
  assert.equal(res.gatedTotal, null);
});

test('journalSignatureDeltas reports ssh transport failure as INCONCLUSIVE material', async () => {
  const exec = async () => ({ ok: false, code: 255, stdout: '', stderr: 'no route', timedOut: false });
  const [res] = await journalSignatureDeltas(FLEET, [{ alias: 'core-1', cursor: CURSOR }], { ledger, _sshExec: exec });
  assert.equal(res.cursorValid, false);
  assert.equal(res.error, 'ssh_failed');
  const unknown = await journalSignatureDeltas(FLEET, [{ alias: 'core-9', cursor: CURSOR }], { ledger, _sshExec: exec });
  assert.equal(unknown[0].error, 'unknown_alias');
});

// ── snapshotCore / snapshotFleet ─────────────────────────────────────────────

const EXEC_START = 'Mon 2026-07-13 09:14:02 UTC';

function snapshotStdout({ full = true } = {}) {
  const b64 = Buffer.from(EXEC_START, 'utf8').toString('base64');
  const lines = [
    'active_state=active',
    'sub_state=running',
    'n_restarts=2',
    `exec_main_start=b64:${b64}`,
    'main_pid=1234',
    'main_rss_kb=210000',
    'worker_pid=1301',
    'worker_rss_kb=812345',
    'memory_current=4831838208',
    'memory_peak=6442450944',
    'memory_high=max',
    'memory_max=7516192768',
    'oom_kills=0',
    'psi_some_avg10=0.13',
    'listen_recvq=0',
    'listen_backlog=511',
    'probe_ok=1',
    'disk_avail_bytes=52613349376',
    'disk_used_pct=37',
  ];
  if (full) {
    lines.push('store_bytes=9663676416', `journal_cursor=${CURSOR}`);
  }
  lines.push('snapshot_complete=1');
  return `${lines.join('\n')}\n`;
}

const STATUS_BODY = {
  version: '10.1.0',
  commit: '0641972200aa',
  buildTime: '2026-07-12T10:00:00Z',
  admission: { rejected: 7 },
  chain: { rpcFailovers: 2, rpcExhaustions: 1 },
};

function fakeExecOk(stdout) {
  const fn = async (target, cmd, opts) => {
    fn.calls.push({ target, cmd, opts });
    return { ok: true, code: 0, stdout, stderr: '', timedOut: false };
  };
  fn.calls = [];
  return fn;
}

const fakeFetchOk = async () => ({ ok: true, status: 200, json: async () => STATUS_BODY });

test('snapshotCore (full) maps the k=v snapshot + /api/status into the EVIDENCE.md shape', async () => {
  const exec = fakeExecOk(snapshotStdout());
  const record = await snapshotCore(CORE, { _sshExec: exec, _fetch: fakeFetchOk });
  assert.ok(exec.calls[0].cmd.includes('systemctl show dkg-node.service'));
  assert.equal(record.alias, 'core-1');
  assert.equal(record.reachable, true);
  assert.equal(record.kind, 'full');
  assert.deepEqual(record.systemd, {
    activeState: 'active', subState: 'running', execMainStartTs: EXEC_START, nRestarts: 2, mainPid: 1234,
  });
  assert.equal(record.workerPid, 1301);
  assert.deepEqual(record.build, { commit: '0641972200aa', buildTime: '2026-07-12T10:00:00Z', version: '10.1.0' });
  assert.equal(record.rss, 812345 * 1024); // ps reports KiB; snapshot rss is bytes
  assert.deepEqual(record.cgroup, {
    memoryCurrent: 4831838208, memoryPeak: 6442450944, memoryHigh: null, memoryMax: 7516192768,
    oomKills: 0, psiSomeAvg10: 0.13,
  });
  assert.deepEqual(record.listen, { recvQ: 0, backlog: 511, connectProbeOk: true });
  assert.deepEqual(record.diskFree, { bytes: 52613349376, fraction: 0.63 });
  assert.deepEqual(record.api, { reachable: true, admissionRejected: 7, rpcFailovers: 2, rpcExhaustions: 1 });
  assert.equal(record.storeBytes, 9663676416);
  assert.equal(record.journalCursor, CURSOR);
});

test('snapshotCore (light) omits full-only fields and asks for the light command', async () => {
  const exec = fakeExecOk(snapshotStdout({ full: false }));
  const record = await snapshotCore(CORE, { light: true, _sshExec: exec, _fetch: fakeFetchOk });
  assert.equal(record.kind, 'light');
  assert.ok(!exec.calls[0].cmd.includes('journalctl'), 'light snapshot must not touch the journal');
  assert.ok(!('journalCursor' in record));
  assert.ok(!('storeBytes' in record));
});

test('snapshotCore records carry ONLY the alias — no host, user, or key path (S6)', async () => {
  const exec = fakeExecOk(snapshotStdout());
  const record = await snapshotCore(CORE, { _sshExec: exec, _fetch: fakeFetchOk });
  const serialized = JSON.stringify(record);
  for (const secret of [CORE.host, CORE.sshUser, CORE.sshIdentity]) {
    assert.ok(!serialized.includes(secret), `record leaked ${secret}`);
  }
});

test('snapshotCore never throws: ssh transport failure -> reachable:false with scrubbed error', async () => {
  const exec = async () => ({
    ok: false, code: 255, stdout: '',
    stderr: 'ssh: connect to host 203.0.113.7 port 22: No route to host (user observer, key ~/.ssh/id_test)',
    timedOut: false,
  });
  const record = await snapshotCore(CORE, { _sshExec: exec, _fetch: fakeFetchOk });
  assert.equal(record.alias, 'core-1');
  assert.equal(record.reachable, false);
  assert.equal(record.systemd, null);
  const serialized = JSON.stringify(record);
  for (const secret of [CORE.host, CORE.sshUser, CORE.sshIdentity]) {
    assert.ok(!serialized.includes(secret), `unreachable record leaked ${secret}`);
  }
  assert.match(record.error, /ssh_failed/);
});

test('snapshotCore reads a real /api/status over local HTTP (default fetch path)', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/api/status') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(STATUS_BODY));
    } else {
      res.statusCode = 404;
      res.end('nope');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const core = { ...CORE, host: '127.0.0.1', apiPort: port };
    const record = await snapshotCore(core, { light: true, _sshExec: fakeExecOk(snapshotStdout({ full: false })) });
    assert.equal(record.reachable, true);
    assert.equal(record.build.commit, '0641972200aa');
    assert.equal(record.api.admissionRejected, 7);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('snapshotCore marks the core unreachable when only /api/status is down, keeping ssh fields', async () => {
  // Grab a 127.0.0.1 port that is then closed again -> fast ECONNREFUSED.
  const server = createServer(() => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const core = { ...CORE, host: '127.0.0.1', apiPort: port };
  const record = await snapshotCore(core, { light: true, _sshExec: fakeExecOk(snapshotStdout({ full: false })) });
  assert.equal(record.reachable, false);
  assert.equal(record.api.reachable, false);
  assert.equal(record.build, null);
  assert.equal(record.systemd.activeState, 'active', 'ssh-side fields must survive an api outage');
  assert.ok(!JSON.stringify(record).includes('127.0.0.1'), 'api error text leaked the host');
});

test('snapshotCore handles defensively a status body without counters', async () => {
  const exec = fakeExecOk(snapshotStdout());
  const fetchBare = async () => ({ ok: true, status: 200, json: async () => ({ version: '10.1.0' }) });
  const record = await snapshotCore(CORE, { _sshExec: exec, _fetch: fetchBare });
  assert.deepEqual(record.api, { reachable: true, admissionRejected: null, rpcFailovers: null, rpcExhaustions: null });
  assert.equal(record.build.commit, null);
});

test('snapshotFleet snapshots every core with bounded concurrency and stamps ts/kind', async () => {
  const fleet = {
    cores: [CORE, { ...CORE, alias: 'core-2', host: '203.0.113.8' }],
    sshConcurrency: 1,
    sshConnectTimeoutSec: 4,
  };
  const exec = fakeExecOk(snapshotStdout({ full: false }));
  const out = await snapshotFleet(fleet, { light: true, _sshExec: exec, _fetch: fakeFetchOk });
  assert.equal(out.kind, 'light');
  assert.ok(Date.parse(out.ts) > 0);
  assert.deepEqual(out.cores.map((c) => c.alias), ['core-1', 'core-2']);
  assert.equal(exec.calls[0].opts.connectTimeoutSec, 4, 'fleet sshConnectTimeoutSec must reach the transport');
});

// ── attestation ──────────────────────────────────────────────────────────────

async function goodSnapshot() {
  return snapshotCore(CORE, { _sshExec: fakeExecOk(snapshotStdout()), _fetch: fakeFetchOk });
}

test('attestBuildIdentity binds daemon commit to worker pid + start timestamp', async () => {
  const att = attestBuildIdentity(await goodSnapshot());
  assert.deepEqual(att, {
    alias: 'core-1',
    commit: '0641972200aa',
    buildTime: '2026-07-12T10:00:00Z',
    workerPid: 1301,
    workerStartTs: EXEC_START,
    attested: true,
  });
});

test('attestBuildIdentity: missing/unknown/dirty commit is NOT attested (§3.1)', async () => {
  const snap = await goodSnapshot();
  const missing = attestBuildIdentity({ ...snap, build: { ...snap.build, commit: null } });
  assert.equal(missing.attested, false);
  assert.equal(missing.inconclusiveReason, 'missing_build_identity');
  const unknown = attestBuildIdentity({ ...snap, build: { ...snap.build, commit: 'unknown' } });
  assert.equal(unknown.inconclusiveReason, 'missing_build_identity');
  const dirty = attestBuildIdentity({ ...snap, build: { ...snap.build, commit: '0641972200aa-dirty' } });
  assert.equal(dirty.attested, false);
  assert.equal(dirty.inconclusiveReason, 'dirty_build_identity');
});

test('attestBuildIdentity: unreachable core or missing process binding is inconclusive', async () => {
  const unreachable = attestBuildIdentity({ alias: 'core-1', reachable: false });
  assert.equal(unreachable.attested, false);
  assert.equal(unreachable.inconclusiveReason, 'core_unreachable');
  const snap = await goodSnapshot();
  const noPid = attestBuildIdentity({ ...snap, workerPid: null, systemd: { ...snap.systemd, mainPid: null } });
  assert.equal(noPid.inconclusiveReason, 'missing_process_binding');
});

test('sameArtifact detects mid-run SHA/PID/restart changes', async () => {
  const a = attestBuildIdentity(await goodSnapshot());
  assert.equal(sameArtifact(a, { ...a }), true);
  assert.equal(sameArtifact(a, { ...a, commit: 'deadbeef' }), false, 'commit change');
  assert.equal(sameArtifact(a, { ...a, workerPid: 1400 }), false, 'worker restart (pid)');
  assert.equal(sameArtifact(a, { ...a, workerStartTs: 'Tue 2026-07-14 01:00:00 UTC' }), false, 'restart (start ts)');
  assert.equal(sameArtifact(a, { ...a, alias: 'core-2' }), false, 'different core');
  assert.equal(sameArtifact(a, { ...a, attested: false }), false, 'unattested never matches');
  assert.equal(sameArtifact(null, a), false);
});

// ── journal cursors ──────────────────────────────────────────────────────────

test('captureJournalCursors parses the "-- cursor:" line and validates its charset', async () => {
  const exec = async (target, cmd) => {
    assert.ok(cmd.includes('journalctl -u dkg-node.service -n 0 --show-cursor'));
    return { ok: true, code: 0, stdout: `-- cursor: ${CURSOR}\n`, stderr: '', timedOut: false };
  };
  const [entry] = await captureJournalCursors(FLEET, { _sshExec: exec });
  assert.deepEqual(entry, { alias: 'core-1', cursor: CURSOR, valid: true });
});

test('captureJournalCursors reports invalid on transport failure or garbage', async () => {
  const dead = async () => ({ ok: false, code: 255, stdout: '', stderr: 'no route', timedOut: false });
  const [entry] = await captureJournalCursors(FLEET, { _sshExec: dead });
  assert.deepEqual(entry, { alias: 'core-1', cursor: null, valid: false });
  const garbage = async () => ({ ok: true, code: 0, stdout: '-- cursor: bad cursor with spaces\n', stderr: '', timedOut: false });
  const [entry2] = await captureJournalCursors(FLEET, { _sshExec: garbage });
  assert.equal(entry2.valid, false);
});

// ── scrubbing helper ─────────────────────────────────────────────────────────

test('scrubTargetRefs removes host, user, and key path from error text', () => {
  const text = 'ssh: connect to host 203.0.113.7 port 22 as observer with ~/.ssh/id_test failed';
  const out = scrubTargetRefs(text, CORE);
  assert.ok(!out.includes('203.0.113.7'));
  assert.ok(!out.includes('observer'));
  assert.ok(!out.includes('id_test'));
  assert.ok(out.includes('[redacted]'));
});
