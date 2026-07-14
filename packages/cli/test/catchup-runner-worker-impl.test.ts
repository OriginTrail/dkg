// catchup-runner-worker-impl.test.ts
//
// Drives the daemon-side Worker catch-up implementation — the
// `/api/context-graph/subscribe` path that fans a full durable+SWM sync out
// over every sync-capable peer — over a mocked `parentPort`, and pins the
// 2026-07-07 sync-storm mitigation (C-1) at THIS call site: no more than
// CATCHUP_MAX_CONCURRENT_PEER_SYNCS per-peer sync rounds (or protocol probes)
// may ever be in flight, while every peer still gets synced exactly once, the
// aggregation keeps its one-result-per-peer input-order shape, and one peer's
// failure stays isolated instead of failing the whole run.
import { describe, expect, it, vi } from 'vitest';
import { CATCHUP_MAX_CONCURRENT_PEER_SYNCS } from '@origintrail-official/dkg-agent';
import type { CatchupJobResult, CatchupRunRequest } from '../src/catchup-runner.js';

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
  it('caps in-flight peer syncs and protocol probes at the shared limit while still syncing every peer in input order', async () => {
    const peerIds = Array.from({ length: 20 }, (_, i) => `peer-${i}`);
    // The bound is only observable when the peer set exceeds the cap.
    expect(CATCHUP_MAX_CONCURRENT_PEER_SYNCS).toBeLessThan(peerIds.length);

    let inFlightProbes = 0;
    let peakProbes = 0;
    let inFlightSyncs = 0;
    let peakSyncs = 0;
    const durableOrder: string[] = [];
    const sharedSeen: string[] = [];
    const finalizeCalls: unknown[][] = [];

    const result = await runWorkerCatchup({ contextGraphId: 'cg-storm', includeSharedMemory: true }, async (method, args) => {
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
          inFlightSyncs += 1;
          peakSyncs = Math.max(peakSyncs, inFlightSyncs);
          await delay(4);
          inFlightSyncs -= 1;
          return durableResult();
        }
        case 'syncSharedMemory': {
          sharedSeen.push(args[0] as string);
          inFlightSyncs += 1;
          peakSyncs = Math.max(peakSyncs, inFlightSyncs);
          await delay(2);
          inFlightSyncs -= 1;
          return sharedResult();
        }
        case 'finalizeCatchup':
          finalizeCalls.push(args);
          return null;
        default:
          throw new Error(`unexpected invoke: ${method}`);
      }
    });

    // The storm guard: neither fan-out phase ever exceeds the cap…
    expect(peakSyncs).toBeLessThanOrEqual(CATCHUP_MAX_CONCURRENT_PEER_SYNCS);
    expect(peakProbes).toBeLessThanOrEqual(CATCHUP_MAX_CONCURRENT_PEER_SYNCS);
    // …but the fan-out is still actually parallel, not accidentally serialised.
    expect(peakSyncs).toBeGreaterThan(1);

    // Coverage preserved: every peer synced exactly once, started in input
    // order (the bounded mapper's shared cursor hands out work in order).
    expect(durableOrder).toEqual(peerIds);
    expect([...sharedSeen].sort()).toEqual([...peerIds].sort());

    // Aggregation unchanged from the unbounded Promise.all shape.
    expect(result.selectedPeers).toBe(peerIds.length);
    expect(result.syncCapablePeers).toBe(peerIds.length);
    expect(result.peersTried).toBe(peerIds.length);
    expect(result.peersResponded).toBe(peerIds.length);
    expect(result.peersSucceeded).toBe(peerIds.length);
    expect(result.deferredBackpressure).toBe(0);
    expect(result.dataSynced).toBe(peerIds.length);
    expect(result.sharedMemorySynced).toBe(peerIds.length);
    expect(result.denied).toBe(false);
    expect(result.diagnostics?.durable.failedPeers).toBe(0);
    expect(finalizeCalls).toEqual([['cg-storm', peerIds.length, peerIds.length]]);
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
          return durableResult();
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
    expect(result.peersResponded).toBe(10);
    expect(result.peersSucceeded).toBe(10);
    expect(result.dataSynced).toBe(10);
    expect(result.sharedMemorySynced).toBe(0);
    expect(result.diagnostics?.noProtocolPeers).toBe(1);
    expect(result.diagnostics?.durable.failedPeers).toBe(1);
  });

  it('surfaces partial progress followed by local deferral without finalizing the catch-up', async () => {
    const finalizeCalls: unknown[][] = [];
    const result = await runWorkerCatchup({ contextGraphId: 'cg-deferred', includeSharedMemory: true }, async (method) => {
      switch (method) {
        case 'prepareCatchup':
          return { preferredPeerId: undefined, isPrivateContextGraph: false, peerIds: ['peer-1'], connectedPeers: 1 };
        case 'waitForSyncProtocol':
          return true;
        case 'syncDurable':
          return durableResult();
        case 'syncSharedMemory':
          return {
            ...sharedResult(),
            insertedTriples: 0,
            fetchedDataTriples: 0,
            insertedDataTriples: 0,
            bytesReceived: 0,
            completedPhases: 0,
            deferredBackpressure: 1,
          };
        case 'finalizeCatchup':
          finalizeCalls.push([]);
          return null;
        default:
          throw new Error(`unexpected invoke: ${method}`);
      }
    });

    expect(result.peersResponded).toBe(1);
    expect(result.peersSucceeded).toBe(0);
    expect(result.deferredBackpressure).toBe(1);
    expect(result.dataSynced).toBe(1);
    expect(result.sharedMemorySynced).toBe(0);
    expect(result.diagnostics?.sharedMemory.deferredBackpressure).toBe(1);
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
      durable: { verifiedDataPeers: 0, emptyPeers: 0 },
      sharedMemory: { verifiedDataPeers: 0, emptyPeers: 0 },
    });
  });

  it('retains clean per-plane completion when another peer denies and times out', async () => {
    const result = await runWorkerCatchup(
      { contextGraphId: 'cg-mixed', includeSharedMemory: false },
      async (method, args) => {
        switch (method) {
          case 'prepareCatchup':
            return {
              preferredPeerId: undefined,
              isPrivateContextGraph: true,
              peerIds: ['peer-clean', 'peer-partial'],
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
      emptyPeers: 0,
    });
  });

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
      dataSynced: 0,
      sharedMemorySynced: 0,
    });
    expect(result.cleanPlaneCompletions).toEqual({
      durable: { verifiedDataPeers: 0, emptyPeers: peerIds.length },
      sharedMemory: { verifiedDataPeers: 0, emptyPeers: peerIds.length },
    });
  });
});
