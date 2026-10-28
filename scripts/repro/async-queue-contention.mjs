#!/usr/bin/env node
// Async queue contention benchmark (OT-RFC-73 P2a/P2b): open-loop share submissions (the route's preflight reads, then
// the real enqueue), the real worker supervisor claiming jobs and replaying the 43-operation share body, closed-loop
// client readers on the background lane, a list observer and an always-on publisher, all on the real default
// scheduler, the real queue and the real Blazegraph adapter against a Blazegraph. The publisher is idle beside a
// share run (--queue share, the default); --queue lift adds open-loop publish submissions into the real
// TripleStoreAsyncLiftPublisher and AsyncLiftRunner (6 wallets) with a synthetic handler for the chain, and --queue
// both runs the two streams together (the mixed cell). --probes and --ack-load add the health-lane status probes and
// the synthetic storage-ACK stream that G0 and G0b ran with. No chain, wallets or funds.
// NOT a CI gate: it needs a Blazegraph the build job does not have, and the knee is host-dependent, so the rung is
// calibrated per host. Needs the built workspace (pnpm run build:packages).
//
//   node scripts/repro/async-queue-contention.mjs run --blazegraph-url URL \
//        (--rung L3 | --calibration FILE [--at reproduction|sub-knee]) [options]
//   node scripts/repro/async-queue-contention.mjs calibrate --blazegraph-url URL \
//        [--ladder L0,L1,..] [--calib-repeats 2] [--out DIR]
//   node scripts/repro/async-queue-contention.mjs verdict --rule halve|flat|equal|noworse|aa|g1b|ledger --a DIR \
//        [--b DIR] [--margin m] [--metric share|publish|pickup|pickupFree] [--min-qualifying N] \
//        [--where history=0,observer=default] [--json]
//
// run options:
//   --queue share|lift|both                  the stream(s): share (default; the publisher idles), publish only, or mixed
//   --history 0|10k|50k [--seed-file FILE]   retained share-job history (a seed file: async-queue-seed-history.mjs)
//   --lift-history 0|10k|50k [--lift-seed-file FILE]   retained publisher-job history (the seed tool's --kind lift)
//   --mu M                                   publish submissions per second (a custom load, see below)
//   --wallets 6 --wallet-hold-ms 3000 --lift-poll-ms 1000   the chain-time model of the publisher (G0b's), --queue
//                                            lift|both only: a wallet is held for the hold while a job "publishes"
//   --probes --ack-load                      the status-probe and ACK load (cadences: --probe-status-ms 10000,
//                                            --probe-metrics-ms 30000, --probe-count-ms 60000, --ack-interval-ms 4000,
//                                            --ack-payload 32); off by default, ON in every G0/G0b and G1b-rehearsal run.
//                                            A probe cadence of 0 switches that probe off: the run's validity then asks
//                                            no evidence of it (statusProbesOff, metricsProbesOff in the result)
//   --observer default|paged|none            the list observer's call; --observer-ms 5000 its polling period. paged
//                                            needs the paged call of each stream the run has (the share queue's:
//                                            P8a/P9b, the publisher's: P9a/P9b): a --queue lift run needs only the
//                                            publisher's
//   --repeats N                              N repeats, one fresh process each; --repeat I runs only repeat I
//   --seed S                                 default seed-base+repeat: a repeat is the same arrival schedule in every build;
//   --seed-base B                            B+repeat for each repeat (default 7300; the G1b rehearsal uses 20262901,
//                                            the G0b seeds)
//   --warmup 30 --measure 180 --cooldown 10 seconds; with --calibration these default to the calibration's own windows
//                                            (its knee was measured with them); other values are flagged in the run's
//                                            meta and in the verdict. calibrate uses the run defaults, so the rung it
//                                            picks is the rung a run sees
//   --label --role --backend-note TEXT       recorded in the run's meta
//   --namespace-prefix aqc --keep-namespace  the run creates and drops its own namespace
//   --out DIR                                default .dkg-repro-reports/async-queue-contention/<timestamp>
//   --dry                                    check imports and config only
//   --lambda L --mu M --content N --aggregate N   a custom load instead of a rung (content, aggregate and the rate of
//                                            each stream the queue runs)
//   --rung: the share ladder L0..L5 (--queue share), and G0b's levels PSTAR (publish only, mu 0.8), MIX (mixed, lambda 4
//   and mu 0.4) and PLOW (publish only, mu 0.4). calibrate covers the share ladder only; a publish ladder is declared in
//   the G2 protocol and run with --mu.
// Counts and seeds are plain integers; a bad value exits 2.
//
// Latency is intended arrival to response, censored at 20 s; every non-success and every client timeout is a failure.
// Exit codes: 0 ok/pass, 1 fail, 2 usage or incomplete, 3 refused backend.
// Small-host cell: DKG_STORE_MAX_CONCURRENT=2 (recorded under meta.env). Scheduler warnings are counted, not printed.
// A run is valid only if the measure window saw requests (measurementObserved), the worker side did its job
// (workerContractOk, dataPlaneReplayed), the load drained, every admission write the queue left running past its caller's
// deadline settled before the ground truth was read (admissionsSettled), and a seed file hashed as its manifest says.
// The P8c backlog leg reads the largest active backlog of the whole workload (warmup to cooldown); worker.backlog stays
// the measurement window's. The P8c claimNext windows (first and last 5 min) are anchored to that same workload
// horizon, never to when the run ended: claims after it are shutdown, not workload. meta.timing records the horizon,
// the drain after it and the run's total, apart from every window. A run with a publisher stream must also show its own
// evidence: requests in the window, no runner error, jobs claimed AND finalized (a run whose claimed jobs all fail has
// no runner error either), at most 2 % of the claimed jobs failed and at most one per wallet left unfinished, the
// handler's work matching the jobs finished (publisherBodyReplayed), no retried or recovered job (the handler never
// fails, and a record keeps its last claim only), and the probes and ACKs that were switched on having run.
//
// Publisher metrics (summary.publish, plan D-15/D-16, see pickup.mjs): pick-up is accepted -> first claim over the jobs
// accepted in the measure window, the run's value its p50, a job nobody claimed by the end of the run right-censored
// there (G0b's and G1b's number). Worker-free pick-up (D-16, G2/G3) is ready -> claimed (ready = the latest of
// acceptedAt, lastRetriedAt, lastRecoveredAt) over the jobs that became ready while at least one of the N wallets held
// no wallet lock; the busy intervals are the wallet-lock writes and deletes (the product's claim trace, never job
// finish times), and workerFree.nQualifying is the sample behind it. The accepted-but-unclaimed backlog and the
// claim-to-finish time are reported next to both, with no threshold: in the ledger (two columns after the pick-up ones)
// and under every `verdict --metric pickup|pickupFree` result (text lines, and `companions` in the JSON of the rules
// and of aa), whatever the result. The probe and ACK numbers are what the caller saw
// (queue wait included); the ACK queue-wait P95 of G2 comes from the product's per-lane counts, not from here.
//
// Runbook. Backend: a Blazegraph that YOU started (never reuse someone else's container); the script only takes a URL
// and refuses non-loopback hosts, e.g.
//   docker run -d --name <your-name> --cpus 3 --memory 2g --memory-swap 2g \
//     -e TOMCAT_JAVA_OPTS='-Xms512m -Xmx1280m' -p 127.0.0.1:19554:8080 <image of blazegraph-image.json>
//   URL=http://127.0.0.1:19554/bigdata/namespace/kb/sparql    (every run creates and drops its own namespace)
// 1. calibrate on the base build, once per host (history 0, observer default):
//      node scripts/repro/async-queue-contention.mjs calibrate --blazegraph-url $URL --out $OUT/calib
// 2. A/A noise at the calibrated rung: the same build twice, 3 repeats each; the margin is declared before the A/B:
//      node ... run --blazegraph-url $URL --calibration $OUT/calib/calibration.json --label aa-1 --repeats 3 \
//           --out $OUT/aa-1                                                              (and aa-2)
//      node ... verdict --rule aa --a $OUT/aa-1 --b $OUT/aa-2                            # prints {"margin": ...}
//    exit 0 only with 3 valid paired repeats per cell, a finite margin AND one build in both arms: an A/A pair with a
//    P95 of 0 against a nonzero one (the same for the number --metric picks, step 6) deviates without bound, and runs
//    from different commits (or a clean and a dirty tree of one) are not noise, and a run with no recorded git sha /
//    dirty flag is no evidence of one build: each is INCOMPLETE (exit 2, margin null, the reason in the output). The A/B
//    rules below still compare two revisions.
// 3. A/B: run THIS script file from the base and the head worktree (rebuild each worktree's packages first), same
//    calibration file, same flags and env except the knob under test, alternating base and head per repeat (ABBA):
//      node ... verdict --rule halve --a $OUT/base --b $OUT/head                         # G1 from P4: b/a <= 0.5
//      node ... verdict --rule equal --a $OUT/base --b $OUT/head --margin <from step 2>  # AC2 path off
//    verdict only counts a pair whose two runs share windows, load, arrival seed, observer period, calibration, seed
//    file and host (CPU count, platform, CPU model and a hash of the hostname; plan 8.3: identical flags; a summary that
//    predates the last three cannot be confirmed to be one host and is warned about), and a rule needs 3 valid paired
//    repeats in EVERY cell (history, observer, rung) with a run in either arm, a cell with none is incomplete and named:
//    use --where to judge one cell; it lists what else it saw.
// 4. AC5, history cells (observer default and paged), 3 repeats each; then verdict --rule flat (b/a <= 1.25 in 3/3):
//      node scripts/repro/async-queue-seed-history.mjs --jobs 50k --out $OUT/seed-50k.nq.gz
//      node ... run --calibration ... --history 0 --label h0 --repeats 3 ...
//      node ... run --calibration ... --history 50k --seed-file $OUT/seed-50k.nq.gz --label h50k --repeats 3 ...
//      node ... verdict --rule flat --a $OUT/h0 --b $OUT/h50k --where observer=default
//    --a must hold history 0 runs only and --b history 50k runs only: swapped or equal arms are INCOMPLETE, not a pass.
// 5. Put `verdict --rule ledger --a ... --b ...` in the PR: every run is listed (worker counters and the P8c indicator
//    included), a discarded run with its failed checks. Two valid runs of one cell are ambiguous and the pair does not
//    count: delete the one that is not meant to count, it stays in the PR.
// 6. Publisher and mixed cells. Declare the load (a rung above or --mu), run the same flags in both arms with
//    --probes --ack-load as G0 and G0b did, and judge the publisher's numbers with the same rules, --metric picking the
//    number: share (the share P95, the default), publish (the publish P95), pickup (D-15) or pickupFree (D-16):
//      node ... run --blazegraph-url $URL --queue both --rung MIX --probes --ack-load --label base --repeats 3 ...
//      node ... verdict --rule aa    --metric pickup --a $OUT/aa-1 --b $OUT/aa-2        # the pick-up's own noise margin
//      node ... verdict --rule halve --metric pickupFree --min-qualifying 20 --a $OUT/base --b $OUT/head
//      node ... verdict --rule noworse --metric publish --margin <A/A> --a $OUT/base --b $OUT/head   # G2's guardrail
//    pickupFree needs --min-qualifying: the protocol states how many qualifying jobs an arm needs, and a run below it is
//    INCOMPLETE (so is one whose wallet trace recorded nothing). Both pick-up metrics print the claim-to-finish p50 and
//    the unclaimed max of each pair under the result (D-16), judged by nothing. Cells of other streams never pair: the
//    stream joins the cell key, as does a lift history.
// 7. Publisher history (AC5's publisher flatness, G2's 10k lift jobs), 3 repeats each, then flat on the publish P95:
//      node scripts/repro/async-queue-seed-history.mjs --kind lift --jobs 10k --out $OUT/lift-10k.nq.gz
//      node ... run --queue lift --rung PSTAR --lift-history 0 --label l0 --repeats 3 ...
//      node ... run --queue lift --rung PSTAR --lift-history 10k --lift-seed-file $OUT/lift-10k.nq.gz --label l10k \
//           --repeats 3 ...
//      node ... verdict --rule flat --metric publish --a $OUT/l0 --b $OUT/l10k
//    --a must hold lift history 0 only and --b ONE non-zero lift history. G2's seeded cell is both histories at once
//    (--history 50k --seed-file ... --lift-history 10k --lift-seed-file ...) from one seed file of each kind; flat then
//    judges it twice over the same two arms, --a empty in both histories: the share P95 (b must be history 50k, the
//    default metric) and --metric publish (b one lift history).
// 8. G1b REHEARSAL, not the D-15 G1b. The plan fixes G1b to harness 0.9 (adapted only to set the P3 env and drive the
//    P4/P5 tagging, backend limited to 3 CPUs); this benchmark is another instrument (P2a's share replay and fixture, no
//    backend CPU gate), so what follows rehearses G0b's cells here and says nothing about P14: a PASS or a MISS neither
//    releases nor stops it. G0b's two-publisher-slot cells, the same five seeds (20262901 + repeat), the path on (the P3
//    env at the S1 geometry), probes and ACK on, fixed rungs (no calibration), 5 repeats of each of G0b's three cells:
//      DKG_STORE_CONTROL_RESERVED_SLOTS=share:1,publisher:2 node ... run --blazegraph-url $URL --queue share --rung L3 \
//           --probes --ack-load --seed-base 20262901 --repeats 5 --out $OUT/g9L3
//      (same env and flags)  node ... run --blazegraph-url $URL --queue both --rung MIX ... --out $OUT/g9mix
//      (same env and flags)  node ... run --blazegraph-url $URL --queue lift --rung PSTAR ... --out $OUT/g9pub
//      node ... verdict --rule g1b --a $OUT        # one directory holding the three cells; labelled a rehearsal
//    g1b checks each run's setup against G0b's (windows, observer, loads, wallets, seed) and that the run recorded the
//    path on (DKG_STORE_CONTROL_RESERVED_SLOTS at share:1,publisher:2: unset, 0, malformed or another geometry is
//    non-conforming), and takes the median of the five repeats against the G0b medians: share P95 within 25 %, pick-up
//    within 25 % or 0.5 s, whichever is larger. A missing, invalid or non-conforming repeat is INCOMPLETE.
//    This process never configures the control path with a backend or a node config (only the daemon does, OT-RFC-73
//    P14), so it honours DKG_STORE_CONTROL_RESERVED_SLOTS alone: unset runs the path OFF here, although a daemon on
//    Blazegraph with more than 2 CPUs has it on by default. Set the variable explicitly in every arm (0 for off).
//
// Not modelled (see fixture.mjs, publisher.mjs): the preflight's O(catalog) list leg, the readiness wait and the chain
// rescue, the real chain (the publisher waits a fixed hold), publisher retries.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { REPO_ROOT, loadDist, provenance, resolveEndpoint, withNamespace } from './async-queue-contention/backend.mjs';
import { seedMainNamespace } from './async-queue-contention/fixture.mjs';
import { G1B_METRICS, g1b } from './async-queue-contention/g1b.mjs';
import { loadGenerated, loadSeedFile, parseCount } from './async-queue-contention/history.mjs';
import { loadGeneratedLift } from './async-queue-contention/lift-history.mjs';
import { jobRow, publishSummary } from './async-queue-contention/pickup.mjs';
import {
  LOAD_DEFAULTS,
  PROBE_DRAIN_MS,
  backgroundLoadEvidence,
  startAckLoad,
  startProbeLoad,
} from './async-queue-contention/probes.mjs';
import {
  LIFT_DEFAULTS,
  LIFT_OBSERVER_CALLS,
  createLiftSide,
  createPublishPreflight,
  pagedObserverProblem,
  publishArrivals,
  readLiftJobs,
  startPublishProducers,
} from './async-queue-contention/publisher.mjs';
import {
  FAMILIES,
  PUBLISH_RUNGS,
  RUNGS,
  aaDeclaration,
  admissionSummary,
  companionLines,
  companionsOf,
  equivalent,
  extractRecord,
  finalizeRequests,
  flat,
  groundTruth,
  guards,
  halve,
  integrityWarnings,
  kneeReached,
  ledgerMarkdown,
  median,
  noWorse,
  p8cOfRun,
  pairKey,
  pairRuns,
  pickReproductionRung,
  summarize,
  validity,
  withMetric,
} from './async-queue-contention/verdict.mjs';
import {
  OBSERVER_CALLS,
  beginEpoch,
  createIdlePublisher,
  createWorker,
  makePreflight,
  readShareJobs,
  reconcileAdmissions,
  sleepUntil,
  startObserver,
  startReaders,
  startShareProducers,
  trackAdmissionWork,
  within,
} from './async-queue-contention/workload.mjs';

