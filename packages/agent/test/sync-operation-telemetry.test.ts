// SPDX-License-Identifier: Apache-2.0
/**
 * W1 §6.3 / §6.4 / §6.5 — the OPERATION-level contract, driven through a real
 * `DKGAgent`: the I4/I5 admission seam, the I6 join sites, the changelog lane's
 * own attempts and bytes, and the `vm-recovery` source override.
 *
 * Acceptance covered here: A6, A8, A12, A15.
 * Mutants these assertions are written to kill: M4, M5, M6, M10, M11, M13.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';

import { DKGAgent, runCatchupPlaneWithPolicy } from '../src/index.js';
import { getSyncBackpressureSnapshot } from '../src/sync/backpressure.js';
import { withSyncAdmissionSource } from '../src/sync/attempt-telemetry.js';
import { encodeChangelogResponse } from '../src/sync/changelog/wire.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';
import { stubLifecycleFetch } from './_helpers/sync-fetch-coalescing.js';
import { W1MetricsHarness, I1, I2, I3, I4, I5, I6 } from './_helpers/w1-metrics.js';

const PEER_A = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const DEFAULT_DEADLINE = Date.UTC(2100, 0, 1);
const CG = 'w1-cg';

const harness = new W1MetricsHarness();
const liveAgents: DKGAgent[] = [];

afterEach(async () => {
  for (const agent of liveAgents.splice(0)) await agent.stop().catch(() => {});
  await harness.dispose();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition was not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function emptySyncPage(phase: string): SyncPageResult {
  return {
    quads: [],
    bytesReceived: 0,
    resumedFromOffset: 0,
    nextOffset: 0,
    checkpointKey: `checkpoint:${phase}`,
    completed: true,
    timedOut: false,
  };
}

async function createAgent(options: {
  sendToPeer?: (...args: unknown[]) => Promise<Uint8Array>;
  syncGlobalMaxInflight?: number;
  syncGlobalQueueLimit?: number;
} = {}): Promise<DKGAgent> {
  const agent = await DKGAgent.create({
    name: 'W1OperationTelemetry',
    listenHost: '127.0.0.1',
    chainAdapter: new MockChainAdapter(),
    syncGlobalMaxInflight: options.syncGlobalMaxInflight ?? 2,
    syncGlobalQueueLimit: options.syncGlobalQueueLimit ?? 2,
  });
  liveAgents.push(agent);
  (agent as any).messenger = { sendToPeer: options.sendToPeer ?? (async () => new Uint8Array(0)) };
  (agent as any).buildSyncRequest = async () => new Uint8Array([1, 2, 3]);
  return agent;
}

/** Reduce a durable page fetch + verification to a no-op so the sync completes fast. */
function stubDurableSyncBody(agent: DKGAgent, onFetch?: () => void): void {
  stubLifecycleFetch(agent, async ({ phase }) => {
    onFetch?.();
    return emptySyncPage(phase);
  });
  (agent as any).processDurableBatchInWorker = async () => ({
    verifiedData: [],
    verifiedMeta: [],
    totalFetchedDataQuads: 0,
    totalFetchedMetaQuads: 0,
    rejectedKcs: 0,
    emptyResponses: 1,
    metaOnlyResponses: 0,
    dataRejectedMissingMeta: 0,
  });
  // Keep every Context Graph on the legacy lane: this peer advertises no
  // changelog protocol, exactly as a pre-RFC-59 peer would.
  (agent as any).getPeerProtocols = async () => [];
}

function admit<T>(
  agent: DKGAgent,
  options: { lane?: string; source?: string; label?: string; operationSignal?: AbortSignal },
  work: () => Promise<T>,
): Promise<T> {
  return (agent as any).runContextGraphSyncWithBackpressure(
    createOperationContext('sync'),
    CG,
    options.lane ?? 'durable',
    options.label ?? 'w1-op',
    work,
    { source: options.source, operationSignal: options.operationSignal },
  );
}

