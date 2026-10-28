/**
 * One dkg:publishedAt per share operation, and a defective head set aside
 * instead of every descriptor of its graph.
 *
 * StorageACK copies of one share carry the same deterministic operation id on
 * every Core, and each Core stamps the copy with its own clock. Catch-up added
 * a peer's operation rows to the local store as a union, so a holder that
 * already stored the operation ended up with two stamps on it. The holder's
 * own head resolver reads that as the earliest stamp and never repaired it,
 * while every requester's recovery parser rejected it ("ambiguous
 * publishedAt") and with it every descriptor of the graph.
 *
 * The writer cases run through `SwmTargetExecutorV1`, which owns the write
 * policy of both catch-up lanes; the set-aside cases exercise the round itself.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOperationContext, workspaceKnowledgeAssetOperationSnapshotGraph, OversizedRdfLiteralError, type OperationContext } from '@origintrail-official/dkg-core';
import { resolveKnowledgeAssetWorkspaceHead } from '@origintrail-official/dkg-publisher';
import { GraphManager, OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { canonicalGraphScopedSnapshotManifestQuads, parseGraphScopedSwmRecoveryDescriptors } from '../src/sync/graph-scoped-swm-recovery.js';
import { parseGraphScopedSwmRecoveryHeadResults } from '../src/sync/graph-scoped-swm-recovery.js';
import { readSharedMemoryPhaseFailureAttribution } from '../src/sync/shared-memory-diagnostics.js';
import { insertKeepingOnePublishedAt, planOperationPublishedAt } from '../src/sync/swm-operation-published-at.js';
import { createSwmRecoveryMutationRuntimeV1 } from '../src/sync/requester/swm-recovery-apply.js';
import { SwmTargetExecutorV1 } from '../src/sync/requester/swm-target-executor.js';
import { MemoryWorkspaceSnapshotStore } from './_helpers/memory-workspace-snapshot-store.js';
import { makeSwmSyncHarness } from './_helpers/swm-sync-harness.js';
import { swmFixtures, type SwmShare } from './swm-descriptor-fixtures.js';

const CG = 'ws00-operation-published-at';
const WS_META = `did:dkg:context-graph:${CG}/_shared_memory_meta`;
const DKG = 'http://dkg.io/ontology/';
const PUBLISHED_AT = `${DKG}publishedAt`;
const XSD_DATE_TIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
const ADDRESS = '0xcccccccccccccccccccccccccccccccccccccccc';
const UAL = `did:dkg:hardhat:31337/${ADDRESS}/7`;
const ctx: OperationContext = { operationId: 'test', operationName: 'sync' } as never;

const fx = swmFixtures(CG);
const stamp = (iso: string): string => `"${iso}"^^<${XSD_DATE_TIME}>`;
const EARLY = '2026-10-26T08:00:00.000Z';
const PEER = '2026-10-26T09:00:00.000Z';
const LOCAL = '2026-10-26T10:00:00.000Z';
const LATER = '2026-10-26T11:00:00.000Z';
const LATEST = '2026-10-26T12:00:00.000Z';

/** `meta` with `operationSubject` stamped at each of `isos` instead. */
function stampedAt(meta: readonly Quad[], operationSubject: string, ...isos: string[]): Quad[] {
  return [
    ...meta.filter((quad) => !(quad.subject === operationSubject && quad.predicate === PUBLISHED_AT)),
    ...isos.map((iso) => ({ subject: operationSubject, predicate: PUBLISHED_AT, object: stamp(iso), graph: WS_META })),
  ];
}

function operationRows(share: SwmShare, meta: readonly Quad[] = share.meta): Quad[] {
  return meta.filter((quad) => quad.subject === share.operationSubject);
}

