#!/usr/bin/env node
// Async queue contention benchmark (OT-RFC-73 P2a): open-loop share submissions (the route's preflight reads, then the
// real enqueue), the real worker supervisor claiming jobs and replaying the 43-operation share body, closed-loop client
// readers on the background lane, a list observer and an always-on idle publisher, all on the real default scheduler,
// the real queue and the real Blazegraph adapter against a Blazegraph. No chain, wallets or funds.
// NOT a CI gate: it needs a Blazegraph the build job does not have, and the knee is host-dependent, so the rung is
// calibrated per host. Needs the built workspace (pnpm run build:packages).
//
//   node scripts/repro/async-queue-contention.mjs run --blazegraph-url URL \
//        (--rung L3 | --calibration FILE [--at reproduction|sub-knee]) [options]
//   node scripts/repro/async-queue-contention.mjs calibrate --blazegraph-url URL \
//        [--ladder L0,L1,..] [--calib-repeats 2] [--out DIR]
//   node scripts/repro/async-queue-contention.mjs verdict --rule halve|flat|equal|aa|ledger --a DIR [--b DIR] \
//        [--margin m] [--where history=0,observer=default] [--json]
//
// run options:
//   --history 0|10k|50k [--seed-file FILE]   retained share-job history (a seed file: async-queue-seed-history.mjs)
//   --observer default|paged|none            the list observer's call; --observer-ms 5000 its polling period
//   --repeats N                              N repeats, one fresh process each; --repeat I runs only repeat I
//   --seed S                                 default 7300+repeat: a repeat is the same arrival schedule in every build
//   --warmup 30 --measure 180 --cooldown 10 seconds; with --calibration these default to the calibration's own windows
//                                            (its knee was measured with them); other values are flagged in the run's
//                                            meta and in the verdict. calibrate uses the run defaults, so the rung it
//                                            picks is the rung a run sees
//   --label --role --backend-note TEXT       recorded in the run's meta
//   --namespace-prefix aqc --keep-namespace  the run creates and drops its own namespace
//   --out DIR                                default .dkg-repro-reports/async-queue-contention/<timestamp>
//   --dry                                    check imports and config only
//   --lambda L --content N --aggregate N     a custom load instead of a rung (all three)
// Counts and seeds are plain integers; a bad value exits 2.
//
// Latency is intended arrival to response, censored at 20 s; every non-success and every client timeout is a failure.
// Exit codes: 0 ok/pass, 1 fail, 2 usage or incomplete, 3 refused backend.
// Small-host cell: DKG_STORE_MAX_CONCURRENT=2 (recorded under meta.env). Scheduler warnings are counted, not printed.
// A run is valid only if the measure window saw requests (measurementObserved), the worker side did its job
// (workerContractOk, dataPlaneReplayed), the load drained, every admission write the queue left running past its caller's
// deadline settled before the ground truth was read (admissionsSettled), and a seed file hashed as its manifest says.
// The P8c backlog leg reads the largest active backlog of the whole run (warmup to cooldown); worker.backlog stays the
// measurement window's.
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
//
// Not modelled (see fixture.mjs): the preflight's O(catalog) list leg, the readiness wait and the chain rescue;
// publisher and mixed cells are P2b.
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
import { loadGenerated, loadSeedFile, parseCount } from './async-queue-contention/history.mjs';
import {
  PAIRED_MIN,
  RUNGS,
  admissionSummary,
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
  noiseMargin,
  p8cOfRun,
  pairKey,
  pairRuns,
  pickReproductionRung,
  repeatsPerCell,
  summarize,
  validity,
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
};
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
  'content',
  'aggregate',
  'history',
  'seed-file',
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

