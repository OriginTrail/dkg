/**
 * A knowledge asset shared by its UAL into a named sub-graph of a public
 * context graph reaches a member that pulls the graph's shared memory, in
 * every pull lane, although the member never created the sub-graph (#3301).
 *
 * The author shares the way `POST /api/knowledge-assets` and then
 * `POST /api/knowledge-assets/{name}/swm/share-async` do: the share queue runs
 * `agent.assertion.promote` for the finalized assertion. The share's metadata
 * is a head that names the per-asset graph and an operation that commits the
 * asset's quad count and digest; the asset itself travels as the share's
 * snapshot. A member that follows the graph learns its sub-graphs from what
 * it is served, so it admits the sub-graph's metadata from the pull, parses
 * the head, fetches the snapshot and materializes the asset.
 *
 * Two lanes pull a public graph's shared memory: the one a change notice and
 * the periodic pull take (named sub-graphs only), and the one a member runs
 * against a peer that serves the graph complete (root and named sub-graphs).
 * The second admitted only sub-graphs registered locally, so such a member
 * discarded the share. The member here pulls from the author through the real
 * sync responder, the real public sync lane (`SwmTargetExecutorV1`) and the
 * real pull verifier (`processSharedMemoryBatch`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  DKG_ONTOLOGY,
  TypedEventBus,
  createOperationContext,
  contextGraphSharedMemoryMetaUri,
  contextGraphSharedMemoryUri,
  generateEd25519Keypair,
} from '@origintrail-official/dkg-core';
import { DKGPublisher, generateSubGraphRegistration } from '@origintrail-official/dkg-publisher';
import { DKGQueryEngine } from '@origintrail-official/dkg-query';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { finalizeRootlessAssertionForTest } from '../../publisher/test/_helpers/rootless-lifecycle.js';
import { DEFAULT_SWM_TTL_MS } from '../src/dkg-agent-constants.js';
import { parseAndFilterNQuads, processSharedMemoryBatch } from '../src/sync-verify-worker-impl.js';
import type { SyncPhase } from '../src/sync/auth/request-build.js';
import { createSwmRecoveryMutationRuntimeV1 } from '../src/sync/requester/swm-recovery-apply.js';
import {
  SwmTargetExecutorV1,
  type PublicSwmTargetV1,
  type SwmTargetExecutorPortsV1,
} from '../src/sync/requester/swm-target-executor.js';
import { MemoryWorkspaceSnapshotStore } from './_helpers/memory-workspace-snapshot-store.js';
import { createPromotionAgentForTest } from './_helpers/promotion-agent.js';
import { registerTestSyncHandler, type CapturedSyncHandler } from './_helpers/sync-responder.js';

const AUTHOR = `0x${'a1'.repeat(20)}`;
const AUTHOR_PEER = '12D3KooWAuthorSharesIntoReportsByUal';
const CG = `0x${'c3'.repeat(20)}/ka-share-pull`;
const SUB = 'reports';
const NAME = 'report-one';
const DKG = 'http://dkg.io/ontology/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEMA = 'http://schema.org/';
const REPORT = 'urn:report:one';
const TRIPLES = [
  { subject: REPORT, predicate: `${SCHEMA}name`, object: '"A report"' },
  { subject: REPORT, predicate: `${SCHEMA}about`, object: 'urn:package:one' },
  { subject: `${REPORT}/finding/1`, predicate: `${SCHEMA}description`, object: '"reads private keys"' },
];
const META_GRAPH = contextGraphSharedMemoryMetaUri(CG, SUB);
const CG_META = `did:dkg:context-graph:${CG}/_meta`;
const SUB_GRAPH_URI = `did:dkg:context-graph:${CG}/${SUB}`;

type Lane = Pick<PublicSwmTargetV1, 'includeRootScope' | 'mode'>;
const NAMED_SUB_GRAPH_LANE = (): Lane => ({ includeRootScope: false, mode: { kind: 'ordinary' } });
const COMPLETE_PROVIDER_LANE = (): Lane => ({
  includeRootScope: true,
  mode: {
    kind: 'selected-recovery',
    recoveryGuard: { signal: new AbortController().signal, assertCurrent: () => undefined },
    // Absent: the round fetches its metadata pages itself.
    metadataFetcher: undefined as never,
  },
});
const LANES: Record<string, () => Lane> = {
  // A change notice and the periodic pull, in the default catalog mode.
  'the named sub-graph lane': NAMED_SUB_GRAPH_LANE,
  // Against a peer whose policy names it a complete provider of the graph.
  'the complete provider lane': COMPLETE_PROVIDER_LANE,
};

const stores: OxigraphStore[] = [];
function newStore(): OxigraphStore {
  const store = new OxigraphStore();
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

/** The author's node: a sub-graph, a finalized knowledge asset in it, and its share. */
async function authorShare() {
  const store = newStore();
  const snapshots = new MemoryWorkspaceSnapshotStore();
  const { agent } = await createPromotionAgentForTest(store, { agentAddress: AUTHOR, peerId: AUTHOR_PEER });
  // A daemon's publisher keeps each share's public snapshot in a snapshot store.
  const publisher = new DKGPublisher({
    store,
    chain: new MockChainAdapter(),
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
    publicSnapshotStore: snapshots,
  });
  agent.publisher = publisher;
  // POST /api/sub-graph/create
  await new GraphManager(store).ensureSubGraph(CG, SUB);
  await store.insert(generateSubGraphRegistration({
    contextGraphId: CG, subGraphName: SUB, createdBy: AUTHOR_PEER, timestamp: new Date(0),
  }));
  // POST /api/knowledge-assets, the write, and the finalization
  await publisher.assertionCreate(CG, NAME, AUTHOR, SUB);
  await publisher.assertionWrite(CG, NAME, AUTHOR, TRIPLES, SUB);
  const finalized = await finalizeRootlessAssertionForTest({
    publisher, store, contextGraphId: CG, name: NAME, agentAddress: AUTHOR, subGraphName: SUB,
  });
  // POST /api/knowledge-assets/{name}/swm/share-async: the queue runs this promote
  const share = await agent.assertion.promote(CG, NAME, {
    subGraphName: SUB, accessPolicy: 'public', agentAddress: AUTHOR,
  });
  expect(share).toMatchObject({ sealed: true });
  const payload = await rows(store, finalized.sharedGraphUri);
  expect(payload).toHaveLength(TRIPLES.length);
  return { store, snapshots, finalized, payload, shareOperationId: share.shareOperationId as string };
}

