/**
 * Live managed-Oxigraph ownership gate — generator (#2052 Stack B2).
 *
 * Launches the checksum-pinned Oxigraph v0.5.8 server, seeds reserved
 * system-record V1 state directly into it, and then drives the real production
 * store stack against that live endpoint. Unit tests and the embedded adapter
 * cannot satisfy this gate: the properties being proven are about a separate
 * OS process, its listen socket, and what a predecessor binary can observe.
 *
 * Emits `artifacts/managed-ownership-result.json`. `verify.ts` turns that into
 * the verdict and throws on any violation.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH,
  SYSTEM_RECORD_V1_STATE_GRAPH,
  createTripleStore,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
// The gate exercises the daemon-internal ownership authority on purpose, so it
// uses the internal entry point the daemon itself uses (#2165).
import {
  attachManagedOxigraphLeaseV1,
  createManagedOxigraphOwnershipControllerV1,
  type ManagedOxigraphSupervisorHandoffV1,
} from '@origintrail-official/dkg-storage/internal/managed-oxigraph-ownership-v1';
// Relative source import: the CLI package does not export this subpath, and the
// gate must use the SAME pinned-asset table production uses rather than
// restating a version or checksum that could silently drift from it.
import {
  OXIGRAPH_VERSION,
  ensureOxigraphBinary,
} from '../../packages/cli/src/daemon/oxigraph-binary.js';
// The REAL supervisor. Driving it is the difference between proving the handoff
// and asserting that a hand-minted lease still looks the way it was minted.
import { startOxigraphServer } from '../../packages/cli/src/daemon/oxigraph-server.js';

import {
  MANAGED_OWNERSHIP_RAW_SCHEMA_VERSION,
  type LiveHandoffMeasurementV1,
  type ManagedOwnershipRawResultV1,
  type CurrentBinaryConformanceV1,
} from './model.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACT = join(HERE, 'artifacts', 'managed-ownership-result.json');
const MANIFEST = join(HERE, 'fixtures', 'system-record-predecessors-v1.json');
const STOP_GRACE_MS = 5_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'string' || !address) {
        reject(new Error('could not resolve an ephemeral port'));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });
}

interface LiveServer {
  readonly child: ChildProcess;
  readonly port: number;
  readonly queryEndpoint: string;
  readonly updateEndpoint: string;
  stop(): Promise<void>;
}

async function startPinnedServer(binaryPath: string, location: string): Promise<LiveServer> {
  const port = await freePort();
  const child = spawn(binaryPath, ['serve', '--location', location, '--bind', `127.0.0.1:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const queryEndpoint = `http://127.0.0.1:${port}/query`;
  const updateEndpoint = `http://127.0.0.1:${port}/update`;

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`pinned Oxigraph ${OXIGRAPH_VERSION} did not become ready on :${port}`);
    }
    try {
      const res = await fetch(queryEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sparql-query' },
        body: 'ASK { ?s ?p ?o }',
        signal: AbortSignal.timeout(1_000),
      });
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }

  return {
    child,
    port,
    queryEndpoint,
    updateEndpoint,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((done) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
        child.once('exit', () => {
          clearTimeout(timer);
          done();
        });
        child.kill('SIGTERM');
      });
    },
  };
}

async function sparqlUpdate(endpoint: string, body: string): Promise<void> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sparql-update' },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`seed update failed (${res.status}): ${await res.text()}`);
}

async function countQuadsInGraph(endpoint: string, graph: string): Promise<number> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/sparql-query',
      Accept: 'application/sparql-results+json',
    },
    body: `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${graph}> { ?s ?p ?o } }`,
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json()) as { results?: { bindings?: { c?: { value?: string } }[] } };
  return Number(json.results?.bindings?.[0]?.c?.value ?? '0');
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Drive ONE real generation handoff and measure it.
 *
 * Everything here is production wiring: `startOxigraphServer` owns and spawns
 * the child, its `ownership.lease` and `supervisorHandoff` travel to the adapter
 * under the symbol key exactly as the daemon composes them, and the lane's
 * transition runs through the process-global store scheduler's control barrier.
 * The only interposition is a timestamp around each supervisor half, which
 * delegates straight through.
 *
 * The probe workload is a LARGE ordinary insert rather than a synthetic hold:
 * it is a single scheduler admission and a single HTTP request over the store's
 * own path, it takes long enough to still be running when the lane is asked to
 * open, and interrupting it is precisely the harm the barrier prevents.
 */
