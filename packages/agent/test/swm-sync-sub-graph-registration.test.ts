/**
 * A share into a named sub-graph that a node receives only by shared-memory
 * sync registers the sub-graph there, as a share that arrives live does
 * (#1611, #3211 item 4).
 *
 * Members of a public context graph that is not registered on chain, and that
 * reach each other only through the graph's owner, never send each other a
 * share. The owner is sent a member's share, registers the sub-graph and
 * serves it; the other members sync it from the owner. Before this change a
 * member stored such a share and did not register its sub-graph, so the share
 * stayed out of every read over the graph's partitions, out of writes and
 * publishes into the sub-graph, and out of what the member serves.
 *
 * The scenario runs the real public sync lane (`SwmTargetExecutorV1`) over a
 * real store; the responder is a stand-in that serves one sub-graph share.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '@origintrail-official/dkg-query';
import {
  DKG_ONTOLOGY,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  contextGraphSharedMemoryMetaUri,
  contextGraphSharedMemoryUri,
  createGraphKnowledgeAssetScope,
  createOperationContext,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import {
  generateKnowledgeAssetShareMetadata,
  generateSubGraphRegistration,
  workspacePublicQuadsDigest,
  type WorkspacePublicSnapshotStore,
} from '@origintrail-official/dkg-publisher';
import {
  SwmTargetExecutorV1,
  type SwmTargetExecutorPortsV1,
} from '../src/sync/requester/swm-target-executor.js';
import { createSwmRecoveryMutationRuntimeV1 } from '../src/sync/requester/swm-recovery-apply.js';
import {
  SYNCED_SUB_GRAPH_CREATED_BY_FALLBACK,
  SyncedSubGraphRegistration,
  subGraphsOfStoredRows,
} from '../src/sync/requester/synced-sub-graph-registration.js';

const CG = '0x1111111111111111111111111111111111111111/member-sub-graph-shares';
const SUB = 'notes';
const AUTHOR = '0x2222222222222222222222222222222222222222';
const UAL = `did:dkg:hardhat:31337/${AUTHOR}/7`;
/** The member that shared: named by the share's operation rows. */
const PUBLISHER = '12D3KooWMemberOneSharedIntoNotes';
const OWNER = '12D3KooWOwnerServesTheSubGraph';
const DKG = 'http://dkg.io/ontology/';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const META = `did:dkg:context-graph:${CG}/_meta`;
const SUB_GRAPH_URI = `did:dkg:context-graph:${CG}/${SUB}`;