const SELF = fileURLToPath(import.meta.url);
const LIB = path.join(path.dirname(SELF), 'async-queue-contention');
const SCRIPT_FILES = [
  SELF,
  path.join(path.dirname(SELF), 'async-queue-seed-history.mjs'),
  ...readdirSync(LIB)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => path.join(LIB, f)),
];
const str = { type: 'string' };
const bool = { type: 'boolean' };
const OPTIONS = {
  'blazegraph-url': str,
  'allow-remote-backend': bool,
  'namespace-prefix': str,
  'keep-namespace': bool,
  'backend-note': str,
  label: str,
  role: str,
  out: str,
  dry: bool,
  rung: str,
  lambda: str,
  content: str,
  aggregate: str,
  calibration: str,
  at: str,
  history: str,
  'seed-file': str,
  observer: str,
  'observer-ms': str,
  repeat: str,
  repeats: str,
  seed: str,
  warmup: str,
  measure: str,
  cooldown: str,
  ladder: str,
  'calib-repeats': str,
  rule: str,
  a: str,
  b: str,
  margin: str,
  where: str,
  json: bool,
  queue: str,
  mu: str,
  'lift-history': str,
  'lift-seed-file': str,
  wallets: str,
  'wallet-hold-ms': str,
  'lift-poll-ms': str,
  probes: bool,
  'ack-load': bool,
  'probe-status-ms': str,
  'probe-metrics-ms': str,
  'probe-count-ms': str,
  'ack-interval-ms': str,
  'ack-payload': str,
  'seed-base': str,
  metric: str,
  'min-qualifying': str,
};
const QUEUES = ['share', 'lift', 'both'];
/**
 * Windows in seconds [warmup, measure, cooldown]: the defaults of run AND calibrate, so a calibrated knee is the knee a
 * run sees.
 */
