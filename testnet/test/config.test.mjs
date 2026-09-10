// Tests for lib/config.mjs — hermetic: fixture files in a temp dir, fake _exec
// for the S2 credential probes. No SSH, no network, no real fleet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  POLICY_TRIPS,
  fileDigest,
  isLooser,
  loadFleet,
  loadPolicy,
  loadScenario,
  verifyCredentialIsolation,
} from '../lib/config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FLEET_EXAMPLE = JSON.parse(readFileSync(join(ROOT, 'fleet.example.json'), 'utf8'));
const POLICY_EXAMPLE = JSON.parse(readFileSync(join(ROOT, 'policy.example.json'), 'utf8'));
const SCENARIO_EXAMPLE = JSON.parse(readFileSync(join(ROOT, 'scenarios', 'certify-100.json'), 'utf8'));

const tmp = mkdtempSync(join(tmpdir(), 'rfc61-config-'));
let seq = 0;
function writeJson(obj) {
  const path = join(tmp, `fixture-${seq++}.json`);
  writeFileSync(path, JSON.stringify(obj, null, 2));
  return path;
}

/** Build a scenario baseDir: scenarios.json manifest + scenarios/<name>.json files. */
function scenarioBaseDir(scenarioByName, manifestNames = Object.keys(scenarioByName)) {
  const base = join(tmp, `scen-${seq++}`);
  mkdirSync(join(base, 'scenarios'), { recursive: true });
  writeFileSync(join(base, 'scenarios.json'), JSON.stringify({ schemaVersion: 1, scenarios: manifestNames }));
  for (const [name, sc] of Object.entries(scenarioByName)) {
    writeFileSync(join(base, 'scenarios', `${name}.json`), JSON.stringify(sc, null, 2));
  }
  return base;
}

const clone = (o) => structuredClone(o);

/** Run fn, return the thrown error (node:assert's throws() does not return it). */
function capture(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return assert.fail('expected the call to throw');
}

// ── fileDigest ───────────────────────────────────────────────────────────────

test('fileDigest is sha256 of the raw file bytes', () => {
  const path = join(tmp, 'digest-probe.bin');
  writeFileSync(path, 'exact bytes\n');
  const expected = createHash('sha256').update('exact bytes\n').digest('hex');
  assert.equal(fileDigest(path), expected);
});

// ── loadFleet ────────────────────────────────────────────────────────────────

test('loadFleet: the example fleet loads and returns the contract shape + digest', () => {
  const path = writeJson(FLEET_EXAMPLE);
  const fleet = loadFleet(path);
  assert.equal(fleet.network, 'base:84532');
  assert.equal(fleet.cores.length, 2);
  assert.deepEqual(fleet.cores.map((c) => c.alias), ['core-1', 'core-2']);
  assert.equal(fleet.sshConcurrency, 2);
  assert.equal(fleet.sshConnectTimeoutSec, 8);
  assert.equal(fleet.edges.nonMember, null);
  assert.deepEqual(fleet.seeds, []);
  assert.equal(fleet.digest, fileDigest(path));
});

test('loadFleet: collects ALL problems into one error joined with "; "', () => {
  const bad = clone(FLEET_EXAMPLE);
  bad.cores[0].alias = 'Core_1'; // bad alias format
  bad.cores[1].apiPort = 0; // bad port
  delete bad.cores[1].host; // missing host
  bad.sshConcurrency = 0; // bad concurrency
  const err = capture(() => loadFleet(writeJson(bad)));
  assert.match(err.message, /alias/);
  assert.match(err.message, /apiPort/);
  assert.match(err.message, /host/);
  assert.match(err.message, /sshConcurrency/);
  assert.ok(err.message.split('; ').length >= 4, `expected >=4 joined problems: ${err.message}`);
});

