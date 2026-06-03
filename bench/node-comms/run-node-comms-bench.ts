/**
 * Node-communication benchmark for the DKG.
 *
 * Spins up real DKGAgent nodes over loopback libp2p (no chain, no daemon) and
 * measures how long it takes one node to *sync a new thing* from another, plus
 * how much memory and disk that costs. Results are persisted so a daily run can
 * compare against a baseline and flag regressions (see `check-regression.ts`).
 *
 * Scenarios (all chain-free, exercising real P2P + SWM gossip + sync protocol):
 *
 *   1. swm_gossip_propagation_single
 *      Two connected, subscribed nodes. A shares ONE new entity to shared
 *      working memory; we measure the latency until B has it. This is the
 *      headline "time to sync a newly published item across the network".
 *
 *   2. swm_bulk_propagation
 *      A shares N separate entities back-to-back; we measure the time until B
 *      has received all N (throughput under a burst of new items) and record
 *      the disk + stored-quad footprint the sync left on the receiver.
 *
 *   3. swm_catchup_on_connect
 *      A already holds N entities in SWM. A fresh node B subscribes and only
 *      THEN connects, triggering sync-on-connect. We measure cold catch-up time
 *      (the sync protocol, not live gossip) — i.e. how long a node that joined
 *      late takes to pull existing shared state.
 *
 * Usage:
 *   tsx bench/node-comms/run-node-comms-bench.ts [options]
 *
 * Options (env var in parentheses):
 *   --iterations N          measured iterations per latency scenario (default 5)
 *   --catchup-iterations N  catch-up iterations, fresh node pair each (default min(iterations, 3))
 *   --bulk N                entities for the bulk/catch-up scenarios   (default 50)
 *   --warmups N             discarded warmup iterations                (default 2)
 *   --threshold N           regression threshold percent (BENCH_REGRESSION_THRESHOLD_PCT, default 15)
 *   --out DIR               results directory (default bench/results/node-comms)
 *   --baseline              after running, also save the result as baseline.json
 *   --no-check              skip the regression check (still writes results/history)
 *   --keep-data             do not delete the agents' temp data dirs (debug)
 *   --verbose               show the agents' raw DKG/libp2p logs (DKG_BENCH_VERBOSE=1)
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, hostname, platform, arch, cpus, totalmem } from 'node:os';
import { join } from 'node:path';
// Import the built agent entry directly (consistent with the existing ESBench
// suite importing `../packages/cli/src/...`). Bare deps inside the agent dist
// resolve from `packages/agent/node_modules`. Rebuild before running so this
// reflects current source — the daily runner does that automatically.
import { DKGAgent } from '../../packages/agent/dist/index.js';
import {
  MemorySampler,
  collectMetrics,
  directorySizeBytes,
  formatBytes,
  pollUntil,
  round,
  sleep,
  summarize,
  type NodeCommsResult,
  type ScenarioResult,
} from './lib.ts';
import { renderReport, runRegressionCheck, DEFAULT_THRESHOLD_PCT } from './check-regression.ts';

const NAME = 'http://schema.org/name';
const SYNC_TIMEOUT_MS = 30_000;
const SETTLE_MS = 1_500;

type Agent = Awaited<ReturnType<typeof DKGAgent.create>>;

interface Options {
  iterations: number;
  catchupIterations: number;
  bulk: number;
  warmups: number;
  thresholdPct: number;
  outDir: string;
  saveBaseline: boolean;
  check: boolean;
  keepData: boolean;
  verbose: boolean;
}

/**
 * The agent's structured logger writes `info` straight to stdout with no level
 * gate, which would bury the benchmark output. In quiet mode (default) we drop
 * the per-line DKG/connection log noise while letting our own output through.
 * `--verbose` (or DKG_BENCH_VERBOSE=1) keeps everything.
 */
function installLogFilter(): () => void {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // DKG structured logger: "YYYY-MM-DD HH:MM:SS <op> …"; node conn logger:
  // "[2026-…T…Z] …"; module console tags: "[dkg-core] …", "[ProtocolRouter] …".
  // Our own output never starts with a bracketed "[word] " token.
  const noisy = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+ |\[\d{4}-\d{2}-\d{2}T|\[[\w-]+\] )/;
  const make = (orig: typeof origOut) =>
    ((chunk: unknown, enc?: unknown, cb?: unknown): boolean => {
      const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
      if (text && noisy.test(text)) {
        if (typeof enc === 'function') (enc as () => void)();
        else if (typeof cb === 'function') (cb as () => void)();
        return true;
      }
      return (orig as (...args: unknown[]) => boolean)(chunk, enc, cb);
    }) as typeof origOut;
  process.stdout.write = make(origOut);
  process.stderr.write = make(origErr);
  return () => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  };
}