/**
 * Release every resource acquired so far, newest first, each independently.
 *
 * The gate previously ran its four teardown steps as bare statements on the
 * SUCCESS tail, so any throw in between left a live Oxigraph child holding an
 * ephemeral port, a temp RocksDB directory, an un-closed store and — once the
 * capability probe had run — the process-global lane registration. The dominant
 * throw site is `lane.open()`, which rejects on any failed handoff step: the
 * leak was most likely exactly when the gate was doing its job and detecting a
 * broken handoff. On `ubuntu-latest` a non-detached child is re-parented rather
 * than reaped, so it would outlive the job holding its port.
 *
 * Each step is caught independently, so one failure cannot skip the rest, and
 * none of them can mask the original error — a teardown failure must never hide
 * the finding that caused it.
 */
async function releaseAll(stack: Array<() => Promise<unknown>>): Promise<void> {
  for (const step of stack.reverse()) {
    try {
      await step();
    } catch (error) {
      console.error(`[managed-ownership-gate] teardown step failed: ${String(error)}`);
    }
  }
}

async function measureLiveHandoff(binaryPath: string): Promise<LiveHandoffMeasurementV1> {
  const cleanup: Array<() => Promise<unknown>> = [];
  try {
    return await runLiveHandoff(binaryPath, cleanup);
  } finally {
    await releaseAll(cleanup);
  }
}

