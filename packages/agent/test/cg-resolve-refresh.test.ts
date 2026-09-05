import { describe, expect, it } from 'vitest';
import { DKG_ONTOLOGY, contextGraphDataGraphUri, contextGraphMetaGraphUri, type OperationContext } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { ContextGraphResolveMethods } from '../src/dkg-agent-cg-resolve.js';
import { WorkspaceCryptoMethods } from '../src/dkg-agent-crypto.js';
import { SYNC_TOTAL_TIMEOUT_MS } from '../src/dkg-agent-constants.js';
import { ContextGraphMetaProjection } from '../src/context-graph-meta-projection.js';
import {
  buildAuthoritativePrivateMetaAskQuery,
  hasAuthoritativePrivateMetaDefinition,
} from '../src/context-graph-private-meta-proof.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import {
  fetchSyncPages,
  type SyncPageFetchOptions,
} from '../src/sync/requester/page-fetch.js';
import { getSyncCheckpointKey, MemorySyncCheckpointStore } from '../src/sync/checkpoint/state.js';

const CURATOR_PEER_ID = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const RELAY_ADDR = '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';

function noop(): void {}

function operationContext(): OperationContext {
  return { kind: 'sync', id: 'cg-refresh-test', startedAt: Date.now() } as never;
}

async function runDirectlyWithBackpressure<T>(
  _ctx: OperationContext,
  _contextGraphId: string,
  _lane: 'durable',
  _label: string,
  work: () => Promise<T>,
): Promise<T> {
  return work();
}

function authoritativePrivateMetaQuads(contextGraphId: string): Quad[] {
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
  return [
    {
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.RDF_TYPE,
      object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
      graph: metaGraph,
    },
    {
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
      object: '"PRIVATE"',
      graph: metaGraph,
    },
    {
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_CREATOR,
      object: `did:dkg:agent:${CURATOR_PEER_ID}`,
      graph: metaGraph,
    },
    {
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_CURATOR,
      object: 'did:dkg:agent:0x0000000000000000000000000000000000000001',
      graph: metaGraph,
    },
  ];
}

function activeMemberMetaQuads(
  contextGraphId: string,
  approvedAgentAddress: string,
  peerId: string,
  opKey: string,
  nowMs: number,
): Quad[] {
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
  const normalizedAgent = approvedAgentAddress.toLowerCase();
  const delegation = `did:dkg:agent-delegation:${contextGraphId}:${normalizedAgent}`;
  return [
    {
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
      object: `"${normalizedAgent}"`,
      graph: metaGraph,
    },
    {
      subject: delegation,
      predicate: DKG_ONTOLOGY.DKG_DELEGATION_AGENT,
      object: `"${normalizedAgent}"`,
      graph: metaGraph,
    },
    {
      subject: delegation,
      predicate: DKG_ONTOLOGY.DKG_DELEGATION_ISSUED_AT,
      object: `"${nowMs - 1_000}"`,
      graph: metaGraph,
    },
    {
      subject: delegation,
      predicate: DKG_ONTOLOGY.DKG_DELEGATION_EXPIRES_AT,
      object: `"${nowMs + 60_000}"`,
      graph: metaGraph,
    },
    {
      subject: delegation,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER,
      object: `"${peerId}"`,
      graph: metaGraph,
    },
    {
      subject: delegation,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_KEY,
      object: `"${opKey.toLowerCase()}"`,
      graph: metaGraph,
    },
  ];
}

