import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  createOperationContext,
  DKG_ONTOLOGY,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import {
  resolveSyncGlobalBackpressure,
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

const ctx = createOperationContext('sync');
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

afterEach(() => {
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