const DEFAULT_WINDOWS_S = [30, 180, 10];
/**
 * Flags that decide what one calibration run is: calibrate sets them itself and refuses them, or they would override
 * the rung of every child.
 */
const CALIBRATE_OWNS = [
  'calibration',
  'at',
  'rung',
  'lambda',
  'mu',
  'content',
  'aggregate',
  'history',
  'seed-file',
  'queue',
  'lift-history',
  'lift-seed-file',
  'observer',
  'repeat',
  'repeats',
  'seed',
  'dry',
];

const die = (code, msg) => {
  console.error(msg);
  process.exit(code);
};
const out1 = (obj) => writeSync(1, `${JSON.stringify(obj)}\n`); // synchronous: the process exits right after
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const num = (v, d) => (v === undefined ? d : Number(v));

/**
 * A plain non-negative integer flag (decimal digits only), or `fallback` when absent; anything else is a usage error.
 */
function intFlag(v, name, fallback, min = 0) {
  const raw = v[name];
  if (raw === undefined) return fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min) die(2, `--${name} must be an integer >= ${min} (got ${raw})`);
  return n;
}

function readJson(file, what) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return die(2, `cannot read the ${what} ${file}: ${e.message}`);
  }
}

let cmd;
let values;
try {
  cmd = process.argv[2];
  ({ values } = parseArgs({ args: process.argv.slice(3), options: OPTIONS, strict: true }));
} catch (e) {
  die(2, `${e.message}\nusage: async-queue-contention.mjs run|calibrate|verdict [options] (see the header comment)`);
}

// ---------------------------------------------------------------- configuration
const windowsFor = (v, d) => ({
  warmup: num(v.warmup, d[0]),
  measure: num(v.measure, d[1]),
  cooldown: num(v.cooldown, d[2]),
});

function checkWindows({ warmup, measure, cooldown }) {
  const ok = [warmup, measure, cooldown].every((x) => Number.isFinite(x) && x >= 0) && measure > 0;
  if (!ok) die(2, '--warmup, --measure and --cooldown are seconds (measure > 0)');
}

/** The probe and ACK load of a run as the cell records it (null cadences while a load is off). */
function loadFactorsOf(v) {
  const probes = Boolean(v.probes);
  const ack = Boolean(v['ack-load']);
  const cadences = [
    ['probe-status-ms', probes],
    ['probe-metrics-ms', probes],
    ['probe-count-ms', probes],
    ['ack-interval-ms', ack],
    ['ack-payload', ack],
  ];
  for (const [flag, on] of cadences)
    if (v[flag] !== undefined && !on) die(2, `--${flag} needs ${flag.startsWith('probe') ? '--probes' : '--ack-load'}`);
  return {
    probes,
    ack,
    statusMs: probes ? intFlag(v, 'probe-status-ms', LOAD_DEFAULTS.statusMs) : null,
    metricsMs: probes ? intFlag(v, 'probe-metrics-ms', LOAD_DEFAULTS.metricsMs) : null,
    countMs: probes ? intFlag(v, 'probe-count-ms', LOAD_DEFAULTS.countMs) : null,
    ackMs: ack ? intFlag(v, 'ack-interval-ms', LOAD_DEFAULTS.ackMs, 1) : null,
    ackPayload: ack ? intFlag(v, 'ack-payload', LOAD_DEFAULTS.ackPayload, 1) : null,
  };
}
const NO_LOAD = loadFactorsOf({});

/**
 * A retained-history seed file's manifest, checked against the kind and job count the flags asked for. `what` names the
 * file in messages, `historyFlag` the count flag it must agree with.
 */
function seedManifest(file, { what, historyFlag, kind, jobs }) {
  if (!existsSync(file)) die(2, `the ${what} ${file} does not exist`);
  const manifest = readJson(`${file}.json`, `${what} manifest`);
  if (manifest.kind !== undefined && manifest.kind !== kind)
    die(2, `the ${what} ${file} holds ${manifest.kind} jobs, not ${kind}`);
  if (manifest.jobs !== jobs) die(2, `--${historyFlag} ${jobs} does not match the ${what} (${manifest.jobs} jobs)`);
  return { path: path.resolve(file), sha256: manifest.sha256, jobs: manifest.jobs, baseTime: manifest.baseTime };
}

const countLabel = (n) => (n === 0 ? '0' : n % 1000 === 0 ? `${n / 1000}k` : String(n));