function parseArgs(argv: string[]): Options {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (flag: string, envVar: string | undefined, fallback: number): number => {
    const raw = get(flag) ?? (envVar ? process.env[envVar] : undefined);
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const iterations = num('--iterations', 'BENCH_NODE_COMMS_ITERATIONS', 5);
  return {
    iterations,
    // Catch-up spins up a fresh node pair per iteration and is dominated by the
    // sync-on-connect trigger delay, so it gets its own (smaller) default count
    // to keep the daily run bounded.
    catchupIterations: num('--catchup-iterations', 'BENCH_NODE_COMMS_CATCHUP_ITER', Math.min(iterations, 3)),
    bulk: num('--bulk', 'BENCH_NODE_COMMS_BULK', 50),
    warmups: num('--warmups', 'BENCH_NODE_COMMS_WARMUPS', 2),
    thresholdPct: num('--threshold', 'BENCH_REGRESSION_THRESHOLD_PCT', DEFAULT_THRESHOLD_PCT),
    outDir: get('--out') ?? join(process.cwd(), 'bench', 'results', 'node-comms'),
    saveBaseline: argv.includes('--baseline'),
    check: !argv.includes('--no-check'),
    keepData: argv.includes('--keep-data'),
    verbose: argv.includes('--verbose') || process.env.DKG_BENCH_VERBOSE === '1',
  };
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function parseCount(result: { type?: string; bindings?: Array<Record<string, string | undefined>> } | undefined): number {
  const raw = result?.bindings?.[0]?.['c'];
  if (!raw) return 0;
  const match = raw.match(/-?\d+/);
  return match ? Number(match[0]) : 0;
}

async function tcpAddr(agent: Agent): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const addr = agent.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'));
    if (addr) return addr;
    await sleep(50);
  }
  throw new Error('agent did not expose a TCP multiaddr in time');
}

/** Count distinct subjects in a CG's SWM whose URI starts with `prefix`. */
async function countSubjects(agent: Agent, cgId: string, prefix: string): Promise<number> {
  const result = await agent.query(
    `SELECT (COUNT(DISTINCT ?s) AS ?c) WHERE { ?s ?p ?o FILTER(STRSTARTS(STR(?s), "${prefix}")) }`,
    { contextGraphId: cgId, graphSuffix: '_shared_memory' },
  );
  return parseCount(result);
}

/** Total triple count in a CG's SWM partition (disk/space indicator). */
async function countSwmQuads(agent: Agent, cgId: string): Promise<number> {
  try {
    const result = await agent.query(
      'SELECT (COUNT(*) AS ?c) WHERE { ?s ?p ?o }',
      { contextGraphId: cgId, graphSuffix: '_shared_memory' },
    );
    return parseCount(result);
  } catch {
    return 0;
  }
}

async function entityPresent(agent: Agent, cgId: string, entity: string): Promise<boolean> {
  const result = await agent.query(
    `SELECT ?o WHERE { <${entity}> <${NAME}> ?o }`,
    { contextGraphId: cgId, graphSuffix: '_shared_memory' },
  );
  return (result.bindings?.length ?? 0) > 0;
}

function nameQuad(subject: string, value: string) {
  return { subject, predicate: NAME, object: `"${value}"`, graph: '' };
}

async function makeAgent(name: string, dataDir: string): Promise<Agent> {
  await mkdir(dataDir, { recursive: true });
  const agent = await DKGAgent.create({ name, listenPort: 0, dataDir, nodeRole: 'core' });
  await agent.start();
  return agent;
}

/**
 * Scenario 1 + 2: A and B are connected and subscribed. Measure single-item
 * propagation latency and a bulk burst.
 */
