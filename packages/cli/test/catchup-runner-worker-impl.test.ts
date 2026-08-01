// catchup-runner-worker-impl.test.ts
//
// Drives the daemon-side Worker catch-up implementation — the production
// `/api/context-graph/subscribe` path — over a mocked `parentPort`, and pins
// two guarantees at THIS call site:
//
//   * the 2026-07-07 sync-storm mitigation (C-1): no more than
//     CATCHUP_MAX_CONCURRENT_PEER_SYNCS per-peer sync rounds (or protocol
//     probes) may ever be in flight, per-peer failures stay isolated, and the
//     aggregation keeps its one-result-per-peer input-order shape;
//   * the issue #2006 progressive walk: peers are contacted in escalating
//     waves over the authority-ranked list and the walk STOPS as soon as the
//     RESOLVED CURATOR has settled every requested plane, so the happy path
//     transfers one payload instead of one per peer. A non-authoritative peer's
//     clean round settles nothing — it can neither stop the walk nor narrow a
//     later peer to one plane.
import { describe, expect, it, vi } from 'vitest';
import {
  CATCHUP_MAX_CONCURRENT_PEER_SYNCS,
  FOREGROUND_CATCHUP_SYNC_PRIORITY,
} from '@origintrail-official/dkg-agent';
import type { CatchupJobResult, CatchupRunRequest } from '../src/catchup-runner.js';

// The foreground backpressure budget is wall-clock (default 180s). Shrink it
// for this file so the persistently-deferred case settles quickly; the exact
// deadline arithmetic is pinned deterministically in
// packages/agent/test/catchup-policy.test.ts with an injected clock.
vi.hoisted(() => {
  process.env.DKG_CATCHUP_BACKPRESSURE_MAX_WAIT_MS = '250';
});

// The worker impl wires itself to `parentPort` at module load, so a
// controllable port has to be in place BEFORE the module is imported.
// Everything else from node:worker_threads stays real.
const fakeParentPort = vi.hoisted(() => {
  const messageListeners: Array<(message: any) => void> = [];
  const port = {
    on(event: string, listener: (message: any) => void) {
      if (event === 'message') messageListeners.push(listener);
    },
    /** Set per run by `runWorkerCatchup`; receives what the impl posts back. */
    onPosted: undefined as ((message: any) => void) | undefined,
    postMessage(message: any) {
      port.onPosted?.(message);
    },
    emitMessage(message: any) {
      for (const listener of messageListeners) listener(message);
    },
  };
  return port;
});

vi.mock('node:worker_threads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:worker_threads')>()),
  parentPort: fakeParentPort,
}));

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function durableResult() {
  return {
    insertedTriples: 1,
    complete: true,
    fetchedMetaTriples: 0,
    fetchedDataTriples: 1,
    insertedMetaTriples: 0,
    insertedDataTriples: 1,
    bytesReceived: 10,
    resumedPhases: 0,
    timedOutPhases: 0,
    completedPhases: 1,
    checkpointAdvances: 0,
    emptyResponses: 0,
    metaOnlyResponses: 0,
    dataRejectedMissingMeta: 0,
    rejectedKcs: 0,
    failedPeers: 0,
    failedPhases: 0,
    deniedPhases: 0,
    deferredBackpressure: 0,
  };
}

function sharedResult() {
  return {
    insertedTriples: 1,
    fetchedMetaTriples: 0,
    fetchedDataTriples: 1,
    insertedMetaTriples: 0,
    insertedDataTriples: 1,
    bytesReceived: 10,
    resumedPhases: 0,
    timedOutPhases: 0,
    completedPhases: 1,
    checkpointAdvances: 0,
    emptyResponses: 0,
    droppedDataTriples: 0,
    failedPeers: 0,
    failedPhases: 0,
    deniedPhases: 0,
    deferredBackpressure: 0,
  };
}

type InvokeHandler = (method: string, args: unknown[]) => Promise<unknown>;

let nextRunId = 1;