/** The instants stored as `subject`'s publishedAt (stores rewrite the lexical form). */
async function publishedAtOf(store: TripleStore, subject: string): Promise<string[]> {
  const result = await store.query(`SELECT ?o WHERE { GRAPH <${WS_META}> { <${subject}> <${PUBLISHED_AT}> ?o } }`);
  if (result.type !== 'bindings') throw new Error(`unexpected ${result.type}`);
  return result.bindings
    .map((row) => new Date(Date.parse(/^"([^"]*)"/.exec(String(row['o']))?.[1] ?? '')).toISOString())
    .sort();
}

async function rowsOf(store: TripleStore, graph: string, subject?: string): Promise<Quad[]> {
  const result = await store.query(subject === undefined
    ? `SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`
    : `SELECT ?p ?o WHERE { GRAPH <${graph}> { <${subject}> ?p ?o } }`);
  if (result.type !== 'bindings') throw new Error(`unexpected ${result.type}`);
  return result.bindings.map((row) => ({
    subject: subject ?? String(row['s']),
    predicate: String(row['p']),
    object: String(row['o']),
    graph,
  }));
}

async function seedMaterialized(store: TripleStore, share: SwmShare, meta: readonly Quad[]): Promise<void> {
  await store.insert(share.payload.map((quad) => ({ ...quad, graph: share.assertionGraph })));
  await store.insert([...meta]);
}

/** The production executor over `store`, serving `meta` and the snapshots of `shares`. */
async function executorServing(
  store: OxigraphStore,
  meta: readonly Quad[],
  shares: readonly SwmShare[],
): Promise<SwmTargetExecutorV1> {
  const publicSnapshotStore = new MemoryWorkspaceSnapshotStore();
  for (const share of shares) await publicSnapshotStore.putSnapshot({ digest: share.digest, quads: share.payload });
  return new SwmTargetExecutorV1({
    store,
    writeLocks: new Map(),
    listSubGraphs: async () => [],
    createContextGraphSyncDeadline: () => Number.MAX_SAFE_INTEGER,
    fetchSyncPages: async (_ctx, _peer, _contextGraphId, _includeSharedMemory, phase) => {
      const quads = phase === 'meta' ? meta.map((quad) => ({ ...quad })) : [];
      return {
        quads,
        bytesReceived: 0,
        timedOut: false,
        resumedFromOffset: 0,
        nextOffset: quads.length,
        checkpointKey: `served:${phase}`,
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
    publicSnapshotStore,
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
  });
}

async function catchUp(store: OxigraphStore, meta: readonly Quad[], shares: readonly SwmShare[]) {
  return (await executorServing(store, meta, shares)).syncPublicTarget({
    ctx: createOperationContext('sync'),
    remotePeerId: 'peer-source',
    contextGraphId: CG,
    remainingContextGraphs: 1,
    mode: { kind: 'ordinary' },
  });
}

const stores: OxigraphStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {}))); });
function newStore(): OxigraphStore {
  const store = new OxigraphStore();
  stores.push(store);
  return store;
}

// A StorageACK copy: the same operation id on every Core that signed it.
const ack = fx.share({ version: 1, operationId: 'storage-ack-7', marker: 'seven', ual: UAL });
// This Core's own operation for the same share, under the id it persisted.
const local = fx.share({ version: 1, operationId: 'op-local', marker: 'seven', ual: UAL });
/** A head naming the local operation and the newer StorageACK copy, stamped by a peer. */
const aliasMeta = (localStamp: string, ackStamp: string): Quad[] => [
  ...stampedAt(ack.meta, ack.operationSubject, ackStamp),
  ...operationRows(local, stampedAt(local.meta, local.operationSubject, localStamp)),
  { subject: local.headSubject, predicate: `${DKG}shareOperationId`, object: '"op-local"', graph: WS_META },
];