async function runLiveHandoff(
  binaryPath: string,
  cleanup: Array<() => Promise<unknown>>,
): Promise<LiveHandoffMeasurementV1> {
  const spawnedPids: number[] = [];
  const location = join(tmpdir(), 'dkg-managed-ownership-gate', `handoff-${process.pid}`);
  await rm(location, { recursive: true, force: true });
  await mkdir(location, { recursive: true });
  cleanup.push(() => rm(location, { recursive: true, force: true }));

  const handle = await startOxigraphServer({
    binaryPath,
    location,
    port: await freePort(),
    log: () => {},
    io: {
      // An observer, not a stub: the real `spawn` runs and its child is
      // returned untouched. Recording the PIDs is what turns "the generation
      // string changed" into "a different OS process serves the socket".
      spawn: ((...args: Parameters<typeof spawn>) => {
        const child = spawn(...args);
        if (typeof child.pid === 'number') spawnedPids.push(child.pid);
        return child;
      }) as typeof spawn,
    },
  });
  cleanup.push(() => handle.stop());

  // Read at the exact instant the supervisor is asked to kill the child, from
  // the scheduler's own counters.
  //
  // Deliberately NOT a wall-clock comparison against the probe write's promise.
  // That was the first shape and it is subtly wrong: the scheduler releases
  // admission when the store work resolves, and the caller's promise settles a
  // few microtasks LATER, through `workLifecycle` and `insert`'s own tail. A
  // correct handoff therefore measured as "stop came 0.09 ms too early" — a
  // check that would have to be given a magic tolerance to pass. The inflight
  // count has no such boundary: it is the very quantity the barrier waits on.
  let inflightWhenChildStopped = -1;
  let supervisorStops = 0;
  // A gate on the supervisor's START step, so the harness can hold a re-open
  // open and drive a real CONCURRENT interleaving rather than only sequential
  // transitions. This is the difference between a gate that pins the happy path
  // and one that can catch the round-2 blocker.
  // A holder rather than plain `let`s: assigned only inside `armStartGate`,
  // TypeScript narrows bare locals to `null` at the call site and reports the
  // release as uncallable.
  const startGate: {
    hold: Promise<void> | null;
    release: () => void;
    reached: Promise<void>;
    arrive: () => void;
  } = { hold: null, release: () => {}, reached: Promise.resolve(), arrive: () => {} };
  const armStartGate = (): void => {
    startGate.hold = new Promise<void>((r) => { startGate.release = r; });
    startGate.reached = new Promise<void>((r) => { startGate.arrive = r; });
  };
  const observedHandoff: ManagedOxigraphSupervisorHandoffV1 = {
    stopAndProveOwnedChildDead: async () => {
      supervisorStops += 1;
      // Optional on the interface; absent here would leave the reading at its
      // -1 sentinel, which the verdict rejects rather than treating as zero.
      const p = store.getPressureSnapshot?.();
      if (p) {
        // Only the FIRST stop is the measured handoff; the shutdown teardown
        // stops the child again and would otherwise overwrite the reading.
        if (inflightWhenChildStopped < 0) {
          inflightWhenChildStopped =
            p.ackInflight + (p.healthInflight ?? 0) + p.normalInflight + p.backgroundInflight;
        }
      }
      await handle.supervisorHandoff.stopAndProveOwnedChildDead();
    },
    startAndProveCleanGeneration: async () => {
      await handle.supervisorHandoff.startAndProveCleanGeneration();
      if (startGate.hold) {
        const held = startGate.hold;
        startGate.hold = null;
        startGate.arrive();
        await held;
      }
    },
  };

  const store = await createTripleStore({
    backend: 'sparql-http',
    options: attachManagedOxigraphLeaseV1(
      {
        queryEndpoint: handle.queryEndpoint,
        updateEndpoint: handle.updateEndpoint,
        managedByDkg: true,
        // Generous: the probe write is deliberately large, and cutting it short
        // on the adapter's own deadline would prove nothing about the barrier.
        timeout: 120_000,
      },
      handle.ownership.lease,
      observedHandoff,
    ) as Record<string, unknown>,
    graphSetIndex: false,
  });
  cleanup.push(() => store.close());

  const lane = store.getSystemRecordLaneControllerV1?.();
  if (!lane) throw new Error('managed store did not advertise the system-record lane');

  const LOAD_GRAPH = 'urn:dkg:gate:handoff-load';
  const LOAD_QUADS = 60_000;
  const quads = Array.from({ length: LOAD_QUADS }, (_, i) => ({
    graph: LOAD_GRAPH,
    subject: `urn:dkg:gate:s:${i}`,
    predicate: 'urn:dkg:gate:p',
    object: `payload-${i}-${'x'.repeat(24)}`,
  }));

  let ordinaryWriteFailure: string | null = null;
  const inflight = store.insert(quads).then(
    () => undefined,
    (error: unknown) => {
      ordinaryWriteFailure = error instanceof Error ? error.message : String(error);
    },
  );

  // OBSERVE admission rather than sleeping for it.
  //
  // A fixed 250 ms sleep was raced against the payload: measured here the write
  // commits in ~2.1-2.3 s, so it happened to hold — but the margin was an
  // accident of the payload size, and on a faster runner a CORRECT handoff would
  // have failed `ordinaryWriteStillInflightWhenLaneOpened` and burned the job.
  //
  // The witness is also sampled at the right layer now. `ordinarySettled` on the
  // CALLER's promise is the wrong quantity for the same reason the wall-clock
  // ordering check was: the scheduler releases admission when the store work
  // resolves, a few microtasks earlier. Reading `getPressureSnapshot()` — the
  // exact counter the barrier gates on, and the one the other half of this pair
  // already reads — closes a marginal window in which both halves could be green
  // and vacuous at once.
  const observedInflight = async (): Promise<number> => {
    const p = store.getPressureSnapshot?.();
    if (!p) return -1;
    return p.ackInflight + (p.healthInflight ?? 0) + p.normalInflight + p.backgroundInflight;
  };

  const admissionDeadline = Date.now() + 30_000;
  let ordinaryInflightAtOpen = false;
  for (;;) {
    if ((await observedInflight()) > 0) {
      ordinaryInflightAtOpen = true;
      break;
    }
    // Bounded, and it FAILS the verdict rather than proceeding vacuously: an
    // overlap we could not observe proves nothing about the barrier.
    if (Date.now() > admissionDeadline) break;
    await sleep(5);
  }

  const generationBefore = handle.ownership.snapshot().childGeneration;
  const session = await lane.open({
    networkId: 'testnet',
    kinds: ['agents'],
    mode: 'shadow',
  });
  // Shutdown also releases the process-global lane registration, which the
  // capability matrix needs. Registering it here means a throw between this
  // point and the explicit shutdown below cannot strand it.
  cleanup.push(() => session.close('shutdown'));
  await inflight;

  const generationAfter = handle.ownership.snapshot().childGeneration;
  const laneStateAfterHandoff = session.state;
  const quadsVisibleAfterHandoff = await countQuadsInGraph(handle.queryEndpoint, LOAD_GRAPH);
  let servedAfterHandoff = false;
  try {
    await store.query('ASK { ?s ?p ?o }');
    servedAfterHandoff = true;
  } catch {
    servedAfterHandoff = false;
  }

  // Captured BEFORE the shutdown section: these describe the HANDOFF. Read
  // afterwards they are answering a different question — the teardown stops the
  // replacement too, so `replacementPidAlive` would be false for a perfectly
  // correct run. (Observed: it went red exactly this way the first time.)
  const retiredPidAlive = pidAlive(spawnedPids[0]!);
  const replacementPidAlive = pidAlive(spawnedPids[spawnedPids.length - 1]!);

  // ---- Terminal lifecycle, against the real supervisor.
  //
  // The gate previously drove `close('shutdown')` and threw its outcome away:
  // `laneState` was captured BEFORE it, and the call itself was
  // `.catch(() => undefined)`. Shutdown is the operation carrying every
  // invariant this stack exists for, and BOTH review rounds found their blockers
  // in it — so the only harness that drives the real supervisor asserted nothing
  // about the one thing that mattered.
  // THE ROUND-2 INTERLEAVING, driven live.
  //
  // A sequential `close('shutdown')` on a quiesced lane behaves correctly even
  // in the pre-fix model — I measured that: with the old materializer built into
  // `dist/`, every terminal check below still passed. A gate that only drives
  // the sequential path is a regression pin, not a discriminator.
  //
  // So this reproduces the reported defect instead: disable, start a re-open and
  // HOLD it inside the supervisor's start step, request shutdown while it is
  // held, release the re-open so its `finally` runs (the pointer-erasure window),
  // then request a disable. Pre-fix that disable is admitted and writes
  // `disabled` over the committed terminal state.
  await session.close('disable');
  armStartGate();
  const reopen = lane
    .open({ networkId: 'testnet', kinds: ['agents'], mode: 'shadow' })
    .then(() => undefined, () => undefined);
  await startGate.reached;

  const stopsBeforeShutdown = supervisorStops;
  const pidsBeforeShutdown = spawnedPids.length;
  let shutdownFailure: string | null = null;
  const shutdown = session.close('shutdown').then(
    () => undefined,
    (error: unknown) => {
      shutdownFailure = error instanceof Error ? error.message : String(error);
    },
  );

  // Release the held re-open: its `finally` runs here, which is exactly where
  // the shutdown entry used to be erased.
  startGate.release();
  await reopen;
  // A disable issued into that window. Pre-fix it saw no shutdown pointer and a
  // non-terminal state, was admitted, and committed `disabled` afterwards.
  const racingDisable = session.close('disable').catch(() => undefined);
  await shutdown;
  await racingDisable;

  const laneStateAfterShutdown = session.state;
  const stopsDuringShutdown = supervisorStops - stopsBeforeShutdown;

  // A second shutdown must be a no-op, not a second child signal. Each teardown
  // signals a child and asserts a port fact, so "idempotent" has to be measured.
  await session.close('shutdown').catch(() => undefined);
  const stopsAfterSecondShutdown = supervisorStops - stopsBeforeShutdown;

  // A dispatch and a re-open must both be refused on a terminal lane. The
  // re-open check is the one with a process fact behind it: `spawnedPids` is
  // recorded from the real `spawn`, so "no child was started after shutdown" is
  // observed, not inferred from a state string.
  const applyAfterShutdown = (await session.applyVerified({})).outcome;
  let reopenRefused = false;
  try {
    await lane.open({ networkId: 'testnet', kinds: ['agents'], mode: 'shadow' });
  } catch {
    reopenRefused = true;
  }
  const childrenSpawnedAfterShutdown = spawnedPids.length - pidsBeforeShutdown;

  return {
    generationBefore,
    generationAfter,
    spawnedPids: [...spawnedPids],
    retiredPidAlive,
    replacementPidAlive,
    ordinaryInflightAtOpen,
    ordinaryWriteFailure,
    inflightWhenChildStopped,
    laneState: laneStateAfterHandoff,
    quadsVisibleAfterHandoff,
    quadsWrittenBeforeHandoff: ordinaryWriteFailure === null ? LOAD_QUADS : 0,
    servedAfterHandoff,
    laneStateAfterShutdown,
    shutdownFailure,
    stopsDuringShutdown,
    stopsAfterSecondShutdown,
    applyAfterShutdown,
    reopenRefused,
    childrenSpawnedAfterShutdown,
  };
}

