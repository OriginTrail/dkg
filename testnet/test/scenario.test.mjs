// Hermetic tests for lib/scenario.mjs + bin/harness.mjs parseArgs.
// No SSH, no network, no real fleet: fake EdgeClient, injected fakes for every
// cross-module seam (the sibling modules are contract stubs written
// concurrently), and contract-faithful local evaluateGate/computeVerdict
// (scoring.mjs's frozen contract) to fold buildGates output into a verdict.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseArgs, UsageError, formatMonitorTable, sanitizeArgv,
} from '../bin/harness.mjs';
import {
  buildGates, mergePeak, pollVmFinalized, runPublishScenario,
} from '../lib/scenario.mjs';
import { sleep } from '../lib/util.mjs';

// ── contract-faithful local scoring (scoring.mjs frozen contract) ──────────

function localPercentile(values, p) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function localEvaluateGate(gate) {
  const result = { id: gate.id, observed: gate.observed, threshold: gate.threshold };
  if (gate.inconclusiveReason) return { ...result, outcome: 'INCONCLUSIVE' };
  if ((gate.kind === 'percentile' || gate.kind === 'successRate')
      && gate.minSamples != null && (gate.samples ?? 0) < gate.minSamples) {
    return { ...result, outcome: 'INCONCLUSIVE' };
  }
  if (gate.kind === 'percentile'
      && gate.minSuccessRate != null && (gate.successRate ?? 0) < gate.minSuccessRate) {
    return { ...result, outcome: 'INCONCLUSIVE' };
  }
  let pass;
  switch (gate.kind) {
    case 'successRate': pass = gate.observed >= gate.threshold; break;
    case 'percentile':
    case 'max': pass = gate.observed != null && gate.observed <= gate.threshold; break;
    case 'exactZero': pass = gate.observed === 0; break;
    case 'bool': pass = gate.observed === true; break;
    default: throw new Error(`unknown gate kind: ${gate.kind}`);
  }
  return { ...result, outcome: pass ? 'PASS' : 'FAIL' };
}

function localComputeVerdict({ gates, safetyAbort }) {
  if (safetyAbort) return { outcome: 'SAFETY_ABORT', gates };
  if (gates.some((g) => g.outcome === 'FAIL')) return { outcome: 'FAIL', gates };
  if (gates.some((g) => g.outcome === 'INCONCLUSIVE')) return { outcome: 'INCONCLUSIVE', gates };
  return { outcome: 'PASS', gates };
}

// ── fakes ───────────────────────────────────────────────────────────────────

class FakeEvidence {
  constructor() {
    this.records = [];
    this.sidecarRecords = [];
  }

  write(type, record) {
    for (const key of ['host', 'ip', 'sshUser']) {
      if (record && Object.hasOwn(record, key)) throw new Error(`hygiene: forbidden key ${key}`);
    }
    this.records.push({ type, ...record });
  }

  writeSidecar(type, record) {
    this.sidecarRecords.push({ type, ...record });
  }

  ofType(type) {
    return this.records.filter((r) => r.type === type);
  }

  get path() { return '/dev/null'; }
}

const RUN_ID = 'certify-testfake-20260714T000000Z';

// Fake EdgeClient: in-memory job progression. `recover` op keys throw a
// client-side timeout from waitPublishJob but the authoritative KA state is
// VM (the §6 recovery case); `hardFail` keys fail terminally and stay at SWM.
function makeFakeEdge({ recover = new Set(), hardFail = new Set(), phaseDelayMs = 0 } = {}) {
  let jobSeq = 0;
  const jobs = new Map();
  const opKey = (name) => name.slice(name.indexOf(RUN_ID) + RUN_ID.length + 1); // "<lane>-<index>"
  return {
    async status() { return { commit: 'deadbeefcafe0123', name: 'driver-fake' }; },
    async createKnowledgeAsset(p) {
      if (phaseDelayMs) await sleep(phaseDelayMs);
      return { ok: true, name: p.name };
    },
    async shareAsync(p) {
      const jobId = `share-${jobSeq++}`;
      jobs.set(jobId, p);
      return { jobId };
    },
    async waitShareJob() {
      if (phaseDelayMs) await sleep(phaseDelayMs);
      return { status: 'succeeded' };
    },
    async publishAsync(p) {
      const jobId = `pub-${jobSeq++}`;
      jobs.set(jobId, p);
      return { jobId };
    },
    async waitPublishJob({ jobId }) {
      if (phaseDelayMs) await sleep(phaseDelayMs);
      const key = opKey(jobs.get(jobId).name);
      if (recover.has(key)) throw new Error('client poll timed out');
      if (hardFail.has(key)) return { status: 'failed', error: 'quorum exhausted: no ack quorum' };
      return { status: 'confirmed', ual: `did:dkg:base:84532/0xstub/${key}`, txHash: `0x${key}` };
    },
    async knowledgeAssetState({ name }) {
      const key = opKey(name);
      if (hardFail.has(key)) return { memoryLayer: 'SWM', status: 'swm-shared' };
      return {
        memoryLayer: 'VM',
        publishedUal: `did:dkg:base:84532/0xstub/${key}`,
        txHash: `0x${key}`,
      };
    },
  };
}