async function runLivePropagation(
  nodeA: Agent,
  nodeB: Agent,
  receiverDataDir: string,
  cgId: string,
  runId: string,
  opts: Options,
): Promise<{ single: ScenarioResult; bulk: ScenarioResult }> {
  // Warmup: graft the gossip mesh for the SWM topic so the first measured
  // iteration is not paying one-time mesh-formation cost.
  for (let w = 0; w < Math.max(opts.warmups, 1); w += 1) {
    const entity = `urn:bench:${runId}:warmup:${w}`;
    await nodeA.share(cgId, [nameQuad(entity, `warmup-${w}`)]);
    await pollUntil(() => entityPresent(nodeB, cgId, entity), (v) => v, { timeoutMs: SYNC_TIMEOUT_MS });
  }

  const singleSamples: number[] = [];
  for (let i = 0; i < opts.iterations; i += 1) {
    const entity = `urn:bench:${runId}:single:${i}`;
    const start = performance.now();
    await nodeA.share(cgId, [nameQuad(entity, `single-${i}`)]);
    // Fine poll interval: propagation is single-digit ms, so a coarse interval
    // would quantize the measurement (and inflate p95) by a whole interval.
    const r = await pollUntil(
      () => entityPresent(nodeB, cgId, entity),
      (v) => v,
      { timeoutMs: SYNC_TIMEOUT_MS, startedAt: start, intervalMs: 5 },
    );
    if ('timedOut' in r) {
      throw new Error(`single-item propagation timed out after ${round(r.elapsedMs)}ms (iteration ${i})`);
    }
    singleSamples.push(round(r.elapsedMs));
  }
  const singleFootprint = await measureReceiver(nodeB, receiverDataDir, cgId);

  const bulkSamples: number[] = [];
  for (let i = 0; i < opts.iterations; i += 1) {
    const prefix = `urn:bench:${runId}:bulk:${i}:`;
    const start = performance.now();
    for (let k = 0; k < opts.bulk; k += 1) {
      await nodeA.share(cgId, [nameQuad(`${prefix}${k}`, `bulk-${i}-${k}`)]);
    }
    const r = await pollUntil(
      () => countSubjects(nodeB, cgId, prefix),
      (count) => count >= opts.bulk,
      { timeoutMs: SYNC_TIMEOUT_MS, startedAt: start, intervalMs: 10 },
    );
    if ('timedOut' in r) {
      throw new Error(`bulk propagation timed out: only ${r.value}/${opts.bulk} synced after ${round(r.elapsedMs)}ms`);
    }
    bulkSamples.push(round(r.elapsedMs));
  }
  const bulkFootprint = await measureReceiver(nodeB, receiverDataDir, cgId);

  const bulkStats = summarize(bulkSamples);
  return {
    single: {
      description: 'Latency for a single newly-shared SWM entity to reach a connected, subscribed peer.',
      itemCount: 1,
      iterations: opts.iterations,
      samplesMs: singleSamples,
      durationMs: summarize(singleSamples),
      receiver: singleFootprint,
    },
    bulk: {
      description: `Time for a burst of ${opts.bulk} newly-shared SWM entities to fully reach a connected peer.`,
      itemCount: opts.bulk,
      iterations: opts.iterations,
      samplesMs: bulkSamples,
      durationMs: bulkStats,
      perItemMsMean: round(bulkStats.mean / Math.max(opts.bulk, 1)),
      receiver: bulkFootprint,
    },
  };
}

/** Disk + stored-quad footprint of a receiver's SWM after a settle/flush. */
async function measureReceiver(
  agent: Agent,
  dataDir: string,
  cgId: string,
): Promise<{ diskBytes: number; storeQuads: number }> {
  await sleep(500); // let the persistent store flush before sizing disk
  return {
    diskBytes: await directorySizeBytes(dataDir),
    storeQuads: await countSwmQuads(agent, cgId),
  };
}

/**
 * Scenario 3: cold catch-up. A holds N entities in SWM. A fresh B subscribes,
 * then connects — sync-on-connect must pull the existing shared state. Measured
 * once per (fresh-pair) iteration because it needs a clean late-joiner each time.
 */