describe('authoritative private metadata proof', () => {
  it('keeps fetched-quad evaluation and the generated store query in lockstep', async () => {
    const cases = [
      {
        name: 'complete private definition',
        mutate: (quads: Quad[]) => quads,
        expected: true,
      },
      {
        name: 'normalized private policy whitespace',
        mutate: (quads: Quad[]) => quads.map((quad) => (
          quad.predicate === DKG_ONTOLOGY.DKG_ACCESS_POLICY
            ? { ...quad, object: '"  PrIvAtE  "' }
            : quad
        )),
        expected: true,
      },
      {
        name: 'missing curator',
        mutate: (quads: Quad[]) => quads.filter(
          (quad) => quad.predicate !== DKG_ONTOLOGY.DKG_CURATOR,
        ),
        expected: false,
      },
      {
        name: 'public policy',
        mutate: (quads: Quad[]) => quads.map((quad) => (
          quad.predicate === DKG_ONTOLOGY.DKG_ACCESS_POLICY
            ? { ...quad, object: '"public"' }
            : quad
        )),
        expected: false,
      },
      {
        name: 'literal creator DID',
        mutate: (quads: Quad[]) => quads.map((quad) => (
          quad.predicate === DKG_ONTOLOGY.DKG_CREATOR
            ? { ...quad, object: `"did:dkg:agent:${CURATOR_PEER_ID}"` }
            : quad
        )),
        expected: false,
      },
    ];

    for (const [index, proofCase] of cases.entries()) {
      const contextGraphId = `private/proof-parity-${index}`;
      const quads = proofCase.mutate(authoritativePrivateMetaQuads(contextGraphId));
      const store = new OxigraphStore();
      try {
        await store.insert(quads);
        const queryResult = await store.query(
          buildAuthoritativePrivateMetaAskQuery(contextGraphId),
        );
        expect(queryResult.type, proofCase.name).toBe('boolean');
        if (queryResult.type !== 'boolean') throw new Error('expected boolean ASK result');
        expect(
          hasAuthoritativePrivateMetaDefinition(contextGraphId, quads),
          proofCase.name,
        ).toBe(proofCase.expected);
        expect(queryResult.value, proofCase.name).toBe(proofCase.expected);
      } finally {
        await store.close();
      }
    }
  });

  it('requires a current approved member delegation matching this peer or operational key', async () => {
    const approvedAgentAddress = '0x00000000000000000000000000000000000000A1';
    const expectedPeerId = '12D3KooWCurrentApprovedMemberPeer';
    const expectedOpKey = '0x00000000000000000000000000000000000000B2';
    const nowMs = 1_784_000_000_000;
    const cases = [
      {
        name: 'active peer and key binding',
        mutate: (quads: Quad[]) => quads,
        expected: true,
      },
      {
        name: 'peer binding alone is sufficient',
        mutate: (quads: Quad[]) => quads.filter(
          (quad) => quad.predicate !== DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_KEY,
        ),
        expected: true,
      },
      {
        name: 'operational-key binding alone is sufficient',
        mutate: (quads: Quad[]) => quads.filter(
          (quad) => quad.predicate !== DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER,
        ),
        expected: true,
      },
      {
        name: 'agent is not approved',
        mutate: (quads: Quad[]) => quads.filter(
          (quad) => quad.predicate !== DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
        ),
        expected: false,
      },
      {
        name: 'agent is revoked',
        mutate: (quads: Quad[]) => [...quads, {
          subject: contextGraphDataGraphUri('private/member-proof-4'),
          predicate: DKG_ONTOLOGY.DKG_REVOKED_AGENT,
          object: `"${approvedAgentAddress.toLowerCase()}"`,
          graph: contextGraphMetaGraphUri('private/member-proof-4'),
        }],
        expected: false,
      },
      {
        name: 'delegation is expired',
        mutate: (quads: Quad[]) => quads.map((quad) => (
          quad.predicate === DKG_ONTOLOGY.DKG_DELEGATION_EXPIRES_AT
            ? { ...quad, object: `"${nowMs}"` }
            : quad
        )),
        expected: false,
      },
      {
        name: 'delegation is not active yet',
        mutate: (quads: Quad[]) => quads.map((quad) => (
          quad.predicate === DKG_ONTOLOGY.DKG_DELEGATION_ISSUED_AT
            ? { ...quad, object: `"${nowMs + 1}"` }
            : quad
        )),
        expected: false,
      },
      {
        name: 'delegation belongs to another agent',
        mutate: (quads: Quad[]) => quads.map((quad) => (
          quad.predicate === DKG_ONTOLOGY.DKG_DELEGATION_AGENT
            ? { ...quad, object: '"0x00000000000000000000000000000000000000ff"' }
            : quad
        )),
        expected: false,
      },
      {
        name: 'delegation matches neither local credential',
        mutate: (quads: Quad[]) => quads.map((quad) => {
          if (quad.predicate === DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER) {
            return { ...quad, object: '"12D3KooWAnotherPeer"' };
          }
          if (quad.predicate === DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_KEY) {
            return {
              ...quad,
              object: '"0x00000000000000000000000000000000000000ff"',
            };
          }
          return quad;
        }),
        expected: false,
      },
    ];

    for (const [index, proofCase] of cases.entries()) {
      const contextGraphId = `private/member-proof-${index}`;
      const quads = proofCase.mutate([
        ...authoritativePrivateMetaQuads(contextGraphId),
        ...activeMemberMetaQuads(
          contextGraphId,
          approvedAgentAddress,
          expectedPeerId,
          expectedOpKey,
          nowMs,
        ),
      ]);
      const memberProof = {
        approvedAgentAddress,
        expectedDelegateePeerId: expectedPeerId,
        expectedDelegateeOpKey: expectedOpKey,
        nowMs,
      };
      const store = new OxigraphStore();
      try {
        await store.insert(quads);
        const result = await store.query(
          buildAuthoritativePrivateMetaAskQuery(contextGraphId, memberProof),
        );
        expect(result.type, proofCase.name).toBe('boolean');
        if (result.type !== 'boolean') throw new Error('expected boolean ASK result');
        expect(
          hasAuthoritativePrivateMetaDefinition(contextGraphId, quads, memberProof),
          proofCase.name,
        ).toBe(proofCase.expected);
        expect(result.value, proofCase.name).toBe(proofCase.expected);
      } finally {
        await store.close();
      }
    }
  });
});