const fakeMakePayload = ({ runId, lane, index, controlFixtureEvery }) => ({
  quads: `<urn:rfc61:${lane}:${runId}:${index}> <http://schema.org/name> "v${index}" .`,
  subject: `urn:rfc61:${lane}:${runId}:${index}`,
  expectedObject: `"v${index}"`,
  controlFixture: index % controlFixtureEvery === 0,
});

const fakeVerifyReadback = async (edge, { items }) => ({ matched: items.length, mismatches: [] });

const fakeClassify = (e) => {
  const text = String(e?.jobError || e?.stderr || e?.stdout || '').toLowerCase();
  if (text.includes('quorum')) return 'quorum_or_backoff';
  if (text.includes('tim')) return 'timeout';
  throw new Error(`unclassified: ${text}`);
};

function coreEntry(overrides = {}) {
  return {
    alias: 'core-1',
    reachable: true,
    systemd: { activeState: 'active', execMainStartTs: 't0', nRestarts: 0, mainPid: 11 },
    workerPid: 100,
    build: { commit: 'aaaa1111', buildTime: 'b0' },
    rss: 1_000_000,
    cgroup: {
      memoryCurrent: 100, memoryPeak: 150, memoryHigh: 1000, memoryMax: 2000,
      oomKills: 0, psiSomeAvg10: 0,
    },
    listen: { recvQ: 0, backlog: 128, connectProbeOk: true },
    diskFree: { bytes: 100e9, fraction: 0.5 },
    api: { admissionRejected: 0, rpcFailovers: 0, rpcExhaustions: 0 },
    ...overrides,
  };
}

const fakeSnapshotFleet = async (fleet, opts) => ({
  ts: new Date().toISOString(),
  kind: opts?.light ? 'light' : 'full',
  cores: [coreEntry()],
});

const fakeJournalDeltas = async (fleet, cursors) => cursors.map((c) => ({
  alias: c.alias, cursorValid: true, counts: {}, gatedTotal: 0, recordedTotal: 0,
}));

const sameArtifact = (a, b) => a.commit === b.commit
  && a.workerPid === b.workerPid && a.workerStartTs === b.workerStartTs;

const baselineFixture = () => ({
  snapshot: { ts: 't', kind: 'full', cores: [coreEntry()] },
  cursors: [{ alias: 'core-1', cursor: 'c1', valid: true }],
  attested: [{
    alias: 'core-1', commit: 'aaaa1111', buildTime: 'b0',
    workerPid: 100, workerStartTs: 't0', attested: true,
  }],
});

const scenarioFixture = (overrides = {}) => ({
  scenario: 'test-certify',
  lanes: ['public', 'private'],
  cg: { public: 'reuse:pub', private: 'reuse:priv' },
  workload: {
    op: 'publish', waves: 2, perWave: { public: 3, private: 3 },
    controlFixtureEvery: 10, concurrency: 2, arrival: 'closed-loop',
  },
  readback: { where: 'driver', byteExact: true, chunkSize: 25 },
  soakSeconds: 0,
  gates: {
    successRate: { overall: 0.95, perLane: 0.9, minSamples: { overall: 10, perLane: 5 } },
    publishP95Ms: 60000,
    controlFixtures: { mustFinalize: true, mustReadBack: true },
    uniqueUals: true,
    fleet: { coreRestarts: 0, oomKillDelta: 0, gatedSignatures: 0, memoryPeakFraction: 0.9 },
  },
  ...overrides,
});

