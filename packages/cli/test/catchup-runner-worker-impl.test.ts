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
import {
  durableCatchupResult as durableResult,
  runWorkerCatchup,
  sharedCatchupResult as sharedResult,
} from './helpers/catchup-runner-worker-test-harness.js';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  CATCHUP_MAX_CONCURRENT_PEER_SYNCS,
  FOREGROUND_CATCHUP_SYNC_PRIORITY,
} from '@origintrail-official/dkg-agent';

// The foreground backpressure budget is wall-clock (default 180s). Shrink it
// for this file so the persistently-deferred case settles quickly; the exact
// deadline arithmetic is pinned deterministically in
// packages/agent/test/catchup-policy.test.ts with an injected clock.
// `vi.hoisted` runs before imports so the module-load-time constant picks this
// up — but it mutates the REAL process env, and vitest can reuse a worker
// process across files in a shard. Anything loaded afterwards, including a
// daemon spawned by a sibling suite, would otherwise inherit the shortened backpressure budget.
//
// The budget must stay comfortably ABOVE `CATCHUP_BACKPRESSURE_BASE_DELAY_MS`
// (250 ms). At exactly 250 ms the first backoff is clamped to the whole
// remaining budget, so the sleep ends ON the deadline and every retry in this
// file depended on the loop admitting an attempt there — which the post-sleep
// deadline check now declines. That ratio does not occur in production (the
// default budget is 180 s against the same 250 ms base), so pinning it would
// have pinned an artefact of the fixture rather than a behaviour.
const previousCATCHUPBACKPRESSUREMAXWAITMS = vi.hoisted(() => {
  const before = process.env.DKG_CATCHUP_BACKPRESSURE_MAX_WAIT_MS;
  process.env.DKG_CATCHUP_BACKPRESSURE_MAX_WAIT_MS = '900';
  return before;
});

afterAll(() => {
  if (previousCATCHUPBACKPRESSUREMAXWAITMS === undefined) delete process.env.DKG_CATCHUP_BACKPRESSURE_MAX_WAIT_MS;
  else process.env.DKG_CATCHUP_BACKPRESSURE_MAX_WAIT_MS = previousCATCHUPBACKPRESSUREMAXWAITMS;
});

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * SCOPE OF THESE TESTS — read before trusting a green run.
 *
 * Most older cases below hand the worker an `authoritativePeerId` through the
 * stubbed `prepareCatchup` boundary. No production metadata resolver currently
 * produces that durable/VM authority: `resolveCuratorSyncPeer` was changed in
 * `e7f46dca2` because a curator-to-peer binding read out of accumulated
 * `<cg>/_meta` identifies the graph that HOLDS the rows, not the writer that
 * SUPPLIED them. RFC-64 now has a separate production route for explicit,
 * operator-pinned graph-complete SWM providers; the focused test below covers
 * that resolver-to-worker bridge and keeps its authority separate from VM.
 *
 * Therefore the injected metadata-authority cases remain worker-contract tests,
 * while the RFC-64 SWM case is production-wiring evidence for SWM selection.
 * Do not read the former as proof that VM authority resolution is already live.
 *
 * They are kept rather than deleted because #2018 re-enables exactly this
 * machinery, and deleting them would remove the contract it has to satisfy. When
 * that lands, the missing piece is a case that derives `authoritativePeerId`
 * through the REAL resolver/projection path instead of injecting it here.
 */
