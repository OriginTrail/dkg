import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  backpressureRegistry,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  createOperationContext,
  DKG_ONTOLOGY,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import {
  DEFAULT_SYNC_CONTROL_PLANE_QUEUE_LIMIT,
  DEFAULT_SYNC_CONTROL_PLANE_QUEUE_TIMEOUT_MS,
} from '../src/sync/control-plane-reserve.js';
import { DEFAULT_SYNC_SHARED_MEMORY_QUEUE_LIMIT } from '../src/sync/shared-memory-reserve.js';
import {
  getSyncBackpressureSnapshot,
  resolveSyncGlobalBackpressure,
  SyncBackpressureBusyError,
  syncAdmissionWouldBeRefused,
  withGlobalSyncBackpressure,
  type SyncGlobalBackpressurePolicy,
} from '../src/sync/backpressure.js';
import { runCuratorMetaRefreshFromPeer } from '../src/curator-meta-refresh.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import type { SyncAdmissionSource, SyncSchedulerLane } from '../src/sync/policy.js';

// Issue #3280: a member configured with one sync slot and no queue
// (`syncGlobalMaxInflight: 1`, `syncGlobalQueueLimit: 0`) refused every
// metadata refresh while another transfer held that slot, with
// "Meta refresh for <graph> failed: Sync backpressure rejected durable:control-plane
// (global inflight=1/1, queued=0/0)". It never obtained a registered graph's
// definition or a private graph's member list.

const RESERVE_ENV = 'DKG_SYNC_CONTROL_PLANE_RESERVED_INFLIGHT';
const SHARED_MEMORY_RESERVE_ENV = 'DKG_SYNC_SHARED_MEMORY_RESERVED_INFLIGHT';
const ctx = createOperationContext('sync');
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const OWNER = '0x7171717171717171717171717171717171717171';
const SERVING_PEER_ID = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';

interface Admission {
  policy: SyncGlobalBackpressurePolicy;
  ctx: typeof ctx;
  label: string;
  contextGraphId?: string;
  lane: SyncSchedulerLane;
  source: SyncAdmissionSource;
  logInfo?: (opCtx: unknown, message: string) => void;
}

function oneSlotNoQueue(): SyncGlobalBackpressurePolicy {
  return resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 });
}

function longTransfer(policy: SyncGlobalBackpressurePolicy, contextGraphId = 'urn:cg:large'): Admission {
  return {
    policy,
    ctx,
    contextGraphId,
    label: `durable:${contextGraphId}:peer`,
    lane: 'durable',
    source: 'on-connect',
  };
}

/** The admission of a standalone curator metadata refresh (`fetchAuthoritativeMetaSnapshot`). */
function metadataRefresh(policy: SyncGlobalBackpressurePolicy, contextGraphId: string): Admission {
  return {
    policy,
    ctx,
    contextGraphId,
    label: 'durable:control-plane',
    lane: 'durable',
    source: 'control-plane',
  };
}

/**
 * Admit work that keeps its slot until `release()`; `started` resolves when it
 * runs. Work released while still queued ends as soon as it starts, so a test
 * that fails early leaves no slot held for the tests after it.
 */
function hold(admission: Admission) {
  let release: (() => void) | undefined;
  let released = false;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const done = withGlobalSyncBackpressure(admission, () => new Promise<void>((resolve) => {
    release = resolve;
    markStarted();
    if (released) resolve();
  }));
  return {
    started,
    done,
    release: () => {
      released = true;
      release?.();
    },
    isRunning: () => release !== undefined,
  };
}

function sharedMemoryPull(policy: SyncGlobalBackpressurePolicy, contextGraphId: string): Admission {
  return {
    policy,
    ctx,
    contextGraphId,
    label: `shared-memory:${contextGraphId}:peer`,
    lane: 'shared_memory',
    source: 'on-connect',
  };
}