describe('catch-up keeps one publishedAt on a share operation', () => {
  it.each([
    { peer: PEER, kept: PEER },
    { peer: LATER, kept: LOCAL },
  ])('per-asset write: a peer copy stamped $peer leaves only $kept', async ({ peer, kept }) => {
    const store = newStore();
    await seedMaterialized(store, ack, stampedAt(ack.meta, ack.operationSubject, LOCAL));

    expect((await catchUp(store, stampedAt(ack.meta, ack.operationSubject, peer), [ack])).failedPhases).toBe(0);

    expect(await publishedAtOf(store, ack.operationSubject)).toEqual([kept]);
    // What the holder now serves is what every requester can parse.
    expect(parseGraphScopedSwmRecoveryDescriptors({
      contextGraphId: CG,
      metaQuads: await rowsOf(store, WS_META),
    })).toHaveLength(1);
    // The stored stamp is the one the head resolver already reported for the
    // union, so local readers see no change.
    const head = await resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager: new GraphManager(store),
      contextGraphId: CG,
      kaUal: UAL,
    });
    expect(head?.publishedAt).toBe(String(Date.parse(kept)));
  });

  it.each(['catch-up', 'private'] as const)('keeps a writable timestamp for a new operation during %s', async lane => {
    const store = newStore();
    const meta = [...stampedAt(ack.meta, ack.operationSubject, LOCAL),
      { subject: ack.operationSubject, predicate: PUBLISHED_AT, object: `"${' '.repeat(60_001)}${EARLY}"`, graph: WS_META }];
    if (lane === 'catch-up') expect((await catchUp(store, meta, [ack])).failedPhases).toBe(0);
    else {
      const executor = await executorServing(store, meta, [ack]);
      await expect(executor.recoverPrivateTarget({ remotePeerId: 'peer-source', contextGraphId: CG,
        recoveryGuard: { signal: new AbortController().signal, assertCurrent: () => undefined },
      })).resolves.toMatchObject({ completed: true });
    }
    expect(await publishedAtOf(store, ack.operationSubject)).toEqual([LOCAL]);
    expect(parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: await rowsOf(store, WS_META) })).toHaveLength(1);
  });

  it('heals an operation that already carries several stamps', async () => {
    const store = newStore();
    await seedMaterialized(store, ack, stampedAt(ack.meta, ack.operationSubject, LOCAL, LATER));

    await catchUp(store, stampedAt(ack.meta, ack.operationSubject, LATEST), [ack]);

    expect(await publishedAtOf(store, ack.operationSubject)).toEqual([LOCAL]);
  });

  it('bulk append: the peer copy of an alias operation the local head keeps', async () => {
    // The peer's head selects its newer StorageACK copy, the local identity is
    // preserved, and the peer's rows for the local operation reach the
    // round's bulk append.
    const store = newStore();
    await seedMaterialized(store, local, stampedAt(local.meta, local.operationSubject, LOCAL));

    await catchUp(store, aliasMeta(PEER, LATER), [ack]);

    expect(await publishedAtOf(store, local.operationSubject)).toEqual([PEER]);
    expect(parseGraphScopedSwmRecoveryDescriptors({
      contextGraphId: CG,
      metaQuads: await rowsOf(store, WS_META),
    })).toHaveLength(1);
  });

  it('private recovery: the source copy of a preserved operation', async () => {
    const store = newStore();
    await seedMaterialized(store, local, stampedAt(local.meta, local.operationSubject, LOCAL));
    const executor = await executorServing(store, aliasMeta(PEER, LATER), [ack]);

    await expect(executor.recoverPrivateTarget({
      remotePeerId: 'peer-source',
      contextGraphId: CG,
      recoveryGuard: { signal: new AbortController().signal, assertCurrent: () => undefined },
    })).resolves.toMatchObject({ completed: true });

    expect(await publishedAtOf(store, local.operationSubject)).toEqual([PEER]);
  });
});