test('loadFleet: duplicate aliases, bad network, missing edge key, unknown role all rejected', () => {
  const bad = clone(FLEET_EXAMPLE);
  bad.cores[1].alias = 'core-1';
  bad.network = 'base sepolia';
  delete bad.edges.nonMember;
  bad.cores[0].roles = ['core', 'gateway'];
  const err = capture(() => loadFleet(writeJson(bad)));
  assert.match(err.message, /duplicate alias 'core-1'/);
  assert.match(err.message, /network/);
  assert.match(err.message, /edges\.nonMember/);
  assert.match(err.message, /unknown role 'gateway'/);
});

test('loadFleet: empty cores and non-object edges rejected', () => {
  const bad = clone(FLEET_EXAMPLE);
  bad.cores = [];
  bad.edges = 'nope';
  const err = capture(() => loadFleet(writeJson(bad)));
  assert.match(err.message, /cores must be a non-empty array/);
  assert.match(err.message, /edges must be an object/);
});

test('loadFleet: invalid JSON and unreadable files throw, not crash', () => {
  const path = join(tmp, 'not-json.json');
  writeFileSync(path, '{ nope');
  assert.throws(() => loadFleet(path), /invalid JSON/);
  assert.throws(() => loadFleet(join(tmp, 'missing.json')), /cannot read file/);
});

test('loadFleet: S6 — error text never echoes host/sshUser/sshIdentity values', () => {
  const bad = clone(FLEET_EXAMPLE);
  bad.cores[0].host = '203.0.113.77'; // sentinel topology values on a core that ALSO has errors
  bad.cores[0].sshUser = 'sentinel-user-zz';
  bad.cores[0].sshIdentity = '/sentinel/key/path';
  bad.cores[0].apiPort = -1;
  bad.cores[0].systemdUnit = '';
  const err = capture(() => loadFleet(writeJson(bad)));
  assert.ok(!err.message.includes('203.0.113.77'), 'host leaked into error text');
  assert.ok(!err.message.includes('sentinel-user-zz'), 'sshUser leaked into error text');
  assert.ok(!err.message.includes('/sentinel/key/path'), 'sshIdentity leaked into error text');
  assert.match(err.message, /core-1/); // referenced by alias instead
});

// ── loadPolicy ───────────────────────────────────────────────────────────────

test('loadPolicy: the example policy loads and returns the contract shape + digest', () => {
  const path = writeJson(POLICY_EXAMPLE);
  const policy = loadPolicy(path);
  assert.deepEqual(
    Object.keys(policy).sort(),
    ['digest', 'faucet', 'permanentData', 'quiesce', 'safetyAbort', 'trips'],
  );
  assert.equal(policy.trips.diskFreeFloorBytes.default, 16106127360);
  assert.equal(policy.quiesce.flatCounterConfirmSec, 20);
  assert.equal(policy.digest, fileDigest(path));
});

test('POLICY_TRIPS direction table covers exactly the policy.example.json trips (drift guard)', () => {
  const exampleTrips = Object.keys(POLICY_EXAMPLE.trips).filter((k) => !k.startsWith('$')).sort();
  assert.deepEqual(Object.keys(POLICY_TRIPS).sort(), exampleTrips);
});

test('loadPolicy: every example trip is required', () => {
  const bad = clone(POLICY_EXAMPLE);
  delete bad.trips.diskFreeFloorBytes;
  assert.throws(() => loadPolicy(writeJson(bad)), /trips\.diskFreeFloorBytes missing/);
});

test('loadPolicy: hardMax FLOOR direction — a LOWER disk floor is looser and throws', () => {
  const bad = clone(POLICY_EXAMPLE);
  bad.trips.diskFreeFloorBytes.default = 8 * 1024 ** 3; // below hardMax floor 10 GiB
  assert.throws(() => loadPolicy(writeJson(bad)), /diskFreeFloorBytes.*LOOSER than hardMax/);

  const ok = clone(POLICY_EXAMPLE);
  ok.trips.diskFreeFloorBytes.default = 20 * 1024 ** 3; // higher floor = tighter
  assert.equal(loadPolicy(writeJson(ok)).trips.diskFreeFloorBytes.default, 20 * 1024 ** 3);
});