const policyFixture = () => ({
  trips: { admissionShedWindowSec: { default: 60 } },
  quiesce: { flatCounterConfirmSec: 0, edgeShutdownTimeoutSec: 1 },
  safetyAbort: { cooldownMin: 60 },
});

function baseRunParams(overrides = {}) {
  return {
    scenario: scenarioFixture(),
    fleet: { cores: [{ alias: 'core-1' }] },
    policy: policyFixture(),
    evidence: new FakeEvidence(),
    runId: RUN_ID,
    baseline: baselineFixture(),
    snapshotIntervalMs: 5,
    pollIntervalMs: 5,
    opTimeoutMs: 2000,
    _snapshotFleet: fakeSnapshotFleet,
    _journalSignatureDeltas: fakeJournalDeltas,
    _evaluateTrips: () => [],
    _quiesce: async () => ({ cancelled: 0, edgeShutdown: false, flatConfirmed: true }),
    _makePayload: fakeMakePayload,
    _verifyReadback: fakeVerifyReadback,
    _classifyFailure: fakeClassify,
    _sameArtifact: sameArtifact,
    ...overrides,
  };
}

// ── runPublishScenario: healthy end-to-end ──────────────────────────────────

test('healthy run: op_results, recovery re-scoring, readbacks, PASS verdict', async () => {
  const evidence = new FakeEvidence();
  const edge = makeFakeEdge({ recover: new Set(['public-1']), phaseDelayMs: 3 });
  const tripCalls = [];
  const params = baseRunParams({
    evidence,
    edge,
    _evaluateTrips: (args) => { tripCalls.push(args); return []; },
  });
  const run = await runPublishScenario(params);

  // 2 waves x (3 public + 3 private) = 12 ops, all successful.
  assert.equal(run.opResults.length, 12);
  assert.ok(run.opResults.every((o) => o.outcome === 'success'));
  assert.equal(run.safetyAborted, false);
  assert.deepEqual(run.trips, []);
  assert.equal(run.partial, false);

  // The client-timeout op recovered via authoritative KA state (§6).
  const recovered = run.opResults.find((o) => o.lane === 'public' && o.index === 1);
  assert.equal(recovered.recovered_after_client_error, true);
  assert.equal(recovered.outcome, 'success');
  assert.match(recovered.ual, /^did:dkg:/);
  const others = run.opResults.filter((o) => !(o.lane === 'public' && o.index === 1));
  assert.ok(others.every((o) => o.recovered_after_client_error === false));

  // Per-phase durations + polled-anchor metadata on every op_result.
  for (const o of run.opResults) {
    for (const phase of ['create', 'share', 'publish', 'vm_finalization']) {
      assert.ok(Number.isFinite(o.durations_ms[phase]) && o.durations_ms[phase] >= 0,
        `${o.lane}#${o.index} missing duration ${phase}`);
    }
    assert.equal(o.anchor_meta.poll_interval_ms, 5);
    assert.ok(o.ual);
  }
  // Unique UALs across the run.
  assert.equal(new Set(run.opResults.map((o) => o.ual)).size, 12);

  // Per-wave, per-lane byte-exact readback.
  assert.equal(run.readbacks.length, 4);
  assert.ok(run.readbacks.every((rb) => rb.expected === 3 && rb.matched === 3
    && rb.mismatches.length === 0 && rb.byteExact === true));

  // Evidence stream contents.
  assert.equal(evidence.ofType('op_result').length, 12);
  assert.equal(evidence.ofType('readback_result').length, 4);
  assert.equal(evidence.ofType('journal_signature_deltas').length, 1);
  assert.ok(evidence.ofType('fleet_snapshot').length >= 1);
  assert.ok(evidence.ofType('host_telemetry').length >= 1, 'snapshot loop emitted host telemetry');
  assert.equal(evidence.ofType('safety_abort').length, 0);
  assert.equal(evidence.ofType('soak_start').length, 0); // soakSeconds 0 => skipped

  // Trip evaluation received the documented inputs.
  assert.ok(tripCalls.length >= 1);
  assert.equal(tripCalls[0].edgeWindow.windowSec, 60);
  assert.ok(tripCalls[0].snapshot.cores.length === 1);
  assert.ok(Array.isArray(tripCalls[0].snapshotHistory));

  // Final full snapshot + peak keyed by alias.
  assert.equal(run.finalSnapshot.kind, 'full');
  assert.equal(run.peak['core-1'].alias, 'core-1');
  assert.ok(run.peak['core-1'].maxRss > 0);
  assert.equal(run.peak['core-1'].restartDetected, false);
  assert.equal(run.signatureDeltas.length, 1);
  assert.equal(run.signatureDeltas[0].cursorValid, true);

  // buildGates → evaluateGate → computeVerdict folds to PASS.
  const inputs = buildGates({
    scenario: params.scenario, run, baseline: params.baseline,
    _percentile: localPercentile, _sameArtifact: sameArtifact,
  });
  const ids = inputs.map((g) => g.id);
  for (const id of ['success_rate_overall', 'success_rate_public', 'success_rate_private',
    'publish_p95_ms', 'control_fixtures', 'unique_uals', 'readback_mismatches',
    'fleet_core_restarts', 'fleet_oom_kill_delta', 'fleet_gated_signatures',
    'fleet_memory_peak_fraction']) {
    assert.ok(ids.includes(id), `missing gate ${id}`);
  }
  const verdict = localComputeVerdict({
    gates: inputs.map(localEvaluateGate),
    safetyAbort: run.safetyAborted,
  });
  assert.equal(verdict.outcome, 'PASS');

  // Mid-run SHA change: network-dependent gates become INCONCLUSIVE.
  const changed = buildGates({
    scenario: params.scenario, run, baseline: params.baseline,
    _percentile: localPercentile, _sameArtifact: () => false,
  });
  for (const id of ['success_rate_overall', 'success_rate_public', 'success_rate_private',
    'publish_p95_ms', 'control_fixtures', 'unique_uals', 'readback_mismatches']) {
    assert.equal(changed.find((g) => g.id === id).inconclusiveReason, 'fleet-sha-changed', id);
  }
  assert.equal(changed.find((g) => g.id === 'fleet_core_restarts').inconclusiveReason, undefined);
  const changedVerdict = localComputeVerdict({ gates: changed.map(localEvaluateGate), safetyAbort: false });
  assert.equal(changedVerdict.outcome, 'INCONCLUSIVE');
});