describe('refreshMetaFromCurator', () => {
  it('passes caller abort signal to direct and relay curator dials', async () => {
    const controller = new AbortController();
    const dialSignals: Array<AbortSignal | undefined> = [];

    const agent = {
      metaRefreshTimestamps: new Map<string, number>(),
      runContextGraphSyncWithBackpressure: runDirectlyWithBackpressure,
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

  it('accepts an authoritative public snapshot without a private member proof', async () => {
    const contextGraphId = 'public/authoritative-curator-snapshot';
    const metaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
    const snapshot: Quad[] = [{
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.RDF_TYPE,
      object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
      graph: metaGraph,
    }, {
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
      object: '"public"',
      graph: metaGraph,
    }];
    let staged: Quad[] = [];
    const agent = {
      metaRefreshTimestamps: new Map<string, number>(),
      runContextGraphSyncWithBackpressure: runDirectlyWithBackpressure,
      peerId: 'local-peer',
      node: {
        libp2p: {
          getConnections: () => [{ remotePeer: { toString: () => CURATOR_PEER_ID } }],
        },
      },
      discovery: {},
      fetchSyncPages: async () => ({
        quads: snapshot,
        checkpointKey: 'public-authoritative-snapshot',
        resumedFromOffset: 0,
        completed: true,
      }),
      store: {
        insert: async (quads: Quad[]) => { staged = quads; },
        update: async () => undefined,
        dropGraph: async () => undefined,
      },
      oversizeTombstoneLog: { record: noop },
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

    expect(refreshed).toBe(true);
    expect(staged).toHaveLength(2);
  });

  it('rejects a public-only snapshot when private member proof was required', async () => {
    const contextGraphId = 'private/member-proof-cannot-use-public-snapshot';
    const metaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
    const snapshot: Quad[] = [{
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.RDF_TYPE,
      object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
      graph: metaGraph,
    }, {
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
      object: '"public"',
      graph: metaGraph,
    }];
    let targetMutated = false;
    const agent = {
      metaRefreshTimestamps: new Map<string, number>(),
      runContextGraphSyncWithBackpressure: runDirectlyWithBackpressure,
      peerId: 'local-peer',
      node: {
        libp2p: {
          getConnections: () => [{ remotePeer: { toString: () => CURATOR_PEER_ID } }],
        },
      },
      discovery: {},
      fetchSyncPages: async () => ({
        quads: snapshot,
        checkpointKey: 'member-proof-public-snapshot',
        resumedFromOffset: 0,
        completed: true,
      }),
      store: {
        insert: async () => { targetMutated = true; },
        update: async () => { targetMutated = true; },
        dropGraph: async () => { targetMutated = true; },
      },
      oversizeTombstoneLog: { record: noop },
      invalidateListContextGraphsCache: noop,
      contextGraphMetaProjection: { markDirty: noop },
      syncCheckpoints: new Map<string, number>(),
      log: { warn: noop, info: noop },
    };

    const refreshed = await ContextGraphResolveMethods.prototype.refreshMetaFromCurator.call(
      agent as never,
      contextGraphId,
      {
        trustedCuratorPeerId: CURATOR_PEER_ID,
        force: true,
        memberProof: {
          approvedAgentAddress: '0x00000000000000000000000000000000000000A1',
          expectedDelegateePeerId: 'local-peer',
        },
      },
    );

    expect(refreshed).toBe(false);
    expect(targetMutated).toBe(false);
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
    let fetchDeadline: number | undefined;
    let forceFreshSession: boolean | undefined;
    let staged: Quad[] = [];
    let replacementUpdate = '';
    const agent = {
      // A recent auth-driven refresh would suppress a normal call.
      metaRefreshTimestamps: new Map([[contextGraphId, Date.now()]]),
      runContextGraphSyncWithBackpressure: runDirectlyWithBackpressure,
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
        fetchDeadline = args[6] as number;
        forceFreshSession = (args[7] as SyncPageFetchOptions | undefined)?.forceFreshSession;
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

    const refreshStartedAt = Date.now();
    const refreshed = await ContextGraphResolveMethods.prototype.refreshMetaFromCurator.call(
      agent as never,
      contextGraphId,
      { trustedCuratorPeerId: CURATOR_PEER_ID, force: true },
    );

    expect(refreshed).toBe(true);
    expect(resolved).toBe(false);
    expect(fetchPeer).toBe(CURATOR_PEER_ID);
    expect(fetchDeadline).toBeGreaterThanOrEqual(
      refreshStartedAt + SYNC_TOTAL_TIMEOUT_MS - 100,
    );
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
      runContextGraphSyncWithBackpressure: runDirectlyWithBackpressure,
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
      runContextGraphSyncWithBackpressure: runDirectlyWithBackpressure,
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
      runContextGraphSyncWithBackpressure: runDirectlyWithBackpressure,
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
      runContextGraphSyncWithBackpressure: runDirectlyWithBackpressure,
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
    const pendingJoinRequest = `did:dkg:join-request:${contextGraphId}:${freshAgent}`;
    const localDraftLifecycle = `urn:dkg:lifecycle:draft:${contextGraphId}:42`;
    const freshOnChainId = '105';
    const freshOnChainHash = `0x${'A'.repeat(64)}`;
    const store = new OxigraphStore();
    try {
      const replacedSubjects: string[] = [];
      let wholeProjectionUpdates = 0;
      const replaceSubject = store.replaceSubject.bind(store);
      const update = store.update.bind(store);
      store.replaceSubject = async (graph, subject, quads, options) => {
        replacedSubjects.push(subject);
        return replaceSubject(graph, subject, quads, options);
      };
      store.update = async (sparql, options) => {
        wholeProjectionUpdates += 1;
        return update(sparql, options);
      };
      await store.insert([
        { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: staleCurator, graph: metaGraph },
        { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, object: `"${staleAgent}"`, graph: metaGraph },
        { subject: staleDelegation, predicate: DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER, object: '"stale-peer"', graph: metaGraph },
        { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_REVOKED_AGENT, object: `"${revokedAgent}"`, graph: metaGraph },
        { subject: pendingJoinRequest, predicate: 'https://dkg.network/ontology#requestStatus', object: '"pending"', graph: metaGraph },
        { subject: localDraftLifecycle, predicate: 'https://dkg.network/ontology#kaNumber', object: '"42"', graph: metaGraph },
      ]);
      const freshSnapshot: Quad[] = [
        { subject: contextGraphUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: metaGraph },
        { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"private"', graph: metaGraph },
        { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: `did:dkg:agent:${CURATOR_PEER_ID}`, graph: metaGraph },
        { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: freshCurator, graph: metaGraph },
        { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, object: `"${freshAgent}"`, graph: metaGraph },
        { subject: contextGraphUri, predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`, object: `"${freshOnChainId}"`, graph: metaGraph },
        { subject: contextGraphUri, predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainHash`, object: `"${freshOnChainHash}"`, graph: metaGraph },
        { subject: freshDelegation, predicate: DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER, object: '"fresh-peer"', graph: metaGraph },
      ];
      let invalidations = 0;
      let projectionInvalidations = 0;
      let persistedBindings = 0;
      const subscription: { onChainId?: string; onChainHash?: string } = {
        onChainId: '104',
      };
      const agent = {
        metaRefreshTimestamps: new Map<string, number>(),
        runContextGraphSyncWithBackpressure: runDirectlyWithBackpressure,
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
        subscribedContextGraphs: new Map([[contextGraphId, subscription]]),
        bindSubscriptionOnChainId: (
          _localCgId: string,
          sub: { onChainId?: string },
          onChainId: string,
        ) => { sub.onChainId = onChainId; },
        recordCgWireId: (
          _localCgId: string,
          onChainHash: string | null,
        ) => { subscription.onChainHash = onChainHash ?? undefined; },
        persistContextGraphSubscription: () => { persistedBindings += 1; },
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
      expect(rows).toContainEqual({
        s: pendingJoinRequest,
        p: 'https://dkg.network/ontology#requestStatus',
        o: '"pending"',
      });
      expect(rows).toContainEqual({
        s: localDraftLifecycle,
        p: 'https://dkg.network/ontology#kaNumber',
        o: '"42"',
      });
      expect(replacedSubjects).toEqual([
        freshDelegation,
        contextGraphUri,
        staleDelegation,
      ]);
      expect(wholeProjectionUpdates).toBe(0);
      expect(invalidations).toBe(2);
      expect(projectionInvalidations).toBe(2);
      expect(subscription).toEqual({
        onChainId: freshOnChainId,
        onChainHash: freshOnChainHash.toLowerCase(),
      });
      expect(persistedBindings).toBe(1);
    } finally {
      await store.close();
    }
  });

  it.each([
    {
      boundary: 'root activation',
      failedSubject: 'root',
      expectedAgent: 'stale',
      rejectedAgent: 'fresh',
    },
    {
      boundary: 'stale delegation retirement',
      failedSubject: 'stale',
      expectedAgent: 'fresh',
      rejectedAgent: 'stale',
    },
  ] as const)('keeps delegated authorization fail closed across $boundary failure', async ({
    failedSubject,
    expectedAgent,
    rejectedAgent,
  }) => {
    const contextGraphId = `private/partial-curator-replacement-${failedSubject}`;
    const metaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
    const staleAgent = '0x0000000000000000000000000000000000000011';
    const freshAgent = '0x0000000000000000000000000000000000000022';
    const staleDelegation = `did:dkg:agent-delegation:${contextGraphId}:${staleAgent}`;
    const stalePeer = '12D3KooWStaleDelegationPeer';
    const freshPeer = '12D3KooWFreshDelegationPeer';
    const nowMs = Date.now();
    const store = new OxigraphStore();
    try {
      await store.insert([
        ...authoritativePrivateMetaQuads(contextGraphId),
        ...activeMemberMetaQuads(
          contextGraphId,
          staleAgent,
          stalePeer,
          '0x00000000000000000000000000000000000000a1',
          nowMs,
        ),
      ]);
      const freshSnapshot: Quad[] = [
        ...authoritativePrivateMetaQuads(contextGraphId),
        ...activeMemberMetaQuads(
          contextGraphId,
          freshAgent,
          freshPeer,
          '0x00000000000000000000000000000000000000a2',
          nowMs,
        ),
      ];
      const projection = new ContextGraphMetaProjection(store);
      const readAllowedPeers = () => WorkspaceCryptoMethods.prototype
        .getContextGraphAllowedDelegateePeers.call({
          getCgMeta: (id: string, options?: { signal?: AbortSignal }) => projection.get(
            id,
            options?.signal === undefined ? {} : { signal: options.signal },
          ),
        } as never, contextGraphId);
      expect(await readAllowedPeers()).toEqual(new Map([[staleAgent, [stalePeer]]]));

      const originalReplaceSubject = store.replaceSubject.bind(store);
      store.replaceSubject = async (graph, subject, quads, options) => {
        if (
          (failedSubject === 'root' && subject === contextGraphUri)
          || (failedSubject === 'stale' && subject === staleDelegation)
        ) {
          throw new Error(`simulated ${failedSubject} replacement failure`);
        }
        return originalReplaceSubject(graph, subject, quads, options);
      };
      let listInvalidations = 0;
      const agent = {
        metaRefreshTimestamps: new Map<string, number>(),
        runContextGraphSyncWithBackpressure: runDirectlyWithBackpressure,
        peerId: 'local-peer',
        node: {
          libp2p: {
            getConnections: () => [{ remotePeer: { toString: () => CURATOR_PEER_ID } }],
          },
        },
        discovery: {},
        fetchSyncPages: async () => ({
          quads: freshSnapshot,
          checkpointKey: `partial-curator-replacement-${failedSubject}`,
          resumedFromOffset: 0,
          completed: true,
        }),
        store,
        oversizeTombstoneLog: { record: noop },
        invalidateListContextGraphsCache: () => { listInvalidations += 1; },
        contextGraphMetaProjection: projection,
        syncCheckpoints: new Map<string, number>(),
        log: { warn: noop, info: noop },
      };

      await expect(ContextGraphResolveMethods.prototype.refreshMetaFromCurator.call(
        agent as never,
        contextGraphId,
        { trustedCuratorPeerId: CURATOR_PEER_ID, force: true },
      )).resolves.toBe(false);

      const allowedPeers = await readAllowedPeers();
      const expectedAddress = expectedAgent === 'fresh' ? freshAgent : staleAgent;
      const expectedPeer = expectedAgent === 'fresh' ? freshPeer : stalePeer;
      const rejectedAddress = rejectedAgent === 'fresh' ? freshAgent : staleAgent;
      expect(allowedPeers).toEqual(new Map([[expectedAddress, [expectedPeer]]]));
      expect(allowedPeers.has(rejectedAddress)).toBe(false);
      expect(listInvalidations).toBe(2);
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
      runContextGraphSyncWithBackpressure: runDirectlyWithBackpressure,
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
      runContextGraphSyncWithBackpressure: runDirectlyWithBackpressure,
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
      runContextGraphSyncWithBackpressure: runDirectlyWithBackpressure,
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
    const declaredFacts = {
      // A complete canonical definition, in the shape the projection produces:
      // each declared fact appears as the scalar AND in its array.
      declared: true,
      accessPolicy: 'private',
      curator: 'did:dkg:agent:0x0000000000000000000000000000000000000abc',
      curators: ['did:dkg:agent:0x0000000000000000000000000000000000000abc'],
      creator: `did:dkg:agent:${authoritativePeer}`,
      creators: [`did:dkg:agent:${authoritativePeer}`],
    };
    const agent = {
      preferredSyncPeers,
      getCgMeta: async () => declaredFacts,
      // The Context Graph declares this curator→peer binding in its OWN `_meta`,
      // which is what makes it authoritative rather than merely rankable (#2006).
      getOwnCgMetaFacts: async () => declaredFacts,
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

    // The same resolution through the lifecycle entry points, against the real
    // metadata rather than a stubbed curator: the join-approved peer ranks only
    // until `_meta` names someone. The declared answer then wins the RANKING —
    // but it confers no authority, because `_meta` identifies the graph that
    // holds the rows, not the writer that supplied them.
    const lifecycleAgent = {
      ...agent,
      preferredSyncPeers: new Map([[contextGraphId, bootstrapPeer]]),
    };
    expect(await LifecycleSyncMethods.prototype.resolvePreferredSyncPeerId
      .call(lifecycleAgent as never, contextGraphId)).toBe(authoritativePeer);
    expect(await LifecycleSyncMethods.prototype.resolveAuthoritativeSyncPeerId
      .call(lifecycleAgent as never, contextGraphId)).toBeUndefined();
  });
});