async function runCatchup(
  cgId: string,
  runId: string,
  baseDir: string,
  opts: Options,
  registerCleanup: (dir: string) => void,
): Promise<ScenarioResult> {
  const samples: number[] = [];
  let lastReceiverDisk = 0;
  let lastReceiverQuads = 0;

  for (let i = 0; i < opts.catchupIterations; i += 1) {
    const dirA = await mkdtemp(join(baseDir, `catchup-A-${i}-`));
    const dirB = await mkdtemp(join(baseDir, `catchup-B-${i}-`));
    registerCleanup(dirA);
    registerCleanup(dirB);
    const seedAgent = await makeAgent(`catchupA-${i}`, dirA);
    const joiner = await makeAgent(`catchupB-${i}`, dirB);
    try {
      const iterCg = `${cgId}-${i}`;
      const prefix = `urn:bench:${runId}:catchup:${i}:`;
      await seedAgent.createContextGraph({ id: iterCg, name: `catchup-${runId}-${i}` });
      seedAgent.subscribeToContextGraph(iterCg);
      // Seed via the normal share() path while the joiner is still offline:
      // data is written to real SWM (Oxigraph) and gossip is attempted; with no
      // peer connected yet nothing is delivered live, so the late joiner must
      // pull via sync-on-connect — not localOnly (which skips gossip entirely).
      for (let k = 0; k < opts.bulk; k += 1) {
        await seedAgent.share(iterCg, [nameQuad(`${prefix}${k}`, `catchup-${i}-${k}`)]);
      }
      const seeded = await countSubjects(seedAgent, iterCg, prefix);
      if (seeded < opts.bulk) {
        throw new Error(`seed node only has ${seeded}/${opts.bulk} entities in SWM before catch-up`);
      }

      const addrA = await tcpAddr(seedAgent);
      // A realistic late joiner already knows the (open) CG: create it locally
      // so SWM reads are authorized and the CG is in the joiner's sync scope,
      // then connect — that is what triggers sync-on-connect catch-up.
      await joiner.createContextGraph({ id: iterCg, name: `catchup-${runId}-${i}` });
      joiner.subscribeToContextGraph(iterCg);
      await sleep(200);

      const start = performance.now();
      await joiner.connectTo(addrA);
      const r = await pollUntil(
        () => countSubjects(joiner, iterCg, prefix),
        (count) => count >= opts.bulk,
        { timeoutMs: SYNC_TIMEOUT_MS, startedAt: start, intervalMs: 40 },
      );
      if ('timedOut' in r) {
        throw new Error(`catch-up sync timed out: only ${r.value}/${opts.bulk} synced after ${round(r.elapsedMs)}ms`);
      }
      samples.push(round(r.elapsedMs));

      const footprint = await measureReceiver(joiner, dirB, iterCg);
      lastReceiverDisk = footprint.diskBytes;
      lastReceiverQuads = footprint.storeQuads;
    } finally {
      await seedAgent.stop().catch(() => {});
      await joiner.stop().catch(() => {});
    }
  }

  return {
    description: `Cold catch-up: a late-joining node syncs ${opts.bulk} pre-existing SWM entities via sync-on-connect.`,
    itemCount: opts.bulk,
    iterations: opts.catchupIterations,
    samplesMs: samples,
    durationMs: summarize(samples),
    perItemMsMean: round(summarize(samples).mean / Math.max(opts.bulk, 1)),
    receiver: { diskBytes: lastReceiverDisk, storeQuads: lastReceiverQuads },
  };
}