describe('planOperationPublishedAt', () => {
  const subject = ack.operationSubject;
  const key = `${WS_META}\u0000${subject}`;
  const row = (object: string, graph = WS_META, rowSubject = subject): Quad => ({
    subject: rowSubject, predicate: PUBLISHED_AT, object, graph,
  });
  const typeRow: Quad = {
    subject, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${DKG}WorkspaceOperation`, graph: WS_META,
  };

  it('keeps the earliest stamp, stored or incoming', () => {
    expect(planOperationPublishedAt(
      [typeRow, row(stamp(LATER)), row(stamp(PEER))],
      new Map([[key, [stamp(LOCAL), stamp(LATEST)]]]),
    )).toEqual({
      rows: [typeRow, row(stamp(PEER))],
      retirements: [{ rows: [row(stamp(LOCAL)), row(stamp(LATEST))], winner: row(stamp(PEER)), requiredReplacement: row(stamp(PEER)) }],
    });
    expect(planOperationPublishedAt(
      [typeRow, row(stamp(LATER))],
      new Map([[key, [stamp(LOCAL), stamp(LATEST)]]]),
    )).toEqual({ rows: [typeRow], retirements: [{ rows: [row(stamp(LATEST))], winner: row(stamp(LOCAL)) }] });
  });

  it('keeps the stored stamp for the same instant in another lexical form', () => {
    expect(planOperationPublishedAt(
      [row(stamp(LOCAL))],
      new Map([[key, [stamp(LOCAL.replace('.000Z', 'Z'))]]]),
    )).toEqual({ rows: [], retirements: [] });
  });

  it('prefers a stamp the head resolver accepts over an earlier unusable one', () => {
    expect(planOperationPublishedAt([row(stamp(LOCAL))], new Map([[key, ['"not-a-date"']]])))
      .toEqual({ rows: [row(stamp(LOCAL))], retirements: [{ rows: [row('"not-a-date"')], winner: row(stamp(LOCAL)), requiredReplacement: row(stamp(LOCAL)) }] });
    expect(planOperationPublishedAt([row(stamp('1960-01-01T00:00:00.000Z'))], new Map([[key, [stamp(LOCAL)]]])))
      .toEqual({ rows: [], retirements: [] });
  });

  it('leaves stamps outside share operations in metadata graphs alone', () => {
    const slice = row(stamp(LATER), WS_META, `urn:dkg:public-stage:${CG}:_:op:urn%3Aroot`);
    const data = row(stamp(LATER), `did:dkg:context-graph:${CG}/_shared_memory`);
    expect(planOperationPublishedAt([slice, data], new Map([[key, [stamp(LOCAL)]]])))
      .toEqual({ rows: [slice, data], retirements: [] });
  });
});

describe('the recovery parser reads publishedAt as the head resolver does', () => {
  // The same share under two operation ids; the newest stamp is selected.
  const alias = fx.share({ version: 1, operationId: 'op-originator', marker: 'seven', ual: UAL });
  const meta = [
    ...stampedAt(ack.meta, ack.operationSubject, EARLY, LATEST),
    ...operationRows(alias, stampedAt(alias.meta, alias.operationSubject, LOCAL)),
    { subject: ack.headSubject, predicate: `${DKG}shareOperationId`, object: '"op-originator"', graph: WS_META },
  ];

  it('dates a twice-stamped operation by its earliest stamp', async () => {
    const [descriptor] = parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: meta });
    expect(descriptor?.shareOperationId).toBe('op-originator');
    const store = newStore();
    await store.insert(meta);
    const head = await resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager: new GraphManager(store),
      contextGraphId: CG,
      kaUal: UAL,
    });
    expect(head?.shareOperationId).toBe(descriptor?.shareOperationId);
  });

  it('still fails closed on an unparseable stamp', () => {
    expect(() => parseGraphScopedSwmRecoveryDescriptors({
      contextGraphId: CG,
      metaQuads: [...meta, { subject: ack.operationSubject, predicate: PUBLISHED_AT, object: '"not-a-date"', graph: WS_META }],
    })).toThrow(/invalid publishedAt/);
  });
});

describe('a defective head is set aside, not its whole graph', () => {
  const valid = fx.share({ version: 1, operationId: 'op-valid', marker: 'valid', ual: `did:dkg:hardhat:31337/${ADDRESS}/1` });
  /** A head whose operation names two publishers. */
  function defective(marker: string) {
    const share = fx.share({ version: 1, operationId: 'op-defective', marker, ual: `did:dkg:hardhat:31337/${ADDRESS}/2` });
    const meta = [
      ...share.meta,
      { subject: share.operationSubject, predicate: `${DKG}publisherPeerId`, object: '"peer-other"', graph: WS_META },
    ];
    return { share, meta };
  }

  it('the parser sets the head aside with its error; the strict parse still throws it', () => {
    const bad = defective('bad');
    const metaQuads = [...valid.meta, ...bad.meta];
    expect(() => parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads }))
      .toThrow('ambiguous publisherPeerId');
    const { descriptors, setAside } = parseGraphScopedSwmRecoveryHeadResults({ contextGraphId: CG, metaQuads });
    expect(descriptors.map((descriptor) => descriptor.kaUal)).toEqual([`did:dkg:hardhat:31337/${ADDRESS}/1`]);
    expect(setAside).toEqual([expect.objectContaining({
      metaGraph: WS_META,
      headSubject: bad.share.headSubject,
      operationSubjects: [bad.share.operationSubject],
      error: expect.objectContaining({ message: 'ambiguous publisherPeerId' }),
    })]);
  });

  it('a head naming no operation keeps cached refs unresolved through the round', async () => {
    const bad = defective('bad');
    const servedMeta = [...valid.meta, ...bad.meta.filter(quad => quad.predicate !== `${DKG}shareOperationId`)];
    const { setAside } = parseGraphScopedSwmRecoveryHeadResults({ contextGraphId: CG, metaQuads: servedMeta });
    expect(setAside).toEqual([expect.objectContaining({ headSubject: bad.share.headSubject, operationSubjects: [] })]);
    const store = newStore();
    const summary = await makeSwmSyncHarness({ ctx, contextGraphId: CG, store, servedMeta,
      cachedSnapshots: new Map([[valid.digest, valid.payload], [bad.share.digest, bad.share.payload]]),
    }).run();
    expect(await rowsOf(store, valid.assertionGraph)).toHaveLength(valid.payload.length);
    expect(await rowsOf(store, WS_META, valid.headSubject)).not.toEqual([]);
    expect(await rowsOf(store, WS_META, bad.share.headSubject)).toEqual([]);
    expect(await rowsOf(store, WS_META, bad.share.operationSubject)).toEqual([]);
    expect(summary.swmCoverage).toMatchObject({ snapshotsResolved: 0, descriptorsAuthoritative: false });
    expect(summary.failedPhases).toBeGreaterThan(0);
  });

  it.each([false, true])('holds defective graph-backed metadata when the canonical manifest is empty (healthy alias: %s)', async mixed => {
    const bad = defective('bad');
    const graphMeta = (share: SwmShare, meta: readonly Quad[]) => [
      ...meta.filter(row => row.predicate !== `${DKG}publicSnapshotRef`),
      { subject: share.operationSubject, predicate: `${DKG}publicSnapshotGraph`,
        object: workspaceKnowledgeAssetOperationSnapshotGraph(CG, share.operationId), graph: WS_META },
    ];
    const healthy = fx.share({ version: 1, operationId: 'op-a-graph', marker: 'valid',
      ual: `did:dkg:hardhat:31337/${ADDRESS}/1` });
    const healthyAlias = fx.share({ version: 1, operationId: 'op-z-store', marker: 'valid',
      ual: `did:dkg:hardhat:31337/${ADDRESS}/1` });
    const servedMeta = [...graphMeta(bad.share, bad.meta), ...(mixed
      ? [...graphMeta(healthy, stampedAt(healthy.meta, healthy.operationSubject, LATEST)),
        ...stampedAt(healthyAlias.meta, healthyAlias.operationSubject, EARLY)] : [])];
    const parsed = parseGraphScopedSwmRecoveryHeadResults({ contextGraphId: CG, metaQuads: servedMeta });
    expect(parsed.setAside).toHaveLength(1);
    expect(parsed.descriptors).toHaveLength(mixed ? 1 : 0);
    if (mixed) expect(parsed.descriptors[0].snapshotSource.locator.kind).toBe('graph');
    const store = newStore();
    const summary = await makeSwmSyncHarness({ ctx, contextGraphId: CG, store, servedMeta,
      cachedSnapshots: new Map([[healthyAlias.digest, healthyAlias.payload]]),
      verifiedDataOverride: [],
      fetchPage: async ({ phase }, fallback) => phase === 'data'
        ? { ...fallback, quads: [...bad.share.payload.map(row => ({ ...row, graph: bad.share.assertionGraph })),
          ...(mixed ? healthy.payload.map(row => ({ ...row, graph: healthy.assertionGraph })) : [])] } : fallback,
    }).run();
    expect(summary.swmCoverage).toMatchObject({ snapshotsTotal: 0, descriptorsAuthoritative: false });
    expect(summary.failedPhases).toBeGreaterThan(0);
    expect(await rowsOf(store, WS_META, bad.share.headSubject)).toEqual([]);
    expect(await rowsOf(store, WS_META, bad.share.operationSubject)).toEqual([]);
    expect(await rowsOf(store, bad.share.assertionGraph)).toEqual([]);
    if (mixed) {
      expect(await rowsOf(store, healthy.assertionGraph)).toHaveLength(healthy.payload.length);
      expect(await rowsOf(store, WS_META, healthy.headSubject)).not.toEqual([]);
    }
  });

  it('a conflict between two valid heads still fails the whole graph', () => {
    // The SWM graph is keyed by agent address and number, not by chain.
    const twin = fx.share({ version: 1, operationId: 'op-twin', marker: 'twin', ual: `did:dkg:base:8453/${ADDRESS}/1` });
    expect(twin.assertionGraph).toBe(valid.assertionGraph);
    expect(() => parseGraphScopedSwmRecoveryHeadResults({
      contextGraphId: CG,
      metaQuads: [...valid.meta, ...twin.meta, ...defective('bad').meta],
    })).toThrow(/multiple UAL owners/);
  });

  it.each([false, true])('rejects a colliding malformed operation before replacing stored content (malformed first: %s)', async malformedFirst => {
    const twin = fx.share({ version: 1, operationId: 'op-colliding-twin', marker: 'stored-twin', ual: `did:dkg:base:8453/${ADDRESS}/1` });
    expect(twin.assertionGraph).toBe(valid.assertionGraph);
    const malformed = [...twin.meta,
      { subject: twin.operationSubject, predicate: `${DKG}publisherPeerId`, object: '"peer-other"', graph: WS_META }];
    const servedMeta = malformedFirst ? [...malformed, ...valid.meta] : [...valid.meta, ...malformed];
    expect(() => parseGraphScopedSwmRecoveryHeadResults({ contextGraphId: CG, metaQuads: servedMeta }))
      .toThrow(/multiple UAL owners/);
    const store = newStore();
    await seedMaterialized(store, twin, twin.meta);
    const contentBefore = await rowsOf(store, twin.assertionGraph);
    const metadataBefore = await rowsOf(store, WS_META);
    const summary = await makeSwmSyncHarness({ ctx, contextGraphId: CG, store, servedMeta,
      cachedSnapshots: new Map([[valid.digest, valid.payload], [twin.digest, twin.payload]]),
    }).run();
    expect(summary.failedPhases).toBeGreaterThan(0);
    expect(await rowsOf(store, twin.assertionGraph)).toEqual(contentBefore);
    expect(await rowsOf(store, WS_META)).toEqual(metadataBefore);
  });

  it('materializes the other assets and holds the round incomplete', async () => {
    const bad = defective('bad');
    const store = newStore();
    const summary = await makeSwmSyncHarness({
      ctx,
      contextGraphId: CG,
      store,
      servedMeta: [...valid.meta, ...bad.meta],
      cachedSnapshots: new Map([[valid.digest, valid.payload], [bad.share.digest, bad.share.payload]]),
    }).run();

    expect(await rowsOf(store, valid.assertionGraph)).toHaveLength(valid.payload.length);
    expect(await rowsOf(store, WS_META, valid.headSubject)).not.toEqual([]);
    // Nothing certifies the set-aside asset: no content, no head, no operation.
    expect(await rowsOf(store, bad.share.assertionGraph)).toEqual([]);
    expect(await rowsOf(store, WS_META, bad.share.headSubject)).toEqual([]);
    expect(await rowsOf(store, WS_META, bad.share.operationSubject)).toEqual([]);
    expect(summary.failedPhases).toBe(1);
    expect(readSharedMemoryPhaseFailureAttribution(summary)).toMatchObject({ materialization: 1 });
    expect(summary.swmCoverage).toMatchObject({
      snapshotsResolved: 1,
      snapshotsTotal: 2,
      descriptorsAuthoritative: false,
    });
  });

  it('keeps a removed alias owned by a defective head unresolved', async () => {
    const alias = fx.share({ version: 1, operationId: 'op-z-alias', marker: 'valid',
      ual: `did:dkg:hardhat:31337/${ADDRESS}/1` });
    const badHead = `${valid.headSubject.replace("#dkg-swm-head", "-defective")}#dkg-swm-head`;
    const servedMeta = [...stampedAt(valid.meta, valid.operationSubject, LATEST), ...stampedAt(alias.meta, alias.operationSubject, LATER),
      ...valid.meta.filter(row => row.subject === valid.headSubject).map(row => ({ ...row,
        subject: badHead,
        object: row.predicate === `${DKG}shareOperationId` ? '"op-z-alias"' : row.object,
      })),
      { subject: badHead, predicate: `${DKG}assertionVersion`, object: '"2"', graph: WS_META },
    ];
    const { descriptors, setAside } = parseGraphScopedSwmRecoveryHeadResults({ contextGraphId: CG, metaQuads: servedMeta });
    expect(descriptors).toHaveLength(1);
    expect(setAside).toHaveLength(1);
    expect(descriptors[0].snapshotSource.operationSubject).toBe(valid.operationSubject);
    expect(canonicalGraphScopedSnapshotManifestQuads(servedMeta, descriptors)
      .some(row => row.subject === alias.operationSubject)).toBe(false);
    const store = newStore();
    const summary = await makeSwmSyncHarness({ ctx, contextGraphId: CG, store, servedMeta,
      cachedSnapshots: new Map([[valid.digest, valid.payload]]),
    }).run();
    expect(await rowsOf(store, valid.assertionGraph)).toHaveLength(valid.payload.length);
    expect(await rowsOf(store, WS_META, badHead)).toEqual([]);
    expect(summary.swmCoverage).toMatchObject({ snapshotsResolved: 0, snapshotsTotal: 1, descriptorsAuthoritative: false });
    expect(summary.failedPhases).toBeGreaterThan(0);
  });

  it('leaves a snapshot ref unresolved when a set-aside head shares it', async () => {
    // Same content, so one snapshot ref serves both assets.
    const bad = defective('valid');
    expect(bad.share.digest).toBe(valid.digest);
    const store = newStore();
    const summary = await makeSwmSyncHarness({
      ctx,
      contextGraphId: CG,
      store,
      servedMeta: [...valid.meta, ...bad.meta],
      cachedSnapshots: new Map([[valid.digest, valid.payload]]),
    }).run();

    expect(await rowsOf(store, valid.assertionGraph)).toHaveLength(valid.payload.length);
    expect(await rowsOf(store, bad.share.assertionGraph)).toEqual([]);
    expect(summary.swmCoverage).toMatchObject({ snapshotsResolved: 0, snapshotsTotal: 1 });
  });
});