test('loadPolicy: hardMax CEILING direction — a HIGHER rpc delta is looser and throws', () => {
  const bad = clone(POLICY_EXAMPLE);
  bad.trips.rpcExhaustionDeltaPerRun.default = 1000; // above hardMax ceiling 500
  assert.throws(() => loadPolicy(writeJson(bad)), /rpcExhaustionDeltaPerRun.*LOOSER than hardMax/);

  const ok = clone(POLICY_EXAMPLE);
  ok.trips.rpcExhaustionDeltaPerRun.default = 50; // lower ceiling = tighter
  assert.equal(loadPolicy(writeJson(ok)).trips.rpcExhaustionDeltaPerRun.default, 50);
});

test('loadPolicy: hardMax BOOLEAN direction — disabling a true-hardMax trip throws', () => {
  const bad = clone(POLICY_EXAMPLE);
  bad.trips.acceptQueueRecvQAtBacklog.default = false;
  assert.throws(() => loadPolicy(writeJson(bad)), /acceptQueueRecvQAtBacklog.*LOOSER than hardMax/);
});

test('loadPolicy: unknown trips, bad types, missing knobs and blocks all collected in one error', () => {
  const bad = clone(POLICY_EXAMPLE);
  bad.trips.totallyMadeUp = { default: 1, hardMax: 2 };
  bad.trips.oomKillDelta.default = 'zero';
  delete bad.trips.memoryPsiSomeAvg10.sustainSec;
  delete bad.quiesce;
  bad.faucet.maxTopUpsPerRun = -1;
  const err = capture(() => loadPolicy(writeJson(bad)));
  assert.match(err.message, /totallyMadeUp.*unknown trip/);
  assert.match(err.message, /oomKillDelta.*must both be numbers/);
  assert.match(err.message, /memoryPsiSomeAvg10\.sustainSec/);
  assert.match(err.message, /quiesce must be an object/);
  assert.match(err.message, /faucet\.maxTopUpsPerRun/);
});

test('isLooser: direction semantics', () => {
  assert.equal(isLooser(5, 10, 'floor'), true); // lower floor = looser
  assert.equal(isLooser(15, 10, 'floor'), false);
  assert.equal(isLooser(15, 10, 'ceiling'), true); // higher ceiling = looser
  assert.equal(isLooser(5, 10, 'ceiling'), false);
  assert.equal(isLooser(10, 10, 'ceiling'), false); // equal is never looser
  assert.equal(isLooser(false, true, 'boolean'), true);
  assert.equal(isLooser(true, true, 'boolean'), false);
});

// ── loadScenario ─────────────────────────────────────────────────────────────

const policy = loadPolicy(writeJson(POLICY_EXAMPLE));

test('loadScenario: the shipped certify-100 scenario loads against the example policy', () => {
  const base = scenarioBaseDir({ 'certify-100': SCENARIO_EXAMPLE });
  const { scenario, digest } = loadScenario('certify-100', { policy, baseDir: base });
  assert.equal(scenario.scenario, 'certify-100');
  assert.deepEqual(scenario.lanes, ['public', 'private']);
  assert.equal(digest, fileDigest(join(base, 'scenarios', 'certify-100.json')));
});

test('loadScenario: a scenario missing from scenarios.json is refused (manifest drift)', () => {
  const base = scenarioBaseDir({ 'certify-100': SCENARIO_EXAMPLE }, []); // file on disk, not listed
  assert.throws(() => loadScenario('certify-100', { policy, baseDir: base }), /not listed in scenarios\.json/);
});

test('loadScenario: listed but file missing throws; traversal-shaped names are rejected outright', () => {
  const base = scenarioBaseDir({}, ['ghost']);
  assert.throws(() => loadScenario('ghost', { policy, baseDir: base }), /cannot read file/);
  assert.throws(() => loadScenario('../evil', { policy, baseDir: base }), /must match/);
});