function resolveConfig(v) {
  if (v.at !== undefined && !['reproduction', 'sub-knee'].includes(v.at))
    die(2, '--at must be reproduction or sub-knee');
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
    calibration = { file: path.resolve(v.calibration), sha256: sha256(v.calibration), windowsMs: cal.windows ?? null };
  } else if (v.rung) {
    base =
      RUNGS.find((r) => r.id === v.rung) ?? die(2, `unknown rung ${v.rung} (${RUNGS.map((r) => r.id).join(', ')})`);
  }
  const custom = [v.lambda, v.content, v.aggregate].some((x) => x !== undefined);
  if (!base && !(v.lambda !== undefined && v.content !== undefined && v.aggregate !== undefined)) {
    die(2, 'give --rung, --calibration or all of --lambda --content --aggregate');
  }
  const lambda = num(v.lambda, base?.lambda);
  const content = num(v.content, base?.content);
  const aggregate = num(v.aggregate, base?.aggregate);
  if (![lambda, content, aggregate].every((x) => Number.isFinite(x) && x >= 0) || !(lambda > 0)) {
    die(2, 'lambda must be positive; content and aggregate must be non-negative numbers');
  }
  const historyJobs = parseCountOrDie(v.history ?? '0');
  let manifest = null;
  if (v['seed-file']) {
    if (!existsSync(v['seed-file'])) die(2, `the seed file ${v['seed-file']} does not exist`);
    manifest = readJson(`${v['seed-file']}.json`, 'seed file manifest');
  }
  if (manifest && manifest.jobs !== historyJobs)
    die(2, `--history ${historyJobs} does not match the seed file (${manifest.jobs} jobs)`);
  const observer = v.observer ?? 'default';
  const repeat = intFlag(v, 'repeat', 0);
  const seed = intFlag(v, 'seed', 7300 + repeat);
  const observerMs = intFlag(v, 'observer-ms', 5000, 1);
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(v['namespace-prefix'] ?? 'aqc'))
    die(2, '--namespace-prefix must match [A-Za-z0-9._-]{1,40}');
  if (!(observer in OBSERVER_CALLS) && observer !== 'none')
    die(2, `unknown --observer ${observer} (default, paged, none)`);
  if (observer === 'paged' && !OBSERVER_CALLS.paged)
    die(2, 'paged listing is not available in this build (needs P8a/P9b)');
  const windows = windowsFor(v, windowDefaults);
  checkWindows(windows);
  const windowsMs = [windows.warmup * 1000, windows.measure * 1000, windows.cooldown * 1000];
  if (calibration?.windowsMs) {
    const cal = calibration.windowsMs;
    calibration.windowsDiffer = [cal.warmupMs, cal.measureMs, cal.cooldownMs].some((x, i) => x !== windowsMs[i]);
  }
  let history = String(historyJobs);
  if (historyJobs === 0) history = '0';
  else if (historyJobs % 1000 === 0) history = `${historyJobs / 1000}k`;
  return {
    label: v.label ?? null,
    role: v.role ?? null,
    rung: custom ? `custom-l${lambda}-c${content}-a${aggregate}` : base.id,
    lambda,
    content,
    aggregate,
    history,
    historyJobs,
    observer,
    observerMs,
    seedFile: manifest
      ? {
          path: path.resolve(v['seed-file']),
          sha256: manifest.sha256,
          jobs: manifest.jobs,
          baseTime: manifest.baseTime,
        }
      : null,
    calibration,
    repeat,
    seed,
    warmupMs: windowsMs[0],
    measureMs: windowsMs[1],
    cooldownMs: windowsMs[2],
    backendNote: v['backend-note'] ?? null,
    namespacePrefix: v['namespace-prefix'] ?? 'aqc',
    keep: Boolean(v['keep-namespace']),
  };
}

function parseCountOrDie(value) {
  try {
    return parseCount(value);
  } catch (e) {
    return die(2, `--history: ${e.message}`);
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
    valid: summary.validity.ok,
  });
  process.exit(0);
}