describe('W1 I4/I5 — the operation denominator and its rejections', () => {
  it('A12/M11: the duration sample excludes admission queue wait', async () => {
    harness.install();
    const agent = await createAgent({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 2 });
    const blocker = deferred<void>();

    const blocking = admit(agent, { source: 'on-connect', label: 'blocker' }, () => blocker.promise);
    await waitFor(() => getSyncBackpressureSnapshot().inflight === 1);

    // The queued operation's WORK is a no-op; all of its wall-clock cost is
    // queue wait. M11 (timing the outer call) folds that wait into the sample.
    const queued = admit(agent, { source: 'reconcile', label: 'queued' }, async () => 'done');
    await waitFor(() => getSyncBackpressureSnapshot().queued === 1);
    const QUEUE_WAIT_MS = 400;
    await new Promise((resolve) => setTimeout(resolve, QUEUE_WAIT_MS));

    blocker.resolve();
    await blocking;
    expect(await queued).toBe('done');

    const samples = await harness.histogram(I4);
    const queuedSample = samples.find((point) => point.attributes.source === 'reconcile');
    expect(queuedSample).toBeDefined();
    expect(queuedSample!.count).toBe(1);
    expect(queuedSample!.attributes).toMatchObject({ lane: 'durable', outcome: 'resolved' });
    expect(queuedSample!.max).toBeLessThan(QUEUE_WAIT_MS / 2);

    // Positive control: the blocker's own occupancy WAS measured, so a sample
    // near zero above means "queue wait excluded", not "the clock is broken".
    const blockerSample = samples.find((point) => point.attributes.source === 'on-connect');
    expect(blockerSample!.count).toBe(1);
    expect(blockerSample!.max).toBeGreaterThanOrEqual(QUEUE_WAIT_MS * 0.8);
  });

  it('A12/M10: an operation rejected before starting goes to I5, never a 0 ms I4 sample', async () => {
    harness.install();
    const agent = await createAgent({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 });
    const blocker = deferred<void>();

    const blocking = admit(agent, { source: 'on-connect', label: 'blocker' }, () => blocker.promise);
    await waitFor(() => getSyncBackpressureSnapshot().inflight === 1);

    let started = false;
    await expect(admit(agent, { source: 'reconcile', label: 'rejected' }, async () => {
      started = true;
    })).rejects.toThrow(/backpressure/i);
    expect(started).toBe(false);

    const rejections = await harness.matching(I5, {
      lane: 'durable', source: 'reconcile', reason: 'queue_full',
    });
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.value).toBe(1);
    // M10 emits a 0 ms duration sample here; the denominator must not grow.
    const samples = await harness.histogram(I4);
    expect(samples.filter((point) => point.attributes.source === 'reconcile')).toEqual([]);

    blocker.resolve();
    await blocking;
  });

  it('records `aborted_before_start` when a queued operation is cancelled', async () => {
    harness.install();
    const agent = await createAgent({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 2 });
    const blocker = deferred<void>();
    const controller = new AbortController();

    const blocking = admit(agent, { source: 'on-connect', label: 'blocker' }, () => blocker.promise);
    await waitFor(() => getSyncBackpressureSnapshot().inflight === 1);

    let started = false;
    const cancelled = admit(
      agent,
      { source: 'catchup-foreground', label: 'cancelled', operationSignal: controller.signal },
      async () => { started = true; },
    );
    await waitFor(() => getSyncBackpressureSnapshot().queued === 1);
    controller.abort();
    await expect(cancelled).rejects.toBeTruthy();
    expect(started).toBe(false);

    expect(await harness.matching(I5, {
      lane: 'durable', source: 'catchup-foreground', reason: 'aborted_before_start',
    })).toHaveLength(1);

    blocker.resolve();
    await blocking;
  });

  it('separates a failed operation from a cancelled one, and clamps a non-requester lane', async () => {
    harness.install();
    const agent = await createAgent();

    await expect(admit(agent, { source: 'reconcile' }, async () => {
      throw new Error('store commit failed');
    })).rejects.toThrow(/store commit/);

    const abortError = new Error('caller gave up');
    abortError.name = 'AbortError';
    await expect(admit(agent, { source: 'on-connect' }, async () => {
      throw abortError;
    })).rejects.toBe(abortError);

    // `responder` is a real SyncSchedulerLane member but not a requester lane;
    // it must clamp rather than widen the I4 label space.
    await admit(agent, { source: 'reconcile', lane: 'responder' }, async () => undefined);

    const samples = await harness.histogram(I4);
    expect(samples.find((p) => p.attributes.source === 'reconcile' && p.attributes.lane === 'durable')!
      .attributes.outcome).toBe('error');
    expect(samples.find((p) => p.attributes.source === 'on-connect')!.attributes.outcome).toBe('cancelled');
    expect(samples.some((p) => p.attributes.lane === 'unspecified')).toBe(true);
    expect(samples.some((p) => p.attributes.lane === 'responder')).toBe(false);
  });

  it('A7: operation points carry only bounded labels — no CG id, no peer id', async () => {
    harness.install();
    const agent = await createAgent({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 });
    const blocker = deferred<void>();
    const blocking = admit(agent, { source: 'on-connect' }, () => blocker.promise);
    await waitFor(() => getSyncBackpressureSnapshot().inflight === 1);
    await expect(admit(agent, { source: 'reconcile' }, async () => undefined)).rejects.toBeTruthy();
    blocker.resolve();
    await blocking;

    expect(await harness.attributeKeys(I4)).toEqual(['lane', 'outcome', 'source']);
    expect(await harness.attributeKeys(I5)).toEqual(['lane', 'reason', 'source']);
  });
});