describe('catchup-runner-worker-impl bounded fan-out (sync-storm mitigation C-1)', () => {
  it('dispatches one durable bridge call when the host owns graph-level recovery', async () => {
    const peerIds = ['peer-a', 'peer-b', 'peer-c'];
    const durableCalls: string[] = [];

    const result = await runWorkerCatchup({
      contextGraphId: 'cg-graph-owner',
      includeSharedMemory: false,
      graphOwnedDurableRecovery: true,
    }, async (method, args) => {
      switch (method) {
        case 'prepareCatchup':
          return {
            isPrivateContextGraph: false,
            peerIds,
            connectedPeers: peerIds.length,
          };
        case 'waitForSyncProtocol':
          return true;
        case 'syncDurableRecovery':
          durableCalls.push(args[0] as string);
          return durableResult();
        case 'finalizeCatchup':
          return null;
        default:
          throw new Error(`unexpected invoke: ${method}`);
      }
    });

    expect(durableCalls).toEqual(['peer-a']);
    expect(result.peersTried).toBe(1);
    expect(result.peersNotAttempted).toBe(2);
  });

  it('does not credit a graph-owner bridge peer with curator-hosted emptiness', async () => {
    const peerIds = ['peer-a', 'peer-b'];

    const result = await runWorkerCatchup({
      contextGraphId: 'cg-graph-owner-empty',
      includeSharedMemory: false,
      graphOwnedDurableRecovery: true,
    }, async (method) => {
      switch (method) {
        case 'prepareCatchup':
          return {
            authoritativePeerId: undefined,
            isPrivateContextGraph: false,
            peerIds,
            connectedPeers: peerIds.length,
          };
        case 'waitForSyncProtocol':
          return true;
        case 'syncDurableRecovery':
          return {
            ...durableResult(),
            insertedTriples: 0,
            fetchedMetaTriples: 0,
            fetchedDataTriples: 0,
            insertedMetaTriples: 0,
            insertedDataTriples: 0,
            bytesReceived: 0,
            emptyResponses: 1,
            completedPhases: 2,
          };
        case 'finalizeCatchup':
          return null;
        default:
          throw new Error(`unexpected invoke: ${method}`);
      }
    });

    expect(result.cleanPlaneCompletions?.durable.authorityEmptyPeers).toBe(0);
    expect(result.cleanPlaneCompletions?.durable.emptyPeers).toBe(1);
  });

  it('keeps shared-memory fan-out when the host owns graph-level durable recovery', async () => {
    const peerIds = ['peer-a', 'peer-b', 'peer-c'];
    const durableCalls: string[] = [];
    const sharedCalls: string[] = [];

    const result = await runWorkerCatchup({
      contextGraphId: 'cg-graph-owner-mixed',
      includeSharedMemory: true,
      graphOwnedDurableRecovery: true,
    }, async (method, args) => {
      switch (method) {
        case 'prepareCatchup':
          return {
            isPrivateContextGraph: false,
            peerIds,
            connectedPeers: peerIds.length,
          };
        case 'waitForSyncProtocol':
          return true;
        case 'syncDurableRecovery':
          durableCalls.push(args[0] as string);
          return durableResult();
        case 'syncSharedMemory':
          sharedCalls.push(args[0] as string);
          return sharedResult();
        case 'finalizeCatchup':
          return null;
        default:
          throw new Error(`unexpected invoke: ${method}`);
      }
    });

    expect(durableCalls).toEqual(['peer-a']);
    expect(sharedCalls.sort()).toEqual([...peerIds].sort());
    expect(result.peersTried).toBe(3);
  });

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
          return { preferredPeerId: 'peer-0', authoritativePeerId: 'peer-0', isPrivateContextGraph: false, peerIds, connectedPeers: peerIds.length };
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

  it('uses distinct RFC-64 SWM and metadata VM authorities without fallback fan-out', async () => {
    const peerIds = ['peer-swm', 'peer-curator', 'peer-a', 'peer-b'];
    const durableCalls: string[] = [];
    const sharedCalls: string[] = [];

    const result = await runWorkerCatchup(
      { contextGraphId: 'cg-plane-authorities', includeSharedMemory: true },
      async (method, args) => {
        switch (method) {
          case 'prepareCatchup':
            return {
              preferredPeerId: 'peer-curator',
              authoritativePeerId: 'peer-curator',
              authoritativeSharedMemoryPeerIds: ['peer-swm'],
              isPrivateContextGraph: false,
              peerIds,
              connectedPeers: peerIds.length,
            };
          case 'waitForSyncProtocol':
            return true;
          case 'syncDurable':
            durableCalls.push(args[0] as string);
            return durableResult();
          case 'syncSharedMemory': {
            if (args[4] !== true) {
              throw new Error('complete SWM provider must select the RFC-64 lane');
            }
            sharedCalls.push(args[0] as string);
            const shared = sharedResult();
            return {
              kind: 'selected-shared-memory',
              shared: {
                ...shared,
                insertedTriples: 0,
                fetchedDataTriples: 0,
                insertedDataTriples: 0,
                bytesReceived: 0,
                emptyResponses: 1,
                failedPhases: 1,
                snapshotPlaneIncomplete: 1,
                resolvedSnapshotPlaneIncomplete: 1,
                timedOutPhases: 1,
                metadataContinuationYields: 1,
                resolvedMetadataContinuationYields: 1,
              },
              scopeComplete: true,
            };
          }
          case 'finalizeCatchup':
            return null;
          default:
            throw new Error(`unexpected invoke: ${method}`);
        }
      },
    );

    expect(durableCalls).toEqual(['peer-curator']);
    expect(sharedCalls).toEqual(['peer-swm']);
    expect(result.peersTried).toBe(2);
    expect(result.peersNotAttempted).toBe(2);
    expect(result.diagnostics?.durable.authorityUnanswered).toBe(false);
    expect(result.diagnostics?.sharedMemory.authorityUnanswered).toBe(false);
    // The selected provider proved the exact graph-complete scope without
    // transferring anything new. Raw historical yield counters remain visible,
    // but the typed terminal verdict is the positive readiness proof.
    expect(result.sharedMemorySynced).toBe(0);
    expect(result.diagnostics?.sharedMemory.failedPhases).toBe(1);
    expect(result.diagnostics?.sharedMemory.timedOutPhases).toBe(1);
    expect(result.cleanPlaneCompletions?.sharedMemory.verifiedDataPeers).toBe(0);
    expect(result.cleanPlaneCompletions?.sharedMemory.selectedScopeCompletePeers).toBe(1);
    expect(result.peersSucceeded).toBe(2);
  });

  it('runs selected SWM before durable when one peer owns both authorities', async () => {
    const calls: string[] = [];
    const result = await runWorkerCatchup(
      { contextGraphId: 'cg-one-selected-authority', includeSharedMemory: true },
      async (method, args) => {
        switch (method) {
          case 'prepareCatchup':
            return {
              preferredPeerId: 'peer-both',
              authoritativePeerId: 'peer-both',
              authoritativeSharedMemoryPeerIds: ['peer-both'],
              isPrivateContextGraph: false,
              peerIds: ['peer-both', 'peer-fallback'],
              connectedPeers: 2,
            };
          case 'waitForSyncProtocol':
            return true;
          case 'syncSharedMemory':
            expect(args[4]).toBe(true);
            calls.push('shared');
            return {
              kind: 'selected-shared-memory',
              shared: sharedResult(),
              scopeComplete: true,
            };
          case 'syncDurable':
            calls.push('durable');
            return durableResult();
          case 'finalizeCatchup':
            return null;
          default:
            throw new Error(`unexpected invoke: ${method}`);
        }
      },
    );

    expect(calls).toEqual(['shared', 'durable']);
    expect(result.peersTried).toBe(1);
    expect(result.peersNotAttempted).toBe(1);
    expect(result.cleanPlaneCompletions?.sharedMemory.selectedScopeCompletePeers).toBe(1);
    expect(result.cleanPlaneCompletions?.durable.verifiedDataPeers).toBe(1);
  });

  it('does not run durable after selected SWM is deferred by backpressure', async () => {
    let selectedCalls = 0;
    let durableCalls = 0;
    const finalizeCalls: unknown[][] = [];
    const result = await runWorkerCatchup(
      { contextGraphId: 'cg-selected-authority-deferred', includeSharedMemory: true },
      async (method) => {
        switch (method) {
          case 'prepareCatchup':
            return {
              preferredPeerId: 'peer-both',
              authoritativePeerId: 'peer-both',
              authoritativeSharedMemoryPeerIds: ['peer-both'],
              isPrivateContextGraph: false,
              peerIds: ['peer-both'],
              connectedPeers: 1,
            };
          case 'waitForSyncProtocol':
            return true;
          case 'syncSharedMemory':
            selectedCalls += 1;
            return {
              kind: 'selected-shared-memory',
              shared: {
                ...sharedResult(),
                insertedTriples: 0,
                insertedDataTriples: 0,
                completedPhases: 0,
                deferredBackpressure: 1,
              },
              scopeComplete: false,
            };
          case 'syncDurable':
            durableCalls += 1;
            return durableResult();
          case 'finalizeCatchup':
            finalizeCalls.push([]);
            return null;
          default:
            throw new Error(`unexpected invoke: ${method}`);
        }
      },
    );

    expect(selectedCalls).toBeGreaterThanOrEqual(2);
    expect(durableCalls).toBe(0);
    expect(result.deferredBackpressure).toBe(1);
    expect(finalizeCalls).toEqual([]);
  });

  it('fails selected SWM closed when its explicit scope is incomplete', async () => {
    const peerIds = ['peer-swm', 'peer-curator'];
    const selectedCalls: string[] = [];

    const result = await runWorkerCatchup(
      { contextGraphId: 'cg-selected-incomplete', includeSharedMemory: true },
      async (method, args) => {
        switch (method) {
          case 'prepareCatchup':
            return {
              preferredPeerId: 'peer-curator',
              authoritativePeerId: 'peer-curator',
              authoritativeSharedMemoryPeerIds: ['peer-swm'],
              isPrivateContextGraph: false,
              peerIds,
              connectedPeers: peerIds.length,
            };
          case 'waitForSyncProtocol':
            return true;
          case 'syncDurable':
            return durableResult();
          case 'syncSharedMemory':
            expect(args[4]).toBe(true);
            selectedCalls.push(String(args[0]));
            return {
              kind: 'selected-shared-memory',
              shared: sharedResult(),
              scopeComplete: false,
            };
          case 'finalizeCatchup':
            return null;
          default:
            throw new Error(`unexpected invoke: ${method}`);
        }
      },
    );

    expect(selectedCalls).toEqual(['peer-swm']);
    expect(result.cleanPlaneCompletions?.sharedMemory.verifiedDataPeers).toBe(0);
    expect(result.cleanPlaneCompletions?.sharedMemory.selectedScopeCompletePeers ?? 0).toBe(0);
    expect(result.cleanPlaneCompletions?.sharedMemory.incompleteResponders).toBe(1);
    expect(result.diagnostics?.sharedMemory.authorityUnanswered).toBe(true);
    // Only the durable curator succeeded. Clean-looking selected payload
    // counters cannot promote an explicitly incomplete terminal boundary.
    expect(result.peersSucceeded).toBe(1);
  });

  it('uses selected scheduling for public SWM without promoting an ordinary peer to graph authority', async () => {
    const selectedFlags: unknown[] = [];
    const result = await runWorkerCatchup(
      { contextGraphId: 'cg-public-selected-default', includeSharedMemory: true },
      async (method, args) => {
        switch (method) {
          case 'prepareCatchup':
            return {
              preferredPeerId: 'peer-curator',
              authoritativePeerId: 'peer-curator',
              authoritativeSharedMemoryPeerIds: [],
              isPrivateContextGraph: false,
              peerIds: ['peer-curator'],
              connectedPeers: 1,
            };
          case 'waitForSyncProtocol':
            return true;
          case 'syncDurable':
            return durableResult();
          case 'syncSharedMemory':
            selectedFlags.push(args[4]);
            return {
              kind: 'selected-shared-memory',
              shared: sharedResult(),
              scopeComplete: true,
            };
          case 'finalizeCatchup':
            return null;
          default:
            throw new Error(`unexpected invoke: ${method}`);
        }
      },
    );

    expect(selectedFlags).toEqual([true]);
    expect(result.cleanPlaneCompletions?.sharedMemory.verifiedDataPeers).toBe(1);
    expect(result.cleanPlaneCompletions?.sharedMemory.selectedScopeCompletePeers ?? 0).toBe(0);
  });

  it('still calls every ordinary peer after a selected-complete local manifest response', async () => {
    const peerIds = ['peer-ordinary-a', 'peer-ordinary-b'];
    const sharedCalls: string[] = [];
    const result = await runWorkerCatchup(
      { contextGraphId: 'cg-public-selected-union', includeSharedMemory: true },
      async (method, args) => {
        switch (method) {
          case 'prepareCatchup':
            return {
              isPrivateContextGraph: false,
              authoritativeSharedMemoryPeerIds: [],
              peerIds,
              connectedPeers: peerIds.length,
            };
          case 'waitForSyncProtocol':
            return true;
          case 'syncDurable':
            return { ...durableResult(), complete: false, failedPhases: 1 };
          case 'syncSharedMemory': {
            expect(args[4]).toBe(true);
            sharedCalls.push(String(args[0]));
            return {
              kind: 'selected-shared-memory',
              shared: {
                ...sharedResult(),
                insertedTriples: 0,
                fetchedDataTriples: 0,
                insertedDataTriples: 0,
                bytesReceived: 0,
                emptyResponses: 1,
              },
              scopeComplete: true,
            };
          }
          case 'finalizeCatchup':
            return null;
          default:
            throw new Error(`unexpected invoke: ${method}`);
        }
      },
    );

    expect(sharedCalls.sort()).toEqual([...peerIds].sort());
    expect(result.peersTried).toBe(peerIds.length);
    expect(result.cleanPlaneCompletions?.sharedMemory.selectedScopeCompletePeers ?? 0).toBe(0);
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
          expect(args[4]).toBe(true);
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
          return { preferredPeerId: 'peer-0', authoritativePeerId: 'peer-0', isPrivateContextGraph: false, peerIds, connectedPeers: peerIds.length };
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

  it('lets the curator settle the DURABLE plane by answering cleanly empty', async () => {
    // The Context Graph is the curator's, so its "there is nothing here" is
    // authoritative for the durable plane and one payload settles it. The
    // shared-memory plane is deliberately NOT symmetric — see the next test.
    const peerIds = Array.from({ length: 10 }, (_, i) => `peer-${i}`);
    const durableCalls: string[] = [];

    const result = await runWorkerCatchup({ contextGraphId: 'cg-empty-durable', includeSharedMemory: false }, async (method, args) => {
      switch (method) {
        case 'prepareCatchup':
          return { preferredPeerId: 'peer-0', authoritativePeerId: 'peer-0', isPrivateContextGraph: false, peerIds, connectedPeers: peerIds.length };
        case 'waitForSyncProtocol':
          return true;
        case 'syncDurable':
          durableCalls.push(args[0] as string);
          return {
            ...durableResult(),
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
    expect(result.peersNotAttempted).toBe(peerIds.length - 1);
    expect(result.cleanPlaneCompletions?.durable.authorityEmptyPeers).toBe(1);
  });

  it('does NOT let the curator settle the shared-memory plane by answering empty', async () => {
    // Shared memory is a per-agent-address layered union
    // (`<swm>/<addr>/<number>`) contributed by many members, so a curator that
    // holds no SWM rows has not said anything about the members' layers — it
    // does not own them. Settling on its silence skipped peers that held valid
    // rows, and could report `sharedMemoryVerified` with `sharedMemorySynced: 0`.
    //
    // The durable plane still settles on the curator's round, so the expensive
    // half of the walk is still one payload: fallback peers are narrowed to SWM.
    const peerIds = Array.from({ length: 6 }, (_, i) => `peer-${i}`);
    const durableCalls: string[] = [];
    const sharedCalls: string[] = [];

    const result = await runWorkerCatchup({ contextGraphId: 'cg-swm-union', includeSharedMemory: true }, async (method, args) => {
      switch (method) {
        case 'prepareCatchup':
          return { preferredPeerId: 'peer-0', authoritativePeerId: 'peer-0', isPrivateContextGraph: false, peerIds, connectedPeers: peerIds.length };
        case 'waitForSyncProtocol':
          return true;
        case 'syncDurable':
          durableCalls.push(args[0] as string);
          return durableResult();
        case 'syncSharedMemory':
          expect(args[4]).toBe(true);
          sharedCalls.push(args[0] as string);
          // The curator has nothing; a later member holds the rows.
          if (args[0] === 'peer-0') {
            return {
              ...sharedResult(),
              insertedTriples: 0,
              fetchedDataTriples: 0,
              insertedDataTriples: 0,
              bytesReceived: 0,
              completedPhases: 2,
              emptyResponses: 1,
            };
          }
          return sharedResult();
        case 'finalizeCatchup':
          return null;
        default:
          throw new Error(`unexpected invoke: ${method}`);
      }
    });

    // The expensive plane is still pulled once…
    expect(durableCalls).toEqual(['peer-0']);
    // …while the union plane keeps walking, and reaches the member that has rows.
    expect([...sharedCalls].sort()).toEqual([...peerIds].sort());
    expect(result.peersNotAttempted).toBe(0);
    expect(result.cleanPlaneCompletions?.sharedMemory.authorityEmptyPeers).toBe(0);
    expect(result.cleanPlaneCompletions?.sharedMemory.verifiedDataPeers).toBeGreaterThan(0);
    expect(result.sharedMemorySynced).toBeGreaterThan(0);
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
          return { preferredPeerId: 'peer-0', authoritativePeerId: 'peer-0', isPrivateContextGraph: false, peerIds, connectedPeers: peerIds.length };
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

  it('does not let an empty curator round settle a PRIVATE plane', async () => {
    // Readiness deliberately refuses to prove a private plane from an empty
    // response, so stopping the walk on one would strand it: fallback peers
    // that may hold authorized private data are skipped and a recoverable
    // catch-up turns into `unreachable`. Emptiness only settles public planes.
    const peerIds = ['peer-curator', 'peer-with-data', 'peer-c', 'peer-d', 'peer-e', 'peer-f'];
    const durableCalls: string[] = [];

    const result = await runWorkerCatchup({ contextGraphId: 'cg-private-empty', includeSharedMemory: false }, async (method, args) => {
      switch (method) {
        case 'prepareCatchup':
          return {
            preferredPeerId: 'peer-curator',
            authoritativePeerId: 'peer-curator',
            isPrivateContextGraph: true,
            peerIds,
            connectedPeers: peerIds.length,
          };
        case 'waitForSyncProtocol':
          return true;
        case 'syncDurable':
          durableCalls.push(args[0] as string);
          if (args[0] === 'peer-curator') {
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
          return durableResult();
        case 'finalizeCatchup':
          return null;
        default:
          throw new Error(`unexpected invoke: ${method}`);
      }
    });

    // The authorized fallback peer must still be reached.
    expect(durableCalls).toContain('peer-with-data');
    expect(result.cleanPlaneCompletions?.durable.verifiedDataPeers).toBeGreaterThan(0);
  });

  it('still lets a verified private-only curator round settle a private plane', async () => {
    // The complement: a cryptographically verified V2 response whose public
    // graph is intentionally empty is CONTENT, not emptiness, and must keep
    // working as positive proof on a private graph.
    const peerIds = Array.from({ length: 8 }, (_, i) => `peer-${i}`);
    const durableCalls: string[] = [];

    const result = await runWorkerCatchup({ contextGraphId: 'cg-private-only', includeSharedMemory: false }, async (method, args) => {
      switch (method) {
        case 'prepareCatchup':
          return {
            preferredPeerId: 'peer-0',
            authoritativePeerId: 'peer-0',
            isPrivateContextGraph: true,
            peerIds,
            connectedPeers: peerIds.length,
          };
        case 'waitForSyncProtocol':
          return true;
        case 'syncDurable':
          durableCalls.push(args[0] as string);
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
    });

    expect(durableCalls).toEqual(['peer-0']);
    expect(result.peersNotAttempted).toBe(peerIds.length - 1);
    expect(result.cleanPlaneCompletions?.durable.verifiedPrivateOnlyPeers).toBe(1);
  });

  it('does not let an empty curator round settle a PRIVATE shared-memory plane', async () => {
    // The shared-memory half of the private rule. It needs its own coverage:
    // `includeSharedMemory` defaults to true on subscribe and shared memory is
    // frequently empty, so this is the plane an over-eager empty rule would
    // settle first — stranding the walk before any authorized peer holding SWM
    // data is contacted. The durable plane settles by verified content here, so
    // only the shared plane's rule is under test.
    const peerIds = Array.from({ length: 6 }, (_, i) => `peer-${i}`);
    const durableCalls: string[] = [];
    const sharedCalls: string[] = [];

    const result = await runWorkerCatchup({ contextGraphId: 'cg-private-swm', includeSharedMemory: true }, async (method, args) => {
      switch (method) {
        case 'prepareCatchup':
          return {
            preferredPeerId: 'peer-0',
            authoritativePeerId: 'peer-0',
            isPrivateContextGraph: true,
            peerIds,
            connectedPeers: peerIds.length,
          };
        case 'waitForSyncProtocol':
          return true;
        case 'syncDurable':
          durableCalls.push(args[0] as string);
          return {
            ...durableResult(),
            insertedTriples: 8,
            fetchedMetaTriples: 8,
            fetchedDataTriples: 0,
            insertedMetaTriples: 8,
            insertedDataTriples: 0,
            verifiedPrivateOnlyResponses: 1,
          };
        case 'syncSharedMemory':
          expect(args[4]).toBe(false);
          sharedCalls.push(args[0] as string);
          return {
            ...sharedResult(),
            insertedTriples: 0,
            fetchedDataTriples: 0,
            insertedDataTriples: 0,
            bytesReceived: 0,
            emptyResponses: 1,
          };
        case 'finalizeCatchup':
          return null;
        default:
          throw new Error(`unexpected invoke: ${method}`);
      }
    });

    // Durable settled on the curator's verified content and is not re-pulled…
    expect(durableCalls).toEqual(['peer-0']);
    // …while the unproven shared plane keeps walking every remaining peer.
    expect([...sharedCalls].sort()).toEqual([...peerIds].sort());
    expect(result.peersNotAttempted).toBe(0);
    // The shared plane produces no authority evidence at all now — privacy is no
    // longer the only thing standing between an empty curator round and a
    // settled SWM plane.
    expect(result.cleanPlaneCompletions?.sharedMemory.authorityEmptyPeers).toBe(0);
  });

  it('reports the curator as unanswered when it was selected and transport-failed', async () => {
    // The exact #2006 shape, produced by the walk's own design: a resolvable
    // curator is ranked first and gets wave 1 ALONE, so when it transport-fails
    // the walk moves on to strangers, one answers empty, and without this signal
    // that stranger's silence would settle a 40-KA graph as `done` with zero.
    const peerIds = ['peer-curator', 'peer-a', 'peer-b', 'peer-c'];

    const result = await runWorkerCatchup({ contextGraphId: 'cg-curator-silent', includeSharedMemory: false }, async (method, args) => {
      switch (method) {
        case 'prepareCatchup':
          return {
            preferredPeerId: 'peer-curator',
            authoritativePeerId: 'peer-curator',
            isPrivateContextGraph: false,
            peerIds,
            connectedPeers: peerIds.length,
          };
        case 'waitForSyncProtocol':
          return true;
        case 'syncDurable':
          if (args[0] === 'peer-curator') {
            // Transport failure: no clean completion from the one peer that knows.
            return { ...durableResult(), complete: false, insertedTriples: 0,
              fetchedDataTriples: 0, insertedDataTriples: 0, bytesReceived: 0,
              completedPhases: 0, failedPeers: 1 };
          }
          return { ...durableResult(), insertedTriples: 0, fetchedDataTriples: 0,
            insertedDataTriples: 0, bytesReceived: 0, completedPhases: 2, emptyResponses: 1 };
        case 'finalizeCatchup':
          return null;
        default:
          throw new Error(`unexpected invoke: ${method}`);
      }
    });

    expect(result.diagnostics?.durable.authorityUnanswered).toBe(true);
    // Strangers still answered cleanly empty — that is exactly what must NOT
    // settle the plane now.
    expect(result.cleanPlaneCompletions?.durable.emptyPeers).toBeGreaterThan(0);
  });

  it('reports the curator as answered when it completed cleanly', async () => {
    // The complement, so the flag cannot be hardwired true: a curator that
    // answers must leave the round provable.
    const peerIds = ['peer-curator', 'peer-a'];

    const result = await runWorkerCatchup({ contextGraphId: 'cg-curator-answered', includeSharedMemory: false }, async (method, args) => {
      switch (method) {
        case 'prepareCatchup':
          return {
            preferredPeerId: 'peer-curator',
            authoritativePeerId: 'peer-curator',
            isPrivateContextGraph: false,
            peerIds,
            connectedPeers: peerIds.length,
          };
        case 'waitForSyncProtocol':
          return true;
        case 'syncDurable':
          return durableResult();
        case 'finalizeCatchup':
          return null;
        default:
          throw new Error(`unexpected invoke: ${method}`);
      }
    });

    expect(result.diagnostics?.durable.authorityUnanswered).toBe(false);
  });

  it('does not stop on a hosted-empty curator that the round already contradicted', async () => {
    // The curator says "nothing here" while another peer in the SAME wave served
    // content that failed verification. Readiness treats that as content
    // EXISTING, so it voids the empty proof — and if the walk had already
    // stopped on the curator's word, the job ends unready having skipped peers
    // that might have delivered valid data. Worst of both.
    //
    // The curator is deliberately NOT first, so the opening wave is full width
    // and both responses land in the same wave: this is exactly the ordering
    // where a per-peer stop decision cannot see the contradiction.
    // `peer-later` MUST sit in a later wave: with the curator not first the
    // opening wave is full width, so a three-peer list would contact everyone
    // regardless and the test could not observe an early stop at all.
    const wave1 = ['peer-rejected', 'peer-curator', 'peer-quiet-a', 'peer-quiet-b'];
    const peerIds = [...wave1, 'peer-later', 'peer-quiet-c'];
    expect(wave1.length).toBe(CATCHUP_MAX_CONCURRENT_PEER_SYNCS);
    expect(peerIds.length).toBeGreaterThan(CATCHUP_MAX_CONCURRENT_PEER_SYNCS);
    const durableCalls: string[] = [];

    const result = await runWorkerCatchup({ contextGraphId: 'cg-contradicted', includeSharedMemory: false }, async (method, args) => {
      switch (method) {
        case 'prepareCatchup':
          return {
            preferredPeerId: 'peer-curator',
            authoritativePeerId: 'peer-curator',
            isPrivateContextGraph: false,
            peerIds,
            connectedPeers: peerIds.length,
          };
        case 'waitForSyncProtocol':
          return true;
        case 'syncDurable': {
          durableCalls.push(args[0] as string);
          if (args[0] === 'peer-curator') {
            return {
              ...durableResult(),
              insertedTriples: 9,
              fetchedMetaTriples: 9,
              fetchedDataTriples: 0,
              insertedMetaTriples: 9,
              insertedDataTriples: 0,
              metaOnlyResponses: 1,
              completedPhases: 2,
            };
          }
          if (args[0] === 'peer-rejected') {
            // Served content for this graph; verification threw it out.
            return {
              ...durableResult(),
              insertedTriples: 0,
              fetchedDataTriples: 4_000,
              insertedDataTriples: 0,
              rejectedKcs: 1,
            };
          }
          if (args[0] === 'peer-later') return durableResult();
          // Everyone else answers content-free, so the only verified data in the
          // run is the one behind the wave boundary.
          return {
            ...durableResult(),
            insertedTriples: 0,
            fetchedDataTriples: 0,
            insertedDataTriples: 0,
            bytesReceived: 0,
            emptyResponses: 1,
            completedPhases: 2,
          };
        }
        case 'finalizeCatchup':
          return null;
        default:
          throw new Error(`unexpected invoke: ${method}`);
      }
    });

    // The contradiction is visible round-wide, so the curator's emptiness does
    // not settle the plane and the remaining peer is still reached.
    expect(durableCalls).toContain('peer-later');
    expect(result.peersNotAttempted).toBe(0);
    // …and that last peer's verified data is what actually proves the plane.
    expect(result.cleanPlaneCompletions?.durable.verifiedDataPeers).toBeGreaterThan(0);
  });

  it('does not settle the SHARED-MEMORY plane on curator metadata alone', async () => {
    // End-to-end counterpart of the plane-aware reducer: shared memory is
    // contributed by many members rather than owned by the curator, so
    // `insertedMetaTriples` there is not the hosting proof `<cg>/_meta` is on
    // the durable plane. Settling on it would stop the walk before any member
    // holding the SWM rows is contacted. Public graph, so privacy is not what
    // is doing the work here.
    const peerIds = Array.from({ length: 6 }, (_, i) => `peer-${i}`);
    const sharedCalls: string[] = [];

    const result = await runWorkerCatchup({ contextGraphId: 'cg-swm-meta', includeSharedMemory: true }, async (method, args) => {
      switch (method) {
        case 'prepareCatchup':
          return {
            preferredPeerId: 'peer-0',
            authoritativePeerId: 'peer-0',
            isPrivateContextGraph: false,
            peerIds,
            connectedPeers: peerIds.length,
          };
        case 'waitForSyncProtocol':
          return true;
        case 'syncDurable':
          return durableResult();
        case 'syncSharedMemory':
          sharedCalls.push(args[0] as string);
          return {
            ...sharedResult(),
            insertedTriples: 5,
            insertedMetaTriples: 5,
            insertedDataTriples: 0,
            fetchedDataTriples: 0,
            bytesReceived: 0,
            emptyResponses: 0,
            completedPhases: 2,
          };
        case 'finalizeCatchup':
          return null;
        default:
          throw new Error(`unexpected invoke: ${method}`);
      }
    });

    expect([...sharedCalls].sort()).toEqual([...peerIds].sort());
    expect(result.cleanPlaneCompletions?.sharedMemory.authorityEmptyPeers).toBe(0);
  });

  it('settles a public plane when the CURATOR hosts the graph and has no data', async () => {
    // A registered public Context Graph with no Knowledge Assets yet. Its host
    // still serves the CG definition triples from `<cg>/_meta`, so it answers
    // metadata-only — never wire-empty — and no whole-round emptiness rule can
    // fire for it. The curator saying "I host this and there is nothing in it"
    // is the only evidence that exists, and without it such a graph would sit
    // at `unreachable` forever while re-walking every peer on every retry.
    const peerIds = Array.from({ length: 8 }, (_, i) => `peer-${i}`);
    const durableCalls: string[] = [];

    const result = await runWorkerCatchup({ contextGraphId: 'cg-registered-empty', includeSharedMemory: false }, async (method, args) => {
      switch (method) {
        case 'prepareCatchup':
          return {
            preferredPeerId: 'peer-0',
            authoritativePeerId: 'peer-0',
            isPrivateContextGraph: false,
            peerIds,
            connectedPeers: peerIds.length,
          };
        case 'waitForSyncProtocol':
          return true;
        case 'syncDurable':
          durableCalls.push(args[0] as string);
          return {
            ...durableResult(),
            insertedTriples: 9,
            fetchedMetaTriples: 9,
            fetchedDataTriples: 0,
            insertedMetaTriples: 9,
            insertedDataTriples: 0,
            metaOnlyResponses: 1,
            completedPhases: 2,
          };
        case 'finalizeCatchup':
          return null;
        default:
          throw new Error(`unexpected invoke: ${method}`);
      }
    });

    expect(durableCalls).toEqual(['peer-0']);
    expect(result.peersNotAttempted).toBe(peerIds.length - 1);
    expect(result.cleanPlaneCompletions?.durable.authorityEmptyPeers).toBe(1);
    // The same round from a peer that is NOT the curator proves nothing: it is
    // what any member holding `_meta` but no data looks like.
    expect(result.cleanPlaneCompletions?.durable.emptyPeers).toBe(0);
  });

  it('does not let a non-curator metadata-only round stop the walk', async () => {
    // The counterpart of the test above, and the reason it is scoped to the
    // curator: mid-sync members answering metadata-only are the commonest
    // state on the network. Accepting theirs would resettle #2006 exactly —
    // `done` with zero Knowledge Assets out of forty.
    const peerIds = Array.from({ length: 6 }, (_, i) => `peer-${i}`);
    const durableCalls: string[] = [];

    const result = await runWorkerCatchup({ contextGraphId: 'cg-members-only', includeSharedMemory: false }, async (method, args) => {
      switch (method) {
        case 'prepareCatchup':
          return {
            preferredPeerId: 'peer-0',
            authoritativePeerId: undefined,
            isPrivateContextGraph: false,
            peerIds,
            connectedPeers: peerIds.length,
          };
        case 'waitForSyncProtocol':
          return true;
        case 'syncDurable':
          durableCalls.push(args[0] as string);
          return {
            ...durableResult(),
            insertedTriples: 9,
            fetchedMetaTriples: 9,
            fetchedDataTriples: 0,
            insertedMetaTriples: 9,
            insertedDataTriples: 0,
            metaOnlyResponses: 1,
            completedPhases: 2,
          };
        case 'finalizeCatchup':
          return null;
        default:
          throw new Error(`unexpected invoke: ${method}`);
      }
    });

    expect([...durableCalls].sort()).toEqual([...peerIds].sort());
    expect(result.peersNotAttempted).toBe(0);
    expect(result.cleanPlaneCompletions?.durable.authorityEmptyPeers).toBe(0);
  });

  it('does not let a bootstrap-hint preferred peer stop the walk', async () => {
    // `resolvePreferredSyncPeerId` falls back to the authenticated join-approval
    // hint when metadata resolves no curator. That hint can be stale — a curator
    // that has since rotated its libp2p identity leaves an ordinary member on
    // that peer id — so it orders the walk but must never end it. The worker
    // sees that as `preferredPeerId` WITHOUT `authoritativePeerId`.
    const peerIds = Array.from({ length: 8 }, (_, i) => `peer-${i}`);
    const durableCalls: string[] = [];

    const result = await runWorkerCatchup({ contextGraphId: 'cg-hint-only', includeSharedMemory: false }, async (method, args) => {
      switch (method) {
        case 'prepareCatchup':
          return {
            preferredPeerId: 'peer-0',
            authoritativePeerId: undefined,
            isPrivateContextGraph: false,
            peerIds,
            connectedPeers: peerIds.length,
          };
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

  it('walks a no-authority round as ONE pass, with no barrier between waves', async () => {
    // Waves exist only so an authority can cut the walk short. With no
    // authoritative curator nothing can break the loop, so splitting the peer
    // set into waves saves no fetch and only adds a barrier — making the round
    // slower than the single bounded pass it replaced.
    //
    // Barriers are invisible to a peak-concurrency assertion (both shapes peak
    // at the cap), so this pins the property that actually differs: with a
    // sliding window a LATER peer starts while an early slow peer is still in
    // flight; behind a barrier it cannot.
    const peerIds = Array.from({ length: 12 }, (_, i) => `peer-${i}`);
    let slowPeerInFlight = false;
    let startedDuringSlowPeer = 0;

    await runWorkerCatchup(
      { contextGraphId: 'cg-no-authority-single-pass', includeSharedMemory: false },
      async (method, args) => {
        switch (method) {
          case 'prepareCatchup':
            return {
              preferredPeerId: undefined,
              authoritativePeerId: undefined,
              isPrivateContextGraph: false,
              peerIds,
              connectedPeers: peerIds.length,
            };
          case 'waitForSyncProtocol':
            return true;
          case 'syncDurable': {
            const peerId = args[0] as string;
            if (peerId === 'peer-0') {
              slowPeerInFlight = true;
              await delay(40);
              slowPeerInFlight = false;
              return { ...durableResult(), complete: false };
            }
            // Anything beyond the first wave-width proves the window slid.
            if (slowPeerInFlight && Number(peerId.slice('peer-'.length)) >= CATCHUP_MAX_CONCURRENT_PEER_SYNCS) {
              startedDuringSlowPeer += 1;
            }
            await delay(1);
            return { ...durableResult(), complete: false };
          }
          case 'finalizeCatchup':
            return null;
          default:
            throw new Error(`unexpected invoke: ${method}`);
        }
      },
    );

    expect(startedDuringSlowPeer).toBeGreaterThan(0);
  });

  it('spends the single-peer opening wave only on a sync-capable curator', async () => {
    // A REAL authority that is offline: metadata resolved a curator, so
    // `authoritativePeerId` is set, but the protocol probe filters it out. The
    // opening wave narrows to one peer only when the authority is the peer that
    // wave would actually contact — otherwise the walk would serialise an
    // arbitrary fallback peer for nothing.
    //
    // The fixture must set `authoritativePeerId`: without it the walk takes the
    // no-curator branch (covered separately above) and neither half of the
    // guard is exercised.
    const peerIds = ['peer-curator', 'peer-a', 'peer-b', 'peer-c', 'peer-d'];
    const durableCalls: string[] = [];
    let inFlight = 0;
    let peak = 0;

    await runWorkerCatchup({ contextGraphId: 'cg-curator-offline', includeSharedMemory: false }, async (method, args) => {
      switch (method) {
        case 'prepareCatchup':
          return {
            preferredPeerId: 'peer-curator',
            authoritativePeerId: 'peer-curator',
            isPrivateContextGraph: false,
            peerIds,
            connectedPeers: peerIds.length,
          };
        case 'waitForSyncProtocol':
          return args[0] !== 'peer-curator';
        case 'syncDurable': {
          durableCalls.push(args[0] as string);
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
    // The offline authority is never contacted, and every reachable peer is.
    expect(durableCalls).not.toContain('peer-curator');
    expect([...durableCalls].sort()).toEqual(['peer-a', 'peer-b', 'peer-c', 'peer-d']);
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
          return { preferredPeerId: 'peer-0', authoritativePeerId: 'peer-0', isPrivateContextGraph: false, peerIds, connectedPeers: peerIds.length };
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
    //
    // The empty peers fill the ENTIRE first wave and the data-bearing peer sits
    // behind a wave boundary, so a regression that accepted any clean-empty
    // round as proof would stop before ever reaching it. A same-wave setup
    // could not observe that.
    const emptyPeers = Array.from(
      { length: CATCHUP_MAX_CONCURRENT_PEER_SYNCS },
      (_, i) => `peer-empty-${i}`,
    );
    const peerIds = [...emptyPeers, 'peer-data-failed', 'peer-quiet'];
    expect(peerIds.length).toBeGreaterThan(CATCHUP_MAX_CONCURRENT_PEER_SYNCS);
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

    // Emptiness is never a stop condition, so the walk crosses the wave
    // boundary and still reaches the data-bearing peer.
    expect(durableCalls).toEqual(peerIds);
    expect(durableCalls).toContain('peer-data-failed');
    expect(result.peersNotAttempted).toBe(0);
    expect(result.cleanPlaneCompletions?.durable.verifiedDataPeers).toBe(0);
    // The clean-empty peers are still recorded as clean empty completions…
    expect(result.cleanPlaneCompletions?.durable.emptyPeers)
      .toBe(peerIds.length - 1);
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
      durable: {
        verifiedDataPeers: 0,
        verifiedPrivateOnlyPeers: 0,
        emptyPeers: 0,
        authorityEmptyPeers: 0,
        // The peer answered and did not complete cleanly: recorded so a whole-round
        // empty verdict cannot be drawn over a half-delivered answer.
        incompleteResponders: 1,
      },
      sharedMemory: { verifiedDataPeers: 0, emptyPeers: 0, authorityEmptyPeers: 0, incompleteResponders: 1 },
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
      authorityEmptyPeers: 0,
      // The peer answered and did not complete cleanly: recorded so a whole-round
      // empty verdict cannot be drawn over a half-delivered answer.
      incompleteResponders: 1,
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
      authorityEmptyPeers: 0,
      // The peer answered and did not complete cleanly: recorded so a whole-round
      // empty verdict cannot be drawn over a half-delivered answer.
      incompleteResponders: 1,
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
      authorityEmptyPeers: 0,
      // No `incompleteResponders`: this peer COMPLETED cleanly. The counter
      // must not appear merely because a plane carried no public data.
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
      authorityEmptyPeers: 0,
      // The peer answered and did not complete cleanly: recorded so a whole-round
      // empty verdict cannot be drawn over a half-delivered answer.
      incompleteResponders: 1,
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
      durable: {
        verifiedDataPeers: 0,
        verifiedPrivateOnlyPeers: 0,
        emptyPeers: peerIds.length,
        authorityEmptyPeers: 0,
      },
      sharedMemory: { verifiedDataPeers: 0, emptyPeers: peerIds.length, authorityEmptyPeers: 0 },
    });
  });
});

/**
 * #2050 — the COMPOSED continuation chain, executed rather than reasoned about.
 *
 * Every link in this chain is pinned individually elsewhere: the coverage record
 * survives a throwing round (agent-side T14), the capability gate reads coverage
 * and not failure counters, the high-water mark advances, and the pure stop rule
 * decides correctly. What nothing executed was the SEAM — that a round which
 * materialized some Knowledge Assets and then failed actually causes a **second
 * pass to run**.
 *
 * That distinction is not pedantic. Both of the last two defects on this change
 * survived precisely because each piece was individually correct: a coverage
 * record that was fabricated-but-plausible, and a counter whose name outlived its
 * meaning. A chain of correct links can still fail to be connected.
 *
 * The load-bearing assertion here is the **pass count**, not the terminal record.
 * A test that only checks the final coverage passes whether the loop ran once or
 * twice — the first pass's own record already carries the converged numbers if
 * the second pass simply overwrites it.
 */
describe('#2050 continuation loop — a failed-but-productive pass earns another one', () => {
  const CG = 'continuation-chain-cg';
  const PEER = 'peer-continuation-0001';

  /** A round that resolved some of its manifest and did NOT complete cleanly. */
  /** Same shape but the manifest is a truncated prefix, so the peer is NOT capable. */
  function truncatedSharedRound(resolved: number, total: number) {
    const round = partialSharedRound(resolved, total);
    return { ...round, swmCoverage: { ...round.swmCoverage, manifestComplete: false } };
  }

  function partialSharedRound(resolved: number, total: number) {
    return {
      ...sharedResult(),
      // Not clean: without this the plane is proven by data and the loop stops at
      // `plane-proven` before the capability gate is ever consulted — which would
      // make this test pass for a reason that has nothing to do with the seam.
      failedPhases: 1,
      swmCoverage: {
        contextGraphId: CG,
        peerIdSuffix: PEER.slice(-8),
        snapshotsResolved: resolved,
        snapshotsTotal: total,
        manifestComplete: true,
        missingCount: total - resolved,
        missingSample: resolved < total ? ['sha256:unresolved'] : [],
        materializationFailures: 0,
      },
    };
  }

  it('runs a SECOND shared-memory pass, and only the shared-memory plane', async () => {
    const sharedCalls: string[] = [];
    const durableCalls: string[] = [];

    const result = await runWorkerCatchup(
      { contextGraphId: CG, includeSharedMemory: true },
      async (method, args) => {
        switch (method) {
          case 'prepareCatchup':
            return { isPrivateContextGraph: false, peerIds: [PEER], connectedPeers: 1 };
          case 'waitForSyncProtocol':
            return true;
          case 'syncDurable':
            durableCalls.push(String(args[0]));
            return durableResult();
          case 'syncSharedMemory': {
            sharedCalls.push(String(args[0]));
            // Pass 1 resolved 2 of 3 and did not finish; pass 2 finishes the
            // manifest, which takes the peer out of the capable set.
            return sharedCalls.length === 1
              ? partialSharedRound(2, 3)
              : partialSharedRound(3, 3);
          }
          default:
            return null;
        }
      },
    );

    // (5) THE seam: a second pass was actually dispatched. Asserted as a COUNT,
    // because the terminal record below is identical whether the loop ran once
    // or twice.
    expect(sharedCalls).toEqual([PEER, PEER]);

    // Continuation passes are shared-memory only — re-pulling durable would be
    // amplification that nothing in the capability gate selects for.
    expect(durableCalls).toEqual([PEER]);

    // (2)-(4) The chain that produced it: the second pass's record replaced the
    // first, coverage advanced, and the loop then stopped because the peer had
    // nothing left rather than because it gave up.
    expect(result.diagnostics?.sharedMemory?.swmCoverage).toMatchObject({
      snapshotsResolved: 3,
      snapshotsTotal: 3,
      missingCount: 0,
    });
    expect(result.diagnostics?.sharedMemory?.continuationPasses).toBe(1);
    expect(result.diagnostics?.sharedMemory?.continuationStopReason).toBe('no-capable-peers');

    // Distinct peers, not peer-passes. Pre-fix this counted rounds, which drove
    // `peersNotAttempted` negative once a pass repeated.
    expect(result.peersTried).toBe(1);
    expect(result.peersNotAttempted).toBe(0);
  });

  it('still runs a selected SWM continuation after authority proof', async () => {
    const CURATOR = 'peer-curator-0001';
    const OTHER = 'peer-capable-0002';
    const sharedCalls: string[] = [];
    const durableCalls: string[] = [];
    let otherSharedCalls = 0;

    const result = await runWorkerCatchup(
      { contextGraphId: CG, includeSharedMemory: true },
      async (method, args) => {
        const peerId = String(args[0]);
        switch (method) {
          case 'prepareCatchup':
            return {
              authoritativePeerId: CURATOR,
              isPrivateContextGraph: false,
              // Same opening wave: the authority can prove SWM while the other
              // peer reports the still-capable record the next pass must retry.
              peerIds: [OTHER, CURATOR],
              connectedPeers: 2,
            };
          case 'waitForSyncProtocol':
            return true;
          case 'syncDurable':
            durableCalls.push(peerId);
            return {
              ...durableResult(),
              complete: false,
              insertedTriples: 0,
              fetchedDataTriples: 0,
              insertedDataTriples: 0,
              failedPhases: 1,
            };
          case 'syncSharedMemory':
            sharedCalls.push(peerId);
            if (peerId === CURATOR) return sharedResult();
            otherSharedCalls += 1;
            return otherSharedCalls === 1
              ? partialSharedRound(2, 3)
              : partialSharedRound(3, 3);
          default:
            return null;
        }
      },
    );

    expect(sharedCalls.filter((peerId) => peerId === CURATOR)).toHaveLength(1);
    expect(sharedCalls.filter((peerId) => peerId === OTHER)).toHaveLength(2);
    expect(durableCalls.filter((peerId) => peerId === OTHER)).toHaveLength(1);
    expect(result.diagnostics?.sharedMemory?.swmCoverage).toMatchObject({
      snapshotsResolved: 3,
      snapshotsTotal: 3,
    });
    expect(result.diagnostics?.sharedMemory?.continuationPasses).toBe(1);
  });

  it('emits one per-pass log line carrying the coverage transition', async () => {
    // The per-pass line is the only PER-PASS observability an operator gets:
    // the terminal record reports the FINAL state, so without it a job that
    // converged in four passes is indistinguishable from one that converged in
    // one. It travels as a fire-and-forget RPC whose rejection is deliberately
    // swallowed, so a line that stops being emitted fails completely silently
    // — which is exactly the shape that needs a row rather than a reader.
    const sharedCalls: string[] = [];
    const passLines: string[] = [];

    await runWorkerCatchup(
      { contextGraphId: CG, includeSharedMemory: true },
      async (method, args) => {
        switch (method) {
          case 'prepareCatchup':
            return { isPrivateContextGraph: false, peerIds: [PEER], connectedPeers: 1 };
          case 'waitForSyncProtocol':
            return true;
          case 'syncDurable':
            return durableResult();
          case 'syncSharedMemory': {
            sharedCalls.push(String(args[0]));
            return sharedCalls.length === 1
              ? partialSharedRound(2, 3)
              : partialSharedRound(3, 3);
          }
          case 'logCatchupPass':
            passLines.push(String(args[0]));
            return null;
          default:
            return null;
        }
      },
    );

    // Two shared rounds ran, so exactly one CONTINUATION pass was logged —
    // numbered 2, because the first round is not a continuation.
    const continuationLines = passLines.filter((line) => line.startsWith('Catch-up SWM pass 2'));
    expect(continuationLines).toHaveLength(1);

    // The TRANSITION, not just the endpoint. A line reporting only the final
    // `3` could not distinguish a pass that advanced coverage from one that ran
    // and achieved nothing — which is the single fact this line exists to give
    // an operator.
    expect(continuationLines[0]).toContain('2 -> 3');
    expect(continuationLines[0]).toContain(CG);
  });

  it('does NOT run a second pass when nothing was resolved AND nobody is capable', async () => {
    // The negative half: without it, the row above would pass under an
    // implementation that always ran a second pass.
    //
    // The peer here reports a TRUNCATED manifest, so it is not capable and there
    // is nothing a repeat could collect. That distinction is the whole point.
    // This row used to use a peer reporting `0/3` with a COMPLETE manifest and
    // assert no repeat — but such a peer is capable by construction: it has just
    // said it holds three refs we do not have. Stopping there reported
    // "more passes would not help" on a graph three Knowledge Assets short. See
    // the row below for the corrected behaviour.
    const sharedCalls: string[] = [];

    const result = await runWorkerCatchup(
      { contextGraphId: CG, includeSharedMemory: true },
      async (method, args) => {
        switch (method) {
          case 'prepareCatchup':
            return { isPrivateContextGraph: false, peerIds: [PEER], connectedPeers: 1 };
          case 'waitForSyncProtocol':
            return true;
          case 'syncDurable':
            return durableResult();
          case 'syncSharedMemory':
            sharedCalls.push(String(args[0]));
            return truncatedSharedRound(0, 3);
          default:
            return null;
        }
      },
    );

    expect(sharedCalls).toEqual([PEER]);
    // `0`, not absent: the field is initialised on the diagnostics object and is
    // overwritten only when a repeat actually ran. Asserting `undefined` here was
    // my own error, and the comment stays because a reader who assumes absence
    // means "no repeats" would write the same wrong assertion again.
    expect(result.diagnostics?.sharedMemory?.continuationPasses).toBe(0);
    expect(result.diagnostics?.sharedMemory?.continuationStopReason).toBe('coverage-stalled');
  });

  it('DOES repeat for a capable peer whose first pass materialized nothing', async () => {
    // The #2050 headline shape, end to end: a store fault failed every write, or
    // the round deadline was spent by the metadata and aggregate phases before
    // the snapshot walk began. Either way the peer reports `0/3` with a COMPLETE
    // manifest — it holds three refs we lack, and on a warm cache a repeat costs
    // no network bytes at all.
    //
    // Before the pass-1 suppression this stopped at `coverage-stalled` after one
    // contact, rendering "more passes would not help" while the graph stayed
    // three Knowledge Assets short. The peer advances by one per pass here, so a
    // correct loop keeps going.
    const sharedCalls: string[] = [];
    let seen = 0;

    const result = await runWorkerCatchup(
      { contextGraphId: CG, includeSharedMemory: true },
      async (method, args) => {
        switch (method) {
          case 'prepareCatchup':
            return { isPrivateContextGraph: false, peerIds: [PEER], connectedPeers: 1 };
          case 'waitForSyncProtocol':
            return true;
          case 'syncDurable':
            return durableResult();
          case 'syncSharedMemory': {
            sharedCalls.push(String(args[0]));
            const resolved = seen;
            seen += 1;
            return partialSharedRound(resolved, 3);
          }
          default:
            return null;
        }
      },
    );

    expect(sharedCalls.length).toBeGreaterThan(1);
    expect(result.diagnostics?.sharedMemory?.continuationPasses).toBeGreaterThan(0);
    expect(result.diagnostics?.sharedMemory?.continuationStopReason)
      .not.toBe('coverage-stalled');
  });
});

/**
 * The two capability-gate clauses, each pinned by WHICH peers a second pass
 * contacts rather than by whether one happens.
 *
 * That shape is deliberate. The obvious fixture — one peer, barren — cannot see
 * either clause: with `snapshotsResolved: 0` the high-water mark has not advanced,
 * so the loop stops at `coverage-stalled` before the gate is consulted, and the
 * row passes whether the guard exists or not. It is the T14 fixture-collapse
 * pattern exactly, and it is why these clauses were unpinned.
 *
 * Pairing a productive peer with the peer under test fixes it: the productive one
 * advances coverage so the loop genuinely reaches the gate, and the assertion is
 * the *membership* of the second pass.
 */
describe('#2050 capability gate — which peers earn a second pass', () => {
  const CG = 'gate-cg';
  const PRODUCTIVE = 'peer-productive-1111';

  function round(peerId: string, resolved: number, total: number, manifestComplete = true) {
    return {
      ...sharedResult(),
      failedPhases: 1,
      swmCoverage: {
        contextGraphId: CG,
        peerIdSuffix: peerId.slice(-8),
        snapshotsResolved: resolved,
        snapshotsTotal: total,
        manifestComplete,
        missingCount: Math.max(0, total - resolved),
        missingSample: [],
        materializationFailures: 0,
      },
    };
  }

  /** Runs a walk over the productive peer plus one peer under test. */
  async function walkWith(other: string, otherRound: () => ReturnType<typeof round>) {
    const shared: string[] = [];
    const result = await runWorkerCatchup(
      { contextGraphId: CG, includeSharedMemory: true },
      async (method, args) => {
        switch (method) {
          case 'prepareCatchup':
            return { isPrivateContextGraph: false, peerIds: [PRODUCTIVE, other], connectedPeers: 2 };
          case 'waitForSyncProtocol':
            return true;
          case 'syncDurable':
            return durableResult();
          case 'syncSharedMemory': {
            const peerId = String(args[0]);
            shared.push(peerId);
            if (peerId !== PRODUCTIVE) return otherRound();
            // Advances coverage every pass, so the loop keeps reaching the gate
            // instead of stopping at `coverage-stalled`.
            const seen = shared.filter((p) => p === PRODUCTIVE).length;
            return round(PRODUCTIVE, seen, 9);
          }
          default:
            return null;
        }
      },
    );
    return { shared, result };
  }

  it('does not re-contact a BARREN peer (snapshotsTotal === 0)', async () => {
    const BARREN = 'peer-barren-2222';
    const { shared } = await walkWith(BARREN, () => round(BARREN, 0, 0));

    // Pass 1 contacts both; every later pass contacts only the productive peer.
    expect(shared.slice(0, 2).sort()).toEqual([BARREN, PRODUCTIVE].sort());
    expect(shared.filter((p) => p === BARREN)).toHaveLength(1);
    expect(shared.filter((p) => p === PRODUCTIVE).length).toBeGreaterThan(1);
  });

  it('keeps retrying a converging peer that a FINISHED peer would otherwise pin', async () => {
    // The progress gate and the capability gate read different peer sets, and
    // that is the whole bug: a peer at `400/400` is not capable, so it is never
    // re-contacted and its record can never move — but a fleet-wide max over all
    // retained records still counts it. The converging peer's entire manifest is
    // 9 refs, so it can NEVER exceed 400 however well it does, and the loop
    // stopped at `coverage-stalled` after exactly one continuation pass, which
    // renders as "more passes would not help" — the opposite of true.
    //
    // Summing each peer's OWN high-water makes the reading move whenever any peer
    // advances. Under the fleet-wide max this row sees exactly 2 contacts and
    // `coverage-stalled`; the assertions below are chosen to fail in that case.
    const PINNED = 'peer-finished-4444';
    const { shared, result } = await walkWith(PINNED, () => round(PINNED, 400, 400));

    expect(shared.filter((p) => p === PINNED)).toHaveLength(1);
    expect(shared.filter((p) => p === PRODUCTIVE).length).toBeGreaterThan(2);
    expect(result.diagnostics?.sharedMemory?.continuationStopReason)
      .not.toBe('coverage-stalled');
  });

  it('does not re-contact a peer whose MANIFEST was truncated', async () => {
    // Resolved < total, so the resolved/total clause alone would call it capable.
    // Only `manifestComplete` excludes it — and it must be excluded, because a
    // truncated round advances `snapshotsResolved` while materializing nothing.
    const TRUNCATED = 'peer-truncated-3333';
    const { shared } = await walkWith(TRUNCATED, () => round(TRUNCATED, 1, 5, false));

    expect(shared.slice(0, 2).sort()).toEqual([PRODUCTIVE, TRUNCATED].sort());
    expect(shared.filter((p) => p === TRUNCATED)).toHaveLength(1);
    expect(shared.filter((p) => p === PRODUCTIVE).length).toBeGreaterThan(1);
  });
});

/**
 * Retention of a peer's coverage across a FAILED round.
 *
 * The discriminator is which peers a LATER pass contacts, and finding it took
 * ruling two others out. After a throwing pass the stop reason cannot tell
 * retention from forgetting — retained leaves coverage equal to the high-water
 * mark, forgotten makes the max over an empty map `0`, and both are `<=` the
 * mark, so both report `coverage-stalled`. The terminal message cannot either:
 * it renders `diagnostics.sharedMemory.swmCoverage`, which `accumulate` reduces
 * independently of `lastCoverageByPeer`, so forgetting a peer there is invisible
 * to it.
 *
 * A second, still-productive peer keeps the mark advancing so the loop runs a
 * further pass at all — and then membership of that pass is the observable.
 */
describe('#2050 coverage retention across a failed round', () => {
  const CG = 'retention-cg';
  const STEADY = 'peer-steady-4444';
  const OTHER = 'peer-other-5555';

  function cov(peerId: string, resolved: number, total: number) {
    return {
      contextGraphId: CG,
      peerIdSuffix: peerId.slice(-8),
      snapshotsResolved: resolved,
      snapshotsTotal: total,
      manifestComplete: true,
      missingCount: Math.max(0, total - resolved),
      missingSample: [],
      materializationFailures: 0,
    };
  }

  /** `otherRound` decides what the peer under test returns on its Nth round. */
  async function walk(otherRound: (nth: number) => unknown) {
    const shared: string[] = [];
    let steadySeen = 0;
    let otherSeen = 0;
    await runWorkerCatchup(
      { contextGraphId: CG, includeSharedMemory: true },
      async (method, args) => {
        switch (method) {
          case 'prepareCatchup':
            return { isPrivateContextGraph: false, peerIds: [STEADY, OTHER], connectedPeers: 2 };
          case 'waitForSyncProtocol':
            return true;
          case 'syncDurable':
            return durableResult();
          case 'syncSharedMemory': {
            const peerId = String(args[0]);
            shared.push(peerId);
            if (peerId === STEADY) {
              steadySeen += 1;
              // Advances every pass so the loop keeps running and the row can
              // actually reach the retention question.
              //
              // The WIDTH of the margin is no longer load-bearing. It was: the
              // progress gate used to be a max over all peers, so at +1 per pass
              // the peer under test — retained at 2 — held the max flat and the
              // loop stopped at `coverage-stalled` before a third pass ran, and
              // the row failed for a reason having nothing to do with retention.
              // That fixture-shaped dodge was evidence of a real defect, and the
              // gate is now a sum over each peer's OWN high-water
              // (`totalPeerProgress`), which rises whenever ANY peer advances.
              // The margin is kept as belt-and-braces, not as a workaround.
              return {
                ...sharedResult(),
                failedPhases: 1,
                swmCoverage: cov(STEADY, steadySeen * 10, 99),
              };
            }
            otherSeen += 1;
            return otherRound(otherSeen);
          }
          default:
            return null;
        }
      },
    );
    return shared;
  }

  it('RETAINS coverage when a round fails, so the peer is contacted again', async () => {
    // Round 1 reports real progress; round 2 throws, which `syncSharedMemory`
    // turns into `emptyShared()` — truthy, and carrying no coverage.
    const shared = await walk((nth) => {
      if (nth === 1) return { ...sharedResult(), failedPhases: 1, swmCoverage: cov(OTHER, 2, 3) };
      throw new Error('transport failure');
    });
    // Contacted in pass 1, again in pass 2 (where it threw), and STILL in pass 3
    // — a throw is not evidence that the peer has nothing left.
    expect(shared.filter((p) => p === OTHER).length).toBeGreaterThanOrEqual(3);
  });

  it('FORGETS coverage when a CLEAN round reports none, so the peer is dropped', async () => {
    // The other direction, and it is what stops "always retain" from satisfying
    // the row above: a peer that cleanly says it has nothing must not be revisited.
    const shared = await walk((nth) => (nth === 1
      ? { ...sharedResult(), failedPhases: 1, swmCoverage: cov(OTHER, 2, 3) }
      : {
        ...sharedResult(),
        // Clean — `completedPhases > 0`, no failures — so the record is
        // legitimately forgotten. But carrying NO data, deliberately: a clean
        // DATA-BEARING round proves the plane, and the loop then stops at
        // `plane-proven` before the capability gate is ever consulted. With the
        // default `sharedResult()` this row passed with the delete branch removed
        // entirely, which is the collapse it exists to rule out.
        insertedTriples: 0,
        insertedDataTriples: 0,
        completedPhases: 1,
      }));
    expect(shared.filter((p) => p === OTHER)).toHaveLength(2);
  });
});
