#!/usr/bin/env node
// OT-RFC-61 testnet harness CLI — mode dispatch + run lifecycle (§4.1).
// Flags are frozen:
//   harness.mjs <selftest|monitor|baseline|certify> [--scenario <name>]
//     [--fleet <path>] [--policy <path>] [--run-id <id>] [--runs-dir <path>]
//     [--interval <sec>] [--once] [--autonomous] [--json]
//
// Lifecycle (certify): safetyAbortGate → load config/policy/scenario →
// (autonomous ? verifyCredentialIsolation : record interactive) → preflight
// (edges healthy incl. driver /api/status commit attestation; FULL fleet
// reachable+observable — degraded ⇒ INCONCLUSIVE + workload NOT_RUN (§3.3);
// wallets funded; CGs visible) → fleet_baseline + cursors + attestation →
// runPublishScenario → buildGates → computeVerdict (SAFETY_ABORT terminal) →
// run_manifest + run_verdict + verdict.json next to the evidence file →
// exit codes: 0 PASS, 1 FAIL, 2 INCONCLUSIVE, 3 SAFETY_ABORT, 4 usage/config.
//
// monitor: light snapshot loop (--interval, default 10 s; --once for a single
// pass) printing a fixed-width fleet table (alias, state, commit, rss, mem%,
// recvq, disk, restarts) and writing fleet_snapshot records when --run-id given.
// baseline: one full snapshot + cursors + attestation, written as evidence.
// selftest: node --test test/ + validate fleet/policy/scenarios if present.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as config from '../lib/config.mjs';
import { EdgeClient } from '../lib/edge.mjs';
import * as evidenceMod from '../lib/evidence.mjs';
import * as fleetMod from '../lib/fleet.mjs';
import { buildGates, resolveCgMap, runPublishScenario } from '../lib/scenario.mjs';
import * as scoringMod from '../lib/scoring.mjs';
import { sleep } from '../lib/util.mjs';
import * as watchMod from '../lib/watch.mjs';

export const BASE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const USAGE = [
  'usage: harness.mjs <selftest|monitor|baseline|certify>',
  '         [--scenario <name>] [--fleet <path>] [--policy <path>]',
  '         [--run-id <id>] [--runs-dir <path>] [--interval <sec>]',
  '         [--once] [--autonomous] [--json]',
].join('\n');

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = 4;
  }
}

const MODES = ['selftest', 'monitor', 'baseline', 'certify'];
const VALUE_FLAGS = {
  '--scenario': 'scenario',
  '--fleet': 'fleet',
  '--policy': 'policy',
  '--run-id': 'runId',
  '--runs-dir': 'runsDir',
  '--interval': 'intervalSec',
};
const BOOL_FLAGS = { '--once': 'once', '--autonomous': 'autonomous', '--json': 'json' };

/** Parse argv (post-node, post-script). Throws UsageError (exitCode 4). */
export function parseArgs(argv) {
  const out = {
    mode: null,
    scenario: 'certify-100',
    fleet: join(BASE_DIR, 'fleet.json'),
    policy: join(BASE_DIR, 'policy.json'),
    runId: null,
    runsDir: join(BASE_DIR, 'runs'),
    intervalSec: 10,
    once: false,
    autonomous: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      if (out.mode) throw new UsageError(`unexpected argument: ${arg}`);
      if (!MODES.includes(arg)) throw new UsageError(`unknown mode: ${arg}`);
      out.mode = arg;
      continue;
    }
    if (arg in VALUE_FLAGS) {
      const value = argv[++i];
      if (value == null || value.startsWith('--')) throw new UsageError(`${arg} requires a value`);
      if (arg === '--interval') {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) throw new UsageError('--interval must be a positive number of seconds');
        out.intervalSec = n;
      } else {
        out[VALUE_FLAGS[arg]] = value;
      }
    } else if (arg in BOOL_FLAGS) {
      out[BOOL_FLAGS[arg]] = true;
    } else {
      throw new UsageError(`unknown flag: ${arg}`);
    }
  }
  if (!out.mode) throw new UsageError('a mode is required');
  return out;
}

function fmtMb(bytes) {
  return Number.isFinite(bytes) ? `${Math.round(bytes / 1e6)}M` : '-';
}

function fmtGb(bytes) {
  return Number.isFinite(bytes) ? `${(bytes / 1e9).toFixed(1)}G` : '-';
}