function published() {
  return backpressureRegistry.capture().schedulers.find(
    (scheduler) => scheduler.scheduler === 'sync-global',
  );
}

afterEach(() => {
  delete process.env[RESERVE_ENV];
  delete process.env[SHARED_MEMORY_RESERVE_ENV];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('reserved control-plane slot (#3280)', () => {
  it('runs a metadata refresh while a long transfer of another graph holds the only slot', async () => {
    const policy = oneSlotNoQueue();
    const transfer = hold(longTransfer(policy));
    await transfer.started;
    const messages: string[] = [];

    try {
      let refreshed = false;
      await withGlobalSyncBackpressure({
        ...metadataRefresh(policy, 'urn:cg:private'),
        logInfo: (_ctx, message) => { messages.push(message); },
      }, async () => { refreshed = true; });

      expect(refreshed).toBe(true);
      expect(transfer.isRunning()).toBe(true);
      expect(messages).toEqual([
        'Sync backpressure running durable:control-plane in a reserved control-plane slot '
          + '(global inflight=1/1, queued=0/0, reserved control-plane inflight=1/1, queued=0/16)',
      ]);
    } finally {
      transfer.release();
      await transfer.done;
    }
  });

  it('keeps large transfers bounded as before: the reserve is not theirs', async () => {
    const policy = oneSlotNoQueue();
    const transfer = hold(longTransfer(policy));
    await transfer.started;
    const refresh = hold(metadataRefresh(policy, 'urn:cg:private'));
    await refresh.started;

    try {
      await expect(withGlobalSyncBackpressure(
        longTransfer(policy, 'urn:cg:second-large'),
        async () => undefined,
      )).rejects.toMatchObject({
        reason: 'queue_full',
        message: 'Sync backpressure rejected durable:urn:cg:second-large:peer (global inflight=1/1, queued=0/0)',
      });
      await expect(withGlobalSyncBackpressure(
        { policy, ctx, label: 'changelog:urn:cg:small', lane: 'changelog', source: 'reconcile' },
        async () => undefined,
      )).rejects.toMatchObject({ reason: 'queue_full' });
      // Each reserve has its own slot: a shared-memory pull still runs.
      await expect(withGlobalSyncBackpressure(
        sharedMemoryPull(policy, 'urn:cg:small'),
        async () => 'pulled',
      )).resolves.toBe('pulled');
      expect(getSyncBackpressureSnapshot(policy)).toMatchObject({ inflight: 1, queued: 0 });
    } finally {
      refresh.release();
      transfer.release();
      await Promise.all([refresh.done, transfer.done]);
    }
  });

  it('queues a refresh behind a busy reserved slot instead of refusing it', async () => {
    const policy = oneSlotNoQueue();
    const transfer = hold(longTransfer(policy));
    await transfer.started;
    const first = hold(metadataRefresh(policy, 'urn:cg:first'));
    await first.started;
    const messages: string[] = [];
    const second = hold({
      ...metadataRefresh(policy, 'urn:cg:second'),
      logInfo: (_ctx, message) => { messages.push(message); },
    });

    try {
      await tick();
      expect(second.isRunning()).toBe(false);
      expect(messages).toEqual([
        'Sync backpressure queued durable:control-plane (global inflight=1/1, queued=0/0, '
          + 'reserved control-plane inflight=1/1, queued=1/16)',
      ]);
      expect(syncAdmissionWouldBeRefused(policy, metadataRefresh(policy, 'urn:cg:third'))).toBe(false);

      first.release();
      await first.done;
      await second.started;
      expect(transfer.isRunning()).toBe(true);
      expect(messages[1]).toBe(
        'Sync backpressure running durable:control-plane in a reserved control-plane slot '
          + '(global inflight=1/1, queued=0/0, reserved control-plane inflight=1/1, queued=0/16)',
      );
    } finally {
      first.release();
      second.release();
      transfer.release();
      await Promise.all([first.done, second.done, transfer.done]);
    }
  });

  it('refuses a queued refresh once it has waited the bounded time', async () => {
    const policy = oneSlotNoQueue();
    const transfer = hold(longTransfer(policy));
    await transfer.started;
    const first = hold(metadataRefresh(policy, 'urn:cg:first'));
    await first.started;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let started = false;
      const outcome = expect(withGlobalSyncBackpressure(
        metadataRefresh(policy, 'urn:cg:waiting'),
        async () => { started = true; },
      )).rejects.toSatisfy((error: unknown) => (
        error instanceof SyncBackpressureBusyError
        && error.reason === 'queue_timeout'
        && error.message === 'Sync backpressure timed out durable:control-plane after 60000 ms '
          + 'waiting for a control-plane slot (global inflight=1/1, reserved control-plane inflight=1/1, '
          + 'queued=0/16)'
      ));
      await vi.advanceTimersByTimeAsync(DEFAULT_SYNC_CONTROL_PLANE_QUEUE_TIMEOUT_MS - 1);
      expect(getSyncBackpressureSnapshot(policy).queued).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await outcome;
      expect(started).toBe(false);
      expect(getSyncBackpressureSnapshot(policy).queued).toBe(0);
    } finally {
      vi.useRealTimers();
      first.release();
      transfer.release();
      await Promise.all([first.done, transfer.done]);
    }
  });

  it('uses a general slot first and the reserve only under pressure, without narrowing general capacity', async () => {
    const policy = oneSlotNoQueue();
    const messages: string[] = [];
    const general = hold({
      ...metadataRefresh(policy, 'urn:cg:general'),
      logInfo: (_ctx, message) => { messages.push(message); },
    });
    await general.started;
    expect(messages).toEqual([
      'Sync backpressure running durable:control-plane (global inflight=1/1, queued=0/0, '
        + 'reserved control-plane inflight=0/1, queued=0/16)',
    ]);
    // Unchanged: a transfer still waits for the general slot.
    await expect(withGlobalSyncBackpressure(longTransfer(policy), async () => undefined))
      .rejects.toMatchObject({ reason: 'queue_full' });

    const reserved = hold(metadataRefresh(policy, 'urn:cg:reserved'));
    await reserved.started;
    general.release();
    await general.done;

    // The reserved refresh is outside the general count: the freed general
    // slot takes a transfer while that refresh still runs.
    const transfer = hold(longTransfer(policy));
    try {
      await transfer.started;
      expect(reserved.isRunning()).toBe(true);
      expect(getSyncBackpressureSnapshot(policy)).toMatchObject({ inflight: 1, queued: 0 });
    } finally {
      reserved.release();
      transfer.release();
      await Promise.all([reserved.done, transfer.done]);
    }
  });

  it('keeps its own bounded queue: waiting refreshes fill neither the general nor the shared-memory queue', async () => {
    const policy = resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 1 });
    const transfer = hold(longTransfer(policy));
    await transfer.started;
    const reserved = hold(metadataRefresh(policy, 'urn:cg:reserved'));
    await reserved.started;
    const waiting = Array.from(
      { length: DEFAULT_SYNC_CONTROL_PLANE_QUEUE_LIMIT },
      (_, index) => hold(metadataRefresh(policy, `urn:cg:waiting-${index}`)),
    );
    const queuedDurable = hold(longTransfer(policy, 'urn:cg:queued-durable'));
    await tick();

    try {
      expect(queuedDurable.isRunning()).toBe(false);
      expect(getSyncBackpressureSnapshot(policy).queued).toBe(DEFAULT_SYNC_CONTROL_PLANE_QUEUE_LIMIT + 1);
      await expect(withGlobalSyncBackpressure(
        metadataRefresh(policy, 'urn:cg:one-too-many'),
        async () => undefined,
      )).rejects.toMatchObject({
        reason: 'queue_full',
        message: `Sync backpressure rejected durable:control-plane (global inflight=1/1, `
          + `queued=${DEFAULT_SYNC_CONTROL_PLANE_QUEUE_LIMIT + 1}/1, reserved control-plane inflight=1/1, `
          + `queued=${DEFAULT_SYNC_CONTROL_PLANE_QUEUE_LIMIT}/${DEFAULT_SYNC_CONTROL_PLANE_QUEUE_LIMIT})`,
      });
      await expect(withGlobalSyncBackpressure(
        sharedMemoryPull(policy, 'urn:cg:small'),
        async () => 'pulled',
      )).resolves.toBe('pulled');

      // Waiters drain through the reserved slot while the transfer still runs.
      reserved.release();
      for (const waiter of waiting) {
        await waiter.started;
        expect(transfer.isRunning()).toBe(true);
        waiter.release();
        await waiter.done;
      }
      transfer.release();
      await queuedDurable.started;
    } finally {
      reserved.release();
      for (const waiter of waiting) waiter.release();
      transfer.release();
      queuedDurable.release();
      await Promise.all([reserved.done, transfer.done, queuedDurable.done, ...waiting.map((waiter) => waiter.done)]);
    }
  });

  it('restores the refusal when the reserve is switched off', async () => {
    process.env[RESERVE_ENV] = '0';
    const policy = oneSlotNoQueue();
    const transfer = hold(longTransfer(policy));
    await transfer.started;

    try {
      expect(syncAdmissionWouldBeRefused(policy, metadataRefresh(policy, 'urn:cg:private'))).toBe(true);
      await expect(withGlobalSyncBackpressure(
        metadataRefresh(policy, 'urn:cg:private'),
        async () => undefined,
      )).rejects.toMatchObject({
        reason: 'queue_full',
        message: 'Sync backpressure rejected durable:control-plane (global inflight=1/1, queued=0/0)',
      });
    } finally {
      transfer.release();
      await transfer.done;
    }
  });

  it('leaves control-plane work to the fast partition under partitioned admission', async () => {
    const policy = resolveSyncGlobalBackpressure({ syncAdmission: {} });
    // The shared-memory reserve grows the slow lane; nothing grows the fast one.
    expect(published()).toMatchObject({
      capacityModel: 'partitioned',
      totals: { inflightLimit: 11, queueLimit: 72 + DEFAULT_SYNC_SHARED_MEMORY_QUEUE_LIMIT },
    });
    expect(published()!.lanes.find((lane) => lane.lane === 'fast'))
      .toMatchObject({ inflightLimit: 8, queueLimit: 64 });
    const messages: string[] = [];
    await withGlobalSyncBackpressure({
      ...metadataRefresh(policy, 'urn:cg:private'),
      logInfo: (_ctx, message) => { messages.push(message); },
    }, async () => undefined);
    expect(messages).toEqual(['Sync backpressure running durable:control-plane (global inflight=1/10, queued=0/72)']);
  });

  it('counts the reserve in the scheduler capacity it publishes', () => {
    resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 });
    expect(published()).toMatchObject({
      capacityModel: 'shared',
      totals: {
        inflightLimit: 3,
        queueLimit: DEFAULT_SYNC_SHARED_MEMORY_QUEUE_LIMIT + DEFAULT_SYNC_CONTROL_PLANE_QUEUE_LIMIT,
      },
    });

    process.env[RESERVE_ENV] = '0';
    resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 });
    expect(published()).toMatchObject({
      totals: { inflightLimit: 2, queueLimit: DEFAULT_SYNC_SHARED_MEMORY_QUEUE_LIMIT },
    });

    process.env[SHARED_MEMORY_RESERVE_ENV] = '0';
    resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 });
    expect(published()).toMatchObject({ totals: { inflightLimit: 1, queueLimit: 0 } });
  });
});