// ── runPublishScenario: hard failure ────────────────────────────────────────

test('hard failure: terminal job failure classified, not recovered, gates FAIL', async () => {
  const evidence = new FakeEvidence();
  const edge = makeFakeEdge({ hardFail: new Set(['public-1']) });
  const scenario = scenarioFixture({
    workload: {
      op: 'publish', waves: 1, perWave: { public: 2, private: 2 },
      controlFixtureEvery: 10, concurrency: 2,
    },
    gates: {
      successRate: { overall: 0.95, perLane: 0.9, minSamples: { overall: 4, perLane: 2 } },
      publishP95Ms: 60000,
      uniqueUals: true,
      fleet: { coreRestarts: 0, oomKillDelta: 0, gatedSignatures: 0, memoryPeakFraction: 0.9 },
    },
  });
  const params = baseRunParams({ evidence, edge, scenario });
  const run = await runPublishScenario(params);

  assert.equal(run.opResults.length, 4);
  const failed = run.opResults.find((o) => o.lane === 'public' && o.index === 1);
  assert.equal(failed.outcome, 'quorum_or_backoff');
  assert.equal(failed.recovered_after_client_error, false);
  assert.equal(failed.ual, null);
  assert.equal(run.opResults.filter((o) => o.outcome === 'success').length, 3);

  // Readback only covers successes: public wave expected 1, private expected 2.
  const publicRb = run.readbacks.find((rb) => rb.lane === 'public');
  assert.equal(publicRb.expected, 1);

  const inputs = buildGates({
    scenario, run, baseline: params.baseline,
    _percentile: localPercentile, _sameArtifact: sameArtifact,
  });
  const verdict = localComputeVerdict({ gates: inputs.map(localEvaluateGate), safetyAbort: false });
  assert.equal(verdict.outcome, 'FAIL'); // 3/4 = 0.75 < 0.95
  assert.equal(inputs.find((g) => g.id === 'success_rate_overall').observed, 0.75);
});

// ── runPublishScenario: S3 trip fires ───────────────────────────────────────