test('loadScenario: shape per certify-100.json — missing keys and field mismatch collected', () => {
  const bad = clone(SCENARIO_EXAMPLE);
  delete bad.readback;
  delete bad.soakSeconds;
  bad.scenario = 'other-name';
  bad.workload.concurrency = 0;
  bad.lanes = ['public', 'sideband'];
  const base = scenarioBaseDir({ 'certify-100': bad });
  const err = capture(() => loadScenario('certify-100', { policy, baseDir: base }));
  assert.match(err.message, /missing required key 'readback'/);
  assert.match(err.message, /missing required key 'soakSeconds'/);
  assert.match(err.message, /'scenario' field must equal the file basename/);
  assert.match(err.message, /workload\.concurrency/);
  assert.match(err.message, /lanes/);
});

test('loadScenario S3: a scalar trip override may only tighten (ceiling)', () => {
  const loosened = clone(SCENARIO_EXAMPLE);
  loosened.trips = { rpcExhaustionDeltaPerRun: 200 }; // policy default 100 → looser
  let base = scenarioBaseDir({ 'certify-100': loosened });
  assert.throws(
    () => loadScenario('certify-100', { policy, baseDir: base }),
    /trips\.rpcExhaustionDeltaPerRun.*LOOSENS policy/,
  );

  const tightened = clone(SCENARIO_EXAMPLE);
  tightened.trips = { rpcExhaustionDeltaPerRun: 50 };
  base = scenarioBaseDir({ 'certify-100': tightened });
  const { scenario } = loadScenario('certify-100', { policy, baseDir: base });
  assert.equal(scenario.trips.rpcExhaustionDeltaPerRun, 50);
});

test('loadScenario S3: a scalar trip override may only tighten (floor — LOWER is looser)', () => {
  const loosened = clone(SCENARIO_EXAMPLE);
  loosened.trips = { diskFreeFloorBytes: 8 * 1024 ** 3 }; // policy default 15 GiB → looser
  let base = scenarioBaseDir({ 'certify-100': loosened });
  assert.throws(
    () => loadScenario('certify-100', { policy, baseDir: base }),
    /trips\.diskFreeFloorBytes.*LOOSENS policy/,
  );

  const tightened = clone(SCENARIO_EXAMPLE);
  tightened.trips = { diskFreeFloorBytes: 20 * 1024 ** 3 }; // higher floor = tighter
  base = scenarioBaseDir({ 'certify-100': tightened });
  loadScenario('certify-100', { policy, baseDir: base }); // must not throw
});

test('loadScenario S3: object overrides check both the default and per-knob directions', () => {
  const loosenedKnob = clone(SCENARIO_EXAMPLE);
  loosenedKnob.trips = { memoryPsiSomeAvg10: { default: 0.3, sustainSec: 120 } }; // 120 > policy 60 → looser
  let base = scenarioBaseDir({ 'certify-100': loosenedKnob });
  assert.throws(
    () => loadScenario('certify-100', { policy, baseDir: base }),
    /memoryPsiSomeAvg10\.sustainSec.*LOOSENS policy/,
  );

  const tightened = clone(SCENARIO_EXAMPLE);
  tightened.trips = { memoryPsiSomeAvg10: { default: 0.3, sustainSec: 30 } };
  base = scenarioBaseDir({ 'certify-100': tightened });
  loadScenario('certify-100', { policy, baseDir: base }); // must not throw

  const booleanOff = clone(SCENARIO_EXAMPLE);
  booleanOff.trips = { acceptQueueRecvQAtBacklog: false }; // disabling the trip = loosening
  base = scenarioBaseDir({ 'certify-100': booleanOff });
  assert.throws(
    () => loadScenario('certify-100', { policy, baseDir: base }),
    /acceptQueueRecvQAtBacklog.*LOOSENS policy/,
  );

  const unknown = clone(SCENARIO_EXAMPLE);
  unknown.trips = { madeUpTrip: 1 };
  base = scenarioBaseDir({ 'certify-100': unknown });
  assert.throws(
    () => loadScenario('certify-100', { policy, baseDir: base }),
    /trips\.madeUpTrip is not a known policy trip/,
  );
});

