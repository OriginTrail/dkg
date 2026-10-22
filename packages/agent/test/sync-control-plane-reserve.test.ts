import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backpressureRegistry,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  createOperationContext,
  DKG_ONTOLOGY,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DEFAULT_SYNC_SHARED_MEMORY_QUEUE_LIMIT } from '../src/sync/shared-memory-reserve.js';
import { ControlPlaneRefusalSummary, syncRefusalReporter } from '../src/sync/control-plane-refusals.js';
import {
  getSyncBackpressureSnapshot,
  resolveSyncGlobalBackpressure,
  syncAdmissionWouldBeRefused,
  withGlobalSyncBackpressure,
  type SyncGlobalBackpressurePolicy,
} from '../src/sync/backpressure.js';
import { runCuratorMetaRefreshFromPeer } from '../src/curator-meta-refresh.js';
import { holdsAuthoritativePublicDefinitionV1 } from '../src/context-graph-meta-confirmation.js';
import { buildAuthoritativePublicMetaQuads } from '../src/context-graph-public-meta-proof.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import type { SyncAdmissionSource, SyncSchedulerLane } from '../src/sync/policy.js';
import { pageResult } from './_helpers/sync-requester-fixtures.js';

// Issue #3280: a member configured with one sync slot and no queue
// (`syncGlobalMaxInflight: 1`, `syncGlobalQueueLimit: 0`) refused every
// metadata refresh while another transfer held that slot, with
// "Meta refresh for <graph> failed: Sync backpressure rejected durable:control-plane
// (global inflight=1/1, queued=0/0)". It never obtained a registered graph's
// definition or a private graph's member list.

const RESERVE_ENV = 'DKG_SYNC_CONTROL_PLANE_RESERVED_INFLIGHT';
const SHARED_MEMORY_RESERVE_ENV = 'DKG_SYNC_SHARED_MEMORY_RESERVED_INFLIGHT';
/** Every variable that overrides the policies these tests resolve. */
const SYNC_ENV = [
  RESERVE_ENV,
  SHARED_MEMORY_RESERVE_ENV,
  'DKG_SYNC_GLOBAL_MAX_INFLIGHT',
  'DKG_SYNC_GLOBAL_LIMIT',
  'DKG_SYNC_GLOBAL_QUEUE_LIMIT',
] as const;
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

interface Held {
  /** Resolves when the work runs. */
  started: Promise<void>;
  /** Settles when the work has ended, or rejects when it was refused. */
  done: Promise<unknown>;
  release: () => void;
}

/**
 * Admit work that keeps its slot until `release()`. Work released while still
 * queued ends as soon as it starts.
 */