async function main(): Promise<void> {
  process.env.DKG_LOG_LEVEL = process.env.DKG_LOG_LEVEL ?? 'error';
  const opts = parseArgs(process.argv.slice(2));
  const restoreLogs = opts.verbose ? () => {} : installLogFilter();
  const runId = `${Date.now().toString(36)}`;
  await mkdir(opts.outDir, { recursive: true });

  const baseDir = await mkdtemp(join(tmpdir(), 'dkg-node-comms-bench-'));
  const cleanupDirs: string[] = [baseDir];
  const registerCleanup = (dir: string) => cleanupDirs.push(dir);

  const memory = new MemorySampler();
  memory.start();

  console.log(`\n▶ node-comms benchmark  (run ${runId})`);
  console.log(`  iterations=${opts.iterations}  catchup-iterations=${opts.catchupIterations}  bulk=${opts.bulk}  warmups=${opts.warmups}  threshold=+${opts.thresholdPct}%`);
  console.log(`  temp data: ${baseDir}`);

  const scenarios: Record<string, ScenarioResult> = {};
  let nodeA: Agent | undefined;
  let nodeB: Agent | undefined;
  let finalDiskA = 0;
  let finalDiskB = 0;
  let exitCode = 0;

  try {
    try {
      const dirA = join(baseDir, 'live-A');
      const dirB = join(baseDir, 'live-B');
      console.log('  • starting two connected nodes (A, B)…');
      nodeA = await makeAgent('liveA', dirA);
      nodeB = await makeAgent('liveB', dirB);
      await sleep(500);

      const addrA = await tcpAddr(nodeA);
      await nodeB.connectTo(addrA);
      await sleep(500);

      const liveCg = `node-comms-live-${runId}`;
      await nodeA.createContextGraph({ id: liveCg, name: 'Node Comms Live' });
      nodeA.subscribeToContextGraph(liveCg);
      nodeB.subscribeToContextGraph(liveCg);
      await sleep(SETTLE_MS);

      console.log('  • scenario 1+2: live gossip propagation (single + bulk)…');
      const live = await runLivePropagation(nodeA, nodeB, dirB, liveCg, runId, opts);
      scenarios['swm_gossip_propagation_single'] = live.single;
      scenarios['swm_bulk_propagation'] = live.bulk;
      console.log(`      single median ${live.single.durationMs.median}ms  p95 ${live.single.durationMs.p95}ms`);
      console.log(`      bulk(${opts.bulk}) median ${live.bulk.durationMs.median}ms  (${live.bulk.perItemMsMean}ms/item)`);

      console.log('  • scenario 3: cold catch-up via sync-on-connect…');
      scenarios['swm_catchup_on_connect'] = await runCatchup(
        `node-comms-catchup-${runId}`,
        runId,
        baseDir,
        opts,
        registerCleanup,
      );
      console.log(`      catch-up median ${scenarios['swm_catchup_on_connect'].durationMs.median}ms`);

      await sleep(600);
      finalDiskA = await directorySizeBytes(dirA);
      finalDiskB = await directorySizeBytes(dirB);
    } finally {
      await nodeA?.stop().catch(() => {});
      await nodeB?.stop().catch(() => {});
    }

    const mem = memory.stop();

    const result: NodeCommsResult = {
      schemaVersion: 1,
      benchmark: 'node-comms',
      timestamp: new Date().toISOString(),
      env: {
        nodeVersion: process.version,
        platform: platform(),
        arch: arch(),
        cpus: cpus().length,
        totalMemBytes: totalmem(),
        hostname: hostname(),
        gitCommit: git(['rev-parse', 'HEAD']),
        gitBranch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      },
      config: {
        iterations: opts.iterations,
        catchupIterations: opts.catchupIterations,
        bulk: opts.bulk,
        warmups: opts.warmups,
        thresholdPct: opts.thresholdPct,
      },
      scenarios,
      process: mem,
      disk: { nodeA: { dataDirBytes: finalDiskA }, nodeB: { dataDirBytes: finalDiskB } },
    };

    const latestPath = join(opts.outDir, 'latest.json');
    await writeFile(latestPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(`\n  wrote ${latestPath}`);
    console.log(`  peak RSS ${formatBytes(mem.peakRssBytes)}  •  receiver disk A ${formatBytes(finalDiskA)} / B ${formatBytes(finalDiskB)}`);

    // Regression check uses a pinned baseline.json or a rolling-median of prior
    // history runs. Run it BEFORE appending this run to history, and exclude the
    // current run's timestamp, so the reference is strictly the *previous* runs.
    let shouldFail = false;
    if (opts.check) {
      const report = await runRegressionCheck({
        result,
        dir: opts.outDir,
        thresholdPct: opts.thresholdPct,
        excludeTimestamp: result.timestamp,
      });
      console.log(renderReport(report));
      shouldFail = report.shouldFail;
    }

    // Append to history (NDJSON of curated metrics) for day-over-day trends.
    const historyLine = JSON.stringify({
      timestamp: result.timestamp,
      gitCommit: result.env.gitCommit,
      gitBranch: result.env.gitBranch,
      metrics: collectMetrics(result),
    });
    await appendFile(join(opts.outDir, 'history.ndjson'), `${historyLine}\n`, 'utf8');

    if (opts.saveBaseline) {
      await copyFile(latestPath, join(opts.outDir, 'baseline.json'));
      console.log(`  saved baseline.json`);
    }

    // Exit non-zero on an enforced, flagged regression so a daily cron/launchd
    // job can alert — unless we're (re)establishing a baseline or checks are off.
    exitCode = opts.check && !opts.saveBaseline && shouldFail ? 1 : 0;
  } catch (error) {
    console.error('\n✗ node-comms benchmark failed:');
    console.error(error);
    exitCode = 2;
  } finally {
    // Always release resources, even on failure: stop the sampler, remove temp
    // data dirs, and restore stdout/stderr.
    memory.stop();
    if (!opts.keepData) {
      for (const dir of cleanupDirs) {
        if (existsSync(dir)) await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    } else {
      console.log(`  kept temp data dirs (--keep-data): ${baseDir}`);
    }
    restoreLogs();
  }

  process.exit(exitCode);
}

main().catch((error) => {
  console.error('\n✗ node-comms benchmark failed:');
  console.error(error);
  process.exit(2);
});