function resolveConfig(v) {
  if (v.at !== undefined && !['reproduction', 'sub-knee'].includes(v.at))
    die(2, '--at must be reproduction or sub-knee');
  const queue = v.queue ?? 'share';
  if (!QUEUES.includes(queue)) die(2, `--queue must be ${QUEUES.join(', ')}`);
  const withShare = queue !== 'lift';
  const withLift = queue !== 'share';
  let base = null;
  let calibration = null;
  let windowDefaults = DEFAULT_WINDOWS_S;
  if (v.calibration) {
    const cal = readJson(v.calibration, 'calibration');
    const which = v.at === 'sub-knee' ? 'sub-knee' : 'reproduction';
    const id = which === 'sub-knee' ? cal.subKneeRung : cal.reproductionRung;
    if (!id) die(2, `the calibration has no ${which} rung (status ${cal.status}); pass --rung instead`);
    base = cal.rungs?.find((r) => r.id === id) ?? die(2, `the calibration lists no rung ${id}`);
    if (cal.windows)
      windowDefaults = [cal.windows.warmupMs / 1000, cal.windows.measureMs / 1000, cal.windows.cooldownMs / 1000];
    calibration = {
      file: path.resolve(v.calibration),
      sha256: sha256(v.calibration),
      windowsMs: cal.windows ?? null,
      factors: cal.factors ?? NO_LOAD,
    };
  } else if (v.rung) {
    base =
      [...RUNGS, ...PUBLISH_RUNGS].find((r) => r.id === v.rung) ??
      die(2, `unknown rung ${v.rung} (${[...RUNGS, ...PUBLISH_RUNGS].map((r) => r.id).join(', ')})`);
  }
  const custom = [v.lambda, v.mu, v.content, v.aggregate].some((x) => x !== undefined);
  const needs = [
    ['lambda', v.lambda, withShare],
    ['content', v.content, true],
    ['aggregate', v.aggregate, true],
    ['mu', v.mu, withLift],
  ].filter(([, , needed]) => needed);
  if (!base && needs.some(([, x]) => x === undefined)) {
    die(2, `give --rung, --calibration or all of ${needs.map(([k]) => `--${k}`).join(' ')}`);
  }
  const lambda = num(v.lambda, base?.lambda ?? 0);
  const mu = num(v.mu, base?.mu ?? 0);
  const content = num(v.content, base?.content);
  const aggregate = num(v.aggregate, base?.aggregate);
  if (![lambda, mu, content, aggregate].every((x) => Number.isFinite(x) && x >= 0) || (withShare && !(lambda > 0))) {
    die(2, 'lambda must be positive; content and aggregate must be non-negative numbers');
  }
  if (withLift && !(mu > 0)) {
    die(
      2,
      `--queue ${queue} needs a positive publish rate mu (--mu, or a rung with publish arrivals: ${PUBLISH_RUNGS.map((r) => r.id).join(', ')})`,
    );
  }
  if (!withLift && mu > 0) die(2, `the load has publish arrivals (mu ${mu}): use --queue lift or --queue both`);
  if (!withShare && lambda > 0) die(2, `the load has share arrivals (lambda ${lambda}): use --queue both`);
  const historyJobs = parseCountOrDie(v.history ?? '0', '--history');
  if (!withShare && historyJobs > 0) die(2, '--history seeds the share queue: a --queue lift run has none');
  if (v['seed-file'] && !withShare) die(2, '--seed-file seeds the share queue: a --queue lift run has none');
  const seedFile = v['seed-file']
    ? seedManifest(v['seed-file'], { what: 'seed file', historyFlag: 'history', kind: 'share', jobs: historyJobs })
    : null;
  const liftHistoryJobs = parseCountOrDie(v['lift-history'] ?? '0', '--lift-history');
  const liftSeedFile = v['lift-seed-file']
    ? seedManifest(v['lift-seed-file'], {
        what: 'lift seed file',
        historyFlag: 'lift-history',
        kind: 'lift',
        jobs: liftHistoryJobs,
      })
    : null;
  const liftFlags = ['wallets', 'wallet-hold-ms', 'lift-poll-ms'].filter((k) => v[k] !== undefined);
  if (!withLift && liftFlags.length)
    die(2, `--${liftFlags.join(', --')} apply to --queue lift or both (the idle publisher of a share run is fixed)`);
  const liftModel = withLift
    ? {
        wallets: intFlag(v, 'wallets', LIFT_DEFAULTS.wallets, 1),
        walletHoldMs: intFlag(v, 'wallet-hold-ms', LIFT_DEFAULTS.walletHoldMs),
        liftPollMs: intFlag(v, 'lift-poll-ms', LIFT_DEFAULTS.pollMs, 1),
      }
    : null;
  const loadFactors = loadFactorsOf(v);
  const observer = v.observer ?? 'default';
  const repeat = intFlag(v, 'repeat', 0);
  const seed = intFlag(v, 'seed', intFlag(v, 'seed-base', 7300) + repeat);
  const observerMs = intFlag(v, 'observer-ms', 5000, 1);
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(v['namespace-prefix'] ?? 'aqc'))
    die(2, '--namespace-prefix must match [A-Za-z0-9._-]{1,40}');
  if (!(observer in OBSERVER_CALLS) && observer !== 'none')
    die(2, `unknown --observer ${observer} (default, paged, none)`);
  const pagedProblem = observer === 'paged' ? pagedObserverProblem({ withShare, withLift }) : null;
  if (pagedProblem) die(2, pagedProblem);
  const windows = windowsFor(v, windowDefaults);
  checkWindows(windows);
  const windowsMs = [windows.warmup * 1000, windows.measure * 1000, windows.cooldown * 1000];
  if (calibration?.windowsMs) {
    const cal = calibration.windowsMs;
    calibration.windowsDiffer = [cal.warmupMs, cal.measureMs, cal.cooldownMs].some((x, i) => x !== windowsMs[i]);
  }
  if (calibration) calibration.factorsDiffer = JSON.stringify(calibration.factors) !== JSON.stringify(loadFactors);
  return {
    label: v.label ?? null,
    role: v.role ?? null,
    queue,
    rung: custom ? `custom-l${lambda}${withLift ? `-m${mu}` : ''}-c${content}-a${aggregate}` : base.id,
    lambda,
    mu,
    content,
    aggregate,
    history: countLabel(historyJobs),
    historyJobs,
    liftHistory: countLabel(liftHistoryJobs),
    liftHistoryJobs,
    observer,
    observerMs,
    seedFile,
    liftSeedFile,
    liftModel,
    loadFactors,
    calibration,
    repeat,
    seed,
    warmupMs: windowsMs[0],
    measureMs: windowsMs[1],
    cooldownMs: windowsMs[2],
    backendNote: v['backend-note'] ?? null,
    namespacePrefix: v['namespace-prefix'] ?? 'aqc',
    keep: Boolean(v['keep-namespace']),
    ...liftModel,
  };
}

function parseCountOrDie(value, flag) {
  try {
    return parseCount(value);
  } catch (e) {
    return die(2, `${flag}: ${e.message}`);
  }
}

/** The flags of this invocation re-serialised for a child process, with overrides (undefined removes a flag). */
function childArgs(v, overrides) {
  const merged = { ...v, ...overrides };
  return Object.entries(merged).flatMap(([k, x]) => {
    if (x === undefined || x === false) return [];
    return x === true ? [`--${k}`] : [`--${k}`, String(x)];
  });
}

function spawnRun(args) {
  const res = spawnSync(process.execPath, [SELF, 'run', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 << 20,
  });
  const line = (res.stdout ?? '').split('\n').filter(Boolean).pop();
  let result = null;
  try {
    result = JSON.parse(line);
  } catch {
    /* the child printed no result line */
  }
  return { status: res.status ?? 1, result };
}

const defaultOut = () =>
  path.join(REPO_ROOT, '.dkg-repro-reports', 'async-queue-contention', new Date().toISOString().replace(/[:.]/g, '-'));