describe('timestamp replacement keeps stored evidence through failed writes', () => {
  const options = { source: 'test', seam: 'test', recordDrops: () => {} };
  const row = (object: string): Quad => ({ subject: ack.operationSubject, predicate: PUBLISHED_AT, object, graph: WS_META });
  it.each([
    { incoming: PEER, initial: [LOCAL], restored: LOCAL },
    { incoming: LATEST, initial: [LOCAL, LATER], restored: LATER },
  ])('preserves the concurrently restored $restored stamp after inserting $incoming', async ({ incoming, initial, restored }) => {
    const store = newStore();
    await store.insert(initial.map(value => row(stamp(value))));
    const insert = store.insert.bind(store);
    vi.spyOn(store, 'insert').mockImplementationOnce(async quads => {
      await insert(quads);
      // Interleave a complete metadata replacement after persistence but before retirement.
      await store.deleteByPattern({ graph: WS_META, subject: ack.operationSubject });
      await insert([row(stamp(restored))]);
    });
    await insertKeepingOnePublishedAt(store, [row(stamp(incoming)),
      { ...row(`${DKG}WorkspaceOperation`), predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' }], options);
    expect(await publishedAtOf(store, ack.operationSubject)).toEqual([restored]);
  });
  it('retires many operations in bounded graph batches while protecting a replaced winner', async () => {
    const store = newStore();
    const graph2 = `did:dkg:context-graph:${CG}/child/_shared_memory_meta`;
    const copies = Array.from({ length: 501 }, (_, i) => ({ ...row(stamp(LOCAL)), subject: `${ack.operationSubject}-${i}` }));
    await store.insert([...copies, { ...copies[0], graph: graph2 }]);
    const insert = store.insert.bind(store);
    vi.spyOn(store, 'insert').mockImplementationOnce(async quads => {
      await insert(quads);
      await store.deleteByPattern({ graph: WS_META, subject: copies[0].subject });
      await insert([copies[0]]);
    });
    const update = vi.spyOn(store, 'update');
    await insertKeepingOnePublishedAt(store,
      [...copies, { ...copies[0], graph: graph2 }].map(quad => ({ ...quad, object: stamp(PEER) })), options);
    expect(update).toHaveBeenCalledTimes(7); // Six bounded batches in the root graph, one in its child.
    expect(await publishedAtOf(store, copies[0].subject)).toEqual([LOCAL]);
    for (const copy of copies.slice(1)) expect(await publishedAtOf(store, copy.subject)).toEqual([PEER]);
    expect(await rowsOf(store, graph2, copies[0].subject)).toHaveLength(1);
  });
  it('renders escaped stored literals through the canonical term policy', async () => {
    const store = newStore();
    await store.insert([row('"bad\\"stamp\\\\value\\n"')]);
    await insertKeepingOnePublishedAt(store, [row(stamp(LOCAL))], options);
    expect(await publishedAtOf(store, ack.operationSubject)).toEqual([LOCAL]);
  });
  it('keeps duplicate stamps when conditional update is unavailable', async () => {
    const store = newStore();
    await store.insert([row(stamp(LOCAL))]);
    Object.defineProperty(store, 'update', { value: undefined });
    await insertKeepingOnePublishedAt(store, [row(stamp(PEER))], options);
    expect(await publishedAtOf(store, ack.operationSubject)).toEqual([PEER, LOCAL]);
  });
  it('preserves the stored timestamp when an oversized replacement is dropped', async () => {
    const store = newStore();
    await store.insert([row(stamp(LOCAL))]);
    await insertKeepingOnePublishedAt(store, [row(`"${' '.repeat(60_001)}${EARLY}"`)],
      options);
    expect(await publishedAtOf(store, ack.operationSubject)).toEqual([LOCAL]);
  });
  it('retires each operation only when its own replacement is persisted', async () => {
    const store = newStore();
    const filtered = `${ack.operationSubject}-filtered`;
    const held = `${ack.operationSubject}-held`;
    await store.insert([row(stamp(LOCAL)),
      { ...row(stamp(LOCAL)), subject: filtered },
      { ...row(stamp(LOCAL)), subject: held }, { ...row(stamp(LATER)), subject: held }]);
    const inserted = await insertKeepingOnePublishedAt(store, [row(stamp(PEER)),
      { ...row(`"${' '.repeat(60_001)}${EARLY}"`), subject: filtered },
      { ...row(stamp(LATEST)), subject: held }], options);
    expect(inserted.map(quad => quad.subject)).toEqual([ack.operationSubject]);
    expect(await publishedAtOf(store, ack.operationSubject)).toEqual([PEER]);
    expect(await publishedAtOf(store, filtered)).toEqual([LOCAL]);
    expect(await publishedAtOf(store, held)).toEqual([LOCAL]);
  });
  it('refuses a new operation with only an oversized timestamp before committing any metadata', async () => {
    const store = newStore(), insert = vi.spyOn(store, 'insert');
    const drops = vi.fn();
    await expect(insertKeepingOnePublishedAt(store,
      [row(`"${' '.repeat(60_001)}${EARLY}"`),
        ...operationRows(ack).filter(quad => quad.predicate !== PUBLISHED_AT)],
      { ...options, recordDrops: drops })).rejects.toThrow('without a usable publishedAt');
    expect(await store.query(`CONSTRUCT { <${ack.operationSubject}> ?p ?o } WHERE {
      GRAPH <${WS_META}> { <${ack.operationSubject}> ?p ?o }
    }`)).toMatchObject({ type: 'quads', quads: [] });
    expect(insert).not.toHaveBeenCalled();
    expect(drops).toHaveBeenCalledOnce();
  });
  it('returns persisted rows and attributes the store backstop without losing its timestamp', async () => {
    const store = newStore();
    const originalInsert = store.insert.bind(store);
    vi.spyOn(store, 'insert').mockImplementationOnce(async () => {
      throw new OversizedRdfLiteralError({ actualBytes: 70_000, maxBytes: 65_535 });
    }).mockImplementation(originalInsert);
    const oversized = { ...row('"' + 'x'.repeat(70_000) + '"'),
      predicate: 'http://schema.org/text', graph: `did:dkg:context-graph:${CG}/_shared_memory` };
    const drops = vi.fn();
    const inserted = await insertKeepingOnePublishedAt(store, [row(stamp(LOCAL)), oversized],
      { ...options, recordDrops: drops });
    expect(inserted).toEqual([row(stamp(LOCAL))]);
    expect(drops).toHaveBeenCalledWith([expect.objectContaining({ quad: oversized, kind: 'store-reject' })], 'test:store-reject');
    expect(await publishedAtOf(store, ack.operationSubject)).toEqual([LOCAL]);
  });
  it('does not retire stored evidence after a failed insert', async () => {
    const store = newStore(); await store.insert([row(stamp(LOCAL))]);
    const retire = vi.spyOn(store, 'update');
    vi.spyOn(store, 'insert').mockRejectedValueOnce(new Error('insert failed'));
    await expect(insertKeepingOnePublishedAt(store, [row(stamp(PEER))], options))
      .rejects.toThrow('insert failed');
    expect(retire).not.toHaveBeenCalled();
    expect(await publishedAtOf(store, ack.operationSubject)).toEqual([LOCAL]);
  });
  it('retains both stamps after failed retirement and converges on retry', async () => {
    const store = newStore(); await store.insert([row(stamp(LOCAL))]);
    const write = () => insertKeepingOnePublishedAt(store, [row(stamp(PEER))], options);
    const retire = vi.spyOn(store, 'update').mockRejectedValueOnce(new Error('retire failed'));
    await expect(write()).rejects.toThrow('retire failed');
    expect(await publishedAtOf(store, ack.operationSubject)).toEqual([PEER, LOCAL]);
    retire.mockRestore();
    await write();
    expect(await publishedAtOf(store, ack.operationSubject)).toEqual([PEER]);
  });
});