/** A public root `_meta` declaration as a serving peer holds it. */
function servedPublicMetaQuads(contextGraphId: string): Quad[] {
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
  return [
    { subject: contextGraphUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: metaGraph },
    { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"public"', graph: metaGraph },
    { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: `did:dkg:agent:${OWNER}`, graph: metaGraph },
  ];
}

async function rootMetaRows(store: TripleStore, contextGraphId: string): Promise<Array<{ p: string; o: string }>> {
  const result = await store.query(
    `SELECT ?p ?o WHERE { GRAPH <${contextGraphMetaGraphUri(contextGraphId)}> { `
    + `<${contextGraphDataGraphUri(contextGraphId)}> ?p ?o } }`,
  );
  if (result.type !== 'bindings') throw new Error('expected _meta bindings');
  return result.bindings.map((row) => ({ p: row['p']!, o: row['o']! }));
}

/**
 * The member of the issue: one sync slot, no queue, and the production
 * admission path (`runContextGraphSyncWithBackpressure`) under a real curator
 * metadata refresh. Only the network edge (`fetchSyncPages`) is stubbed.
 */
function createOneSlotMember(store: OxigraphStore, contextGraphId: string) {
  const fetches: string[] = [];
  const noop = () => {};
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const agent = {
    config: { syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 },
    peerId: 'local-peer',
    node: {
      stopSignal: undefined,
      libp2p: { getConnections: () => [{ remotePeer: { toString: () => SERVING_PEER_ID } }] },
    },
    metaRefreshTimestamps: new Map<string, number>(),
    runContextGraphSyncWithBackpressure: LifecycleSyncMethods.prototype.runContextGraphSyncWithBackpressure,
    fetchSyncPages: async (_ctx: unknown, _peer: string, _cg: string, _swm: boolean, phase: string) => {
      fetches.push(phase);
      return {
        quads: servedPublicMetaQuads(contextGraphId),
        checkpointKey: 'one-slot-member-meta',
        resumedFromOffset: 0,
        completed: true,
      };
    },
    store,
    oversizeTombstoneLog: { record: noop },
    invalidateListContextGraphsCache: noop,
    contextGraphMetaProjection: { markDirty: noop },
    subscribedContextGraphs: new Map([[contextGraphId, {}]]),
    syncCheckpoints: new Map<string, number>(),
    log,
  };
  return { agent, fetches, log };
}

describe('metadata refresh on a node with one sync slot and no queue (#3280)', () => {
  it('installs a graph\'s definition while a long transfer of another graph holds the only slot', async () => {
    const contextGraphId = `${OWNER}/one-slot-member`;
    const store = new OxigraphStore();
    const member = createOneSlotMember(store, contextGraphId);
    let releaseTransfer!: () => void;
    const transfer = LifecycleSyncMethods.prototype.runContextGraphSyncWithBackpressure.call(
      member.agent as never,
      ctx,
      'urn:cg:other-verified',
      'durable',
      'durable:urn:cg:other-verified:peer',
      () => new Promise<void>((resolve) => { releaseTransfer = resolve; }),
      { source: 'on-connect' },
    );
    await vi.waitFor(() => expect(releaseTransfer).toBeTypeOf('function'));

    try {
      // The RFC-64 metadata bootstrap's refresh: a relayed public declaration.
      await expect(runCuratorMetaRefreshFromPeer(member.agent, contextGraphId, SERVING_PEER_ID, {
        force: true,
        requirePublicDefinition: true,
        ignoreRegistrationBinding: true,
        expectedCuratorAddress: OWNER,
      })).resolves.toBe(true);

      expect(member.fetches).toEqual(['meta']);
      expect(await rootMetaRows(store, contextGraphId)).toContainEqual({
        p: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
        o: '"public"',
      });
      expect(member.log.warn).not.toHaveBeenCalled();
    } finally {
      releaseTransfer?.();
      await transfer;
      await store.close();
    }
  });
});