// ---------------------------------------------------------------- run
async function runCommand(v) {
  const c = resolveConfig(v);
  const outDir = path.resolve(v.out ?? defaultOut());
  const repeats = intFlag(v, 'repeats', 1, 1);
  if (repeats > 1) {
    // the scheduler singleton, the share mutex map and the admission coordinators are process-wide: one fresh process
    // per repeat
    let worst = 0;
    for (let i = 0; i < repeats; i++) {
      const { status, result } = spawnRun(
        childArgs(v, { repeats: undefined, repeat: i, seed: v.seed, out: path.join(outDir, `r${i}`) }),
      );
      if (result) out1(result);
      worst = Math.max(worst, status);
      if (status === 2 || status === 3) break; // a usage or backend refusal repeats identically
    }
    process.exit(worst);
  }
  let endpoint;
  if (!v.dry) {
    try {
      endpoint = resolveEndpoint({ url: v['blazegraph-url'], allowRemote: v['allow-remote-backend'] });
    } catch (e) {
      die(e.exitCode ?? 3, e.message);
    }
  }
  const dist = await loadDist();
  if (v.dry) {
    out1({ dry: true, config: c, provenance: provenance(SCRIPT_FILES), out: outDir });
    process.exit(0);
  }
  if (c.calibration?.windowsDiffer) {
    console.error(
      "warning: the windows of this run differ from the calibration's (recorded in meta.calibration.windowsDiffer)",
    );
  }
  const summary = await runOnce(c, dist, endpoint, outDir);
  out1({
    runId: summary.meta.runId,
    out: outDir,
    p95Ms: summary.submission.latencyMs?.p95 ?? null,
    F: summary.submission.F,
    ...(summary.publish
      ? {
          publishP95Ms: summary.publish.latencyMs?.p95 ?? null,
          publishF: summary.publish.F,
          pickupP50Ms: summary.publish.pickup?.p50 ?? null,
        }
      : {}),
    valid: summary.validity.ok,
  });
  process.exit(0);
}

const NOOP = {
  stop() {},
  async drain() {
    return 0;
  },
};