test('loadScenario S3: gates.fleet keys that shadow policy trips are tighten-only too', () => {
  const loosened = clone(SCENARIO_EXAMPLE);
  loosened.gates.fleet.oomKillDelta = 2; // policy trip default 0 → looser
  let base = scenarioBaseDir({ 'certify-100': loosened });
  assert.throws(
    () => loadScenario('certify-100', { policy, baseDir: base }),
    /gates\.fleet\.oomKillDelta.*LOOSENS policy/,
  );

  const equal = clone(SCENARIO_EXAMPLE); // shipped gate is 0 == policy default 0
  base = scenarioBaseDir({ 'certify-100': equal });
  loadScenario('certify-100', { policy, baseDir: base }); // equal is not looser
});

// ── verifyCredentialIsolation (S2) ───────────────────────────────────────────

const HOME = join(tmp, 'home');
mkdirSync(join(HOME, '.ssh'), { recursive: true });
writeFileSync(join(HOME, '.ssh', 'id_harness_readonly'), 'FAKE KEY MATERIAL\n');

const SENTINEL_HOST = '203.0.113.10';
const SENTINEL_USER = 'obsvr-sentinel';
function makeFleet(overrides = {}) {
  return {
    cores: [{
      alias: 'core-1',
      host: SENTINEL_HOST,
      sshUser: SENTINEL_USER,
      sshIdentity: '~/.ssh/id_harness_readonly',
      systemdUnit: 'dkg-node',
      apiPort: 9200,
      listenPort: 9090,
      storeFilesystem: '/',
      roles: ['core'],
      ...overrides,
    }],
    sshConnectTimeoutSec: 8,
  };
}

/** Fake _exec: records calls, answers via responder({file, args}). Never throws. */
function makeExec(responder) {
  const calls = [];
  const exec = async (file, args, opts) => {
    calls.push({ file, args, opts });
    return { stdout: '', stderr: '', code: 0, timedOut: false, ...responder({ file, args }) };
  };
  return { exec, calls };
}

const remoteCmdOf = (args) => args[args.length - 1];

/** Responder for a correctly isolated fleet: allowlisted forced command rejects everything. */
function isolatedResponder({ file, args }) {
  if (file === 'ssh-add') return { code: 1, stdout: 'The agent has no identities.\n' };
  const cmd = remoteCmdOf(args);
  if (cmd === 'sudo -n true') return { code: 12, stderr: 'snapshot-only key: command rejected\n' };
  if (cmd === 'echo x') return { code: 0, stdout: 'host=b64:aG9zdA==\nactive_state=active\n' }; // forced snapshot output, not 'x'
  throw new Error(`unexpected probe command: ${cmd}`);
}

test('verifyCredentialIsolation: interactive mode skips probes and records the mode', async () => {
  const { exec, calls } = makeExec(() => ({}));
  const res = await verifyCredentialIsolation(makeFleet(), { mode: 'interactive', _exec: exec, _env: {} });
  assert.equal(res.ok, true);
  assert.equal(res.checks.length, 1);
  assert.equal(res.checks[0].id, 'mode-interactive');
  assert.equal(res.checks[0].evidence.mode, 'interactive');
  assert.equal(calls.length, 0);
});