type Author = Awaited<ReturnType<typeof authorShare>>;

/** The author's sync responder; `holdsSnapshot: false` serves no snapshot. */
function responderOf(author: Author, holdsSnapshot = true): CapturedSyncHandler {
  return registerTestSyncHandler(author.store, {
    sharedMemoryTtlMs: DEFAULT_SWM_TTL_MS,
    ...(holdsSnapshot ? { publicSnapshotStore: author.snapshots } : {}),
  });
}

/** A member node that pulls from `responder`; `served` may change what a data page carries. */
function memberOf(responder: CapturedSyncHandler, options: {
  served?: (phase: SyncPhase, quads: Quad[]) => Quad[];
  registeredSubGraphs?: readonly string[];
} = {}) {
  const store = newStore();
  const ports: SwmTargetExecutorPortsV1 = {
    store,
    writeLocks: new Map(),
    // The member never created the sub-graph, unless a test says it did.
    listSubGraphs: async () => (options.registeredSubGraphs ?? []).map((name) => ({ name })),
    createContextGraphSyncDeadline: () => Number.MAX_SAFE_INTEGER,
    fetchSyncPages: async (_ctx, _peer, contextGraphId, includeSharedMemory, phase, graphUri, _deadline, fetch) => {
      const text = await responder.invoke({
        contextGraphId,
        offset: 0,
        limit: 5_000,
        includeSharedMemory,
        phase,
        ...(fetch?.snapshotRef === undefined ? {} : { snapshotRef: fetch.snapshotRef }),
      });
      const parsed = parseAndFilterNQuads(text, graphUri, contextGraphId).quads;
      const quads = options.served ? options.served(phase, parsed) : parsed;
      return {
        quads,
        bytesReceived: text.length,
        resumedFromOffset: 0,
        nextOffset: quads.length,
        checkpointKey: `${phase}:${fetch?.snapshotRef ?? ''}`,
        completed: true,
        timedOut: false,
      };
    },
    processSharedMemoryBatch: async (...args) => processSharedMemoryBatch(...args),
    publicSnapshotStore: new MemoryWorkspaceSnapshotStore(),
    recordDrops: () => undefined,
    invalidateListContextGraphsCache: () => undefined,
    recoveryMutation: createSwmRecoveryMutationRuntimeV1({
      store,
      recordDrops: () => undefined,
      invalidateListContextGraphsCache: () => undefined,
    }),
    setCheckpoint: () => undefined,
    deleteCheckpoint: () => undefined,
    deletePublicCheckpoint: () => undefined,
    ensureOwnedMap: () => new Map(),
    retireFinalizedSwmTwin: async () => undefined,
    logInfo: () => undefined,
    logWarn: () => undefined,
    logDebug: () => undefined,
  };
  const pull = (lane: Lane) => new SwmTargetExecutorV1(ports).syncPublicTarget({
    ctx: createOperationContext('sync'),
    remotePeerId: AUTHOR_PEER,
    contextGraphId: CG,
    remainingContextGraphs: 1,
    ...lane,
  } as PublicSwmTargetV1);
  return { store, pull };
}