async function runOnce(c, dist, endpoint, outDir) {
  const { storage, core, pub, utils } = dist;
  const prov = provenance(SCRIPT_FILES);
  const warn = console.warn;
  const runTag = `run${randomBytes(3).toString('hex')}`;
  const runId = `${c.label ?? 'run'}-${c.rung}-r${c.repeat}-${Date.now().toString(36)}`;
  const useShare = c.queue !== 'lift';
  const useLift = c.queue !== 'share';
  const host = {
    cpus: os.cpus().length,
    loadavgStart: os.loadavg().map((x) => Math.round(x * 100) / 100),
    platform: `${process.platform}-${process.arch}`,
    model: os.cpus()[0]?.model ?? null,
    // a hash of the hostname: verdict pairs only runs of one machine (the CPU count, platform and model can match across
    // two), and the summaries do not carry the name itself
    hostId: createHash('sha256').update(os.hostname()).digest('hex').slice(0, 16),
  };
  const startedAt = new Date().toISOString();
  let schedulerWarnings = 0;
  console.warn = (...a) => {
    if (typeof a[0] === 'string' && a[0].startsWith('[store scheduler]')) schedulerWarnings++;
    else warn(...a);
  };
  mkdirSync(outDir, { recursive: true });
  try {
    return await withNamespace(
      storage,
      endpoint,
      { keep: c.keep, prefix: c.namespacePrefix },
      async ({ sparqlUrl, namespace }) => {
        const seedScheduler = new storage.StorePriorityScheduler({
          maxConcurrent: 8,
          ackReservedSlots: 1,
          healthReservedSlots: 1,
          queueLimits: 256,
          queueWaitTimeoutMs: 120_000,
        });
        // seeding and ground truth stay off the measured scheduler
        const seedStore = new storage.BlazegraphStore(sparqlUrl, { scheduler: seedScheduler, timeout: 120_000 });
        // the product's default scheduler: P3's per-queue instances apply to it automatically
        const store = new storage.BlazegraphStore(sparqlUrl);
        const cfg = { ...c, runTag };
        const world = {
          cfg,
          t0: null, // set by beginEpoch, once the worker and the publisher are up
          epoch0: 0,
          store,
          queue: null,
          requests: [],
          pubRequests: [],
          observerEvents: [],
          liftObserverEvents: [],
          readerEvents: [],
          claimMs: [],
          claimLatMs: [],
          completions: [],
        };
        // the daemon's publisher: the idle one (no publish load) beside a share run, the real one with the synthetic
        // handler when the run publishes
        const idle = useLift ? null : createIdlePublisher(world, dist);
        const liftSide = useLift
          ? createLiftSide(world, dist, { stageStore: seedStore, graphManager: new storage.GraphManager(seedStore) })
          : null;
        const publisherSide = liftSide ?? idle;
        let worker = null;
        let sampler = null;
        let admissions = null;
        let running = false;
        const loopMonitor = monitorEventLoopDelay({ resolution: 10 });
        try {
          await seedMainNamespace(seedStore, core);
          let seedLoad = null;
          let liftSeedLoad = null;
          if (c.historyJobs > 0) {
            if (c.seedFile) seedLoad = await loadSeedFile(sparqlUrl, c.seedFile.path);
            else await loadGenerated(seedStore, dist, { jobs: c.historyJobs, baseTime: Date.now() });
          }
          if (c.liftHistoryJobs > 0) {
            if (c.liftSeedFile) liftSeedLoad = await loadSeedFile(sparqlUrl, c.liftSeedFile.path);
            else await loadGeneratedLift(seedStore, dist, { jobs: c.liftHistoryJobs, baseTime: Date.now() });
          }
          const arrivals = useLift ? publishArrivals(cfg) : [];
          // every scheduled publication's share snapshot is staged before the run (the share step precedes the publish call)
          for (let n = 0; n < arrivals.length; n++) await liftSide.stage(n);
          if (useShare) {
            world.queue = new pub.TripleStoreAsyncPromoteQueue(store);
            // the admission work an enqueue leaves running after its caller was answered at the deadline
            admissions = trackAdmissionWork(
              dist.admission.PromoteAdmissionCoordinator.for(store, utils.DEFAULT_PROMOTE_CONTROL_GRAPH_URI),
            );
            worker = createWorker(world, dist);
          }
          const schedulerSnapshot = storage.getExternalStorePrioritySchedulerSnapshot();
          const maxOldest = {};
          const window = { from: c.warmupMs, to: c.warmupMs + c.measureMs };
          const preflight = makePreflight({ store, deps: dist });
          const publishPreflight = useLift ? createPublishPreflight(world, preflight) : null;
          // the epoch starts after the awaited startup; the samplers and every window boundary count from it
          await beginEpoch(
            world,
            async () => {
              await worker?.supervisor.start();
              await publisherSide.start();
            },
            () => {
              loopMonitor.enable();
              sampler = setInterval(() => {
                const t = performance.now() - world.t0;
                if (t < window.from || t >= window.to) return;
                for (const s of core.backpressureRegistry.capture().schedulers) {
                  maxOldest[s.scheduler] = Math.max(maxOldest[s.scheduler] ?? 0, s.totals.oldestQueuedAgeMs);
                }
              }, 1000);
            },
          );
          running = true;
          const horizonMs = c.warmupMs + c.measureMs + c.cooldownMs;
          const producers = useShare ? startShareProducers(world, preflight) : NOOP;
          const pubProducers = useLift ? startPublishProducers(world, liftSide, publishPreflight, arrivals) : NOOP;
          const readers = startReaders(world);
          const observer = useShare ? startObserver(world, c.observer) : NOOP;
          const liftObserver = useLift
            ? startObserver(world, c.observer, {
                calls: LIFT_OBSERVER_CALLS,
                target: liftSide.admission,
                events: world.liftObserverEvents,
              })
            : NOOP;
          const lf = c.loadFactors;
          const probeLoad = lf.probes
            ? await startProbeLoad(world, dist, {
                statusMs: lf.statusMs,
                metricsMs: lf.metricsMs,
                countMs: lf.countMs,
                horizonMs,
              })
            : null;
          const ackLoad = lf.ack
            ? startAckLoad(world, storage, { intervalMs: lf.ackMs, payload: lf.ackPayload, horizonMs })
            : null;
          await sleepUntil(world, window.from);
          loopMonitor.reset();
          const before = core.backpressureRegistry.capture();
          const cpu0 = process.cpuUsage();
          const wall0 = performance.now();
          await sleepUntil(world, window.to);
          const cpu = process.cpuUsage(cpu0);
          const wallMs = performance.now() - wall0;
          const after = core.backpressureRegistry.capture();
          const eventLoop = {
            p99Ms: Math.round((loopMonitor.percentile(99) / 1e6) * 10) / 10,
            maxMs: Math.round((loopMonitor.max / 1e6) * 10) / 10,
          };
          await sleepUntil(world, window.to + c.cooldownMs);
          const horizonReachedAt = performance.now() - world.t0;
          producers.stop(); // an arrival overdue at the horizon is still issued, so none is missing from the stats
          pubProducers.stop();
          readers.stop();
          observer.stop();
          liftObserver.stop();
          probeLoad?.stop();
          ackLoad?.stop();
          const stillInflight = (await producers.drain(50_000)) + (await pubProducers.drain(50_000));
          await readers.drain(5000);
          await observer.drain(1000);
          await liftObserver.drain(1000);
          // a status probe's CALLER answers within its 5 s wait by construction, but its ASK is never aborted and
          // neither is the COUNT (like the daemon's), so the drain waits for those store queries too, up to
          // PROBE_DRAIN_MS: one still running then is reported (stillInflightAtDrain). A metrics probe still running
          // at that drain and an ACK still running at its own are recorded as censored at that moment and fail the
          // probesFinished / acksFinished checks
          const probesStillInflight = probeLoad ? await probeLoad.drain(PROBE_DRAIN_MS) : 0;
          await ackLoad?.drain(10_000);
          worker?.freeze(); // jobs cut short by the shutdown are not worker contract breaks
          await worker?.supervisor.stop();
          await publisherSide.stop();
          running = false;
          clearInterval(sampler);
          // the shutdown after the workload horizon: reported on its own, it is no input to any window. The publisher can
          // no longer claim at runMs: the censoring time of an unclaimed job
          const runMs = performance.now() - world.t0;
          const timing = {
            horizonMs,
            drainMs: Math.round(runMs - horizonReachedAt),
            runMs: Math.round(runMs),
          };

          // ground truth: which request keys became persisted jobs (read off the unscheduled seed store), once the
          // admission writes the queue left running past their callers' deadline have settled
          const reconciled = useShare
            ? await reconcileAdmissions({
                tracker: admissions,
                issued: world.requests.some((r) => r.enqStart !== undefined),
                readJobs: () => readShareJobs(seedStore, utils, runTag),
              })
            : { jobsByName: new Map(), reconcileError: null, admissions: null };
          const { jobsByName, reconcileError } = reconciled;
          let liftByName = new Map();
          let liftReconcileError = null;
          if (useLift) {
            try {
              liftByName = await readLiftJobs(seedStore, dist, runTag);
            } catch (e) {
              liftReconcileError = String(e?.message ?? e).slice(0, 300);
            }
          }

          finalizeRequests(world.requests);
          finalizeRequests(world.pubRequests);
          const submission = admissionSummary(world.requests);
          const gt = groundTruth(world.requests, jobsByName);
          const inWin = (e) => e.t >= window.from && e.t < window.to;
          const obs = world.observerEvents.filter(inWin);
          const reads = world.readerEvents.filter(inWin);
          const done = world.completions.filter(inWin);
          const claims = world.claimMs.filter(inWin);
          // backlog = the measurement window's statistics; the P8c backlog leg reads the whole run's maximum
          const { backlog, p8c } = p8cOfRun({
            requests: world.requests,
            completions: world.completions,
            claimNext: world.claimMs,
            windows: { warmupMs: c.warmupMs, measureMs: c.measureMs, cooldownMs: c.cooldownMs },
          });
          const counters = worker?.supervisor.getCounters() ?? {};
          const rejected = (cap) =>
            Object.fromEntries(cap.schedulers.map((s) => [s.scheduler, s.totals.rejectedTotal]));
          const agent = {
            agentErrors: worker?.stats.agentErrors,
            dataOps: worker?.stats.dataOps,
            firstAgentError: worker?.stats.firstAgentError,
            crashes: worker?.log.crashes,
          };
          // the publisher stream: persisted jobs (run-relative times), the wallet-lock events and the pick-up metrics
          let publish = null;
          let liftRows = [];
          if (useLift) {
            const pgt = groundTruth(world.pubRequests, liftByName);
            const rows = [...liftByName.values()].flat().map((j) => jobRow(j, world.epoch0));
            liftRows = rows;
            publish = publishSummary({
              admission: admissionSummary(world.pubRequests),
              groundTruth: pgt,
              rows,
              window,
              runEnd: runMs,
              walletEvents: liftSide.trace.events.map((e) => ({
                t: e.at - world.epoch0,
                ev: e.ev,
                walletId: e.walletId,
              })),
              walletIds: liftSide.walletIds,
              scheduledArrivals: arrivals.length,
              reconcileError: liftReconcileError,
              handler: liftSide.handler.state,
              runner: { ...liftSide.state },
              config: { ...c.liftModel, mu: c.mu },
            });
          }
          const background = backgroundLoadEvidence({
            loadFactors: lf,
            probeState: probeLoad?.state,
            ackState: ackLoad?.state,
            from: window.from,
            to: window.to,
            stillInflightAtDrain: probesStillInflight,
          });
          const validityChecks = validity({
            lambda: c.lambda,
            measureMs: c.measureMs,
            measured: submission.n,
            stillInflight,
            admissionsPending: reconciled.admissions?.pending,
            reconcileError: reconcileError ?? liftReconcileError,
            successWithoutJob: gt.successWithoutPersistedJob,
            doubleAdmissions: gt.doubleAdmissions,
            driverCpu: (cpu.user + cpu.system) / 1000 / wallMs,
            idlePublisherErrors: idle?.state.errors,
            worker: useShare
              ? {
                  agentErrors: agent.agentErrors,
                  crashes: agent.crashes,
                  failedTerminal: counters.failedTerminal,
                  succeeded: counters.succeeded,
                  attempted: counters.attempted,
                  dataOps: agent.dataOps,
                }
              : undefined,
            seedFileVerified: c.seedFile ? seedLoad?.sha256 === c.seedFile.sha256 : true,
            queue: c.queue,
            ...(c.liftSeedFile ? { liftSeedFileVerified: liftSeedLoad?.sha256 === c.liftSeedFile.sha256 } : {}),
            ...(publish
              ? {
                  publisher: {
                    measured: publish.n,
                    mu: c.mu,
                    successWithoutJob: publish.groundTruth.successWithoutPersistedJob,
                    doubleAdmissions: publish.groundTruth.doubleAdmissions,
                    errors: liftSide.state.errors,
                    stopTimedOut: liftSide.state.stopTimedOut,
                    reclaimed: publish.reclaimed,
                    claimed: publish.claimed,
                    finalized: publish.finalized,
                    failed: publish.failed,
                    wallets: liftSide.walletIds.length,
                    executions: liftSide.handler.state.executions,
                    tailOps: liftSide.handler.state.tailOps,
                  },
                }
              : {}),
            ...(background.load ? { load: background.load } : {}),
          });
          const summary = {
            schema: 2,
            meta: {
              runId,
              label: c.label,
              role: c.role,
              startedAt,
              endedAt: new Date().toISOString(),
              argv: process.argv.slice(2),
              git: prov.git,
              scriptSha256: prov.scriptSha256,
              distStaleSuspected: prov.distStaleSuspected,
              node: prov.node,
              host: {
                ...host,
                loadavgEnd: os.loadavg().map((x) => Math.round(x * 100) / 100),
                busyAtStart: host.loadavgStart[0] > 0.75 * host.cpus,
              },
              env: prov.env,
              backendNote: c.backendNote,
              backend: { endpoint: new URL(endpoint).origin, namespace },
              scheduler: schedulerSnapshot,
              cell: {
                history: c.history,
                liftHistory: c.liftHistory,
                queue: c.queue,
                observer: c.observer,
                rung: c.rung,
                lambda: c.lambda,
                mu: c.mu,
                content: c.content,
                aggregate: c.aggregate,
                repeat: c.repeat,
                seed: c.seed,
                observerMs: c.observerMs,
                loadFactors: c.loadFactors,
                liftModel: c.liftModel,
              },
              windows: { warmupMs: c.warmupMs, measureMs: c.measureMs, cooldownMs: c.cooldownMs },
              timing,
              calibration: c.calibration,
              // sha256 is the manifest's, loadedSha256 the hash of the bytes this run loaded (validity.seedFileVerified
              // compares them)
              seedFile: c.seedFile && {
                path: c.seedFile.path,
                sha256: c.seedFile.sha256,
                loadedSha256: seedLoad?.sha256 ?? null,
                jobs: c.seedFile.jobs,
              },
              liftSeedFile: c.liftSeedFile && {
                path: c.liftSeedFile.path,
                sha256: c.liftSeedFile.sha256,
                loadedSha256: liftSeedLoad?.sha256 ?? null,
                jobs: c.liftSeedFile.jobs,
              },
            },
            submission,
            publish,
            observer: {
              mode: c.observer,
              polls: obs.length,
              failed: obs.filter((e) => !e.ok).length,
              latencyMs: summarize(obs.map((e) => e.ms)),
              rows: obs.at(-1)?.rows ?? null,
              ...(obs.some((e) => e.pages)
                ? { pages: { n: obs.at(-1).pages, maxPageMs: Math.max(...obs.map((e) => e.maxPageMs ?? 0)) } }
                : {}),
            },
            liftObserver: useLift
              ? {
                  mode: c.observer,
                  polls: world.liftObserverEvents.length,
                  failed: world.liftObserverEvents.filter((e) => !e.ok).length,
                  latencyMs: summarize(world.liftObserverEvents.filter(inWin).map((e) => e.ms)),
                  rows: world.liftObserverEvents.at(-1)?.rows ?? null,
                }
              : null,
            worker: useShare
              ? {
                  completionsInWindow: done.length,
                  completionsPerMin: Math.round((done.length / (c.measureMs / 60_000)) * 100) / 100,
                  claimLatencyMs: summarize(world.claimLatMs),
                  claimNextMs: summarize(claims.map((x) => x.ms)),
                  counters,
                  agent,
                  backlog,
                  p8c,
                  workerLogLines: worker.log.count,
                  workerLog: worker.log.lines,
                }
              : null,
            readers: {
              n: reads.length,
              failed: reads.filter((e) => !e.ok).length,
              failFrac: reads.length ? reads.filter((e) => !e.ok).length / reads.length : null,
              latencyMs: summarize(reads.map((e) => e.ms)),
            },
            idlePublisher: idle?.state ?? null,
            probes: background.probes,
            ack: background.ack,
            backpressure: {
              before,
              after,
              rejectedDelta: Object.fromEntries(
                Object.entries(rejected(after)).map(([id, n]) => [id, n - (rejected(before)[id] ?? 0)]),
              ),
              maxOldestQueuedAgeMs: maxOldest,
              schedulerWarnings,
            },
            eventLoop,
            groundTruth: gt,
            reconcileError,
            admissions: reconciled.admissions,
            validity: validityChecks,
          };
          writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
          const events = [
            ['req', world.requests],
            ['preq', world.pubRequests],
            ['obs', world.observerEvents],
            ['lobs', world.liftObserverEvents],
            ['read', world.readerEvents],
            ['claim', world.claimMs],
            ['done', world.completions],
            ['ljob', liftRows],
            ['wallet', liftSide?.trace.events ?? []],
            ['probe', probeLoad?.state.events ?? []],
            ['ack', ackLoad?.state.events ?? []],
          ];
          writeFileSync(
            path.join(outDir, 'events.jsonl'),
            events.flatMap(([e, rows]) => rows.map((r) => JSON.stringify({ e, ...r }))).join('\n') + '\n',
          );
          return summary;
        } finally {
          clearInterval(sampler);
          admissions?.dispose();
          loopMonitor.disable();
          // only when the run failed half way
          if (running) await within(Promise.allSettled([worker?.supervisor.stop(), publisherSide.stop()]), 25_000);
          liftSide?.trace.uninstall(); // the product's claim trace is the process's: leave it as it was found
          await store.close?.();
          await seedStore.close?.();
        }
      },
    );
  } finally {
    console.warn = warn;
  }
}