test('verifyCredentialIsolation: autonomous happy path — isolated key passes all checks', async () => {
  const { exec, calls } = makeExec(isolatedResponder);
  const res = await verifyCredentialIsolation(makeFleet(), { mode: 'autonomous', _exec: exec, _env: { HOME } });
  assert.equal(res.ok, true, JSON.stringify(res.checks, null, 2));
  assert.deepEqual(
    res.checks.map((c) => c.id),
    ['no-agent', 'identity-only', 'sudo-refused:core-1', 'no-verbatim-exec:core-1'],
  );
  assert.ok(res.checks.every((c) => c.pass));

  // No agent socket → ssh-add never consulted; exactly the two ssh probes ran.
  assert.deepEqual(calls.map((c) => c.file), ['ssh', 'ssh']);
  for (const call of calls) {
    const flat = call.args.join(' ');
    assert.match(flat, /BatchMode=yes/);
    assert.match(flat, /IdentitiesOnly=yes/);
    assert.match(flat, /IdentityAgent=none/);
    assert.match(flat, /StrictHostKeyChecking=accept-new/);
    assert.ok(call.args.includes('-i'), 'probe must pin the identity file');
    assert.equal(call.args[call.args.length - 2], '--');
  }
  assert.equal(remoteCmdOf(calls[0].args), 'sudo -n true');
  assert.equal(remoteCmdOf(calls[1].args), 'echo x');
});

test('verifyCredentialIsolation: verbatim echo round-trip means NO forced command — fail', async () => {
  const { exec } = makeExec((call) => {
    if (remoteCmdOf(call.args) === 'echo x') return { code: 0, stdout: 'x\n' };
    return isolatedResponder(call);
  });
  const res = await verifyCredentialIsolation(makeFleet(), { mode: 'autonomous', _exec: exec, _env: { HOME } });
  assert.equal(res.ok, false);
  const echoCheck = res.checks.find((c) => c.id === 'no-verbatim-exec:core-1');
  assert.equal(echoCheck.pass, false);
  assert.equal(echoCheck.evidence.verbatim, true);
});

test('verifyCredentialIsolation: sudo probe succeeding (exit 0) fails the isolation check', async () => {
  const { exec } = makeExec((call) => {
    if (remoteCmdOf(call.args) === 'sudo -n true') return { code: 0, stdout: '' };
    return isolatedResponder(call);
  });
  const res = await verifyCredentialIsolation(makeFleet(), { mode: 'autonomous', _exec: exec, _env: { HOME } });
  assert.equal(res.ok, false);
  assert.equal(res.checks.find((c) => c.id === 'sudo-refused:core-1').pass, false);
});

test('verifyCredentialIsolation: sudo refusal via password-required message passes', async () => {
  const { exec } = makeExec((call) => {
    if (remoteCmdOf(call.args) === 'sudo -n true') {
      return { code: 1, stderr: 'sudo: a password is required\n' };
    }
    return isolatedResponder(call);
  });
  const res = await verifyCredentialIsolation(makeFleet(), { mode: 'autonomous', _exec: exec, _env: { HOME } });
  const sudoCheck = res.checks.find((c) => c.id === 'sudo-refused:core-1');
  assert.equal(sudoCheck.pass, true);
  assert.equal(sudoCheck.evidence.passwordPrompt, true);
});

test('verifyCredentialIsolation: ambient agent WITH identities fails; empty agent passes', async () => {
  const withKeys = makeExec((call) => {
    if (call.file === 'ssh-add') return { code: 0, stdout: '256 SHA256:abcdef laptop-key (ED25519)\n' };
    return isolatedResponder(call);
  });
  const env = { HOME, SSH_AUTH_SOCK: join(tmp, 'agent.sock') };
  const res1 = await verifyCredentialIsolation(makeFleet(), { mode: 'autonomous', _exec: withKeys.exec, _env: env });
  assert.equal(res1.ok, false);
  const agentCheck = res1.checks.find((c) => c.id === 'no-agent');
  assert.deepEqual(agentCheck, { id: 'no-agent', pass: false, evidence: { authSockSet: true, agentIdentities: 1 } });
  assert.equal(withKeys.calls[0].file, 'ssh-add');
  assert.deepEqual(withKeys.calls[0].args, ['-l']);

  const empty = makeExec(isolatedResponder); // ssh-add → code 1 "no identities"
  const res2 = await verifyCredentialIsolation(makeFleet(), { mode: 'autonomous', _exec: empty.exec, _env: env });
  assert.equal(res2.ok, true);
  assert.deepEqual(res2.checks.find((c) => c.id === 'no-agent').evidence, { authSockSet: true, agentEmpty: true });
});