test('trip fires: quiesce runs, safety_abort recorded, partial aborted results', async () => {
  const evidence = new FakeEvidence();
  const edge = makeFakeEdge({ phaseDelayMs: 60 });
  const firedTrip = {
    trip: 'memoryCurrentVsHighFraction', alias: 'core-1', observed: 0.99, threshold: 0.95,
  };
  let tripCalls = 0;
  let quiesceArgs = null;
  const scenario = scenarioFixture({
    workload: {
      op: 'publish', waves: 1, perWave: { public: 2, private: 2 },
      controlFixtureEvery: 10, concurrency: 1,
    },
    soakSeconds: 600, // must be skipped on abort — the test would hang otherwise
  });
  const params = baseRunParams({
    evidence,
    edge,
    scenario,
    snapshotIntervalMs: 5,
    _evaluateTrips: () => (++tripCalls === 1 ? [firedTrip] : []),
    _quiesce: async (q) => {
      quiesceArgs = q;
      for (const handle of q.inflight) await handle.cancel();
      return { cancelled: q.inflight.length, edgeShutdown: false, flatConfirmed: true };
    },
  });
  const run = await runPublishScenario(params);

  assert.equal(run.safetyAborted, true);
  assert.equal(run.partial, true);
  assert.equal(run.trips.length, 1);
  assert.equal(run.trips[0].trip, 'memoryCurrentVsHighFraction');

  // Quiesce saw the in-flight handles, the local edge, and the policy.
  assert.ok(quiesceArgs, 'quiesce was invoked');
  assert.equal(quiesceArgs.edges[0], edge);
  assert.equal(quiesceArgs.policy, params.policy);
  assert.ok(quiesceArgs.inflight.length >= 1);
  assert.equal(typeof quiesceArgs.confirmFlat, 'function');

  // One op per lane was in flight; both settle as harness-quiesce 'aborted'.
  assert.equal(run.opResults.length, 2);
  assert.ok(run.opResults.every((o) => o.outcome === 'aborted'));

  const abortRecords = evidence.ofType('safety_abort');
  assert.equal(abortRecords.length, 1);
  assert.equal(abortRecords[0].trip, 'memoryCurrentVsHighFraction');
  assert.deepEqual(abortRecords[0].quiesce, { cancelled: 2, edgeShutdown: false, flatConfirmed: true });
  assert.equal(evidence.ofType('soak_start').length, 0);
  assert.equal(evidence.ofType('readback_result').length, 0);

  // Final snapshot + deltas still bind the partial evidence.
  assert.equal(run.finalSnapshot.kind, 'full');
  assert.equal(run.signatureDeltas.length, 1);

  // SAFETY_ABORT is terminal regardless of gate outcomes.
  const inputs = buildGates({
    scenario, run, baseline: params.baseline,
    _percentile: localPercentile, _sameArtifact: sameArtifact,
  });
  const verdict = localComputeVerdict({
    gates: inputs.map(localEvaluateGate),
    safetyAbort: run.safetyAborted,
  });
  assert.equal(verdict.outcome, 'SAFETY_ABORT');
});

// ── pollVmFinalized ─────────────────────────────────────────────────────────

test('pollVmFinalized: VM state resolves; deadline yields vm_poll_timeout', async () => {
  const vmEdge = {
    async knowledgeAssetState() {
      return { memoryLayer: 'VM', publishedUal: 'did:dkg:x/1', txHash: '0xa' };
    },
  };
  const done = await pollVmFinalized(vmEdge, { name: 'n', cg: 'c', deadlineMs: Date.now() });
  assert.deepEqual(done, { finalized: true, ual: 'did:dkg:x/1', reservedUal: null, tx: '0xa' });

  const stuckEdge = { async knowledgeAssetState() { return { memoryLayer: 'SWM' }; } };
  const stuck = await pollVmFinalized(stuckEdge, {
    name: 'n', cg: 'c', deadlineMs: Date.now() + 20, intervalMs: 5,
  });
  assert.deepEqual(stuck, { finalized: false, reason: 'vm_poll_timeout' });
});

// ── mergePeak ───────────────────────────────────────────────────────────────