// ---------------------------------------------------------------- calibrate
async function calibrateCommand(v) {
  const refused = CALIBRATE_OWNS.filter((k) => v[k] !== undefined && v[k] !== false);
  if (refused.length) {
    const flags = refused.map((k) => `--${k}`).join(' ');
    die(2, `calibrate sets the rung, history 0 and observer default itself: remove ${flags}`);
  }
  const outDir = path.resolve(v.out ?? defaultOut());
  const windows = windowsFor(v, DEFAULT_WINDOWS_S);
  checkWindows(windows);
  const repeats = intFlag(v, 'calib-repeats', 2, 1);
  const ladder = v.ladder
    ? v.ladder
        .split(',')
        .map((x) => RUNGS.find((r) => r.id === x || String(r.lambda) === x) ?? die(2, `unknown ladder entry ${x}`))
    : RUNGS;
  const results = [];
  const rungs = [];
  for (const rung of ladder) {
    const runs = [];
    const valid = [];
    for (let i = 0; i < repeats; i++) {
      for (const attempt of [0, 1]) {
        // an invalid run is retried once and stays in the ledger
        const dir = path.join(outDir, `${rung.id}-r${i}${attempt ? '-retry' : ''}`);
        const { status, result } = spawnRun(
          childArgs(v, {
            ladder: undefined,
            'calib-repeats': undefined,
            out: dir,
            rung: rung.id,
            history: '0',
            observer: 'default',
            repeat: i,
            repeats: undefined,
            warmup: windows.warmup,
            measure: windows.measure,
            cooldown: windows.cooldown,
          }),
        );
        if (status === 2 || status === 3) process.exit(status);
        runs.push(path.join(dir, 'summary.json'));
        if (status === 0 && result?.valid) {
          valid.push(extractRecord(JSON.parse(readFileSync(path.join(dir, 'summary.json'), 'utf8'))));
          break;
        }
      }
    }
    if (!valid.length) die(1, `${rung.id}: no valid run (${runs.join(', ')})`);
    const entry = {
      ...rung,
      runs,
      medianP95Ms: median(valid.map((r) => r.p95Ms)),
      medianF: median(valid.map((r) => r.failureFrac)),
    };
    entry.knee = kneeReached({ p95Ms: entry.medianP95Ms, failureFrac: entry.medianF });
    rungs.push(entry);
    results.push({ id: rung.id, p95Ms: entry.medianP95Ms, failureFrac: entry.medianF });
    console.error(
      `${rung.id}  lambda ${rung.lambda}  P95 ${entry.medianP95Ms} ms  F ${entry.medianF}  ${entry.knee ? 'KNEE' : ''}`,
    );
    if (entry.knee) break; // the rung below it is the sub-knee rung
  }
  const pick = pickReproductionRung(results);
  const prov = provenance(SCRIPT_FILES);
  const calibration = {
    schema: 1,
    createdAt: new Date().toISOString(),
    git: prov.git,
    host: {
      cpus: os.cpus().length,
      platform: `${process.platform}-${process.arch}`,
      env: prov.env,
      backendNote: v['backend-note'] ?? null,
    },
    windows: {
      warmupMs: windows.warmup * 1000,
      measureMs: windows.measure * 1000,
      cooldownMs: windows.cooldown * 1000,
    },
    cell: { history: '0', observer: 'default' },
    // the probe and ACK load the knee was measured under: a run with another load is flagged (calibration.factorsDiffer)
    factors: loadFactorsOf(v),
    criteria: { p95Ms: 5000, failureFrac: 0.05 },
    ladder: ladder.map((r) => r.id),
    rungs,
    status: pick.status,
    reproductionRung: pick.rung,
    subKneeRung: pick.subKneeRung,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'calibration.json'), `${JSON.stringify(calibration, null, 2)}\n`);
  out1({
    calibration: path.join(outDir, 'calibration.json'),
    status: pick.status,
    reproductionRung: pick.rung,
    subKneeRung: pick.subKneeRung,
  });
  if (pick.status === 'no-knee')
    console.error('no rung reached the knee: G2 falls back to non-inferiority at the top rung');
  if (pick.status === 'below-ladder') {
    console.error(
      'the first rung is already at the knee: run with --lambda/--content/--aggregate below L0 and calibrate by hand',
    );
  }
  process.exit(pick.status === 'found' ? 0 : 1);
}

