import { describe, expect, it } from 'vitest';
import { DKG_ONTOLOGY, contextGraphDataGraphUri, contextGraphMetaGraphUri, type OperationContext } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { ContextGraphResolveMethods } from '../src/dkg-agent-cg-resolve.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import { fetchSyncPages } from '../src/sync/requester/page-fetch.js';
import { getSyncCheckpointKey, MemorySyncCheckpointStore } from '../src/sync/checkpoint/state.js';

const CURATOR_PEER_ID = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const RELAY_ADDR = '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';

function noop(): void {}

function operationContext(): OperationContext {
  return { kind: 'sync', id: 'cg-refresh-test', startedAt: Date.now() } as never;
}

describe('refreshMetaFromCurator', () => {
  it('passes caller abort signal to direct and relay curator dials', async () => {
    const controller = new AbortController();
    const dialSignals: Array<AbortSignal | undefined> = [];

    const agent = {
      metaRefreshTimestamps: new Map<string, number>(),
      peerId: 'local-peer',
      resolveCuratorPeerId: async () => CURATOR_PEER_ID,
      node: {
        libp2p: {
          getConnections: () => [],
          dial: async (_target: unknown, opts?: { signal?: AbortSignal }) => {
            dialSignals.push(opts?.signal);
            if (dialSignals.length === 1) {
              throw new Error('direct dial unavailable');
            }
          },
          peerStore: {
            merge: async () => undefined,
          },
        },
      },
      discovery: {
        findAgentByPeerId: async () => ({ relayAddress: RELAY_ADDR }),
      },
      fetchSyncPages: async () => {
        throw new Error('should not fetch without a connected curator');
      },
      log: {
        warn: () => undefined,
        info: () => undefined,
      },
    };

    const refreshed = await ContextGraphResolveMethods.prototype.refreshMetaFromCurator.call(
      agent as never,
      'unit-test-cg',
      { signal: controller.signal },
    );

    expect(refreshed).toBe(false);
    expect(dialSignals).toEqual([controller.signal, controller.signal]);
  });

  it('uses a trusted join-approved curator directly and bypasses the auth-probe cooldown', async () => {
    const contextGraphId = 'private/trusted-curator-bootstrap';
    const metaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
    const inserted = [{
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.RDF_TYPE,
      object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
      graph: metaGraph,
    }, {
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
      object: '"private"',
      graph: metaGraph,
    }, {
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_CREATOR,
      object: `did:dkg:agent:${CURATOR_PEER_ID}`,
      graph: metaGraph,
    }, {
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_CURATOR,
      object: 'did:dkg:agent:0x0000000000000000000000000000000000000001',
      graph: metaGraph,
    }, {
      // The common response parser permits CG-prefixed graphs. The trusted
      // control-plane refresh must still discard data-plane content.
      subject: 'urn:payload',
      predicate: 'urn:value',
      object: 'unsafe',
      graph: `did:dkg:context-graph:${contextGraphId}/_shared_memory`,
    }];
    let resolved = false;
    let fetchPeer: string | undefined;
    let forceFreshSession: boolean | undefined;
    let staged: Quad[] = [];
    let replacementUpdate = '';
    const agent = {
      // A recent auth-driven refresh would suppress a normal call.
      metaRefreshTimestamps: new Map([[contextGraphId, Date.now()]]),
      peerId: 'local-peer',
      resolveCuratorPeerId: async () => {
        resolved = true;
        return 'wrong-peer';
      },
      node: {
        libp2p: {
          getConnections: () => [{ remotePeer: { toString: () => CURATOR_PEER_ID } }],
        },
      },
      discovery: {},
      fetchSyncPages: async (...args: unknown[]) => {
        const peerId = args[1] as string;
        fetchPeer = peerId;
        forceFreshSession = args[11] as boolean | undefined;
        return {
          quads: inserted,
          checkpointKey: 'trusted-meta-checkpoint',
          resumedFromOffset: 0,
          completed: true,
        };
      },
      store: {
        insert: async (quads: Quad[]) => { staged = quads; },
        update: async (sparql: string) => { replacementUpdate = sparql; },
        dropGraph: async () => undefined,
      },
      oversizeTombstoneLog: { record: noop },
      invalidateListContextGraphsCache: noop,
      contextGraphMetaProjection: { markDirty: noop },
      syncCheckpoints: new Map([['trusted-meta-checkpoint', 1]]),
      log: {
        warn: () => undefined,
        info: () => undefined,
      },
    };

    const refreshed = await ContextGraphResolveMethods.prototype.refreshMetaFromCurator.call(
      agent as never,
      contextGraphId,
      { trustedCuratorPeerId: CURATOR_PEER_ID, force: true },
    );

    expect(refreshed).toBe(true);
    expect(resolved).toBe(false);
    expect(fetchPeer).toBe(CURATOR_PEER_ID);
    expect(forceFreshSession).toBe(true);
    expect(staged).toHaveLength(4);
    expect(staged[0]).toMatchObject({
      subject: inserted[0].subject,
      predicate: inserted[0].predicate,
      object: inserted[0].object,
    });
    expect(staged[0].graph).toMatch(/^urn:dkg:curator-meta-refresh:/);
    expect(replacementUpdate).toContain(`GRAPH <${metaGraph}>`);
    expect(replacementUpdate).not.toContain(inserted[4].graph);
    expect(agent.syncCheckpoints.has('trusted-meta-checkpoint')).toBe(false);
  });

  it('does not persist a partial curator metadata snapshot and resets its checkpoint', async () => {
    const contextGraphId = 'private/partial-curator-bootstrap';
    const checkpointKey = getSyncCheckpointKey(
      CURATOR_PEER_ID,
      contextGraphId,
      false,
      'meta',
    );
    let stored = false;
    const agent = {
      metaRefreshTimestamps: new Map<string, number>(),
      peerId: 'local-peer',
      node: {
        libp2p: {
          getConnections: () => [{ remotePeer: { toString: () => CURATOR_PEER_ID } }],
        },
      },
      discovery: {},
      fetchSyncPages: async () => ({
        quads: [{
          subject: 'urn:cg',
          predicate: 'urn:allowedAgent',
          object: '0xpartial',
          graph: contextGraphMetaGraphUri(contextGraphId),
        }],
        checkpointKey,
        resumedFromOffset: 0,
        completed: false,
      }),
      insertSyncedQuadsAndInvalidateListCache: async () => {
        stored = true;
      },
      syncCheckpoints: new Map([[checkpointKey, 100]]),
      log: {
        warn: () => undefined,
        info: () => undefined,
      },
    };

    const refreshed = await ContextGraphResolveMethods.prototype.refreshMetaFromCurator.call(
      agent as never,
      contextGraphId,
      { trustedCuratorPeerId: CURATOR_PEER_ID, force: true },
    );

    expect(refreshed).toBe(false);
    expect(stored).toBe(false);
    expect(agent.syncCheckpoints.has(checkpointKey)).toBe(false);
  });

  it('rejects a completed resumed tail, clears it, then accepts a complete offset-zero snapshot', async () => {
    const contextGraphId = 'private/resumed-curator-bootstrap';
    const metaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
    const checkpointKey = getSyncCheckpointKey(
      CURATOR_PEER_ID,
      contextGraphId,
      false,
      'meta',
    );
    const firstPage = {
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.RDF_TYPE,
      object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
      graph: metaGraph,
    };
    const definitionTail = [{
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
      object: '"private"',
      graph: metaGraph,
    }, {
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_CREATOR,
      object: `did:dkg:agent:${CURATOR_PEER_ID}`,
      graph: metaGraph,
    }, {
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_CURATOR,
      object: 'did:dkg:agent:0x0000000000000000000000000000000000000001',
      graph: metaGraph,
    }];
    const tailPage = {
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
      object: '"0xmember"',
      graph: metaGraph,
    };
    let fetchCount = 0;
    const storedSnapshots: unknown[] = [];
    const agent = {
      metaRefreshTimestamps: new Map<string, number>(),
      peerId: 'local-peer',
      node: {
        libp2p: {
          getConnections: () => [{ remotePeer: { toString: () => CURATOR_PEER_ID } }],
        },
      },
      discovery: {},
      fetchSyncPages: async () => {
        fetchCount += 1;
        if (fetchCount === 1) {
          // Model an already-running/coalesced fetch which captured the old
          // cursor before the trusted path deleted it and returned only page 2.
          return {
            quads: [tailPage],
            checkpointKey,
            resumedFromOffset: 1,
            completed: true,
          };
        }
        return {
          quads: [firstPage, ...definitionTail, tailPage],
          checkpointKey,
          resumedFromOffset: 0,
          completed: true,
        };
      },
      store: {
        insert: async (quads: Quad[]) => {
          storedSnapshots.push(quads.map((quad) => ({ ...quad, graph: metaGraph })));
        },
        update: async () => undefined,
        dropGraph: async () => undefined,
      },
      oversizeTombstoneLog: { record: noop },
      invalidateListContextGraphsCache: noop,
      contextGraphMetaProjection: { markDirty: noop },
      syncCheckpoints: new Map([[checkpointKey, 1]]),
      log: {
        warn: () => undefined,
        info: () => undefined,
      },
    };

    const firstRefresh = await ContextGraphResolveMethods.prototype.refreshMetaFromCurator.call(
      agent as never,
      contextGraphId,
      { trustedCuratorPeerId: CURATOR_PEER_ID, force: true },
    );
    expect(firstRefresh).toBe(false);
    expect(storedSnapshots).toEqual([]);
    expect(agent.syncCheckpoints.has(checkpointKey)).toBe(false);

    const secondRefresh = await ContextGraphResolveMethods.prototype.refreshMetaFromCurator.call(
      agent as never,
      contextGraphId,
      { trustedCuratorPeerId: CURATOR_PEER_ID, force: true },
    );
    expect(secondRefresh).toBe(true);
    expect(storedSnapshots).toEqual([[firstPage, ...definitionTail, tailPage]]);
  });

  it('fails closed on an empty or incomplete definition instead of wiping existing control metadata', async () => {
    const contextGraphId = 'private/missing-authoritative-floor';
    const metaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
    const snapshots: Quad[][] = [[], [
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: metaGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"private"', graph: metaGraph },
      // Creator is a literal, not the IRI-shaped agent DID required by the
      // same authoritative-definition proof used by hasConfirmedMetaState.
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: '"did:dkg:agent:not-an-iri"', graph: metaGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: 'did:dkg:agent:0x0000000000000000000000000000000000000001', graph: metaGraph },
    ]];
    let targetMutated = false;
    const agent = {
      metaRefreshTimestamps: new Map<string, number>(),
      peerId: 'local-peer',
      node: {
        libp2p: {
          getConnections: () => [{ remotePeer: { toString: () => CURATOR_PEER_ID } }],
        },
      },
      discovery: {},
      fetchSyncPages: async () => ({
        quads: snapshots.shift() ?? [],
        checkpointKey: 'empty-authoritative-snapshot',
        resumedFromOffset: 0,
        completed: true,
      }),
      store: {
        insert: async () => { targetMutated = true; },
        update: async () => { targetMutated = true; },
        dropGraph: async () => { targetMutated = true; },
      },
      syncCheckpoints: new Map<string, number>(),
      log: { warn: noop, info: noop },
    };

    const emptyRefreshed = await ContextGraphResolveMethods.prototype.refreshMetaFromCurator.call(
      agent as never,
      contextGraphId,
      { trustedCuratorPeerId: CURATOR_PEER_ID, force: true },
    );
    const malformedRefreshed = await ContextGraphResolveMethods.prototype.refreshMetaFromCurator.call(
      agent as never,
      contextGraphId,
      { trustedCuratorPeerId: CURATOR_PEER_ID, force: true },
    );

    expect(emptyRefreshed).toBe(false);
    expect(malformedRefreshed).toBe(false);
    expect(targetMutated).toBe(false);
  });

  it('does not replace the target when oversize filtering would make the snapshot partial', async () => {
    const contextGraphId = 'private/oversize-authoritative-snapshot';
    const metaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
    const snapshot: Quad[] = [
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: metaGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"private"', graph: metaGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: `did:dkg:agent:${CURATOR_PEER_ID}`, graph: metaGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: 'did:dkg:agent:0x0000000000000000000000000000000000000001', graph: metaGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.SCHEMA_DESCRIPTION, object: `"${'x'.repeat(60_001)}"`, graph: metaGraph },
    ];
    let targetUpdates = 0;
    let recordedDrops = 0;
    const agent = {
      metaRefreshTimestamps: new Map<string, number>(),
      peerId: 'local-peer',
      node: {
        libp2p: {
          getConnections: () => [{ remotePeer: { toString: () => CURATOR_PEER_ID } }],
        },
      },
      discovery: {},
      fetchSyncPages: async () => ({
        quads: snapshot,
        checkpointKey: 'oversize-authoritative-snapshot',
        resumedFromOffset: 0,
        completed: true,
      }),
      store: {
        insert: async () => undefined,
        update: async () => { targetUpdates += 1; },
        dropGraph: async () => undefined,
      },
      oversizeTombstoneLog: {
        record: (drops: unknown[]) => { recordedDrops += drops.length; },
      },
      invalidateListContextGraphsCache: noop,
      contextGraphMetaProjection: { markDirty: noop },
      syncCheckpoints: new Map<string, number>(),
      log: { warn: noop, info: noop },
    };

    const refreshed = await ContextGraphResolveMethods.prototype.refreshMetaFromCurator.call(
      agent as never,
      contextGraphId,
      { trustedCuratorPeerId: CURATOR_PEER_ID, force: true },
    );

    expect(refreshed).toBe(false);
    expect(recordedDrops).toBe(1);
    expect(targetUpdates).toBe(0);
  });

  it('atomically replaces stale curator ACL/delegation rows while retaining the local revocation tombstone', async () => {
    const contextGraphId = 'private/atomic-curator-projection';
    const metaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
    const staleCurator = 'did:dkg:agent:0x0000000000000000000000000000000000000001';
    const freshCurator = 'did:dkg:agent:0x0000000000000000000000000000000000000002';
    const staleAgent = '0x0000000000000000000000000000000000000011';
    const freshAgent = '0x0000000000000000000000000000000000000022';
    const revokedAgent = '0x0000000000000000000000000000000000000033';
    const staleDelegation = `did:dkg:agent-delegation:${contextGraphId}:${staleAgent}`;
    const freshDelegation = `did:dkg:agent-delegation:${contextGraphId}:${freshAgent}`;
    const store = new OxigraphStore();
    try {
      await store.insert([
        { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: staleCurator, graph: metaGraph },
        { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, object: `"${staleAgent}"`, graph: metaGraph },
        { subject: staleDelegation, predicate: DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER, object: '"stale-peer"', graph: metaGraph },
        { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_REVOKED_AGENT, object: `"${revokedAgent}"`, graph: metaGraph },
      ]);
      const freshSnapshot: Quad[] = [
        { subject: contextGraphUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: metaGraph },
        { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"private"', graph: metaGraph },
        { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: `did:dkg:agent:${CURATOR_PEER_ID}`, graph: metaGraph },
        { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: freshCurator, graph: metaGraph },
        { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, object: `"${freshAgent}"`, graph: metaGraph },
        { subject: freshDelegation, predicate: DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER, object: '"fresh-peer"', graph: metaGraph },
      ];
      let invalidations = 0;
      let projectionInvalidations = 0;
      const agent = {
        metaRefreshTimestamps: new Map<string, number>(),
        peerId: 'local-peer',
        node: {
          libp2p: {
            getConnections: () => [{ remotePeer: { toString: () => CURATOR_PEER_ID } }],
          },
        },
        discovery: {},
        fetchSyncPages: async () => ({
          quads: freshSnapshot,
          checkpointKey: 'atomic-replacement-checkpoint',
          resumedFromOffset: 0,
          completed: true,
        }),
        store,
        oversizeTombstoneLog: { record: noop },
        invalidateListContextGraphsCache: () => { invalidations += 1; },
        contextGraphMetaProjection: { markDirty: () => { projectionInvalidations += 1; } },
        syncCheckpoints: new Map<string, number>(),
        log: { warn: noop, info: noop },
      };

      const refreshed = await ContextGraphResolveMethods.prototype.refreshMetaFromCurator.call(
        agent as never,
        contextGraphId,
        { trustedCuratorPeerId: CURATOR_PEER_ID, force: true },
      );
      expect(refreshed).toBe(true);

      const result = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${metaGraph}> { ?s ?p ?o } }`);
      expect(result.type).toBe('bindings');
      if (result.type !== 'bindings') throw new Error('expected bindings');
      const rows = result.bindings;
      expect(rows).toContainEqual({
        s: contextGraphUri,
        p: DKG_ONTOLOGY.DKG_CURATOR,
        o: freshCurator,
      });
      expect(rows).toContainEqual({
        s: contextGraphUri,
        p: DKG_ONTOLOGY.DKG_REVOKED_AGENT,
        o: `"${revokedAgent}"`,
      });
      expect(rows.some((row) => row.o === staleCurator || row.o === `"${staleAgent}"`)).toBe(false);
      expect(rows.some((row) => row.s === staleDelegation)).toBe(false);
      expect(rows.some((row) => row.s === freshDelegation && row.o === '"fresh-peer"')).toBe(true);
      expect(invalidations).toBe(2);
      expect(projectionInvalidations).toBe(2);
    } finally {
      await store.close();
    }
  });

  it('invalidates auth projections when a replacement commits before its store wrapper throws', async () => {
    const contextGraphId = 'private/post-mutation-marker-failure';
    const metaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
    const snapshot: Quad[] = [
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: metaGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"private"', graph: metaGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: `did:dkg:agent:${CURATOR_PEER_ID}`, graph: metaGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: 'did:dkg:agent:0x0000000000000000000000000000000000000001', graph: metaGraph },
    ];
    let targetCommitted = false;
    let listInvalidations = 0;
    let projectionInvalidations = 0;
    let signalCleanupStarted!: () => void;
    let releaseCleanup!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => { signalCleanupStarted = resolve; });
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const agent = {
      metaRefreshTimestamps: new Map<string, number>(),
      peerId: 'local-peer',
      node: {
        libp2p: {
          getConnections: () => [{ remotePeer: { toString: () => CURATOR_PEER_ID } }],
        },
      },
      discovery: {},
      fetchSyncPages: async () => ({
        quads: snapshot,
        checkpointKey: 'post-mutation-marker-failure',
        resumedFromOffset: 0,
        completed: true,
      }),
      store: {
        insert: async () => undefined,
        update: async () => {
          // Model ChangelogStore.update: inner SPARQL committed, then the
          // post-mutation marker append failed and surfaced an exception.
          targetCommitted = true;
          throw new Error('post-mutation marker append failed');
        },
        dropGraph: async () => {
          signalCleanupStarted();
          await cleanupGate;
        },
      },
      oversizeTombstoneLog: { record: noop },
      invalidateListContextGraphsCache: () => { listInvalidations += 1; },
      contextGraphMetaProjection: { markDirty: () => { projectionInvalidations += 1; } },
      syncCheckpoints: new Map<string, number>(),
      log: { warn: noop, info: noop },
    };

    const refresh = ContextGraphResolveMethods.prototype.refreshMetaFromCurator.call(
      agent as never,
      contextGraphId,
      { trustedCuratorPeerId: CURATOR_PEER_ID, force: true },
    );

    await cleanupStarted;
    // The target already committed, but staging cleanup is deliberately
    // blocked. Both the pre- and post-attempt invalidations must be visible now,
    // not after cleanup eventually returns.
    expect(targetCommitted).toBe(true);
    expect(listInvalidations).toBe(2);
    expect(projectionInvalidations).toBe(2);
    releaseCleanup();
    const refreshed = await refresh;
    expect(refreshed).toBe(false);
  });

  it('queues one trailing generation for concurrent forced refresh followers', async () => {
    const contextGraphId = 'private/single-flight-meta-refresh';
    const metaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
    const snapshot: Quad[] = [
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: metaGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"private"', graph: metaGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: `did:dkg:agent:${CURATOR_PEER_ID}`, graph: metaGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: 'did:dkg:agent:0x0000000000000000000000000000000000000001', graph: metaGraph },
    ];
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    let fetches = 0;
    let replacements = 0;
    const agent = {
      metaRefreshTimestamps: new Map<string, number>(),
      peerId: 'local-peer',
      node: {
        libp2p: {
          getConnections: () => [{ remotePeer: { toString: () => CURATOR_PEER_ID } }],
        },
      },
      discovery: {},
      fetchSyncPages: async () => {
        fetches += 1;
        await fetchGate;
        return {
          quads: snapshot,
          checkpointKey: 'single-flight-checkpoint',
          resumedFromOffset: 0,
          completed: true,
        };
      },
      store: {
        insert: async () => undefined,
        update: async () => { replacements += 1; },
        dropGraph: async () => undefined,
      },
      oversizeTombstoneLog: { record: noop },
      invalidateListContextGraphsCache: noop,
      contextGraphMetaProjection: { markDirty: noop },
      syncCheckpoints: new Map<string, number>(),
      log: { warn: noop, info: noop },
    };

    const first = ContextGraphResolveMethods.prototype.refreshMetaFromCurator.call(
      agent as never,
      contextGraphId,
      { trustedCuratorPeerId: CURATOR_PEER_ID, force: true },
    );
    const second = ContextGraphResolveMethods.prototype.refreshMetaFromCurator.call(
      agent as never,
      contextGraphId,
      { trustedCuratorPeerId: CURATOR_PEER_ID, force: true },
    );
    const third = ContextGraphResolveMethods.prototype.refreshMetaFromCurator.call(
      agent as never,
      contextGraphId,
      { trustedCuratorPeerId: CURATOR_PEER_ID, force: true },
    );
    expect(fetches).toBe(1);
    releaseFetch();
    await expect(Promise.all([first, second, third])).resolves.toEqual([true, true, true]);
    expect(fetches).toBe(2);
    expect(replacements).toBe(2);
  });

  it('serializes different curator sources that replace the same metadata graph', async () => {
    const secondCuratorPeerId = '12D3KooWSecondCuratorSourceForOrdering';
    const contextGraphId = 'private/cross-source-meta-refresh';
    const metaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const fetchOrder: string[] = [];
    let activeFetches = 0;
    let peakFetches = 0;
    let replacements = 0;
    const agent = {
      metaRefreshTimestamps: new Map<string, number>(),
      peerId: 'local-peer',
      node: {
        libp2p: {
          getConnections: () => [CURATOR_PEER_ID, secondCuratorPeerId]
            .map((peerId) => ({ remotePeer: { toString: () => peerId } })),
        },
      },
      discovery: {},
      fetchSyncPages: async (...args: unknown[]) => {
        const source = args[1] as string;
        fetchOrder.push(source);
        activeFetches += 1;
        peakFetches = Math.max(peakFetches, activeFetches);
        if (source === CURATOR_PEER_ID) await firstGate;
        activeFetches -= 1;
        return {
          quads: [
            { subject: contextGraphUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: metaGraph },
            { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"private"', graph: metaGraph },
            { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: `did:dkg:agent:${source}`, graph: metaGraph },
            { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: 'did:dkg:agent:0x0000000000000000000000000000000000000001', graph: metaGraph },
          ],
          checkpointKey: `cross-source-${source}`,
          resumedFromOffset: 0,
          completed: true,
        };
      },
      store: {
        insert: async () => undefined,
        update: async () => { replacements += 1; },
        dropGraph: async () => undefined,
      },
      oversizeTombstoneLog: { record: noop },
      invalidateListContextGraphsCache: noop,
      contextGraphMetaProjection: { markDirty: noop },
      syncCheckpoints: new Map<string, number>(),
      log: { warn: noop, info: noop },
    };

    const first = ContextGraphResolveMethods.prototype.refreshMetaFromCurator.call(
      agent as never,
      contextGraphId,
      { trustedCuratorPeerId: CURATOR_PEER_ID, force: true },
    );
    // A different source must serialize even for a non-force auth refresh;
    // coalescing it onto source A would return the wrong authority snapshot.
    const second = ContextGraphResolveMethods.prototype.refreshMetaFromCurator.call(
      agent as never,
      contextGraphId,
      { trustedCuratorPeerId: secondCuratorPeerId },
    );
    expect(fetchOrder).toEqual([CURATOR_PEER_ID]);
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(fetchOrder).toEqual([CURATOR_PEER_ID, secondCuratorPeerId]);
    expect(peakFetches).toBe(1);
    expect(replacements).toBe(2);
  });

  it('forceFreshSession discards an unfinished offset-zero responder token', async () => {
    const checkpointStore = new MemorySyncCheckpointStore();
    const contextGraphId = 'private/fresh-responder-session';
    const observedFirstRound: Array<{ offset: number; sessionId?: string }> = [];
    let firstSendCount = 0;
    const common = {
      ctx: operationContext(),
      remotePeerId: CURATOR_PEER_ID,
      contextGraphId,
      includeSharedMemory: false,
      phase: 'meta' as const,
      graphUri: contextGraphMetaGraphUri(contextGraphId),
      deadline: Date.now() + 60_000,
      syncPageTimeoutMs: 5_000,
      syncRouterAttempts: 1,
      syncPageRetryAttempts: 1,
      syncPageSize: 1,
      syncDeniedResponse: '#DENIED',
      debugSyncProgress: false,
      protocolSync: '/dkg/10.0.2/sync',
      checkpointStore,
      parseAndFilter: async () => ({ quads: [], totalQuads: 1 }),
      logWarn: noop,
      logInfo: noop,
      logDebug: noop,
    };

    await expect(fetchSyncPages({
      ...common,
      buildSyncRequest: async (
        _contextGraphId,
        offset,
        _limit,
        _includeSharedMemory,
        _remotePeerId,
        _phase,
        _snapshotRef,
        _sinceBatchId,
        sessionId,
      ) => {
        observedFirstRound.push({ offset, sessionId });
        return new TextEncoder().encode('request');
      },
      send: async () => {
        firstSendCount += 1;
        if (firstSendCount === 1) return new TextEncoder().encode('one-row');
        throw new Error('connection dropped after page one');
      },
    })).rejects.toThrow('connection dropped after page one');

    let freshOffset = -1;
    let freshSessionId: string | undefined;
    const result = await fetchSyncPages({
      ...common,
      forceFreshSession: true,
      buildSyncRequest: async (
        _contextGraphId,
        offset,
        _limit,
        _includeSharedMemory,
        _remotePeerId,
        _phase,
        _snapshotRef,
        _sinceBatchId,
        sessionId,
      ) => {
        freshOffset = offset;
        freshSessionId = sessionId;
        return new TextEncoder().encode('request');
      },
      send: async () => new Uint8Array(),
    });

    expect(observedFirstRound[0]?.sessionId).toBeTruthy();
    expect(freshOffset).toBe(0);
    expect(freshSessionId).toBeTruthy();
    expect(freshSessionId).not.toBe(observedFirstRound[0]?.sessionId);
    expect(result.resumedFromOffset).toBe(0);
  });

  it('uses the join-approved peer only as a bootstrap fallback to authoritative curator metadata', async () => {
    const contextGraphId = 'private/curator-route-transition';
    const bootstrapPeer = 'peer-from-join-approval';
    const authoritativePeer = 'peer-from-authoritative-meta';
    const preferredSyncPeers = new Map([[contextGraphId, bootstrapPeer]]);
    const agent = {
      preferredSyncPeers,
      getCgMeta: async () => ({
        curator: 'did:dkg:agent:0x0000000000000000000000000000000000000abc',
        curators: [],
        creator: `did:dkg:agent:${authoritativePeer}`,
        creators: [],
      }),
      discovery: {
        findAgents: async () => {
          throw new Error('creator metadata should resolve the curator peer');
        },
      },
    };

    const resolved = await ContextGraphResolveMethods.prototype.resolveCuratorPeerId.call(
      agent as never,
      contextGraphId,
    );
    expect(resolved).toBe(authoritativePeer);
    expect(preferredSyncPeers.has(contextGraphId)).toBe(false);

    const lifecycleResolved = await LifecycleSyncMethods.prototype.resolvePreferredSyncPeerId.call({
      preferredSyncPeers: new Map([[contextGraphId, bootstrapPeer]]),
      resolveCuratorPeerId: async () => authoritativePeer,
    } as never, contextGraphId);
    expect(lifecycleResolved).toBe(authoritativePeer);
  });
});