function holdWith(admit: (work: () => Promise<void>) => Promise<unknown>): Held {
  let release: (() => void) | undefined;
  let released = false;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const done = admit(() => new Promise<void>((resolve) => {
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
  };
}

const hold = (admission: Admission) => holdWith((work) => withGlobalSyncBackpressure(admission, work));

/** Wait until held work runs; a refusal fails the test at once instead of hanging it. */
async function running(work: Held): Promise<void> {
  await Promise.race([work.started, work.done]);
}

/**
 * Run a test whose held work is always released, so a failed assertion never
 * leaves a slot of the one sync-global scheduler held for the tests after it.
 */
async function withHolds(test: (keep: (work: Held) => Held) => Promise<void>): Promise<void> {
  const held: Held[] = [];
  try {
    await test((work) => {
      held.push(work);
      return work;
    });
  } finally {
    for (const work of held) work.release();
    await Promise.allSettled(held.map((work) => work.done));
  }
}

function published() {
  return backpressureRegistry.capture().schedulers.find(
    (scheduler) => scheduler.scheduler === 'sync-global',
  );
}


let savedEnv: Partial<Record<(typeof SYNC_ENV)[number], string>> = {};

beforeEach(() => {
  savedEnv = {};
  for (const name of SYNC_ENV) {
    if (process.env[name] !== undefined) savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of SYNC_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  vi.restoreAllMocks();
});

describe('reserved control-plane slot (#3280)', () => {
  it('runs a metadata refresh while a long transfer of another graph holds the only slot', () => withHolds(async (keep) => {
    const policy = oneSlotNoQueue();
    await running(keep(hold(longTransfer(policy))));
    const messages: string[] = [];

    let refreshed = false;
    await withGlobalSyncBackpressure({
      ...metadataRefresh(policy, 'urn:cg:private'),
      logInfo: (_ctx, message) => { messages.push(message); },
    }, async () => { refreshed = true; });

    expect(refreshed).toBe(true);
    expect(messages).toEqual([
      'Sync backpressure running durable:control-plane in a reserved control-plane slot '
        + '(global inflight=1/1, queued=0/0, reserved control-plane inflight=1/1)',
    ]);
    // The transfer kept the general slot throughout.
    expect(getSyncBackpressureSnapshot(policy)).toMatchObject({ inflight: 1, queued: 0 });
  }));

  it('keeps large transfers bounded as before: the reserve is not theirs', () => withHolds(async (keep) => {
    const policy = oneSlotNoQueue();
    await running(keep(hold(longTransfer(policy))));
    await running(keep(hold(metadataRefresh(policy, 'urn:cg:private'))));

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
  }));

  it('refuses a second refresh at once, as before, while the reserved slot is busy too', () => withHolds(async (keep) => {
    // No queue of its own: an inbound request's authorization, which holds a
    // responder slot meanwhile, or a loop over peers gets its answer at once.
    const policy = oneSlotNoQueue();
    await running(keep(hold(longTransfer(policy))));
    await running(keep(hold(metadataRefresh(policy, 'urn:cg:first'))));

    expect(syncAdmissionWouldBeRefused(policy, metadataRefresh(policy, 'urn:cg:second'))).toBe(true);
    await expect(withGlobalSyncBackpressure(
      metadataRefresh(policy, 'urn:cg:second'),
      async () => undefined,
    )).rejects.toMatchObject({
      reason: 'queue_full',
      message: 'Sync backpressure rejected durable:control-plane '
        + '(global inflight=1/1, queued=0/0, reserved control-plane inflight=1/1)',
    });
    // Nothing waits for the general slot, so it goes to whatever asks next.
    expect(getSyncBackpressureSnapshot(policy)).toMatchObject({ inflight: 1, queued: 0 });
  }));

  it('hands a refusal to the admission\'s reporter, which counts refused refreshes and logs every other refusal', () => withHolds(async (keep) => {
    const policy = oneSlotNoQueue();
    await running(keep(hold(longTransfer(policy))));
    await running(keep(hold(metadataRefresh(policy, 'urn:cg:first'))));
    const messages: string[] = [];
    const summaryLines: string[] = [];
    const logInfo = (_ctx: unknown, message: string) => { messages.push(message); };
    const summary = new ControlPlaneRefusalSummary({ emit: (line) => summaryLines.push(line) });
    const reported = (admission: Admission) => ({
      ...admission,
      logInfo,
      reportRefusal: syncRefusalReporter(admission, summary, logInfo),
    });

    for (const contextGraphId of ['urn:cg:second', 'urn:cg:third', 'urn:cg:second']) {
      await expect(withGlobalSyncBackpressure(reported(metadataRefresh(policy, contextGraphId)), async () => undefined))
        .rejects.toMatchObject({ reason: 'queue_full', state: 'global inflight=1/1, queued=0/0, reserved control-plane inflight=1/1' });
    }
    // Other work refused for the same lack of a slot keeps its own line.
    await expect(withGlobalSyncBackpressure(reported(longTransfer(policy, 'urn:cg:second-large')), async () => undefined))
      .rejects.toMatchObject({ reason: 'queue_full', state: 'global inflight=1/1, queued=0/0' });
    // Without a reporter the admission logs every refusal itself.
    await expect(withGlobalSyncBackpressure({ ...metadataRefresh(policy, 'urn:cg:fourth'), logInfo }, async () => undefined))
      .rejects.toMatchObject({ reason: 'queue_full' });

    expect(messages).toEqual([
      'Sync backpressure rejected durable:urn:cg:second-large:peer (global inflight=1/1, queued=0/0)',
      'Sync backpressure rejected durable:control-plane (global inflight=1/1, queued=0/0, reserved control-plane inflight=1/1)',
    ]);
    summary.flush();
    expect(summaryLines).toEqual([
      expect.stringMatching(
        /^Sync backpressure rejected durable:control-plane 3 time\(s\) in the last \d+ s for 2 graph\(s\), each asked again later \(last: global inflight=1\/1, queued=0\/0, reserved control-plane inflight=1\/1\)$/,
      ),
    ]);
  }));

  it('waits in the general queue where the node has one, and takes the reserved slot when it frees', () => withHolds(async (keep) => {
    const policy = resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 2 });
    const transfer = keep(hold(longTransfer(policy)));
    await running(transfer);
    const first = keep(hold(metadataRefresh(policy, 'urn:cg:first')));
    await running(first);
    const messages: string[] = [];
    const second = keep(hold({
      ...metadataRefresh(policy, 'urn:cg:second'),
      logInfo: (_ctx, message) => { messages.push(message); },
    }));
    const queuedTransfer = keep(hold(longTransfer(policy, 'urn:cg:queued-transfer')));
    await tick();

    expect(messages).toEqual([
      'Sync backpressure queued durable:control-plane '
        + '(global inflight=1/1, queued=0/2, reserved control-plane inflight=1/1)',
    ]);
    expect(getSyncBackpressureSnapshot(policy)).toMatchObject({ inflight: 1, queued: 2 });

    // The reserved slot frees: the waiting refresh takes it, and the waiting
    // transfer still waits for the general slot.
    first.release();
    await first.done;
    await running(second);
    expect(messages[1]).toBe(
      'Sync backpressure running durable:control-plane in a reserved control-plane slot '
        + '(global inflight=1/1, queued=1/2, reserved control-plane inflight=1/1)',
    );
    expect(getSyncBackpressureSnapshot(policy)).toMatchObject({ inflight: 1, queued: 1 });

    transfer.release();
    await transfer.done;
    await running(queuedTransfer);
    expect(getSyncBackpressureSnapshot(policy)).toMatchObject({ inflight: 1, queued: 0 });
  }));

  it('uses a general slot first and the reserve only under pressure, without narrowing general capacity', () => withHolds(async (keep) => {
    const policy = oneSlotNoQueue();
    const messages: string[] = [];
    const general = keep(hold({
      ...metadataRefresh(policy, 'urn:cg:general'),
      logInfo: (_ctx, message) => { messages.push(message); },
    }));
    await running(general);
    expect(messages).toEqual([
      'Sync backpressure running durable:control-plane '
        + '(global inflight=1/1, queued=0/0, reserved control-plane inflight=0/1)',
    ]);
    // Unchanged: a transfer still waits for the general slot.
    await expect(withGlobalSyncBackpressure(longTransfer(policy), async () => undefined))
      .rejects.toMatchObject({ reason: 'queue_full' });

    await running(keep(hold(metadataRefresh(policy, 'urn:cg:reserved'))));
    general.release();
    await general.done;

    // The reserved refresh is outside the general count: the freed general
    // slot takes a transfer while that refresh still runs.
    await running(keep(hold(longTransfer(policy))));
    expect(getSyncBackpressureSnapshot(policy)).toMatchObject({ inflight: 1, queued: 0 });
  }));

  it('keeps the shared-memory reserve for a shared-memory pull, whatever its source', () => withHolds(async (keep) => {
    const policy = oneSlotNoQueue();
    await running(keep(hold(longTransfer(policy))));
    const messages: string[] = [];

    await withGlobalSyncBackpressure({
      ...sharedMemoryPull(policy, 'urn:cg:small'),
      source: 'control-plane',
      logInfo: (_ctx, message) => { messages.push(message); },
    }, async () => undefined);

    expect(messages).toEqual([
      'Sync backpressure running shared-memory:urn:cg:small:peer in a reserved shared-memory slot '
        + '(global inflight=1/1, queued=0/0, reserved shared-memory inflight=1/1, queued=0/16)',
    ]);
  }));

  it('restores the refusal when the reserve is switched off', () => withHolds(async (keep) => {
    process.env[RESERVE_ENV] = '0';
    const policy = oneSlotNoQueue();
    await running(keep(hold(longTransfer(policy))));

    expect(syncAdmissionWouldBeRefused(policy, metadataRefresh(policy, 'urn:cg:private'))).toBe(true);
    await expect(withGlobalSyncBackpressure(
      metadataRefresh(policy, 'urn:cg:private'),
      async () => undefined,
    )).rejects.toMatchObject({
      reason: 'queue_full',
      message: 'Sync backpressure rejected durable:control-plane (global inflight=1/1, queued=0/0)',
    });
  }));

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

  it('counts the reserve in the scheduler capacity it publishes: one slot more, no queue', () => {
    resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 });
    expect(published()).toMatchObject({
      capacityModel: 'shared',
      totals: { inflightLimit: 3, queueLimit: DEFAULT_SYNC_SHARED_MEMORY_QUEUE_LIMIT },
    });

    process.env[SHARED_MEMORY_RESERVE_ENV] = '0';
    resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 });
    expect(published()).toMatchObject({ totals: { inflightLimit: 2, queueLimit: 0 } });

    process.env[RESERVE_ENV] = '0';
    resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 });
    expect(published()).toMatchObject({ totals: { inflightLimit: 1, queueLimit: 0 } });
  });
});