// ---------------------------------------------------------------- verdict
function loadRecords(dir, where) {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'summary.json') files.push(p);
    }
  };
  try {
    walk(dir);
  } catch (e) {
    die(2, `cannot read ${dir}: ${e.message}`);
  }
  const conds = Object.fromEntries(
    (where ?? '')
      .split(',')
      .filter(Boolean)
      .map((kv) => kv.split('=')),
  );
  return files
    .sort()
    .map((f) => {
      try {
        return extractRecord(JSON.parse(readFileSync(f, 'utf8')));
      } catch (e) {
        return die(2, `cannot read the run summary ${f}: ${e.message}`);
      }
    })
    .filter((r) => Object.entries(conds).every(([k, x]) => String(r.cell[k]) === x));
}

/** The metric family a rule judges (--metric), with the sample minimum the worker-free pick-up needs. */
function familyFlags(v) {
  const family = v.metric ?? 'share';
  if (!Object.hasOwn(FAMILIES, family)) die(2, `--metric must be ${Object.keys(FAMILIES).join(', ')}`);
  if (v['min-qualifying'] !== undefined && family !== 'pickupFree')
    die(2, '--min-qualifying belongs to --metric pickupFree');
  if (family !== 'pickupFree') return { family };
  if (v['min-qualifying'] === undefined)
    die(2, '--metric pickupFree needs --min-qualifying N (the sample the protocol requires, declared before the A/B)');
  return { family, minSamples: intFlag(v, 'min-qualifying', 0, 1) };
}

function printG1b(result, warnings) {
  const reason = result.reason ? ` - ${result.reason}` : '';
  console.log(
    `${result.label}: ${result.status.toUpperCase()} (${result.have} usable repeats in the thinnest cell, ${result.need} needed)${reason}`,
  );
  console.log(`  ${result.note}`);
  for (const [id, cell] of Object.entries(result.cells)) {
    console.log(`  ${id} (--queue ${cell.queue}, rung ${cell.rung}): ${cell.have} of ${result.need} repeats usable`);
    for (const [name, m] of Object.entries(cell.metrics)) {
      const pct = `${m.deviation >= 0 ? '+' : ''}${(m.deviation * 100).toFixed(1)} %`;
      console.log(
        `    ${G1B_METRICS[name].label}: median ${m.median} ms vs G0b ${m.ref} ms (${pct}), band ${m.lo}..${m.hi} ms  ${m.ok ? 'ok' : 'MISS'}`,
      );
    }
    for (const p of cell.problems) console.log(`    problem: ${p}`);
  }
  for (const w of warnings) console.log(`warning: ${w}`);
}

function verdictCommand(v) {
  if (!v.a) die(2, 'verdict needs --a DIR');
  const A = loadRecords(v.a, v.where);
  const B = v.b ? loadRecords(v.b, v.where) : [];
  const rule = v.rule;
  if (rule === 'ledger') {
    console.log(ledgerMarkdown([...A, ...B]));
    process.exit(0);
  }
  if (rule === 'g1b') {
    if (v.b) die(2, '--rule g1b judges one arm (--a DIR) against the G0b medians: drop --b');
    const result = g1b(A);
    const warnings = integrityWarnings(A, [], null);
    if (v.json) console.log(JSON.stringify({ result, warnings }));
    else printG1b(result, warnings);
    process.exit({ pass: 0, fail: 1, incomplete: 2 }[result.status]);
  }
  if (!['halve', 'flat', 'equal', 'noworse', 'aa'].includes(rule))
    die(2, 'verdict needs --rule halve|flat|equal|noworse|aa|g1b|ledger');
  if (!v.b) die(2, `--rule ${rule} needs --b DIR`);
  if ((rule === 'equal' || rule === 'noworse') && v.margin === undefined)
    die(2, `--rule ${rule} needs --margin (declare it from the A/A pair first)`);
  const margin = num(v.margin, null);
  if ((rule === 'equal' || rule === 'noworse') && !(Number.isFinite(margin) && margin >= 0))
    die(2, '--margin must be a non-negative number');
  const { family, minSamples } = familyFlags(v);
  if (rule === 'flat' && family !== 'share' && family !== 'publish')
    die(2, '--rule flat judges a P95: --metric share or publish');
  // the flatness rule pairs across histories and their seed files, the share and the lift one (G2's seeded cell is both)
  const flatKey = { ignoreHistory: true, ignoreLiftHistory: true };
  const keyOf = rule === 'flat' ? (r) => pairKey(r, flatKey) : (r) => r.key;
  const { pairs, missing } = pairRuns(A, B, keyOf, { ignoreSeed: rule === 'flat', ignoreLiftSeed: rule === 'flat' });
  if (rule === 'aa') {
    // three repeats of EACH cell, whatever cell has a run in either arm: valid pairs of different cells do not add up
    // and a finite margin: an unbounded A/A deviation (a zero value against a nonzero one, in any metric) declares
    // nothing, and neither do runs of different (or unrecorded) builds: the whole arms are checked, the runs that did
    // not pair included
    const declaration = aaDeclaration(pairs, missing, { family, minSamples, aRecords: A, bRecords: B });
    const aaPairs = withMetric(pairs, family, { minSamples });
    const warnings = integrityWarnings([...A, ...B], aaPairs, null);
    console.log(JSON.stringify({ ...declaration, warnings, missing, companions: companionsOf(aaPairs, family) }));
    process.exit(declaration.status === 'complete' ? 0 : 2);
  }
  const options = { missing, family, minSamples };
  // the pairs the rule can judge: one whose runs lack the metric says why among the warnings
  const judged = withMetric(pairs, family, { minSamples });
  const result =
    rule === 'halve'
      ? halve(judged, options)
      : rule === 'flat'
        ? flat(judged, { aRecords: A, bRecords: B, family, missing })
        : rule === 'noworse'
          ? noWorse(judged, margin, options)
          : equivalent(judged, margin, options);
  const g = guards(judged, family);
  const warnings = integrityWarnings([...A, ...B], judged, result);
  // D-16: the backlog and the claim-to-finish time, next to a pick-up result, whatever the result
  const companions = companionsOf(judged, family);
  if (v.json) {
    console.log(JSON.stringify({ result, guards: g, missing, warnings, companions }));
  } else {
    const reason = result.reason ? ` - ${result.reason}` : '';
    console.log(
      `${result.label}: ${result.status.toUpperCase()} (${result.have} valid pairs, ${result.need} needed)${reason}`,
    );
    for (const r of result.perRepeat)
      console.log(`  ${r.key}  ${r.a} -> ${r.b}  ratio ${r.ratio}  ${r.ok ? 'ok' : 'FAIL'}`);
    for (const m of missing) console.log(`  missing in ${m.missingIn}: ${m.key}`);
    const failureOk = g.failureFrac.every((x) => x.ok) ? 'ok' : 'NOT MET';
    const completionsOk = g.completions.every((x) => x.ok) ? 'ok' : 'NOT MET';
    console.log(
      `guards (reported, not gating): candidate failure fraction <= 0.02 ${failureOk}; ` +
        `completions >= 0.9 x base ${completionsOk}`,
    );
    for (const line of companionLines(companions, family)) console.log(line);
    for (const w of warnings) console.log(`warning: ${w}`);
  }
  process.exit({ pass: 0, fail: 1, incomplete: 2 }[result.status]);
}

try {
  if (cmd === 'run') await runCommand(values);
  else if (cmd === 'calibrate') await calibrateCommand(values);
  else if (cmd === 'verdict') verdictCommand(values);
  else die(2, 'usage: async-queue-contention.mjs run|calibrate|verdict [options] (see the header comment)');
} catch (e) {
  die(e?.exitCode ?? 1, `async-queue-contention ${cmd} failed: ${e?.stack ?? e}`);
}