async function runWorkerCatchup(request: CatchupRunRequest, handler: InvokeHandler): Promise<CatchupJobResult> {
  // The first call loads the module, which registers its message listener on
  // the mocked parentPort; later calls reuse it (distinct runIds).
  await import('../src/catchup-runner-worker-impl.js');
  const runId = nextRunId++;
  return new Promise<CatchupJobResult>((resolve, reject) => {
    fakeParentPort.onPosted = (message: any) => {
      if (message.type === 'invoke') {
        handler(message.method, message.args).then(
          (result) => fakeParentPort.emitMessage({ type: 'invoke-result', invokeId: message.invokeId, result }),
          (error: unknown) => fakeParentPort.emitMessage({
            type: 'invoke-result',
            invokeId: message.invokeId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return;
      }
      if (message.type === 'run-result' && message.runId === runId) {
        if (message.error) reject(new Error(message.error));
        else resolve(message.result as CatchupJobResult);
      }
    };
    fakeParentPort.emitMessage({ type: 'run', runId, request });
  });
}

describe('catchup-runner-worker-impl bounded fan-out (sync-storm mitigation C-1)', () => {
  it('stops the walk at the first peer that proves every requested plane', async () => {
    const peerIds = Array.from({ length: 20 }, (_, i) => `peer-${i}`);
    const durableOrder: string[] = [];
    const sharedSeen: string[] = [];
    const probeOrder: string[] = [];
    const syncPriorities: Array<number | undefined> = [];
    const syncSources: Array<string | undefined> = [];
    const finalizeCalls: unknown[][] = [];

    const result = await runWorkerCatchup({ contextGraphId: 'cg-one-payload', includeSharedMemory: true }, async (method, args) => {
      switch (method) {
        case 'prepareCatchup':
          return { preferredPeerId: 'peer-0', isPrivateContextGraph: false, peerIds, connectedPeers: peerIds.length };
        case 'waitForSyncProtocol':
          probeOrder.push(args[0] as string);
          return true;
        case 'syncDurable':
          durableOrder.push(args[0] as string);
          syncPriorities.push(args[2] as number | undefined);
          syncSources.push(args[3] as string | undefined);
          return durableResult();
        case 'syncSharedMemory':
          sharedSeen.push(args[0] as string);
          syncPriorities.push(args[2] as number | undefined);
          syncSources.push(args[3] as string | undefined);
          return sharedResult();
        case 'finalizeCatchup':
          finalizeCalls.push(args);
          return null;
        default:
          throw new Error(`unexpected invoke: ${method}`);
      }
    });

    // The whole point of issue #2006: one authoritative payload, not twenty.
    // Before the progressive walk this was `toEqual(peerIds)` on both planes —
    // 20 full durable pulls and 20 full SWM pulls for a single graph.
    expect(durableOrder).toEqual(['peer-0']);
    expect(sharedSeen).toEqual(['peer-0']);
    expect(syncPriorities).toEqual([
      FOREGROUND_CATCHUP_SYNC_PRIORITY,
      FOREGROUND_CATCHUP_SYNC_PRIORITY,
    ]);
    expect(syncSources).toEqual(['catchup-foreground', 'catchup-foreground']);

    // Probing stays eager over the whole connected set: `syncCapablePeers` and
    // `noProtocolPeers` are read by daemon status mapping as counts over every
    // connected peer, not over the walked prefix.
    expect(probeOrder.sort()).toEqual([...peerIds].sort());
    expect(result.syncCapablePeers).toBe(peerIds.length);
    expect(result.selectedPeers).toBe(peerIds.length);

    // Peers the walk deliberately skipped are neither tried nor failed.
    expect(result.peersTried).toBe(1);
    expect(result.peersNotAttempted).toBe(peerIds.length - 1);
    expect(result.peersResponded).toBe(1);
    expect(result.peersSucceeded).toBe(1);
    expect(result.diagnostics?.durable.failedPeers).toBe(0);
    expect(result.diagnostics?.durable.timedOutPhases).toBe(0);

    expect(result.deferredBackpressure).toBe(0);
    expect(result.dataSynced).toBe(1);
    expect(result.sharedMemorySynced).toBe(1);
    expect(result.denied).toBe(false);
    expect(finalizeCalls).toEqual([['cg-one-payload', 1, 1]]);
  });

  it('escalates waves and still caps in-flight peer syncs when no peer proves the plane', async () => {
    const peerIds = Array.from({ length: 20 }, (_, i) => `peer-${i}`);
    // The bound is only observable when the peer set exceeds the cap.
    expect(CATCHUP_MAX_CONCURRENT_PEER_SYNCS).toBeLessThan(peerIds.length);

    let inFlightProbes = 0;
    let peakProbes = 0;
    let inFlightSyncs = 0;
    let peakSyncs = 0;
    const durableOrder: string[] = [];
    const startOrder: string[] = [];

    // Nobody completes, so nothing is ever proven and the walk must cover the
    // whole peer set — the fallback path.
    const unprovenDurable = () => ({ ...durableResult(), complete: false });

    const result = await runWorkerCatchup({ contextGraphId: 'cg-storm', includeSharedMemory: false }, async (method, args) => {
      switch (method) {
        case 'prepareCatchup':
          return { preferredPeerId: undefined, isPrivateContextGraph: false, peerIds, connectedPeers: peerIds.length };
        case 'waitForSyncProtocol': {
          inFlightProbes += 1;
          peakProbes = Math.max(peakProbes, inFlightProbes);
          await delay(2);
          inFlightProbes -= 1;
          return true;
        }
        case 'syncDurable': {
          durableOrder.push(args[0] as string);
          startOrder.push(args[0] as string);
          inFlightSyncs += 1;
          peakSyncs = Math.max(peakSyncs, inFlightSyncs);
          await delay(4);
          inFlightSyncs -= 1;
          return unprovenDurable();
        }
        case 'finalizeCatchup':
          return null;
        default:
          throw new Error(`unexpected invoke: ${method}`);
      }
    });

    // The storm guard: neither phase ever exceeds the cap…
    expect(peakSyncs).toBeLessThanOrEqual(CATCHUP_MAX_CONCURRENT_PEER_SYNCS);
    expect(peakProbes).toBeLessThanOrEqual(CATCHUP_MAX_CONCURRENT_PEER_SYNCS);
    // …but later waves are still actually parallel, not accidentally serialised.
    expect(peakSyncs).toBeGreaterThan(1);
    // No curator resolved here, so the opening wave is NOT narrowed to one peer
    // (that narrowing only buys anything when there is an authority to spend it
    // on). The ranked order is still honoured.
    expect(startOrder[0]).toBe('peer-0');

    // Coverage preserved when nothing proves: every peer walked, in rank order.
    expect(durableOrder).toEqual(peerIds);
    expect(result.peersTried).toBe(peerIds.length);
    expect(result.peersNotAttempted).toBe(0);
    expect(result.dataSynced).toBe(peerIds.length);
  });

  it('keeps walking past a non-authoritative peer that returned verified data', async () => {
    // A peer's `complete` flag proves it served ITS OWN manifest, not the union
    // of what the network holds: peer-0 can cleanly return KA-1 while a later
    // peer holds KA-2 for the same graph. Without a resolved curator there is no
    // reference snapshot, so a clean data-bearing round must NOT cut the walk
    // short and strand the other peers' Knowledge Assets.
    //
    // The peer set must exceed the concurrency cap, or the whole walk is one
    // wave and this assertion could not fail regardless of the gate.
    const peerIds = Array.from({ length: 8 }, (_, i) => `peer-${i}`);
    expect(peerIds.length).toBeGreaterThan(CATCHUP_MAX_CONCURRENT_PEER_SYNCS);
    const durableCalls: string[] = [];

    const result = await runWorkerCatchup({ contextGraphId: 'cg-disjoint', includeSharedMemory: false }, async (method, args) => {
      switch (method) {
        case 'prepareCatchup':
          return { preferredPeerId: undefined, isPrivateContextGraph: false, peerIds, connectedPeers: peerIds.length };
        case 'waitForSyncProtocol':
          return true;
        case 'syncDurable':
          durableCalls.push(args[0] as string);
          return durableResult();
        case 'finalizeCatchup':
          return null;
        default:
          throw new Error(`unexpected invoke: ${method}`);
      }
    });

    expect([...durableCalls].sort()).toEqual([...peerIds].sort());
    expect(result.peersNotAttempted).toBe(0);
    expect(result.dataSynced).toBe(peerIds.length);
  });

  it('does not let a non-authoritative peer narrow a later peer to one plane', async () => {
    // The other half of the authority gate: a non-curator peer settling shared
    // memory must not cause later peers to be contacted for durable only.
    const peerIds = Array.from({ length: 8 }, (_, i) => `peer-${i}`);
    const durableCalls: string[] = [];
    const sharedCalls: string[] = [];

    await runWorkerCatchup({ contextGraphId: 'cg-no-narrow', includeSharedMemory: true }, async (method, args) => {
      switch (method) {
        case 'prepareCatchup':
          return { preferredPeerId: undefined, isPrivateContextGraph: false, peerIds, connectedPeers: peerIds.length };
        case 'waitForSyncProtocol':
          return true;
        case 'syncDurable':
          durableCalls.push(args[0] as string);
          return { ...durableResult(), complete: false };
        case 'syncSharedMemory':
          sharedCalls.push(args[0] as string);
          return sharedResult();
        case 'finalizeCatchup':
          return null;
        default:
          throw new Error(`unexpected invoke: ${method}`);
      }
    });

    expect([...durableCalls].sort()).toEqual([...peerIds].sort());
    expect([...sharedCalls].sort()).toEqual([...peerIds].sort());
  });

  it('stops after the curator proves the only requested plane', async () => {
    // Plain `subscribe` with no workspace is the most common production shape
    // for the early stop; the multi-wave curator case above requests both
    // planes, so this pins the durable-only path.
    const peerIds = Array.from({ length: 10 }, (_, i) => `peer-${i}`);
    const durableCalls: string[] = [];

    const result = await runWorkerCatchup({ contextGraphId: 'cg-durable-only', includeSharedMemory: false }, async (method, args) => {
      switch (method) {
        case 'prepareCatchup':
          return { preferredPeerId: 'peer-0', isPrivateContextGraph: false, peerIds, connectedPeers: peerIds.length };
        case 'waitForSyncProtocol':
          return true;
        case 'syncDurable':
          durableCalls.push(args[0] as string);
          return durableResult();
        case 'finalizeCatchup':
          return null;
        default:
          throw new Error(`unexpected invoke: ${method}`);
      }
    });

    expect(durableCalls).toEqual(['peer-0']);
    expect(result.peersNotAttempted).toBe(peerIds.length - 1);
  });

  it('lets the curator settle a plane by answering cleanly empty', async () => {
    // Shared memory is frequently empty for a graph that has durable data, and
    // `includeSharedMemory` defaults to true on subscribe. If only inserted
    // rows could settle a plane, the early stop would almost never fire in the
    // shape this fix targets.
    const peerIds = Array.from({ length: 10 }, (_, i) => `peer-${i}`);
    const durableCalls: string[] = [];
    const sharedCalls: string[] = [];

    const result = await runWorkerCatchup({ contextGraphId: 'cg-empty-swm', includeSharedMemory: true }, async (method, args) => {
      switch (method) {
        case 'prepareCatchup':
          return { preferredPeerId: 'peer-0', isPrivateContextGraph: false, peerIds, connectedPeers: peerIds.length };
        case 'waitForSyncProtocol':
          return true;
        case 'syncDurable':
          durableCalls.push(args[0] as string);
          return durableResult();
        case 'syncSharedMemory':
          sharedCalls.push(args[0] as string);
          return {
            ...sharedResult(),
            insertedTriples: 0,
            fetchedDataTriples: 0,
            insertedDataTriples: 0,
            bytesReceived: 0,
            completedPhases: 2,
            emptyResponses: 1,
          };
        case 'finalizeCatchup':
          return null;
        default:
          throw new Error(`unexpected invoke: ${method}`);
      }
    });

    expect(durableCalls).toEqual(['peer-0']);
    expect(sharedCalls).toEqual(['peer-0']);
    expect(result.peersNotAttempted).toBe(peerIds.length - 1);
    expect(result.cleanPlaneCompletions?.sharedMemory.emptyPeers).toBe(1);
  });

  it('skips the durable plane on fallback peers once the curator settled it', async () => {
    // The `durable: null` round — the reason the peer-accounting helpers accept
    // a missing plane at all. The curator settles durable but not shared
    // memory, so later peers must be contacted for shared memory only and must
    // not be credited with a durable response.
    const peerIds = Array.from({ length: 6 }, (_, i) => `peer-${i}`);
    const durableCalls: string[] = [];
    const sharedCalls: string[] = [];
    const sharedPriorities: Array<number | undefined> = [];
    const sharedSources: Array<string | undefined> = [];

    const result = await runWorkerCatchup({ contextGraphId: 'cg-swm-fallback', includeSharedMemory: true }, async (method, args) => {
      switch (method) {
        case 'prepareCatchup':
          return { preferredPeerId: 'peer-0', isPrivateContextGraph: false, peerIds, connectedPeers: peerIds.length };
        case 'waitForSyncProtocol':
          return true;
        case 'syncDurable':
          durableCalls.push(args[0] as string);
          return durableResult();
        case 'syncSharedMemory':
          sharedCalls.push(args[0] as string);
          sharedPriorities.push(args[2] as number | undefined);
          sharedSources.push(args[3] as string | undefined);
          // The curator engages and fails (so SWM is never settled); every
          // fallback peer transport-fails, delivering nothing at all.
          return args[0] === 'peer-0'
            ? {
              ...sharedResult(),
              insertedTriples: 0,
              insertedDataTriples: 0,
              completedPhases: 0,
              failedPhases: 1,
            }
            : {
              ...sharedResult(),
              insertedTriples: 0,
              fetchedDataTriples: 0,
              insertedDataTriples: 0,
              bytesReceived: 0,
              completedPhases: 0,
              failedPeers: 1,
            };
        case 'finalizeCatchup':
          return null;
        default:
          throw new Error(`unexpected invoke: ${method}`);
      }
    });

    // Durable pulled once, from the curator; shared memory from everyone.
    expect(durableCalls).toEqual(['peer-0']);
    expect([...sharedCalls].sort()).toEqual([...peerIds].sort());
    // The shared-only fallback goes through a different call path than the
    // both-planes one, so it has to carry foreground admission itself.
    expect(sharedPriorities).toEqual(
      peerIds.map(() => FOREGROUND_CATCHUP_SYNC_PRIORITY),
    );
    expect(sharedSources).toEqual(peerIds.map(() => 'catchup-foreground'));
    expect(result.peersTried).toBe(peerIds.length);
    expect(result.peersNotAttempted).toBe(0);
    // The skipped durable plane must not manufacture a response for peers whose
    // only requested plane transport-failed: only the curator responded.
    expect(result.peersResponded).toBe(1);
    expect(result.peersSucceeded).toBe(0);
    // One durable round in the whole walk — that is the amplification fix.
    expect(result.diagnostics?.durable.fetchedDataTriples).toBe(1);
    expect(result.dataSynced).toBe(1);
  });

  it('opens at the full concurrency cap when no curator resolved', async () => {
    // A single-peer opening wave buys "one payload from the curator". Without a
    // resolvable curator it buys nothing, so the walk must not serialise the
    // head of the list and pay an extra round-trip on every round.
    const peerIds = Array.from({ length: 12 }, (_, i) => `peer-${i}`);
    let inFlight = 0;
    let peak = 0;
    const startOrder: string[] = [];

    await runWorkerCatchup({ contextGraphId: 'cg-no-curator', includeSharedMemory: false }, async (method, args) => {
      switch (method) {
        case 'prepareCatchup':
          return { preferredPeerId: undefined, isPrivateContextGraph: false, peerIds, connectedPeers: peerIds.length };
        case 'waitForSyncProtocol':
          return true;
        case 'syncDurable': {
          startOrder.push(args[0] as string);
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await delay(4);
          inFlight -= 1;
          return { ...durableResult(), complete: false };
        }
        case 'finalizeCatchup':
          return null;
        default:
          throw new Error(`unexpected invoke: ${method}`);
      }
    });

    expect(peak).toBe(CATCHUP_MAX_CONCURRENT_PEER_SYNCS);
    expect(startOrder).toEqual(peerIds);
  });

  it('spends the single-peer opening wave only on a sync-capable curator', async () => {
    // The curator is ranked first but is NOT sync-capable, so the walk has no
    // authority to try alone and must not serialise an arbitrary peer instead.
    const peerIds = ['peer-curator', 'peer-a', 'peer-b', 'peer-c', 'peer-d'];
    let inFlight = 0;
    let peak = 0;

    await runWorkerCatchup({ contextGraphId: 'cg-curator-offline', includeSharedMemory: false }, async (method, args) => {
      switch (method) {
        case 'prepareCatchup':
          return { preferredPeerId: 'peer-curator', isPrivateContextGraph: false, peerIds, connectedPeers: peerIds.length };
        case 'waitForSyncProtocol':
          return args[0] !== 'peer-curator';
        case 'syncDurable': {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await delay(4);
          inFlight -= 1;
          return { ...durableResult(), complete: false };
        }
        case 'finalizeCatchup':
          return null;
        default:
          throw new Error(`unexpected invoke: ${method}`);
      }
    });

    expect(peak).toBe(CATCHUP_MAX_CONCURRENT_PEER_SYNCS);
  });

  it('narrows fallback peers to the planes the curator already settled', async () => {
    // The curator settles shared memory but never settles durable (its durable
    // round engages and fails). Without per-plane narrowing, walking on for
    // durable would drag a full re-pull of the ALREADY SETTLED shared-memory
    // plane out of every remaining peer — the exact amplification this removes.
    const peerIds = Array.from({ length: 8 }, (_, i) => `peer-${i}`);
    const durableCalls: string[] = [];
    const sharedCalls: string[] = [];

    const result = await runWorkerCatchup({ contextGraphId: 'cg-swm-only', includeSharedMemory: true }, async (method, args) => {
      switch (method) {
        case 'prepareCatchup':
          return { preferredPeerId: 'peer-0', isPrivateContextGraph: false, peerIds, connectedPeers: peerIds.length };
        case 'waitForSyncProtocol':
          return true;
        case 'syncDurable':
          durableCalls.push(args[0] as string);
          return {
            ...durableResult(),
            complete: false,
            insertedTriples: 0,
            insertedDataTriples: 0,
            completedPhases: 0,
            timedOutPhases: 1,
          };
        case 'syncSharedMemory':
          sharedCalls.push(args[0] as string);
          return sharedResult();
        case 'finalizeCatchup':
          return null;
        default:
          throw new Error(`unexpected invoke: ${method}`);
      }
    });

    // Shared memory is settled by the curator and never pulled again…
    expect(sharedCalls).toEqual(['peer-0']);
    // …while the unsettled durable plane still walks everyone.
    expect(durableCalls).toEqual(peerIds);
    expect(result.sharedMemorySynced).toBe(1);
    expect(result.cleanPlaneCompletions?.sharedMemory.verifiedDataPeers).toBe(1);
  });

  it('keeps per-peer failure isolation and probe filtering under the bounded fan-out', async () => {
    const peerIds = Array.from({ length: 12 }, (_, i) => `peer-${i}`);
    const durableCalls: string[] = [];
    let sharedCalls = 0;

    const result = await runWorkerCatchup({ contextGraphId: 'cg-isolate', includeSharedMemory: false }, async (method, args) => {
      switch (method) {
        case 'prepareCatchup':
          return { preferredPeerId: undefined, isPrivateContextGraph: false, peerIds, connectedPeers: peerIds.length };
        case 'waitForSyncProtocol':
          await delay(1);
          // peer-5 is connected but not sync-capable: it must be filtered out
          // by the (bounded) probe pass, never handed to syncDurable.
          return args[0] !== 'peer-5';
        case 'syncDurable': {
          durableCalls.push(args[0] as string);
          await delay(2);
          if (args[0] === 'peer-3') throw new Error('peer 3 exploded');
          // `complete: false` keeps every peer unproven, so the walk covers the
          // whole set and the isolation claim below is actually exercised
          // instead of being skipped by an early stop.
          return { ...durableResult(), complete: false };
        }
        case 'syncSharedMemory':
          sharedCalls += 1;
          return sharedResult();
        case 'finalizeCatchup':
          return null;
        default:
          throw new Error(`unexpected invoke: ${method}`);
      }
    });

    // One peer's sync failure must not reject the run or drop other peers.
    expect(durableCalls).toEqual(peerIds.filter((peerId) => peerId !== 'peer-5'));
    expect(sharedCalls).toBe(0);
    expect(result.syncCapablePeers).toBe(11);
    expect(result.peersTried).toBe(11);
    expect(result.peersNotAttempted).toBe(0);
    expect(result.peersResponded).toBe(10);
    expect(result.peersSucceeded).toBe(10);
    expect(result.dataSynced).toBe(10);
    expect(result.sharedMemorySynced).toBe(0);
    expect(result.diagnostics?.noProtocolPeers).toBe(1);
    expect(result.diagnostics?.durable.failedPeers).toBe(1);
  });

  it('does not let an unrelated peer\'s clean empty response stop the walk or prove readiness', async () => {
    // The reported #2006 shape: a data-bearing peer fails part-way, an
    // unrelated peer that has never heard of the graph answers empty. On the
    // wire those two peers are indistinguishable, so the empty answer must not
    // stop the walk and must not settle the job as `done`.
    const peerIds = ['peer-empty', 'peer-data-failed', 'peer-quiet'];
    const durableCalls: string[] = [];

    const result = await runWorkerCatchup({ contextGraphId: 'cg-empty-mask', includeSharedMemory: false }, async (method, args) => {
      switch (method) {
        case 'prepareCatchup':
          return { preferredPeerId: undefined, isPrivateContextGraph: false, peerIds, connectedPeers: peerIds.length };
        case 'waitForSyncProtocol':
          return true;
        case 'syncDurable': {
          durableCalls.push(args[0] as string);
          if (args[0] === 'peer-data-failed') {
            return {
              ...durableResult(),
              complete: false,
              fetchedDataTriples: 5_000,
              insertedTriples: 0,
              insertedDataTriples: 0,
              completedPhases: 0,
              timedOutPhases: 1,
              failedPhases: 1,
            };
          }
          return {
            ...durableResult(),
            insertedTriples: 0,
            fetchedDataTriples: 0,
            insertedDataTriples: 0,
            bytesReceived: 0,
            completedPhases: 2,
            emptyResponses: 1,
          };
        }
        case 'finalizeCatchup':
          return null;
        default:
          throw new Error(`unexpected invoke: ${method}`);
      }
    });

    // Emptiness is never a stop condition, so every peer is still contacted.
    expect(durableCalls).toEqual(peerIds);
    expect(result.cleanPlaneCompletions?.durable.verifiedDataPeers).toBe(0);
    // The clean-empty peers are still recorded as clean empty completions…
    expect(result.cleanPlaneCompletions?.durable.emptyPeers).toBe(2);
    // …but the round fetched data and failed, so readiness must not follow.
    expect(result.diagnostics?.durable.fetchedDataTriples).toBe(5_000);
    expect(result.diagnostics?.durable.failedPhases).toBe(1);
  });

  it('retries only SWM after durable progress and finalizes when local pressure clears', async () => {
    const finalizeCalls: unknown[][] = [];
    let durableCalls = 0;
    let sharedCalls = 0;
    const result = await runWorkerCatchup({ contextGraphId: 'cg-deferred', includeSharedMemory: true }, async (method) => {
      switch (method) {
        case 'prepareCatchup':
          return { preferredPeerId: undefined, isPrivateContextGraph: false, peerIds: ['peer-1'], connectedPeers: 1 };
        case 'waitForSyncProtocol':
          return true;
        case 'syncDurable':
          durableCalls += 1;
          return durableResult();
        case 'syncSharedMemory': {
          sharedCalls += 1;
          return sharedCalls === 1
            ? {
                ...sharedResult(),
                insertedTriples: 0,
                fetchedDataTriples: 0,
                insertedDataTriples: 0,
                bytesReceived: 0,
                completedPhases: 0,
                deferredBackpressure: 1,
              }
            : sharedResult();
        }
        case 'finalizeCatchup':
          finalizeCalls.push([]);
          return null;
        default:
          throw new Error(`unexpected invoke: ${method}`);
      }
    });

    expect(result.peersResponded).toBe(1);
    expect(result.peersSucceeded).toBe(1);
    expect(result.deferredBackpressure).toBe(0);
    expect(result.dataSynced).toBe(1);
    expect(result.sharedMemorySynced).toBe(1);
    expect(result.diagnostics?.sharedMemory.deferredBackpressure).toBe(0);
    expect(durableCalls).toBe(1);
    expect(sharedCalls).toBe(2);
    expect(finalizeCalls).toEqual([[]]);
  });

  it('finishes deferred durable sync before starting SWM', async () => {
    let durableCalls = 0;
    let sharedCalls = 0;
    const callOrder: string[] = [];

    const result = await runWorkerCatchup(
      { contextGraphId: 'cg-durable-deferred', includeSharedMemory: true },
      async (method) => {
        switch (method) {
          case 'prepareCatchup':
            return { preferredPeerId: undefined, isPrivateContextGraph: false, peerIds: ['peer-1'], connectedPeers: 1 };
          case 'waitForSyncProtocol':
            return true;
          case 'syncDurable':
            durableCalls += 1;
            callOrder.push(`durable-${durableCalls}`);
            return durableCalls === 1
              ? {
                  ...durableResult(),
                  insertedTriples: 0,
                  insertedDataTriples: 0,
                  completedPhases: 0,
                  deferredBackpressure: 1,
                }
              : durableResult();
          case 'syncSharedMemory':
            sharedCalls += 1;
            callOrder.push('shared');
            return sharedResult();
          case 'finalizeCatchup':
            return null;
          default:
            throw new Error(`unexpected invoke: ${method}`);
        }
      },
    );

    expect(result.deferredBackpressure).toBe(0);
    expect(durableCalls).toBe(2);
    expect(sharedCalls).toBe(1);
    expect(callOrder).toEqual(['durable-1', 'durable-2', 'shared']);
  });

  it('returns deferred after the wall-clock durable retry budget and never starts dependent SWM', async () => {
    let durableCalls = 0;
    let sharedCalls = 0;
    const finalizeCalls: unknown[][] = [];

    const result = await runWorkerCatchup(
      { contextGraphId: 'cg-persistently-deferred', includeSharedMemory: true },
      async (method) => {
        switch (method) {
          case 'prepareCatchup':
            return { preferredPeerId: undefined, isPrivateContextGraph: false, peerIds: ['peer-1'], connectedPeers: 1 };
          case 'waitForSyncProtocol':
            return true;
          case 'syncDurable':
            durableCalls += 1;
            return {
              ...durableResult(),
              insertedTriples: 0,
              fetchedDataTriples: 0,
              insertedDataTriples: 0,
              bytesReceived: 0,
              completedPhases: 0,
              deferredBackpressure: 1,
            };
          case 'syncSharedMemory':
            sharedCalls += 1;
            return sharedResult();
          case 'finalizeCatchup':
            finalizeCalls.push([]);
            return null;
          default:
            throw new Error(`unexpected invoke: ${method}`);
        }
      },
    );

    // The retry loop is wired and bounded: at least one retry happened (the
    // pre-#2006 policy also retried, but on a fixed 850 ms ladder), and the run
    // settled at the wall-clock budget instead of spinning forever. The exact
    // deadline arithmetic — that attempts are governed by the clock, not by a
    // fixed attempt count — is pinned in packages/agent/test/catchup-policy.test.ts.
    expect(durableCalls).toBeGreaterThanOrEqual(2);
    expect(sharedCalls).toBe(0);
    expect(result.deferredBackpressure).toBe(1);
    expect(result.peersResponded).toBe(0);
    expect(result.peersSucceeded).toBe(0);
    expect(finalizeCalls).toEqual([]);
  });

  it('propagates durable and shared-memory denied phases from the real worker result', async () => {
    const result = await runWorkerCatchup(
      { contextGraphId: 'cg-denied', includeSharedMemory: true },
      async (method) => {
        switch (method) {
          case 'prepareCatchup':
            return {
              preferredPeerId: undefined,
              isPrivateContextGraph: true,
              peerIds: ['peer-denied'],
              connectedPeers: 1,
            };
          case 'waitForSyncProtocol':
            return true;
          case 'syncDurable':
            return { ...durableResult(), deniedPhases: 1 };
          case 'syncSharedMemory':
            return { ...sharedResult(), deniedPhases: 1 };
          case 'finalizeCatchup':
            return null;
          default:
            throw new Error(`unexpected invoke: ${method}`);
        }
      },
    );

    expect(result).toMatchObject({
      denied: true,
      deniedPeers: 1,
      peersResponded: 1,
      peersSucceeded: 0,
      dataSynced: 1,
      sharedMemorySynced: 1,
    });
    expect(result.diagnostics?.durable.deniedPhases).toBe(1);
    expect(result.diagnostics?.sharedMemory.deniedPhases).toBe(1);
    expect(result.cleanPlaneCompletions).toEqual({
      durable: { verifiedDataPeers: 0, verifiedPrivateOnlyPeers: 0, emptyPeers: 0 },
      sharedMemory: { verifiedDataPeers: 0, emptyPeers: 0 },
    });
    expect(result.diagnostics?.durable.verifiedPrivateOnlyResponses).toBe(0);
  });

  it('retains clean per-plane completion when another peer denies and times out', async () => {
    const result = await runWorkerCatchup(
      { contextGraphId: 'cg-mixed', includeSharedMemory: false },
      async (method, args) => {
        switch (method) {
          case 'prepareCatchup':
            // The denying/timing-out peer is ranked FIRST so the walk reaches
            // the clean peer in a later wave: the claim under test is that a
            // clean per-peer completion survives another peer's denial in the
            // aggregate, which an early stop on wave 1 would never exercise.
            return {
              preferredPeerId: undefined,
              isPrivateContextGraph: true,
              peerIds: ['peer-partial', 'peer-clean'],
              connectedPeers: 2,
            };
          case 'waitForSyncProtocol':
            return true;
          case 'syncDurable':
            return args[0] === 'peer-clean'
              ? durableResult()
              : { ...durableResult(), deniedPhases: 1, timedOutPhases: 1 };
          case 'finalizeCatchup':
            return null;
          default:
            throw new Error(`unexpected invoke: ${method}`);
        }
      },
    );

    expect(result).toMatchObject({
      denied: true,
      deniedPeers: 1,
      peersSucceeded: 1,
      dataSynced: 2,
    });
    expect(result.diagnostics?.durable).toMatchObject({
      deniedPhases: 1,
      timedOutPhases: 1,
    });
    expect(result.cleanPlaneCompletions?.durable).toEqual({
      verifiedDataPeers: 1,
      verifiedPrivateOnlyPeers: 0,
      emptyPeers: 0,
    });
  });

  it('keeps explicit incomplete progress out of clean completion evidence', async () => {
    const result = await runWorkerCatchup(
      { contextGraphId: 'cg-incomplete', includeSharedMemory: false },
      async (method) => {
        switch (method) {
          case 'prepareCatchup':
            return {
              preferredPeerId: undefined,
              isPrivateContextGraph: true,
              peerIds: ['peer-partial'],
              connectedPeers: 1,
            };
          case 'waitForSyncProtocol':
            return true;
          case 'syncDurable':
            return { ...durableResult(), complete: false };
          case 'finalizeCatchup':
            return null;
          default:
            throw new Error(`unexpected invoke: ${method}`);
        }
      },
    );

    // peersSucceeded is liveness/progress accounting only. Readiness consumes
    // the separate cleanPlaneCompletions proof, which must remain empty.
    expect(result).toMatchObject({
      peersResponded: 1,
      peersSucceeded: 1,
      dataSynced: 1,
    });
    expect(result.cleanPlaneCompletions?.durable).toEqual({
      verifiedDataPeers: 0,
      verifiedPrivateOnlyPeers: 0,
      emptyPeers: 0,
    });
  });

  it('records a clean verified private-only durable response as peer progress', async () => {
    const result = await runWorkerCatchup(
      { contextGraphId: 'cg-private-only', includeSharedMemory: false },
      async (method) => {
        switch (method) {
          case 'prepareCatchup':
            return {
              preferredPeerId: undefined,
              isPrivateContextGraph: true,
              peerIds: ['peer-private-only'],
              connectedPeers: 1,
            };
          case 'waitForSyncProtocol':
            return true;
          case 'syncDurable':
            return {
              ...durableResult(),
              insertedTriples: 8,
              fetchedMetaTriples: 8,
              fetchedDataTriples: 0,
              insertedMetaTriples: 8,
              insertedDataTriples: 0,
              verifiedPrivateOnlyResponses: 1,
            };
          case 'finalizeCatchup':
            return null;
          default:
            throw new Error(`unexpected invoke: ${method}`);
        }
      },
    );

    expect(result).toMatchObject({
      peersResponded: 1,
      peersSucceeded: 1,
      dataSynced: 0,
    });
    expect(result.diagnostics?.durable.verifiedPrivateOnlyResponses).toBe(1);
    expect(result.cleanPlaneCompletions?.durable).toEqual({
      verifiedDataPeers: 0,
      verifiedPrivateOnlyPeers: 1,
      emptyPeers: 0,
    });
  });

  it.each([
    ['rejectedKcs'],
    ['dataRejectedMissingMeta'],
  ] as const)('does not emit clean completion evidence when durable sync reports %s', async (field) => {
    const result = await runWorkerCatchup(
      { contextGraphId: `cg-${field}`, includeSharedMemory: false },
      async (method) => {
        switch (method) {
          case 'prepareCatchup':
            return {
              preferredPeerId: undefined,
              isPrivateContextGraph: true,
              peerIds: ['peer-integrity-reject'],
              connectedPeers: 1,
            };
          case 'waitForSyncProtocol':
            return true;
          case 'syncDurable':
            return { ...durableResult(), [field]: 1 };
          case 'finalizeCatchup':
            return null;
          default:
            throw new Error(`unexpected invoke: ${method}`);
        }
      },
    );

    expect(result).toMatchObject({
      peersResponded: 1,
      peersSucceeded: 0,
      dataSynced: 1,
    });
    expect(result.diagnostics?.durable[field]).toBe(1);
    expect(result.cleanPlaneCompletions?.durable).toEqual({
      verifiedDataPeers: 0,
      verifiedPrivateOnlyPeers: 0,
      emptyPeers: 0,
    });
  });

  // A clean empty round is never a stop condition — it cannot distinguish an
  // empty host from a peer that never heard of the graph — so every peer is
  // still walked and emptiness stays a whole-round verdict.
  it('records each distinct responder that cleanly completes both planes empty', async () => {
    const peerIds = ['peer-empty-1', 'peer-empty-2', 'peer-empty-3', 'peer-empty-4'];
    const result = await runWorkerCatchup(
      { contextGraphId: 'cg-empty-public', includeSharedMemory: true },
      async (method) => {
        switch (method) {
          case 'prepareCatchup':
            return {
              preferredPeerId: undefined,
              isPrivateContextGraph: false,
              peerIds,
              connectedPeers: peerIds.length,
            };
          case 'waitForSyncProtocol':
            return true;
          case 'syncDurable':
            return {
              ...durableResult(),
              insertedTriples: 0,
              fetchedDataTriples: 0,
              insertedDataTriples: 0,
              bytesReceived: 0,
              completedPhases: 2,
              emptyResponses: 2,
            };
          case 'syncSharedMemory':
            return {
              ...sharedResult(),
              insertedTriples: 0,
              fetchedDataTriples: 0,
              insertedDataTriples: 0,
              bytesReceived: 0,
              completedPhases: 2,
              emptyResponses: 2,
            };
          case 'finalizeCatchup':
            return null;
          default:
            throw new Error(`unexpected invoke: ${method}`);
        }
      },
    );

    expect(result).toMatchObject({
      peersResponded: peerIds.length,
      peersSucceeded: peerIds.length,
      peersTried: peerIds.length,
      peersNotAttempted: 0,
      dataSynced: 0,
      sharedMemorySynced: 0,
    });
    expect(result.cleanPlaneCompletions).toEqual({
      durable: { verifiedDataPeers: 0, verifiedPrivateOnlyPeers: 0, emptyPeers: peerIds.length },
      sharedMemory: { verifiedDataPeers: 0, emptyPeers: peerIds.length },
    });
  });
});