describe('W1 A8/M5 — `source` is in no coalescing key, at every scope', () => {
  it('page scope: two differently-sourced identical fetches share ONE physical send', async () => {
    harness.install();
    const response = deferred<Uint8Array>();
    let sends = 0;
    const agent = await createAgent({
      sendToPeer: async () => { sends += 1; return response.promise; },
    });

    const fetchPage = () => (agent as any).fetchSyncPages(
      createOperationContext('sync'), PEER_A, CG, false, 'data',
      `did:dkg:context-graph:${CG}`, DEFAULT_DEADLINE,
    );
    const first = withSyncAdmissionSource('on-connect', fetchPage);
    await flushMicrotasks();
    const second = withSyncAdmissionSource('reconcile', fetchPage);
    await flushMicrotasks();

    // M5 (source in the page key) forks this into two sends.
    expect(sends).toBe(1);
    response.resolve(new Uint8Array(0));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);

    // M4 (drop/overwrite the owner source) collapses these two labels into one.
    const joins = await harness.matching(I6, {
      scope: 'page', owner_source: 'on-connect', joiner_source: 'reconcile',
    });
    expect(joins).toHaveLength(1);
    expect(joins[0]!.value).toBe(1);
    expect(await harness.attributeKeys(I6)).toEqual(['joiner_source', 'owner_source', 'scope']);
  });

  it('context-graph scope: the source OVERRIDE does not fork the generic single-flight key', async () => {
    harness.install();
    const agent = await createAgent();
    // The single-flight map is the subject here; the peer-discovery preamble in
    // front of it needs a started libp2p node, which this unit agent has not.
    (agent as any).isPrivateContextGraph = async () => false;
    (agent as any).resolvePreferredSyncPeerId = async () => undefined;
    (agent as any).primeCatchupConnections = async () => undefined;
    (agent as any).node = { ...(agent as any).node, libp2p: { getConnections: () => [] } };
    let catchupRuns = 0;
    const release = deferred<void>();
    (agent as any).runCatchupOverPeers = async () => {
      catchupRuns += 1;
      await release.promise;
      return { connectedPeers: 0, totalPeers: 0, selectedPeers: 0, syncCapablePeers: 0 };
    };

    const first = (agent as any).syncContextGraphFromConnectedPeers(CG, { sourceOverride: 'vm-recovery' });
    await waitFor(() => catchupRuns === 1);
    const second = (agent as any).syncContextGraphFromConnectedPeers(CG, {});
    await flushMicrotasks();

    // M5 at the GENERIC scope: the override must not be part of the key.
    expect(catchupRuns).toBe(1);
    release.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);

    expect(await harness.matching(I6, {
      scope: 'context-graph', owner_source: 'vm-recovery', joiner_source: 'catchup-background',
    })).toHaveLength(1);
  });

  it('durable scope: two differently-sourced durable syncs share one run', async () => {
    harness.install();
    const agent = await createAgent();
    let fetchCalls = 0;
    stubDurableSyncBody(agent, () => { fetchCalls += 1; });

    const first = (agent as any).syncFromPeerDetailed(
      PEER_A, [CG], undefined, undefined, undefined, { source: 'on-connect' },
    );
    const second = (agent as any).syncFromPeerDetailed(
      PEER_A, [CG], undefined, undefined, undefined, { source: 'reconcile' },
    );
    const [a, b] = await Promise.all([first, second]);

    expect(a).toBe(b);
    const singleRunFetches = fetchCalls;
    expect(singleRunFetches).toBeGreaterThan(0);

    expect(await harness.matching(I6, {
      scope: 'durable', owner_source: 'on-connect', joiner_source: 'reconcile',
    })).toHaveLength(1);
    // One admitted operation, not two — the coalesced pair shares a denominator entry.
    const samples = await harness.histogram(I4);
    expect(samples.filter((point) => point.attributes.lane === 'durable')
      .reduce((sum, point) => sum + point.count, 0)).toBe(1);
  });

  it('shared-memory scope: two differently-sourced SWM syncs share one run', async () => {
    harness.install();
    const agent = await createAgent();
    stubDurableSyncBody(agent);
    // A precomputed plan removes the only `await` before the single-flight map,
    // so the join is deterministic rather than a microtask-ordering race.
    const sharedMemorySyncPlan = {
      publicContextGraphIds: [CG],
      privateRecoverFromCurator: [],
      eligibleContextGraphIds: [CG],
    };

    const first = (agent as any).syncSharedMemoryFromPeerDetailed(
      PEER_A, [CG], { source: 'on-connect', sharedMemorySyncPlan },
    );
    const second = (agent as any).syncSharedMemoryFromPeerDetailed(
      PEER_A, [CG], { source: 'catchup-foreground', sharedMemorySyncPlan },
    );
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);

    expect(await harness.matching(I6, {
      scope: 'shared-memory', owner_source: 'on-connect', joiner_source: 'catchup-foreground',
    })).toHaveLength(1);
  });
});