test('verifyCredentialIsolation: unverifiable agent state fails closed', async () => {
  const { exec } = makeExec((call) => {
    if (call.file === 'ssh-add') return { code: 2, stderr: 'Error connecting to agent\n' };
    return isolatedResponder(call);
  });
  const res = await verifyCredentialIsolation(makeFleet(), {
    mode: 'autonomous', _exec: exec, _env: { HOME, SSH_AUTH_SOCK: '/dead/agent.sock' },
  });
  assert.equal(res.ok, false);
  assert.equal(res.checks.find((c) => c.id === 'no-agent').evidence.reason, 'agent-state-unverifiable');
});

test('verifyCredentialIsolation: ssh transport failure (255) fails BOTH probes closed', async () => {
  const { exec } = makeExec((call) => {
    if (call.file === 'ssh') return { code: 255, stderr: 'Connection timed out\n' };
    return isolatedResponder(call);
  });
  const res = await verifyCredentialIsolation(makeFleet(), { mode: 'autonomous', _exec: exec, _env: { HOME } });
  assert.equal(res.ok, false);
  for (const id of ['sudo-refused:core-1', 'no-verbatim-exec:core-1']) {
    const check = res.checks.find((c) => c.id === id);
    assert.equal(check.pass, false);
    assert.equal(check.evidence.reason, 'ssh-transport-error-cannot-verify');
  }
});

test('verifyCredentialIsolation: missing identity file fails and is never probed over ssh', async () => {
  const { exec, calls } = makeExec(isolatedResponder);
  const fleet = makeFleet({ sshIdentity: '~/.ssh/no-such-key' });
  const res = await verifyCredentialIsolation(fleet, { mode: 'autonomous', _exec: exec, _env: { HOME } });
  assert.equal(res.ok, false);
  const idCheck = res.checks.find((c) => c.id === 'identity-only');
  assert.equal(idCheck.pass, false);
  assert.deepEqual(idCheck.evidence.coresMissingIdentity, ['core-1']);
  for (const id of ['sudo-refused:core-1', 'no-verbatim-exec:core-1']) {
    assert.equal(res.checks.find((c) => c.id === id).evidence.reason, 'identity-missing-not-probed');
  }
  assert.equal(calls.filter((c) => c.file === 'ssh').length, 0, 'must not ssh without a pinned identity');
});

test('verifyCredentialIsolation: S6 — checks carry aliases only, never host/user/key-path', async () => {
  const { exec } = makeExec((call) => {
    if (call.file === 'ssh') return { code: 255, stderr: `connect to ${SENTINEL_HOST}: refused\n` };
    return isolatedResponder(call);
  });
  const res = await verifyCredentialIsolation(makeFleet(), { mode: 'autonomous', _exec: exec, _env: { HOME } });
  const serialized = JSON.stringify(res);
  assert.ok(!serialized.includes(SENTINEL_HOST), 'host leaked into checks');
  assert.ok(!serialized.includes(SENTINEL_USER), 'sshUser leaked into checks');
  assert.ok(!serialized.includes('id_harness_readonly'), 'identity path leaked into checks');
  assert.ok(serialized.includes('core-1'), 'cores must be referenced by alias');
});

test('verifyCredentialIsolation: invalid mode throws (config error, not probe result)', async () => {
  await assert.rejects(
    () => verifyCredentialIsolation(makeFleet(), { mode: 'yolo' }),
    /mode must be 'autonomous' or 'interactive'/,
  );
});