/** Fixed-width fleet table (aliases only — S6). Degrades per-core. */
export function formatMonitorTable(snapshot) {
  const cols = [
    ['alias', 10], ['state', 12], ['commit', 10], ['rss', 8],
    ['mem%', 6], ['recvq', 6], ['disk', 8], ['restarts', 8],
  ];
  const row = (values) => values.map((v, i) => String(v).padEnd(cols[i][1])).join(' ');
  const lines = [row(cols.map(([name]) => name))];
  for (const core of snapshot?.cores || []) {
    if (core.reachable === false) {
      lines.push(row([core.alias ?? '?', 'UNREACHABLE', '-', '-', '-', '-', '-', '-']));
      continue;
    }
    const cg = core.cgroup || {};
    const ceiling = Number.isFinite(cg.memoryHigh) && cg.memoryHigh > 0 ? cg.memoryHigh
      : Number.isFinite(cg.memoryMax) && cg.memoryMax > 0 ? cg.memoryMax : null;
    const memPct = ceiling != null && Number.isFinite(cg.memoryCurrent)
      ? `${Math.round((cg.memoryCurrent / ceiling) * 100)}%` : '-';
    lines.push(row([
      core.alias ?? '?',
      core.systemd?.activeState ?? '?',
      String(core.build?.commit ?? '').slice(0, 8) || '-',
      fmtMb(core.rss),
      memPct,
      core.listen?.recvQ ?? '-',
      fmtGb(core.diskFree?.bytes),
      core.systemd?.nRestarts ?? '-',
    ]));
  }
  return lines.join('\n');
}

/** Replace path-flag values so evidence never carries local paths (S6). */
export function sanitizeArgv(argv) {
  const pathFlags = new Set(['--fleet', '--policy', '--runs-dir']);
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    out.push(argv[i]);
    if (pathFlags.has(argv[i]) && i + 1 < argv.length) {
      out.push('<path>');
      i++;
    }
  }
  return out;
}