async function rows(store: OxigraphStore, graph: string): Promise<string[]> {
  const result = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  const bindings = result.type === 'bindings' ? result.bindings : [];
  return bindings.map((row) => `${row['s']} ${row['p']} ${row['o']}`).sort();
}

async function headOperationIds(store: OxigraphStore, kaUal: string): Promise<string[]> {
  const result = await store.query(
    `SELECT ?id WHERE { GRAPH <${META_GRAPH}> { <${kaUal}#dkg-swm-head> <${DKG}shareOperationId> ?id } }`,
  );
  const bindings = result.type === 'bindings' ? result.bindings : [];
  return bindings.map((row) => String(row['id']).replace(/^"|"(\^\^<[^>]+>)?$/g, ''));
}

async function subGraphRegistered(store: OxigraphStore): Promise<boolean> {
  const result = await store.query(`ASK { GRAPH <${CG_META}> { <${SUB_GRAPH_URI}> <${RDF_TYPE}> <${DKG}SubGraph> } }`);
  return result.type === 'boolean' && result.value;
}

/** The graphs a read over all of the graph's partitions finds the report in. */
async function partitionsHolding(store: OxigraphStore): Promise<string[]> {
  const result = await new DKGQueryEngine(store).query(
    `SELECT DISTINCT ?g WHERE { GRAPH ?g { <${REPORT}> ?p ?o } }`,
    { contextGraphId: CG, includeContextGraphPartitions: true },
  );
  return result.bindings.map((row) => String(row['g'])).sort();
}

describe('a knowledge asset shared by UAL into a named sub-graph, pulled by a member', () => {
  it.each(Object.entries(LANES))('reaches a member that never created the sub-graph, in %s', async (_lane, lane) => {
    const author = await authorShare();
    const member = memberOf(responderOf(author));

    const summary = await member.pull(lane());

    expect(summary.failedPhases).toBe(0);
    expect(await rows(member.store, author.finalized.sharedGraphUri)).toEqual(author.payload);
    expect(await headOperationIds(member.store, author.finalized.kaUal)).toEqual([author.shareOperationId]);
    expect(await subGraphRegistered(member.store)).toBe(true);
    expect(await partitionsHolding(member.store)).toEqual([author.finalized.sharedGraphUri]);
  });

  it('stores only what the share commits, whatever else the data pages carry', async () => {
    const author = await authorShare();
    const forged: Quad = {
      subject: REPORT, predicate: `${SCHEMA}name`, object: '"A forged name"', graph: author.finalized.sharedGraphUri,
    };
    const unnamedGraph = `${contextGraphSharedMemoryUri(CG, SUB)}/0x${'de'.repeat(20)}/9`;
    const unnamed: Quad = { subject: 'urn:report:unnamed', predicate: `${SCHEMA}name`, object: '"no share"', graph: unnamedGraph };
    const served = (phase: SyncPhase, quads: Quad[]) => (phase === 'data' ? [...quads, forged, unnamed] : quads);

    // The asset comes from its snapshot, which matches the share's commitment.
    const member = memberOf(responderOf(author), { served });
    await member.pull(COMPLETE_PROVIDER_LANE());
    expect(await rows(member.store, author.finalized.sharedGraphUri)).toEqual(author.payload);
    expect(await rows(member.store, unnamedGraph)).toEqual([]);

    // Without the snapshot nothing proves the rows on the wire, so none is stored.
    const withoutSnapshot = memberOf(responderOf(author, false), { served });
    await withoutSnapshot.pull(COMPLETE_PROVIDER_LANE());
    expect(await rows(withoutSnapshot.store, author.finalized.sharedGraphUri)).toEqual([]);
    expect(await rows(withoutSnapshot.store, unnamedGraph)).toEqual([]);
    expect(await headOperationIds(withoutSnapshot.store, author.finalized.kaUal)).toEqual([]);
  });

  it.each(Object.entries(LANES).flatMap(([laneName, lane]) => [
    [laneName, 'not registered', lane, []],
    [laneName, 'registered', lane, [SUB]],
  ] as const))(
    'never writes the shared memory of a context graph of its own named like the sub-graph, in %s (%s)',
    async (_laneName, _label, lane, registeredSubGraphs) => {
      const author = await authorShare();
      const member = memberOf(responderOf(author), { registeredSubGraphs });
      // `<graph>/reports` is a context graph of its own on the member.
      await member.store.insert([{
        subject: SUB_GRAPH_URI,
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
        graph: `${SUB_GRAPH_URI}/_meta`,
      }]);

      await member.pull(lane());

      expect(await rows(member.store, author.finalized.sharedGraphUri)).toEqual([]);
      expect(await rows(member.store, META_GRAPH)).toEqual([]);
      expect(await subGraphRegistered(member.store)).toBe(false);
    },
  );
});