/**
 * Exact-quad existence probe.
 *
 * Deliberately not a graph total: a canary asserted by count can be masked by
 * any unrelated insertion into the same graph, which is how a check quietly
 * stops testing what it names.
 */
async function askExactQuad(
  endpoint: string,
  graph: string,
  subject: string,
  predicate: string,
): Promise<boolean> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/sparql-query',
      Accept: 'application/sparql-results+json',
    },
    body: `ASK { GRAPH <${graph}> { <${subject}> <${predicate}> ?o } }`,
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json()) as { boolean?: boolean };
  return json.boolean === true;
}

interface Manifest {
  reservedGraphs: string[];
  entries: {
    id: string;
    commit: string;
    nodeVersion: string;
    seededReservedState: string;
    expected: Record<string, boolean>;
  }[];
  fixtures: Record<
    string,
    {
      quads: { graph: string; subject: string; predicate: string; object: string }[];
      expectedQuadCount: number;
    }
  >;
}

async function main(): Promise<void> {
  // Delete any previous artifact FIRST. Without this, a run that throws part
  // way through leaves the last successful result on disk, and the standalone
  // `verify` script will cheerfully re-verify it and exit 0 — certifying a run
  // that crashed. Demonstrated: a malformed manifest crashed the generator and
  // the stale artifact still verified as PASS.
  await rm(ARTIFACT, { force: true });
  await rm(join(HERE, 'artifacts', 'managed-ownership-verdict.json'), { force: true });

  // Strip a UTF-8 BOM if an editor or shell redirect added one. `JSON.parse`
  // rejects it, and that crash is exactly what exposed the stale-artifact hole
  // above, so tolerating it here removes a foot-gun rather than hiding one.
  const manifestText = (await readFile(MANIFEST, 'utf8')).replace(/^﻿/, '');
  const manifest = JSON.parse(manifestText) as Manifest;

  const cacheDir = join(tmpdir(), 'dkg-managed-ownership-gate', 'oxigraph');
  await mkdir(cacheDir, { recursive: true });
  const binaryPath = await ensureOxigraphBinary({ cacheDir, log: () => {} });
  const binarySha256 = createHash('sha256')
    .update(await readFile(binaryPath))
    .digest('hex');

  // FIRST, because it drives the real supervisor end to end and its lane
  // shutdown is what releases the process-global controller registration the
  // capability matrix below needs.
  const liveHandoff = await measureLiveHandoff(binaryPath);

  // `rm` FIRST, and remove it again in the `finally` below. Neither happened:
  // the directory is named by PID, was never cleaned, and 12 of them had
  // accumulated locally. On a PID collision the seed lands on top of leftover
  // reserved quads, `seededQuadCount` reads 4 against an expected 2, and every
  // predecessor row fails — a false RED with a thoroughly misleading cause.
  const location = join(tmpdir(), 'dkg-managed-ownership-gate', `store-${process.pid}`);
  await rm(location, { recursive: true, force: true });
  await mkdir(location, { recursive: true });

  const server = await startPinnedServer(binaryPath, location);

  // Every pinned commit must exist in this repository. This is the check that
  // would have caught a manifest entry carrying a short SHA zero-padded to 40
  // characters — which is not a commit, resolves to nothing, and was being
  // copied verbatim into the artifact CI uploads as evidence.
  const manifestCommitsResolved = manifest.entries.every((entry) => {
    try {
      execFileSync('git', ['cat-file', '-e', `${entry.commit}^{commit}`], {
        cwd: resolve(HERE, '../..'),
        stdio: 'ignore',
      });
      return true;
    } catch {
      console.error(`[managed-ownership-gate] manifest commit does not resolve: ${entry.commit}`);
      return false;
    }
  });

  let currentBinaryConformance: CurrentBinaryConformanceV1 | null = null;
  const capability = {
    withoutLease: false,
    withLeaseWithoutHandoff: false,
    withTerminalOwnership: false,
    withLiveLeaseAndHandoff: false,
    throughEnabledChangelog: false,
  };

  try {
    // ---- Seed reserved state directly, so the store stack observes state it
    // ---- did not write, exactly as a predecessor binary would.
    const fixture = manifest.fixtures['reserved-state-fixture-v1'];
    const triples = fixture.quads
      .map((q) => `GRAPH <${q.graph}> { <${q.subject}> <${q.predicate}> ${q.object} . }`)
      .join('\n');
    await sparqlUpdate(server.updateEndpoint, `INSERT DATA {\n${triples}\n}`);

    const seededQuadCount =
      (await countQuadsInGraph(server.queryEndpoint, SYSTEM_RECORD_V1_STATE_GRAPH)) +
      (await countQuadsInGraph(server.queryEndpoint, SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH));

    // ---- Capability fail-closed matrix against the LIVE endpoint.
    const ownership = createManagedOxigraphOwnershipControllerV1(
      server.queryEndpoint,
      server.updateEndpoint,
    );
    ownership.bindReadyGeneration();
    const handoff: ManagedOxigraphSupervisorHandoffV1 = {
      stopAndProveOwnedChildDead: async () => undefined,
      startAndProveCleanGeneration: async () => undefined,
    };
    const base = { queryEndpoint: server.queryEndpoint, updateEndpoint: server.updateEndpoint };

    const build = async (
      options: Record<string, unknown>,
      changelog?: boolean,
    ): Promise<TripleStore> =>
      createTripleStore({
        backend: 'sparql-http',
        options,
        graphSetIndex: true,
        ...(changelog === undefined ? {} : { changelog }),
      });

    const plain = await build({ ...base });
    capability.withoutLease = plain.getSystemRecordLaneControllerV1?.() !== undefined;

    const leaseOnly = await build(
      attachManagedOxigraphLeaseV1({ ...base, managedByDkg: true }, ownership.lease) as Record<
        string,
        unknown
      >,
    );
    capability.withLeaseWithoutHandoff =
      leaseOnly.getSystemRecordLaneControllerV1?.() !== undefined;

    // ORDER IS LOAD-BEARING, and it was wrong.
    //
    // Probing `full` REGISTERS the process-global controller. From that moment
    // every later probe that reaches the factory gets
    // SYSTEM_RECORD_DUPLICATE_CONTROLLER, which the adapter swallows and reports
    // as `undefined`. So with `full` probed third, the two negative checks after
    // it — enabled-changelog and terminal-ownership — were satisfied by that
    // backstop rather than by the guards they name, and REMOVING either guard
    // would not have turned them red. Two checks that could not fail.
    //
    // Every NEGATIVE case is now probed while the registry is still empty, and
    // `full` goes last. The coupling that remains is honest and loud: if a
    // negative case wrongly advertises, it takes the registration and
    // `capabilityPresentWhenFullyProven` goes red.
    const withChangelog = await build(
      attachManagedOxigraphLeaseV1(
        { ...base, managedByDkg: true },
        ownership.lease,
        handoff,
      ) as Record<string, unknown>,
      true,
    );
    capability.throughEnabledChangelog =
      withChangelog.getSystemRecordLaneControllerV1?.() !== undefined;

    const terminalOwnership = createManagedOxigraphOwnershipControllerV1(
      server.queryEndpoint,
      server.updateEndpoint,
    );
    terminalOwnership.bindReadyGeneration();
    terminalOwnership.invalidate('port-release-unproven');
    const terminal = await build(
      attachManagedOxigraphLeaseV1(
        { ...base, managedByDkg: true },
        terminalOwnership.lease,
        handoff,
      ) as Record<string, unknown>,
    );
    capability.withTerminalOwnership =
      terminal.getSystemRecordLaneControllerV1?.() !== undefined;

    const full = await build(
      attachManagedOxigraphLeaseV1(
        { ...base, managedByDkg: true },
        ownership.lease,
        handoff,
      ) as Record<string, unknown>,
    );
    capability.withLiveLeaseAndHandoff =
      full.getSystemRecordLaneControllerV1?.() !== undefined;

    // No owned-client socket probe. The pool moved to Stack B3 with the class
    // that owns it; measuring it here would exercise a capability that no B2
    // production path can reach.
    // ---- Reserved-state conformance: ONE probe, against the current binary.
    //
    // Reported once and honestly. An earlier revision iterated the manifest and
    // emitted a `pass` per pinned commit, which published green PREDECESSOR
    // verdicts that nothing measured — no predecessor is checked out or built,
    // so every row ran this same binary and the rows were identical by
    // construction. The manifest keeps its real job, a reviewed inventory of the
    // commits that must retain the property with each proven to resolve, and
    // carries no pass/fail field to be misread.
    {
      const failures: string[] = [];

      // The deletion probe below is destructive, so seed immediately before it.
      // This is also why the old per-entry loop could not work: the first row's
      // `dropGraph` either failed (as it must) or emptied the graph, after which
      // later rows read before=0/after=0, `after < before` was false, and they
      // PASSED. Only the first row could ever detect a deletion.
      await sparqlUpdate(server.updateEndpoint, `INSERT DATA {\n${triples}\n}`);

      const listed = await full.listGraphs();
      const enumerated = manifest.reservedGraphs.filter((g) => listed.includes(g));
      if (enumerated.length > 0) {
        failures.push(`enumerated reserved graphs: ${enumerated.join(', ')}`);
      }

      // Enumeration is checked on the index-free composition TOO. `full` is
      // built with `graphSetIndex: true`, and both that decorator and the
      // adapter filter the internal prefix — so with only `full` measured,
      // deleting either filter left this check green. The always-on adapter
      // layer has to be independently falsifiable.
      const listedDirect = await plain.listGraphs();
      const enumeratedDirect = manifest.reservedGraphs.filter((g) => listedDirect.includes(g));
      if (enumeratedDirect.length > 0) {
        failures.push(`adapter enumerated reserved graphs: ${enumeratedDirect.join(', ')}`);
      }

      const served: string[] = [];
      for (const graph of manifest.reservedGraphs) {
        if (await full.hasGraph(graph)) served.push(graph);
        // Adapter-only too, for the same reason as the enumeration pair above:
        // `hasGraph` asked the backend directly and answered `true` for reserved
        // state whenever the graph-set index was disabled, so measuring only the
        // indexed composition left the always-on layer unfalsifiable.
        if (await plain.hasGraph(graph)) served.push(`adapter:${graph}`);
      }
      if (served.length > 0) failures.push(`served reserved graphs: ${served.join(', ')}`);

      // An unscoped `deleteByPattern` binds `?g_ctx` across EVERY named graph,
      // so it reaches reserved state while sailing past the scope guard, whose
      // body is `if (graph)`. A reserved-prefix FILTER closes that — and this
      // proves the BEHAVIOUR against real Oxigraph rather than string-matching
      // the generated update: an ordinary row that matches the same pattern
      // must be deleted while the reserved rows survive.
      const decoyGraph = 'urn:dkg:gate:unscoped-delete-decoy';
      const decoySubject = 'urn:dkg:gate:decoy-subject';
      const decoyPredicate = 'urn:dkg:gate:decoy-predicate';
      const canarySubject = 'urn:dkg:gate:reserved-canary';

      // A CANARY inside each reserved graph, matching the SAME predicate the
      // deletion targets. Without it this check does not test what it claims:
      // the first version seeded only the ordinary row, so removing the
      // reserved-prefix FILTER still deleted just that row, reserved counts did
      // not move, and the gate passed with the guard gone. Measured as a solo
      // mutant — `PASS: 27 checks` with the FILTER removed.
      //
      // The canaries are asserted by EXACT ASK rather than by graph totals, so
      // an unrelated insertion cannot mask a deletion, and they are removed
      // again below so the seed-count check further down still sees exactly the
      // fixture.
      await sparqlUpdate(
        server.updateEndpoint,
        `INSERT DATA {\n${[
          `GRAPH <${decoyGraph}> { <${decoySubject}> <${decoyPredicate}> "decoy" . }`,
          ...manifest.reservedGraphs.map(
            (g) => `GRAPH <${g}> { <${canarySubject}> <${decoyPredicate}> "canary" . }`,
          ),
        ].join('\n')}\n}`,
      );

      // Deliberately UNSCOPED (no `graph`) and matching only by predicate, so
      // the pattern is exactly one a reserved row DOES match.
      await full.deleteByPattern({ predicate: decoyPredicate }).catch(() => undefined);

      const decoyAfter = await countQuadsInGraph(server.queryEndpoint, decoyGraph);
      if (decoyAfter !== 0) {
        failures.push(`unscoped deleteByPattern did not delete the ordinary row (${decoyAfter} left)`);
      }
      for (const graph of manifest.reservedGraphs) {
        const survived = await askExactQuad(
          server.queryEndpoint,
          graph,
          canarySubject,
          decoyPredicate,
        );
        if (!survived) {
          failures.push(`unscoped deleteByPattern deleted the reserved canary in ${graph}`);
        }
      }

      // Restore the seeded state: the canaries are scaffolding, not fixture.
      await sparqlUpdate(
        server.updateEndpoint,
        `DELETE WHERE { GRAPH ?g { <${canarySubject}> <${decoyPredicate}> ?o } }`,
      );

      // Failed atomic-replace cleanup must not delete persistent reserved state.
      const deleted: string[] = [];
      for (const graph of manifest.reservedGraphs) {
        const before = await countQuadsInGraph(server.queryEndpoint, graph);
        try {
          await full.dropGraph(graph);
        } catch {
          /* refusal is the expected outcome */
        }
        const after = await countQuadsInGraph(server.queryEndpoint, graph);
        if (after < before) deleted.push(graph);
      }
      if (deleted.length > 0) {
        failures.push(`cleanup deleted reserved graphs: ${deleted.join(', ')}`);
      }

      // Re-counted per entry, not hoisted: with the re-seed above, a seed that
      // stopped landing would now be caught on the entry it happened on.
      const seededQuadCount =
        (await countQuadsInGraph(server.queryEndpoint, SYSTEM_RECORD_V1_STATE_GRAPH)) +
        (await countQuadsInGraph(server.queryEndpoint, SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH));
      if (seededQuadCount !== fixture.expectedQuadCount) {
        failures.push(
          `seed incomplete: ${seededQuadCount}/${fixture.expectedQuadCount} quads`,
        );
      }

      currentBinaryConformance = {
        enumeratedReservedGraphs: [...enumerated, ...enumeratedDirect],
        servedReservedGraphs: served,
        deletedReservedGraphsOnCleanup: deleted,
        seededQuadCount,
        expectedQuadCount: fixture.expectedQuadCount,
        failures,
      };
    }

    for (const store of [plain, leaseOnly, full, withChangelog, terminal]) {
      await store.close().catch(() => undefined);
    }
  } finally {
    await server.stop();
    await rm(location, { recursive: true, force: true }).catch(() => undefined);
  }

  const raw: ManagedOwnershipRawResultV1 = {
    schemaVersion: MANAGED_OWNERSHIP_RAW_SCHEMA_VERSION,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: resolve(HERE, '../..'),
      encoding: 'utf8',
    }).trim(),
    oxigraphVersion: OXIGRAPH_VERSION,
    oxigraphBinarySha256: `0x${binarySha256}`,
    platform: process.platform,
    nodeVersion: process.versions.node,
    pinnedPredecessors: manifest.entries.map((entry) => ({
      id: entry.id,
      commit: entry.commit,
      nodeVersion: entry.nodeVersion,
    })),
    currentBinaryConformance,
    manifestEntryCount: manifest.entries.length,
    manifestCommitsResolved,
    liveHandoff,
    capability,
  };

  await mkdir(dirname(ARTIFACT), { recursive: true });
  await writeFile(ARTIFACT, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  console.log(`[managed-ownership-gate] wrote ${ARTIFACT}`);
  console.log(
    `[managed-ownership-gate] oxigraph ${OXIGRAPH_VERSION} sha256=0x${binarySha256.slice(0, 16)}…`,
  );
}

await main();