/** A public root `_meta` declaration of `OWNER`'s graph, as a serving peer holds it. */
function servedPublicMetaQuads(contextGraphId: string): Quad[] {
  return [
    ...buildAuthoritativePublicMetaQuads(contextGraphId),
    {
      subject: contextGraphDataGraphUri(contextGraphId),
      predicate: DKG_ONTOLOGY.DKG_CURATOR,
      object: `did:dkg:agent:${OWNER}`,
      graph: contextGraphMetaGraphUri(contextGraphId),
    },
  ];
}

/** The refresh of the RFC-64 metadata bootstrap: a relayed public declaration. */
const BOOTSTRAP_REFRESH = Object.freeze({
  force: true,
  requirePublicDefinition: true,
  ignoreRegistrationBinding: true,
  expectedCuratorAddress: OWNER,
});

/**
 * The member of the issue: one sync slot, no queue, and the production
 * admission path (`runContextGraphSyncWithBackpressure`) under a real curator
 * metadata refresh. Only the network edge (`fetchSyncPages`) is stubbed.
 */
function createOneSlotMember(store: OxigraphStore, contextGraphId: string) {
  const fetches: string[] = [];
  const noop = () => {};
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const summaryLines: string[] = [];
  const stop = new AbortController();
  const agent = {
    config: { syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 },
    peerId: 'local-peer',
    node: {
      stopSignal: stop.signal,
      libp2p: { getConnections: () => [{ remotePeer: { toString: () => SERVING_PEER_ID } }] },
    },
    metaRefreshTimestamps: new Map<string, number>(),
    runContextGraphSyncWithBackpressure: LifecycleSyncMethods.prototype.runContextGraphSyncWithBackpressure,
    fetchSyncPages: async (_ctx: unknown, _peer: string, cg: string, _swm: boolean, phase: string) => {
      fetches.push(phase);
      return pageResult(cg, phase, { quads: servedPublicMetaQuads(contextGraphId) });
    },
    store,
    oversizeTombstoneLog: { record: noop },
    invalidateListContextGraphsCache: noop,
    contextGraphMetaProjection: { markDirty: noop },
    subscribedContextGraphs: new Map([[contextGraphId, {}]]),
    syncCheckpoints: new Map<string, number>(),
    log,
    controlPlaneRefusals: new ControlPlaneRefusalSummary({ emit: (line) => summaryLines.push(line) }),
  };
  /** Admit work through this member's admission path, held until released. */
  const admit = (otherGraphId: string, label: string, source: SyncAdmissionSource) => holdWith(
    (work) => LifecycleSyncMethods.prototype.runContextGraphSyncWithBackpressure.call(
      agent as never,
      ctx,
      otherGraphId,
      'durable',
      label,
      work,
      { source },
    ),
  );
  return { agent, fetches, log, admit, summaryLines, stop };
}