describe('W1 A6/M6 — the changelog lane reports its own attempts AND bytes', () => {
  it('records transport=changelog, phase=delta with both byte legs', async () => {
    harness.install();
    const denial = encodeChangelogResponse({ kind: 'denied' });
    let requestByteLength = 0;
    const agent = await createAgent({
      sendToPeer: async (..._args: unknown[]) => {
        requestByteLength = (_args[2] as Uint8Array).byteLength;
        return denial;
      },
    });
    (agent as any).getOrCreateSyncVerifyWorker = () => ({
      parseAndFilter: async () => ({ quads: [], totalQuads: 0 }),
    });

    const result = await (agent as any).runChangelogSyncForCg(
      createOperationContext('sync'), PEER_A, CG,
    );
    expect(result.deniedPhases).toBe(1);

    const changelogLabels = { transport: 'changelog', plane: 'durable', phase: 'delta' };
    // M6 deletes this record entirely; the denominator then silently omits a
    // whole lane, and the omission is uncorrectable after collection.
    const attempts = await harness.matching(I1, { ...changelogLabels, outcome: 'response' });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.value).toBe(1);

    const requestBytes = await harness.matching(I2, changelogLabels);
    expect(requestBytes).toHaveLength(1);
    expect(requestBytes[0]!.value).toBe(requestByteLength);
    expect(requestByteLength).toBeGreaterThan(0);

    // Byte accounting is the part this lane had none of before W1.
    const responseBytes = await harness.matching(I3, { ...changelogLabels, outcome: 'response' });
    expect(responseBytes).toHaveLength(1);
    expect(responseBytes[0]!.value).toBe(denial.byteLength);
  });

  it('labels a failed changelog send transport_error, keeping its request bytes', async () => {
    harness.install();
    const agent = await createAgent({
      sendToPeer: async () => { throw new Error('all multiaddr dials failed'); },
    });
    (agent as any).getOrCreateSyncVerifyWorker = () => ({
      parseAndFilter: async () => ({ quads: [], totalQuads: 0 }),
    });

    await expect((agent as any).runChangelogSyncForCg(
      createOperationContext('sync'), PEER_A, CG,
    )).rejects.toThrow(/multiaddr/);

    expect(await harness.matching(I1, {
      transport: 'changelog', phase: 'delta', outcome: 'transport_error',
    })).toHaveLength(1);
    expect(await harness.total(I2)).toBeGreaterThan(0);
    expect(await harness.counter(I3)).toEqual([]);
  });

  it('inherits the ambient admission source, so both lanes share one denominator', async () => {
    harness.install();
    const agent = await createAgent({
      sendToPeer: async () => encodeChangelogResponse({ kind: 'denied' }),
    });
    (agent as any).getOrCreateSyncVerifyWorker = () => ({
      parseAndFilter: async () => ({ quads: [], totalQuads: 0 }),
    });

    await admit(agent, { source: 'catchup-foreground', lane: 'changelog' }, () =>
      (agent as any).runChangelogSyncForCg(createOperationContext('sync'), PEER_A, CG));

    expect(await harness.matching(I1, {
      transport: 'changelog', source: 'catchup-foreground',
    })).toHaveLength(1);
  });
});