function harnessVersion() {
  try {
    return JSON.parse(readFileSync(join(BASE_DIR, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ── monitor ─────────────────────────────────────────────────────────────────

export async function cmdMonitor(args, deps = {}) {
  const loadFleet = deps.loadFleet || config.loadFleet;
  const snapshotFleet = deps.snapshotFleet || fleetMod.snapshotFleet;
  const log = deps.log || console.log;
  const sleepFn = deps.sleep || sleep;
  let fleet;
  try {
    fleet = loadFleet(args.fleet);
  } catch (error) {
    console.error(`monitor: cannot load fleet config: ${error.message}`);
    return 4;
  }
  const writer = args.runId
    ? new (deps.EvidenceWriter || evidenceMod.EvidenceWriter)({ runId: args.runId, runsDir: args.runsDir })
    : null;
  for (;;) {
    const snapshot = await snapshotFleet(fleet, { light: true });
    log(formatMonitorTable(snapshot));
    if (writer) {
      writer.write('fleet_snapshot', {
        kind: snapshot.kind ?? 'light',
        snapshotTs: snapshot.ts ?? null,
        cores: snapshot.cores ?? [],
      });
    }
    if (args.once) return 0;
    await sleepFn(args.intervalSec * 1000);
  }
}

// ── baseline ────────────────────────────────────────────────────────────────

export async function cmdBaseline(args, deps = {}) {
  const loadFleet = deps.loadFleet || config.loadFleet;
  const snapshotFleet = deps.snapshotFleet || fleetMod.snapshotFleet;
  const captureJournalCursors = deps.captureJournalCursors || fleetMod.captureJournalCursors;
  const attestBuildIdentity = deps.attestBuildIdentity || fleetMod.attestBuildIdentity;
  const log = deps.log || console.log;
  let fleet;
  try {
    fleet = loadFleet(args.fleet);
  } catch (error) {
    console.error(`baseline: cannot load fleet config: ${error.message}`);
    return 4;
  }
  const runId = args.runId || (deps.makeRunId || evidenceMod.makeRunId)({ phase: 'baseline' });
  const writer = new (deps.EvidenceWriter || evidenceMod.EvidenceWriter)({ runId, runsDir: args.runsDir });
  const snapshot = await snapshotFleet(fleet, { light: false });
  const cursors = await captureJournalCursors(fleet);
  const attested = (snapshot.cores || []).map((core) => attestBuildIdentity(core));
  writer.write('fleet_baseline', { snapshot, cursors, attested });
  log(formatMonitorTable(snapshot));
  log(`baseline evidence: ${writer.path}`);
  return 0;
}

// ── certify ─────────────────────────────────────────────────────────────────

const EXIT_BY_OUTCOME = { PASS: 0, FAIL: 1, INCONCLUSIVE: 2, SAFETY_ABORT: 3 };

export async function cmdCertify(args, deps = {}) {
  const d = {
    loadFleet: config.loadFleet,
    loadPolicy: config.loadPolicy,
    loadScenario: config.loadScenario,
    verifyCredentialIsolation: config.verifyCredentialIsolation,
    snapshotFleet: fleetMod.snapshotFleet,
    captureJournalCursors: fleetMod.captureJournalCursors,
    attestBuildIdentity: fleetMod.attestBuildIdentity,
    loadLedger: fleetMod.loadLedger,
    safetyAbortGate: watchMod.safetyAbortGate,
    recordSafetyAbort: watchMod.recordSafetyAbort,
    evaluateGate: scoringMod.evaluateGate,
    computeVerdict: scoringMod.computeVerdict,
    formatVerdict: scoringMod.formatVerdict,
    EvidenceWriter: evidenceMod.EvidenceWriter,
    makeRunId: evidenceMod.makeRunId,
    buildManifest: evidenceMod.buildManifest,
    EdgeClient,
    runScenario: runPublishScenario,
    buildGates,
    resolveCgMap,
    writeFile: writeFileSync,
    log: console.log,
    error: console.error,
    ...deps,
  };

  // S3: the cooldown gate runs before anything else — a prior SAFETY_ABORT
  // blocks new load-generating runs until cleared.
  const gate = d.safetyAbortGate({ runsDir: args.runsDir });
  if (gate?.blocked) {
    d.error(`certify: blocked by safety-abort cooldown${gate.until ? ` until ${gate.until}` : ''} `
      + '(remove runs/safety-abort.json to clear manually)');
    return 3;
  }

  let fleet;
  let policy;
  let scenarioLoad;
  try {
    fleet = d.loadFleet(args.fleet);
    policy = d.loadPolicy(args.policy);
    scenarioLoad = d.loadScenario(args.scenario, { policy, baseDir: BASE_DIR });
  } catch (error) {
    d.error(`certify: config error: ${error.message}`);
    return 4;
  }
  const scenario = scenarioLoad.scenario;
  const scenarioDigest = scenarioLoad.digest;

  if (!fleet.edges?.driver) {
    d.error('certify: fleet.json has no driver edge configured');
    return 4;
  }

  // Driver edge status first: supplies the sha8 for the run id and the
  // commit-attestation preflight check.
  let edge = null;
  let driverStatus = null;
  let driverStatusError = null;
  try {
    edge = new d.EdgeClient({
      dkgHome: fleet.edges.driver.dkgHome,
      apiPort: fleet.edges.driver.apiPort,
      label: 'driver',
    });
    driverStatus = await edge.status();
  } catch (error) {
    driverStatusError = String(error?.message || error);
  }
  const sha8 = String(driverStatus?.commit || '').slice(0, 8) || undefined;
  const runId = args.runId || d.makeRunId({ phase: 'certify', sha8 });
  const evidence = new d.EvidenceWriter({ runId, runsDir: args.runsDir });

  evidence.write('run_start', {
    mode: 'certify',
    scenario: args.scenario,
    scenarioDigest,
    fleetDigest: fleet.digest ?? null,
    policyDigest: policy.digest ?? null,
    harnessVersion: harnessVersion(),
    argv: sanitizeArgv(['certify', ...process.argv.slice(3)]),
    runMode: args.autonomous ? 'autonomous' : 'interactive',
  });

  // S2: autonomous runs refuse to start without verified credential isolation.
  let credentialIsolation = null;
  if (args.autonomous) {
    credentialIsolation = await d.verifyCredentialIsolation(fleet, { mode: 'autonomous' });
  }

  // Preflight (§4.1/§3.3): full fleet reachable + observable, driver edge
  // healthy with an attested commit. Wallet/CG checks are honestly recorded as
  // skipped in Phase 0 (TODO: S4 wallet/faucet + CG-visibility preflight).
  const baselineSnapshot = await d.snapshotFleet(fleet, { light: false });
  const attested = (baselineSnapshot.cores || []).map((core) => d.attestBuildIdentity(core));
  const checks = [];
  const expectedCores = (fleet.cores || []).length;
  const reachableCores = (baselineSnapshot.cores || []).filter((c) => c.reachable !== false);
  checks.push({
    id: 'fleet_reachable',
    pass: expectedCores > 0 && reachableCores.length === expectedCores,
    evidence: {
      expected: expectedCores,
      reachable: reachableCores.length,
      unreachable: (baselineSnapshot.cores || [])
        .filter((c) => c.reachable === false)
        .map((c) => c.alias),
    },
  });
  checks.push({
    id: 'fleet_build_identity_attested',
    pass: attested.length === expectedCores && attested.every((a) => a.attested === true),
    evidence: attested.map((a) => ({
      alias: a.alias, commit: a.commit ?? null, attested: a.attested === true,
      inconclusiveReason: a.inconclusiveReason ?? null,
    })),
  });
  checks.push({
    id: 'driver_edge_status',
    pass: driverStatus != null,
    evidence: driverStatus
      ? { label: 'driver', commit: driverStatus.commit ?? null }
      : { label: 'driver', error: driverStatusError },
  });
  checks.push({
    id: 'driver_edge_commit_attested',
    pass: Boolean(driverStatus?.commit),
    evidence: { commit: driverStatus?.commit ?? null },
  });
  if (args.autonomous) {
    checks.push({
      id: 'credential_isolation',
      pass: credentialIsolation?.ok === true,
      evidence: credentialIsolation?.checks ?? null,
    });
  }
  checks.push({
    id: 'wallets_funded',
    pass: 'skipped',
    evidence: { todo: 'S4 wallet/faucet preflight not implemented in Phase 0' },
  });
  checks.push({
    id: 'context_graphs_visible',
    pass: 'skipped',
    evidence: { todo: 'CG registration/visibility preflight not implemented in Phase 0' },
  });
  // reuse:<name> CG mappings must resolve via local fleet.json cgs (S6: actual
  // ids stay out of committed files and out of evidence — logical names only).
  let cgMap = null;
  try {
    cgMap = d.resolveCgMap(scenario, fleet);
    checks.push({
      id: 'cg_mapping_resolved',
      pass: true,
      evidence: { lanes: Object.fromEntries(Object.entries(cgMap).map(([l, s]) => [l, s.logical])) },
    });
  } catch (err) {
    checks.push({ id: 'cg_mapping_resolved', pass: false, evidence: { problem: String(err?.message ?? err) } });
  }

  const preflightOk = checks.every((c) => c.pass === true || c.pass === 'skipped');
  evidence.write('preflight', {
    outcome: preflightOk ? 'ok' : 'inconclusive',
    mode: args.autonomous ? 'autonomous' : 'interactive',
    checks,
    edges: { driver: { label: 'driver', commit: driverStatus?.commit ?? null } },
    cores: attested,
  });

  const skipped = checks.filter((c) => c.pass === 'skipped').map((c) => `preflight:${c.id}`);
  const verdictPath = join(args.runsDir, `${runId}.verdict.json`);
  const writeVerdictFile = (body) => d.writeFile(verdictPath, `${JSON.stringify(body, null, 2)}\n`);

  if (!preflightOk) {
    // §3.3: a degraded fleet is not loaded — INCONCLUSIVE, workload NOT_RUN.
    const notRun = [`workload:${args.scenario}`, ...skipped];
    evidence.write('run_verdict', { outcome: 'INCONCLUSIVE', gates: [], notRun, reason: 'preflight_failed' });
    writeVerdictFile({
      scenario: args.scenario,
      run_id: runId,
      outcome: 'INCONCLUSIVE',
      gates: [],
      notRun,
      inconclusive_reasons: checks.filter((c) => c.pass === false).map((c) => c.id),
      evidence: evidence.path,
    });
    d.error(`certify: preflight failed — workload NOT_RUN (verdict: ${verdictPath})`);
    return 2;
  }

  // Baseline: full snapshot + journal cursors + attestation (exact deltas).
  const cursors = await d.captureJournalCursors(fleet);
  const baseline = { snapshot: baselineSnapshot, cursors, attested };
  evidence.write('fleet_baseline', {
    snapshot: {
      kind: baselineSnapshot.kind ?? 'full',
      snapshotTs: baselineSnapshot.ts ?? null,
      cores: baselineSnapshot.cores ?? [],
    },
    cursors,
    attested,
  });

  const ledgerPath = join(BASE_DIR, 'ledger.json');
  const ledger = existsSync(ledgerPath) ? d.loadLedger(ledgerPath) : null;

  const run = await d.runScenario({
    scenario, fleet, policy, edge, evidence, runId, baseline, ledger, cgMap,
  });

  if (run.safetyAborted) {
    d.recordSafetyAbort({ runsDir: args.runsDir, runId, trips: run.trips, policy });
  }

  const gateInputs = d.buildGates({ scenario, run, baseline });
  const gates = gateInputs.map((input) => d.evaluateGate(input));
  const verdict = d.computeVerdict({ gates, safetyAbort: run.safetyAborted });

  const notRun = [...skipped];
  if (run.safetyAborted) notRun.push(`workload-remainder:${args.scenario}`);
  const permanentBytesWritten = (run.opResults || [])
    .filter((o) => o.outcome === 'success')
    .reduce((n, o) => n + (o.bytes || 0), 0);
  const manifest = d.buildManifest({
    attested: { cores: attested, driver: { label: 'driver', commit: driverStatus?.commit ?? null } },
    scenario,
    scenarioDigest,
    fleetDigest: fleet.digest ?? null,
    policyDigest: policy.digest ?? null,
    gates: verdict.gates,
    notRun,
    permanentBytesWritten,
  });
  evidence.write('run_manifest', manifest);
  evidence.write('run_verdict', { outcome: verdict.outcome, gates: verdict.gates, notRun });
  writeVerdictFile({
    scenario: args.scenario,
    run_id: runId,
    outcome: verdict.outcome,
    gates: verdict.gates,
    notRun,
    safety_abort: run.safetyAborted === true,
    trips: run.trips || [],
    evidence: evidence.path,
  });

  if (args.json) {
    d.log(JSON.stringify({ outcome: verdict.outcome, gates: verdict.gates, verdict: verdictPath }, null, 2));
  } else {
    d.log(d.formatVerdict(verdict));
    d.log(`verdict: ${verdictPath}`);
  }
  return EXIT_BY_OUTCOME[verdict.outcome] ?? 1;
}

// ── selftest ────────────────────────────────────────────────────────────────

export async function cmdSelftest(args, deps = {}) {
  const spawnFn = deps.spawn || spawn;
  const log = deps.log || console.log;
  const problems = [];

  const testDir = join(BASE_DIR, 'test');
  if (existsSync(testDir)) {
    // Default discovery (bare `node --test`, cwd = package root): a directory
    // positional is spawned as an entry module on Node >= 22.16 and fails with
    // "Cannot find module .../test", so never pass test/ as an argument.
    const testsOk = await new Promise((resolveP) => {
      const child = spawnFn(process.execPath, ['--test'], { stdio: 'inherit', cwd: BASE_DIR });
      child.on('error', () => resolveP(false));
      child.on('exit', (code) => resolveP(code === 0));
    });
    if (!testsOk) problems.push('node --test failed');
  } else {
    log('selftest: no test/ directory yet (unit tests skipped)');
  }

  // Config validation — only against files that exist; examples as fallback.
  let policy = null;
  const policyPath = existsSync(args.policy) ? args.policy : join(BASE_DIR, 'policy.example.json');
  try {
    policy = config.loadPolicy(policyPath);
    log(`selftest: policy ok (${policyPath === args.policy ? 'policy.json' : 'policy.example.json'})`);
  } catch (error) {
    problems.push(`policy invalid: ${error.message}`);
  }
  const fleetPath = existsSync(args.fleet) ? args.fleet : join(BASE_DIR, 'fleet.example.json');
  try {
    config.loadFleet(fleetPath);
    log(`selftest: fleet ok (${fleetPath === args.fleet ? 'fleet.json' : 'fleet.example.json'})`);
  } catch (error) {
    problems.push(`fleet invalid: ${error.message}`);
  }
  if (policy) {
    try {
      const manifest = JSON.parse(readFileSync(join(BASE_DIR, 'scenarios.json'), 'utf8'));
      for (const name of manifest.scenarios || []) {
        config.loadScenario(name, { policy, baseDir: BASE_DIR });
      }
      log(`selftest: scenarios ok (${(manifest.scenarios || []).join(', ')})`);
    } catch (error) {
      problems.push(`scenario validation: ${error.message}`);
    }
  }

  for (const problem of problems) console.error(`selftest problem: ${problem}`);
  log(problems.length === 0 ? 'selftest: PASS' : 'selftest: FAIL');
  return problems.length === 0 ? 0 : 1;
}

// ── dispatch ────────────────────────────────────────────────────────────────

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      console.error(USAGE);
      return 4;
    }
    throw error;
  }
  switch (args.mode) {
    case 'selftest': return cmdSelftest(args);
    case 'monitor': return cmdMonitor(args);
    case 'baseline': return cmdBaseline(args);
    case 'certify': return cmdCertify(args);
    default: return 4; // unreachable — parseArgs validates the mode
  }
}

// Only run when invoked as a script, so tests can import the exported helpers.
const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => { console.error(err?.stack || String(err)); process.exit(4); });
}