describe('metadata refresh on a node with one sync slot and no queue (#3280)', () => {
  it('installs a graph\'s definition while a long transfer of another graph holds the only slot', () => withHolds(async (keep) => {
    const contextGraphId = `${OWNER}/one-slot-member`;
    const store = new OxigraphStore();
    try {
      const member = createOneSlotMember(store, contextGraphId);
      await running(keep(member.admit('urn:cg:other-verified', 'durable:urn:cg:other-verified:peer', 'on-connect')));

      await expect(runCuratorMetaRefreshFromPeer(member.agent, contextGraphId, SERVING_PEER_ID, BOOTSTRAP_REFRESH))
        .resolves.toBe(true);

      expect(member.fetches).toEqual(['meta']);
      await expect(holdsAuthoritativePublicDefinitionV1(store, contextGraphId)).resolves.toBe(true);
      expect(member.log.warn).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  }));

  it('fails at once, without waiting, while the reserved slot is busy too, and is counted, not logged', () => withHolds(async (keep) => {
    const contextGraphId = `${OWNER}/busy-member`;
    const store = new OxigraphStore();
    try {
      const member = createOneSlotMember(store, contextGraphId);
      await running(keep(member.admit('urn:cg:other-verified', 'durable:urn:cg:other-verified:peer', 'on-connect')));
      await running(keep(member.admit('urn:cg:other-private', 'durable:control-plane', 'control-plane')));

      await expect(runCuratorMetaRefreshFromPeer(member.agent, contextGraphId, SERVING_PEER_ID, BOOTSTRAP_REFRESH))
        .resolves.toBe(false);

      expect(member.fetches).toEqual([]);
      // Neither the admission's line nor the refresh's warning: one line per interval instead.
      expect(member.log.info).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('rejected'));
      expect(member.log.warn).not.toHaveBeenCalled();
      // Counted, and logged when the node stops (or when its interval ends).
      expect(member.summaryLines).toEqual([]);
      member.stop.abort();
      expect(member.summaryLines).toEqual([
        expect.stringMatching(
          /^Sync backpressure rejected durable:control-plane 1 time\(s\) in the last \d+ s for 1 graph\(s\), each asked again later \(last: global inflight=1\/1, queued=0\/0, reserved control-plane inflight=1\/1\)$/,
        ),
      ]);
      await expect(holdsAuthoritativePublicDefinitionV1(store, contextGraphId)).resolves.toBe(false);
    } finally {
      await store.close();
    }
  }));

  it('still warns when a refresh fails for any other reason', async () => {
    const contextGraphId = `${OWNER}/failing-member`;
    const store = new OxigraphStore();
    try {
      const member = createOneSlotMember(store, contextGraphId);
      member.agent.fetchSyncPages = async () => {
        throw new Error('stream reset by peer');
      };

      await expect(runCuratorMetaRefreshFromPeer(member.agent, contextGraphId, SERVING_PEER_ID, BOOTSTRAP_REFRESH))
        .resolves.toBe(false);

      expect(member.log.warn).toHaveBeenCalledWith(
        expect.anything(),
        `Meta refresh for "${contextGraphId}" failed: stream reset by peer`,
      );
    } finally {
      await store.close();
    }
  });
});