async function runOnce(c, dist, endpoint, outDir) {
  const { storage, core, pub, utils } = dist;
  const prov = provenance(SCRIPT_FILES);
  const warn = console.warn;
  const runTag = `run${randomBytes(3).toString('hex')}`;
  const runId = `${c.label ?? 'run'}-${c.rung}-r${c.repeat}-${Date.now().toString(36)}`;
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
          t0: null, // set by beginEpoch, once the worker and the idle publisher are up
          epoch0: 0,
          store,
          queue: null,
          requests: [],
          observerEvents: [],
          readerEvents: [],
          claimMs: [],
          claimLatMs: [],
          completions: [],
        };
        const idle = createIdlePublisher(world, dist);
        let worker = null;
        let sampler = null;
        let admissions = null;
        let running = false;
        const loopMonitor = monitorEventLoopDelay({ resolution: 10 });
        try {
          await seedMainNamespace(seedStore, core);
          let seedLoad = null;
          if (c.historyJobs > 0) {
            if (c.seedFile) seedLoad = await loadSeedFile(sparqlUrl, c.seedFile.path);
            else await loadGenerated(seedStore, dist, { jobs: c.historyJobs, baseTime: Date.now() });
          }
          world.queue = new pub.TripleStoreAsyncPromoteQueue(store);
          // the admission work an enqueue leaves running after its caller was answered at the deadline
          admissions = trackAdmissionWork(
            dist.admission.PromoteAdmissionCoordinator.for(store, utils.DEFAULT_PROMOTE_CONTROL_GRAPH_URI),
          );
          worker = createWorker(world, dist);
          const schedulerSnapshot = storage.getExternalStorePrioritySchedulerSnapshot();
          const maxOldest = {};
          const window = { from: c.warmupMs, to: c.warmupMs + c.measureMs };
          const preflight = makePreflight({ store, deps: dist });
          // the epoch starts after the awaited startup; the samplers and every window boundary count from it
          await beginEpoch(
            world,
            async () => {
              await worker.supervisor.start();
              await idle.start();
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
          const producers = startShareProducers(world, preflight);
          const readers = startReaders(world);
          const observer = startObserver(world, c.observer);
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
          producers.stop(); // an arrival overdue at the horizon is still issued, so none is missing from the stats
          readers.stop();
          observer.stop();
          const stillInflight = await producers.drain(50_000);
          await readers.drain(5000);
          await observer.drain(1000);
          worker.freeze(); // jobs cut short by the shutdown are not worker contract breaks
          await worker.supervisor.stop();
          await idle.stop();
          running = false;
          clearInterval(sampler);
          const runMs = performance.now() - world.t0;

          // ground truth: which request keys became persisted jobs (read off the measured scheduler), once the admission
          // writes the queue left running past their callers' deadline have settled
          const reconciled = await reconcileAdmissions({
            tracker: admissions,
            issued: world.requests.some((r) => r.enqStart !== undefined),
            readJobs: () => readShareJobs(seedStore, utils, runTag),
          });
          const { jobsByName, reconcileError } = reconciled;

          finalizeRequests(world.requests);
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
            runMs,
          });
          const counters = worker.supervisor.getCounters();
          const rejected = (cap) =>
            Object.fromEntries(cap.schedulers.map((s) => [s.scheduler, s.totals.rejectedTotal]));
          const agent = {
            agentErrors: worker.stats.agentErrors,
            dataOps: worker.stats.dataOps,
            firstAgentError: worker.stats.firstAgentError,
            crashes: worker.log.crashes,
          };
          const validityChecks = validity({
            lambda: c.lambda,
            measureMs: c.measureMs,
            measured: submission.n,
            stillInflight,
            admissionsPending: reconciled.admissions.pending,
            reconcileError,
            successWithoutJob: gt.successWithoutPersistedJob,
            doubleAdmissions: gt.doubleAdmissions,
            driverCpu: (cpu.user + cpu.system) / 1000 / wallMs,
            idlePublisherErrors: idle.state.errors,
            worker: {
              agentErrors: agent.agentErrors,
              crashes: agent.crashes,
              failedTerminal: counters.failedTerminal,
              succeeded: counters.succeeded,
              attempted: counters.attempted,
              dataOps: agent.dataOps,
            },
            seedFileVerified: c.seedFile ? seedLoad?.sha256 === c.seedFile.sha256 : true,
          });
          const summary = {
            schema: 1,
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
                observer: c.observer,
                rung: c.rung,
                lambda: c.lambda,
                content: c.content,
                aggregate: c.aggregate,
                repeat: c.repeat,
                seed: c.seed,
                observerMs: c.observerMs,
              },
              windows: { warmupMs: c.warmupMs, measureMs: c.measureMs, cooldownMs: c.cooldownMs },
              calibration: c.calibration,
              // sha256 is the manifest's, loadedSha256 the hash of the bytes this run loaded (validity.seedFileVerified
              // compares them)
              seedFile: c.seedFile && {
                path: c.seedFile.path,
                sha256: c.seedFile.sha256,
                loadedSha256: seedLoad?.sha256 ?? null,
                jobs: c.seedFile.jobs,
              },
            },
            submission,
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
            worker: {
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
            },
            readers: {
              n: reads.length,
              failed: reads.filter((e) => !e.ok).length,
              failFrac: reads.length ? reads.filter((e) => !e.ok).length / reads.length : null,
              latencyMs: summarize(reads.map((e) => e.ms)),
            },
            idlePublisher: idle.state,
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
            ['obs', world.observerEvents],
            ['read', world.readerEvents],
            ['claim', world.claimMs],
            ['done', world.completions],
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
          if (running) await within(Promise.allSettled([worker.supervisor.stop(), idle.stop()]), 25_000);
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