test('mergePeak: peaks, sticky unreachability, attestation restart detection', () => {
  const attested = baselineFixture().attested;
  // null peak → created.
  let peak = mergePeak(null, { cores: [coreEntry()] }, attested, { _sameArtifact: sameArtifact });
  assert.equal(peak['core-1'].maxRss, 1_000_000);
  assert.equal(peak['core-1'].restartDetected, false);
  assert.equal(peak['core-1'].maxMemoryCurrentFraction, 0.1); // 100 / high 1000

  // Unreachable is sticky, but later measurements still merge.
  peak = mergePeak(peak, { cores: [{ alias: 'core-1', reachable: false, error: 'ssh timeout' }] },
    attested, { _sameArtifact: sameArtifact });
  assert.equal(peak['core-1'].reachable, false);
  assert.equal(peak['core-1'].lastError, 'ssh timeout');
  peak = mergePeak(peak, {
    cores: [coreEntry({ rss: 2_000_000, cgroup: { memoryCurrent: 900, memoryHigh: 1000, oomKills: 1 } })],
  }, attested, { _sameArtifact: sameArtifact });
  assert.equal(peak['core-1'].reachable, false, 'unreachability stays sticky');
  assert.equal(peak['core-1'].maxRss, 2_000_000);
  assert.equal(peak['core-1'].maxMemoryCurrentFraction, 0.9);
  assert.equal(peak['core-1'].maxOomKills, 1);

  // A worker pid change vs the baseline attestation flags a restart.
  peak = mergePeak(peak, { cores: [coreEntry({ workerPid: 999 })] }, attested,
    { _sameArtifact: sameArtifact });
  assert.equal(peak['core-1'].restartDetected, true);
});

// ── bin/harness.mjs: parseArgs + helpers ────────────────────────────────────

test('parseArgs: modes, defaults, flags', () => {
  const monitor = parseArgs(['monitor', '--once']);
  assert.equal(monitor.mode, 'monitor');
  assert.equal(monitor.once, true);
  assert.equal(monitor.intervalSec, 10);
  assert.equal(monitor.scenario, 'certify-100');
  assert.ok(monitor.fleet.endsWith('/fleet.json'));
  assert.ok(monitor.policy.endsWith('/policy.json'));
  assert.ok(monitor.runsDir.endsWith('/runs'));
  assert.equal(monitor.runId, null);
  assert.equal(monitor.autonomous, false);
  assert.equal(monitor.json, false);

  const certify = parseArgs([
    'certify', '--scenario', 'certify-100', '--run-id', 'r1', '--interval', '5',
    '--json', '--autonomous', '--fleet', '/tmp/f.json', '--policy', '/tmp/p.json',
    '--runs-dir', '/tmp/runs',
  ]);
  assert.equal(certify.mode, 'certify');
  assert.equal(certify.scenario, 'certify-100');
  assert.equal(certify.runId, 'r1');
  assert.equal(certify.intervalSec, 5);
  assert.equal(certify.json, true);
  assert.equal(certify.autonomous, true);
  assert.equal(certify.fleet, '/tmp/f.json');
  assert.equal(certify.policy, '/tmp/p.json');
  assert.equal(certify.runsDir, '/tmp/runs');
});

test('parseArgs: usage errors carry exitCode 4', () => {
  for (const argv of [[], ['bogus'], ['monitor', '--nope'], ['monitor', '--interval'],
    ['monitor', '--interval', 'zero'], ['monitor', '--interval', '-3'],
    ['monitor', 'baseline'], ['monitor', '--fleet', '--once']]) {
    assert.throws(() => parseArgs(argv), (e) => e instanceof UsageError && e.exitCode === 4,
      JSON.stringify(argv));
  }
});

test('formatMonitorTable: aliases only, unreachable rows degrade per-core', () => {
  const table = formatMonitorTable({
    cores: [
      coreEntry(),
      { alias: 'core-2', reachable: false, error: 'ssh: connect timeout host 10.0.0.9' },
    ],
  });
  assert.match(table, /alias\s+state\s+commit\s+rss\s+mem%\s+recvq\s+disk\s+restarts/);
  assert.match(table, /core-1\s+active\s+aaaa1111\s+1M\s+10%/);
  assert.match(table, /core-2\s+UNREACHABLE/);
  assert.ok(!table.includes('10.0.0.9'), 'raw error text (may carry hosts) never printed');
});

test('sanitizeArgv: path flag values are redacted', () => {
  assert.deepEqual(
    sanitizeArgv(['certify', '--fleet', '/Users/op/fleet.json', '--json', '--policy', '/tmp/p.json']),
    ['certify', '--fleet', '<path>', '--json', '--policy', '<path>'],
  );
});