describe('W1 R1 — the ambient source reaches every recording path', () => {
  // Parameter threading fails CLOSED: a missing argument is a compile error.
  // The ambient context fails OPEN: a path that never enters the scope records
  // `unspecified` at runtime with no type error. §5.5 turns that into a loud
  // window invalidation rather than corrupt data — but if a path routinely
  // misses the scope, EVERY window is inconclusive and W1 answers nothing. So
  // each lane is proven against its EXACT expected literal, not "not unspecified".
  it.each([
    ['durable', 'on-connect'],
    ['changelog', 'catchup-foreground'],
    ['shared_memory', 'reconcile'],
    ['swm_recovery', 'swm-recovery'],
  ] as const)('lane %s: a real send inside the boundary carries source=%s', async (lane, source) => {
    harness.install();
    let sends = 0;
    const agent = await createAgent({
      sendToPeer: async () => { sends += 1; return new Uint8Array(0); },
    });

    await admit(agent, { lane, source }, () => (agent as any).fetchSyncPages(
      createOperationContext('sync'), PEER_A, CG, false, 'data',
      `did:dkg:context-graph:${CG}`, DEFAULT_DEADLINE,
    ));

    expect(sends).toBe(1);
    expect(await harness.matching(I1, { transport: 'legacy', source })).toHaveLength(1);
    expect(await harness.matching(I1, { source: 'unspecified' })).toEqual([]);
  });

  it('the changelog→legacy `runResync` fallback inherits the changelog operation\'s source', async () => {
    harness.install();
    // This is the case that motivated the ambient design over parameter
    // threading: `runResync` re-enters the LEGACY lane from inside the
    // changelog lane, and no `source` is in scope on that path. Threading
    // would have left these attempts `unspecified` — a silently partial
    // denominator, which §4 says is uncorrectable after collection.
    let changelogSends = 0;
    let legacySends = 0;
    const agent = await createAgent({
      sendToPeer: async (..._args: unknown[]) => {
        const protocolId = _args[1] as string;
        if (protocolId.includes('changelog')) {
          changelogSends += 1;
          return encodeChangelogResponse({ kind: 'resync', era: 'era-1', headSeq: 5 });
        }
        legacySends += 1;
        return new Uint8Array(0); // empty page ⇒ the legacy phase completes
      },
    });
    (agent as any).getOrCreateSyncVerifyWorker = () => ({
      parseAndFilter: async () => ({ quads: [], totalQuads: 0 }),
    });
    (agent as any).processDurableBatchInWorker = async () => ({
      verifiedData: [], verifiedMeta: [],
      totalFetchedDataQuads: 0, totalFetchedMetaQuads: 0,
      rejectedKcs: 0, emptyResponses: 1, metaOnlyResponses: 0, dataRejectedMissingMeta: 0,
    });

    await admit(agent, { source: 'catchup-foreground', lane: 'changelog' }, () =>
      (agent as any).runChangelogSyncForCg(createOperationContext('sync'), PEER_A, CG));

    expect(changelogSends).toBeGreaterThanOrEqual(1);
    expect(legacySends).toBeGreaterThanOrEqual(1);

    // Both lanes, one operation, one source — the shared denominator §4 requires.
    expect((await harness.matching(I1, { transport: 'changelog', source: 'catchup-foreground' })).length)
      .toBeGreaterThanOrEqual(1);
    expect((await harness.matching(I1, { transport: 'legacy', source: 'catchup-foreground' })).length)
      .toBeGreaterThanOrEqual(1);
    expect(await harness.matching(I1, { source: 'unspecified' })).toEqual([]);
    // Bytes follow the attempts, so the fallback is in the denominator too.
    expect((await harness.matching(I2, { transport: 'legacy', source: 'catchup-foreground' })).length)
      .toBeGreaterThanOrEqual(1);
  });

  it('a detached spawn that establishes its own source keeps it after the operation ends', async () => {
    harness.install();
    let sends = 0;
    const agent = await createAgent({
      sendToPeer: async () => { sends += 1; return new Uint8Array(0); },
    });

    // This pins the MITIGATION, not the absence of the hazard. If you must
    // detach, wrapping in `withSyncAdmissionSource` works and the scope survives
    // the detachment — that is what is asserted below.
    //
    // It deliberately does NOT prove that a *bare* detached spawn is impossible.
    // A bare spawn would inherit `catchup-foreground` and keep it, and this test
    // would stay green; the assertion below passes because the spawn was handed
    // its own source, not because detachment prevents inheritance. The real
    // protection is the audit (no detached senders inside the admitted boundary)
    // plus the standing hazard note in the plan's §5.5 — not a runtime guard.
    //
    // The audit's structural half, which is the durable part: the send-capable
    // modules are exactly `dkg-agent-lifecycle.ts`, `p2p/sync-transport.ts` and
    // the two `sync/requester/` modules. The store-commit and verification trees
    // contain no sender at all, so detached work there cannot reach an I1–I3
    // record site whatever scope it inherits.
    //
    // A test asserting the bare case DOES inherit is deliberately absent: it
    // would encode the hazard as expected behaviour and make the eventual fix
    // read as a regression.
    let detached: Promise<unknown> | undefined;
    await admit(agent, { lane: 'durable', source: 'catchup-foreground' }, async () => {
      detached = withSyncAdmissionSource('catchup-background', () => (agent as any).fetchSyncPages(
        createOperationContext('sync'), PEER_A, `${CG}-detached`, false, 'data',
        `did:dkg:context-graph:${CG}-detached`, DEFAULT_DEADLINE,
      ));
      return undefined;
    });
    await detached;

    expect(sends).toBe(1);
    // The detached send carries the source IT established, not the foreground
    // operation's — `catchup-foreground` is an ELIGIBLE family, so inheriting
    // it here would inflate the eligible bytes numerator in §7.3.
    expect(await harness.matching(I1, { source: 'catchup-background' })).toHaveLength(1);
    expect(await harness.matching(I1, { source: 'catchup-foreground' })).toEqual([]);
  });
});