function verdictCommand(v) {
  if (!v.a) die(2, 'verdict needs --a DIR');
  const A = loadRecords(v.a, v.where);
  const B = v.b ? loadRecords(v.b, v.where) : [];
  const rule = v.rule;
  if (rule === 'ledger') {
    console.log(ledgerMarkdown([...A, ...B]));
    process.exit(0);
  }
  if (!['halve', 'flat', 'equal', 'aa'].includes(rule)) die(2, 'verdict needs --rule halve|flat|equal|aa|ledger');
  if (!v.b) die(2, `--rule ${rule} needs --b DIR`);
  if (rule === 'equal' && v.margin === undefined)
    die(2, '--rule equal needs --margin (declare it from the A/A pair first)');
  const margin = num(v.margin, null);
  if (rule === 'equal' && !(Number.isFinite(margin) && margin >= 0)) die(2, '--margin must be a non-negative number');
  const keyOf = rule === 'flat' ? (r) => pairKey(r, { ignoreHistory: true }) : (r) => r.key;
  const { pairs, missing } = pairRuns(A, B, keyOf, { ignoreSeed: rule === 'flat' });
  if (rule === 'aa') {
    // three repeats of EACH cell, whatever cell has a run in either arm: valid pairs of different cells do not add up
    const { have, cells } = repeatsPerCell(pairs, missing);
    const warnings = integrityWarnings([...A, ...B], pairs, null);
    console.log(JSON.stringify({ margin: noiseMargin(pairs), validPairs: have, cells, warnings, missing }));
    process.exit(have >= PAIRED_MIN ? 0 : 2);
  }
  const result =
    rule === 'halve'
      ? halve(pairs, { missing })
      : rule === 'flat'
        ? flat(pairs, { aRecords: A, bRecords: B, missing })
        : equivalent(pairs, margin, { missing });
  const g = guards(pairs);
  const warnings = integrityWarnings([...A, ...B], pairs, result);
  if (v.json) {
    console.log(JSON.stringify({ result, guards: g, missing, warnings }));
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