/** One graph-scoped KA share into `subGraph` (the root when null), as a responder serves it. */
function share(subGraph: string | null = SUB) {
  const subGraphName = subGraph ?? undefined;
  const scope = createGraphKnowledgeAssetScope(UAL, 1);
  const metaGraph = contextGraphSharedMemoryMetaUri(CG, subGraphName);
  const assertionGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.SharedWorkingMemory, scope, subGraphName);
  const operationId = 'member-one-share-op';
  const operationSubject = `urn:dkg:share:${CG}:${operationId}`;
  const headSubject = `${UAL}#dkg-swm-head`;
  const payload: Quad[] = [
    { subject: 'urn:member-one:note', predicate: 'http://schema.org/name', object: '"shared into notes"', graph: '' },
    { subject: 'urn:member-one:note', predicate: 'http://schema.org/text', object: '"by member one"', graph: '' },
  ];
  const digest = workspacePublicQuadsDigest(payload);
  const meta: Quad[] = [
    ...generateKnowledgeAssetShareMetadata({
      shareOperationId: operationId,
      contextGraphId: CG,
      kaUal: UAL,
      assertionVersion: 1,
      publicTripleCount: payload.length,
      privateTripleCount: 0,
      publisherPeerId: PUBLISHER,
      accessPolicy: 'public',
      timestamp: new Date(0),
      ...(subGraphName === undefined ? {} : { subGraphName }),
    }, metaGraph),
    { subject: operationSubject, predicate: `${DKG}publicQuadsDigest`, object: `"${digest}"`, graph: metaGraph },
    { subject: operationSubject, predicate: `${DKG}publicSnapshotRef`, object: `"${digest}"`, graph: metaGraph },
    { subject: headSubject, predicate: `${DKG}contentScopeVersion`, object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${XSD_INTEGER}>`, graph: metaGraph },
    { subject: headSubject, predicate: `${DKG}kaUal`, object: UAL, graph: metaGraph },
    { subject: headSubject, predicate: `${DKG}assertionVersion`, object: `"1"^^<${XSD_INTEGER}>`, graph: metaGraph },
    { subject: headSubject, predicate: `${DKG}assertionGraph`, object: assertionGraph, graph: metaGraph },
    { subject: headSubject, predicate: `${DKG}shareOperationId`, object: `"${operationId}"`, graph: metaGraph },
  ];
  return { payload, digest, meta, metaGraph, assertionGraph };
}

type Share = ReturnType<typeof share>;

function snapshotStoreFor(shared: Share): WorkspacePublicSnapshotStore {
  return {
    putSnapshot: async (input) => ({ ref: input.digest, byteLength: 0 }),
    getSnapshot: async (ref) => (ref === shared.digest ? shared.payload.map((quad) => ({ ...quad })) : null),
  };
}

interface Member {
  readonly executor: () => SwmTargetExecutorV1;
  readonly logInfo: ReturnType<typeof vi.fn>;
  readonly logWarn: ReturnType<typeof vi.fn>;
  readonly invalidateListContextGraphsCache: ReturnType<typeof vi.fn>;
}

/**
 * A member's public sync lane over `store`. Each `executor()` is one sync
 * session, as the agent creates one per sync run; all share the write locks.
 */
function member(
  store: OxigraphStore,
  shared: Share,
  listSubGraphs: SwmTargetExecutorPortsV1['listSubGraphs'] = async () => [],
): Member {
  const logInfo = vi.fn();
  const logWarn = vi.fn();
  const invalidateListContextGraphsCache = vi.fn();
  const writeLocks = new Map<string, Promise<void>>();
  const ports: SwmTargetExecutorPortsV1 = {
    store,
    writeLocks,
    listSubGraphs,
    createContextGraphSyncDeadline: () => Number.MAX_SAFE_INTEGER,
    fetchSyncPages: async (_ctx, _peerId, _contextGraphId, _includeSharedMemory, phase) => {
      const quads = phase === 'meta' ? shared.meta.map((quad) => ({ ...quad })) : [];
      return {
        quads,
        bytesReceived: 0,
        timedOut: false,
        resumedFromOffset: 0,
        nextOffset: quads.length,
        checkpointKey: `public:${phase}`,
        completed: true,
      };
    },
    processSharedMemoryBatch: async (dataQuads, metaQuads) => ({
      verifiedData: dataQuads,
      verifiedMeta: metaQuads,
      totalFetchedDataQuads: dataQuads.length,
      totalFetchedMetaQuads: metaQuads.length,
      droppedDataTriples: 0,
      emptyResponses: 0,
      entityCreators: [],
    }),
    publicSnapshotStore: snapshotStoreFor(shared),
    recordDrops: () => undefined,
    invalidateListContextGraphsCache,
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
    logInfo,
    logWarn,
    logDebug: () => undefined,
  };
  return { executor: () => new SwmTargetExecutorV1(ports), logInfo, logWarn, invalidateListContextGraphsCache };
}

/** One sync of the graph's shared memory from the owner, the root left to the catalog as on a catalog-owned graph. */
function syncFromOwner(executor: SwmTargetExecutorV1, includeRootScope = false) {
  return executor.syncPublicTarget({
    ctx: createOperationContext('sync'),
    remotePeerId: OWNER,
    contextGraphId: CG,
    remainingContextGraphs: 1,
    includeRootScope,
    mode: { kind: 'ordinary' },
  });
}

async function registrationRows(store: OxigraphStore, subGraphUri = SUB_GRAPH_URI): Promise<Array<[string, string]>> {
  const result = await store.query(`SELECT ?p ?o WHERE { GRAPH <${META}> { <${subGraphUri}> ?p ?o } }`);
  const rows = result.type === 'bindings' ? result.bindings : [];
  return rows.map((row) => [String(row['p']), String(row['o'])] as [string, string]).sort();
}

/** What a read over the graph's partitions (the node UI, the counts of `/api/query`) finds of the share. */
async function partitionsHolding(store: OxigraphStore, subject: string): Promise<string[]> {
  const result = await new DKGQueryEngine(store).query(
    `SELECT DISTINCT ?g WHERE { GRAPH ?g { <${subject}> ?p ?o } }`,
    { contextGraphId: CG, includeContextGraphPartitions: true },
  );
  return result.bindings.map((row) => String(row['g'])).sort();
}

const AUTO_REGISTERED = `Auto-registered sub-graph "${SUB}" in context graph "${CG}" from SWM sync`;

describe('a sub-graph share that a member receives only by sync (#1611)', () => {
  const stores: OxigraphStore[] = [];
  const newStore = () => {
    const store = new OxigraphStore();
    stores.push(store);
    return store;
  };

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });

  it('registers the sub-graph, and a read over the graph\'s partitions then finds the share', async () => {
    const store = newStore();
    const shared = share();
    const m = member(store, shared);

    const summary = await syncFromOwner(m.executor());

    expect(summary.failedPhases).toBe(0);
    expect(await store.countQuads(shared.assertionGraph)).toBe(shared.payload.length);
    expect(await registrationRows(store)).toEqual([
      [`${DKG}createdAt`, expect.stringMatching(/^"\d{4}-\d\d-\d\dT/)],
      [`${DKG}createdBy`, `did:dkg:agent:${PUBLISHER}`],
      [`${DKG}parentContextGraph`, `did:dkg:context-graph:${CG}`],
      ['http://schema.org/name', `"${SUB}"`],
      ['http://www.w3.org/1999/02/22-rdf-syntax-ns#type', `${DKG}SubGraph`],
    ]);
    expect(await partitionsHolding(store, 'urn:member-one:note')).toEqual([shared.assertionGraph]);
    expect(m.logInfo).toHaveBeenCalledWith(expect.anything(), AUTO_REGISTERED);
    expect(m.invalidateListContextGraphsCache).toHaveBeenCalled();
    expect(m.logWarn).not.toHaveBeenCalled();
  });

  it('registers it on a node that synced the share before this change and holds it unregistered', async () => {
    const store = newStore();
    const shared = share();
    // What an earlier round left: the share's graph and its verified metadata, no registration.
    await store.insert([
      ...shared.payload.map((quad) => ({ ...quad, graph: shared.assertionGraph })),
      ...shared.meta,
    ]);
    expect(await partitionsHolding(store, 'urn:member-one:note')).toEqual([]);

    await syncFromOwner(member(store, shared).executor());

    expect((await registrationRows(store)).map(([p]) => p)).toContain(`${DKG}createdBy`);
    expect(await partitionsHolding(store, 'urn:member-one:note')).toEqual([shared.assertionGraph]);
  });

  it('registers the sub-graph once across concurrent and repeated sync rounds', async () => {
    const store = newStore();
    const shared = share();
    const m = member(store, shared);

    await Promise.all([syncFromOwner(m.executor()), syncFromOwner(m.executor())]);
    await syncFromOwner(m.executor());

    const createdAt = (await registrationRows(store)).filter(([p]) => p === `${DKG}createdAt`);
    expect(createdAt).toHaveLength(1);
    expect(m.logInfo.mock.calls.filter(([, message]) => message === AUTO_REGISTERED)).toHaveLength(1);
  });

  it('leaves a sub-graph the node has registered as it is', async () => {
    const store = newStore();
    const shared = share();
    const own = generateSubGraphRegistration({
      contextGraphId: CG,
      subGraphName: SUB,
      createdBy: AUTHOR,
      timestamp: new Date(0),
    });
    await store.insert(own);
    const m = member(store, shared, async () => [{ name: SUB, uri: SUB_GRAPH_URI }]);

    await syncFromOwner(m.executor());

    expect(await store.countQuads(shared.assertionGraph)).toBe(shared.payload.length);
    expect((await registrationRows(store)).find(([p]) => p === `${DKG}createdBy`)?.[1])
      .toBe(`did:dkg:agent:${AUTHOR}`);
    expect((await registrationRows(store)).filter(([p]) => p === `${DKG}createdAt`)).toHaveLength(1);
    expect(m.logInfo).not.toHaveBeenCalledWith(expect.anything(), AUTO_REGISTERED);
  });

  it('never registers a sub-graph under the name of a context graph of its own', async () => {
    const store = newStore();
    const shared = share();
    // `<graph>/notes` is a context graph on this node, not a sub-graph of `<graph>`.
    await store.insert([{
      subject: SUB_GRAPH_URI,
      predicate: DKG_ONTOLOGY.RDF_TYPE,
      object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
      graph: `${SUB_GRAPH_URI}/_meta`,
    }]);
    const m = member(store, shared);

    await syncFromOwner(m.executor());

    expect(await registrationRows(store)).toEqual([]);
    expect(m.logInfo).not.toHaveBeenCalledWith(expect.anything(), AUTO_REGISTERED);
  });

  it('registers nothing for a share into the root', async () => {
    const store = newStore();
    const shared = share(null);

    await syncFromOwner(member(store, shared).executor(), true);

    expect(await store.countQuads(shared.assertionGraph)).toBe(shared.payload.length);
    const subGraphs = await store.query(`ASK { GRAPH <${META}> { ?s a <${DKG}SubGraph> } }`);
    expect(subGraphs.type === 'boolean' && subGraphs.value).toBe(false);
  });

  it('keeps the share when the registration fails, and registers the sub-graph on the next round', async () => {
    const store = newStore();
    const shared = share();
    const insert = store.insert.bind(store);
    let refuseRegistration = true;
    vi.spyOn(store, 'insert').mockImplementation(async (quads, ...rest) => {
      if (refuseRegistration && quads.some((quad) => quad.object === `${DKG}SubGraph`)) {
        throw new Error('store refused the write');
      }
      return insert(quads, ...rest);
    });
    const m = member(store, shared);

    const first = await syncFromOwner(m.executor());
    refuseRegistration = false;

    expect(first.failedPhases).toBe(0);
    expect(await store.countQuads(shared.assertionGraph)).toBe(shared.payload.length);
    expect(await registrationRows(store)).toEqual([]);
    expect(m.logWarn).toHaveBeenCalledWith(
      expect.anything(),
      `SWM sync stored shared memory of a sub-graph of "${CG}" it could not register: store refused the write`,
    );

    await syncFromOwner(m.executor());

    expect((await registrationRows(store)).map(([p]) => p)).toContain(`${DKG}createdBy`);
    expect(m.logInfo).toHaveBeenCalledWith(expect.anything(), AUTO_REGISTERED);
  });
});

describe('SyncedSubGraphRegistration', () => {
  const stores: OxigraphStore[] = [];
  const newStore = () => {
    const store = new OxigraphStore();
    stores.push(store);
    return store;
  };

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });

  const row = (graph: string, predicate = 'http://schema.org/name', object = '"x"'): Quad => (
    { subject: 'urn:row', predicate, object, graph }
  );
  const subGraphMeta = contextGraphSharedMemoryMetaUri(CG, SUB);
  const publisherRow = (object: string) => row(subGraphMeta, `${DKG}publisherPeerId`, object);

  it('reads the sub-graph of each shared-memory row, and the publishers its operation rows name', () => {
    const rows = [
      row(contextGraphSharedMemoryUri(CG, SUB)),
      row(`${contextGraphSharedMemoryUri(CG, 'drafts')}/${AUTHOR}/3`),
      publisherRow(`"${PUBLISHER}"`),
      publisherRow('"0xabc"'),
      // Not a plain identifier: never used for the registration's IRI.
      publisherRow('"peer with spaces"'),
      publisherRow(`"${PUBLISHER}"^^<http://www.w3.org/2001/XMLSchema#string>`),
      // The root's shared memory, other graphs of a sub-graph, another context graph.
      row(contextGraphSharedMemoryUri(CG)),
      row(contextGraphSharedMemoryMetaUri(CG)),
      row(`did:dkg:context-graph:${CG}/${SUB}`),
      row(`did:dkg:context-graph:${CG}/${SUB}/_meta`),
      row(contextGraphSharedMemoryUri('0x3333333333333333333333333333333333333333/other', SUB)),
    ];

    expect(subGraphsOfStoredRows(CG, rows)).toEqual(new Map([
      [SUB, new Set([PUBLISHER, '0xabc'])],
      ['drafts', new Set()],
    ]));
  });

  it('names the smallest publisher, or a fixed marker when the rows name none', async () => {
    const store = newStore();
    const registration = new SyncedSubGraphRegistration({
      store,
      writeLocks: new Map(),
      admittedNames: async () => [],
      isKnownChildContextGraph: async () => false,
    });

    expect(await registration.registerFor(CG, [
      publisherRow('"12D3KooWZed"'),
      publisherRow('"12D3KooWAda"'),
      row(contextGraphSharedMemoryUri(CG, 'drafts')),
    ])).toEqual([SUB, 'drafts']);

    expect((await registrationRows(store)).find(([p]) => p === `${DKG}createdBy`)?.[1])
      .toBe('did:dkg:agent:12D3KooWAda');
    expect((await registrationRows(store, `did:dkg:context-graph:${CG}/drafts`))
      .find(([p]) => p === `${DKG}createdBy`)?.[1])
      .toBe(`did:dkg:agent:${SYNCED_SUB_GRAPH_CREATED_BY_FALLBACK}`);
  });

  it('reads nothing for rows outside any sub-graph or of a name the node admitted, and settles a name once', async () => {
    const store = newStore();
    const query = vi.spyOn(store, 'query');
    const admittedNames = vi.fn(async () => [SUB]);
    const isKnownChildContextGraph = vi.fn(async () => false);
    const registration = new SyncedSubGraphRegistration({
      store,
      writeLocks: new Map(),
      admittedNames,
      isKnownChildContextGraph,
    });

    expect(await registration.registerFor(CG, [row(contextGraphSharedMemoryMetaUri(CG))])).toEqual([]);
    expect(admittedNames).not.toHaveBeenCalled();

    expect(await registration.registerFor(CG, [row(subGraphMeta)])).toEqual([]);
    expect(admittedNames).toHaveBeenCalledOnce();

    expect(await registration.registerFor(CG, [row(contextGraphSharedMemoryUri(CG, 'drafts'))])).toEqual(['drafts']);
    expect(await registration.registerFor(CG, [row(contextGraphSharedMemoryUri(CG, 'drafts'))])).toEqual([]);
    // One registration check for `drafts`, none for the admitted name.
    expect(query).toHaveBeenCalledOnce();
    expect(isKnownChildContextGraph).toHaveBeenCalledExactlyOnceWith(CG, 'drafts');
  });
});