describe('W1 A15/M13 — VM recovery is labelled `vm-recovery`, not `catchup-background`', () => {
  it('the override replaces the mode-derived source and leaves priority alone', async () => {
    const seen: Array<{ priority?: number; source?: string }> = [];
    const run = async (context: { priority?: number; source?: string }) => {
      seen.push({ ...context });
      return {};
    };

    await runCatchupPlaneWithPolicy('background', run);
    await runCatchupPlaneWithPolicy('background', run, { sourceOverride: 'vm-recovery' });
    await runCatchupPlaneWithPolicy('foreground', run, { sourceOverride: 'vm-recovery' });
    // An out-of-set override is clamped, never smuggled through.
    await runCatchupPlaneWithPolicy('background', run, { sourceOverride: 'vm-repair' as never });

    expect(seen[0]).toEqual({ priority: undefined, source: 'catchup-background' });
    expect(seen[1]).toEqual({ priority: undefined, source: 'vm-recovery' });
    expect(seen[2]).toEqual({ priority: 2_000, source: 'vm-recovery' });
    expect(seen[3]).toEqual({ priority: undefined, source: 'unspecified' });
  });

  it('M13: catch-up samples carry the EXACT label `vm-recovery` end to end', async () => {
    harness.install();
    const agent = await createAgent();
    stubDurableSyncBody(agent);
    (agent as any).waitForSyncProtocol = async () => true;

    await (agent as any).runCatchupOverPeers(CG, false, [{ toString: () => PEER_A }], {
      totalPeers: 1,
      mode: 'background',
      sourceOverride: 'vm-recovery',
    });

    const samples = await harness.histogram(I4);
    const sources = samples.map((point) => point.attributes.source);
    // Asserting "not recurring" would NOT kill M13 — `catchup-background` is
    // excluded from the recurring family too, so the exact label is the test.
    expect(sources).toContain('vm-recovery');
    expect(sources).not.toContain('catchup-background');
    expect(samples.find((point) => point.attributes.source === 'vm-recovery')!.count)
      .toBeGreaterThanOrEqual(1);
    expect(samples.every((point) => point.attributes.source === 'vm-recovery')).toBe(true);
  });

  it('without the override the same path stays `catchup-background`', async () => {
    harness.install();
    const agent = await createAgent();
    stubDurableSyncBody(agent);
    (agent as any).waitForSyncProtocol = async () => true;

    await (agent as any).runCatchupOverPeers(CG, false, [{ toString: () => PEER_A }], {
      totalPeers: 1,
      mode: 'background',
    });

    const sources = (await harness.histogram(I4)).map((point) => point.attributes.source);
    expect(sources).toContain('catchup-background');
    expect(sources).not.toContain('vm-recovery');
  });
});
