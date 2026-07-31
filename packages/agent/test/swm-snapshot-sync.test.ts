import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contextGraphWorkspaceGraphUri, contextGraphWorkspaceMetaGraphUri, type OperationContext } from '@origintrail-official/dkg-core';
import { FileWorkspacePublicSnapshotStore, serializeWorkspacePublicSnapshotQuads, TripleStoreAsyncLiftPublisher } from '@origintrail-official/dkg-publisher';
import { withLegacyRawLiftTestSeeder } from '../../publisher/test/_helpers/legacy-raw-lift.js';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';
import { DKGAgent } from '../src/index.js';

const CONTEXT_GRAPH = 'swm-snapshot-sync';
const ENTITY = 'urn:swm:snapshot-sync:entity';
const REMOTE_PEER = '12D3KooWSnapshotSyncRemote';

describe('SWM snapshot catch-up sync', () => {
  const tempDirs: string[] = [];
  const agents: DKGAgent[] = [];

  afterEach(async () => {
    await Promise.all(agents.splice(0).map(async (agent) => {
      await agent.stop().catch(() => {});
      await agent.store.close().catch(() => {});
    }));
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('syncs disk public snapshots before inserting publicSnapshotRef metadata', async () => {
    const nodeADataDir = await tempDataDir();
    const nodeBDataDir = await tempDataDir();
    const nodeA = await createAgent(nodeADataDir, 'SnapshotSyncA');
    const nodeB = await createAgent(nodeBDataDir, 'SnapshotSyncB');
    const sourceSnapshots = new FileWorkspacePublicSnapshotStore(join(nodeADataDir, 'swm-public-snapshots'));
    const targetSnapshots = new FileWorkspacePublicSnapshotStore(join(nodeBDataDir, 'swm-public-snapshots'));

    const write = await nodeA.publisher.writeToWorkspace(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Synced Snapshot"', graph: '' },
      { subject: `${ENTITY}/.well-known/genid/child`, predicate: 'http://schema.org/value', object: '"Nested"', graph: '' },
    ], { publisherPeerId: 'peer-a' });

    installSharedMemorySyncMock(nodeB, nodeA, sourceSnapshots);

    const inserted = await nodeB.syncSharedMemoryFromPeer(REMOTE_PEER, [CONTEXT_GRAPH]);
    expect(inserted).toBeGreaterThan(0);

    await expect(targetSnapshots.getSnapshot(await getSnapshotRef(nodeB, write.shareOperationId))).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subject: ENTITY, predicate: 'http://schema.org/name', object: '"Synced Snapshot"', graph: '' }),
        expect.objectContaining({ subject: `${ENTITY}/.well-known/genid/child`, predicate: 'http://schema.org/value', object: '"Nested"', graph: '' }),
      ]),
    );

    const metaGraph = contextGraphWorkspaceMetaGraphUri(CONTEXT_GRAPH);
    const legacyPayloads = await nodeB.store.query(
      `SELECT ?payload WHERE { GRAPH <${metaGraph}> { ?s <http://dkg.io/ontology/publicStagedQuads> ?payload } }`,
    );
    expect(legacyPayloads.type).toBe('bindings');
    if (legacyPayloads.type === 'bindings') {
      expect(legacyPayloads.bindings).toHaveLength(0);
    }

    const asyncPublisher = withLegacyRawLiftTestSeeder(new TripleStoreAsyncLiftPublisher(nodeB.store, {
      publicSnapshotStore: targetSnapshots,
    }), nodeB.store, {
      now: () => Date.now(),
      idGenerator: () => 'swm-snapshot-legacy-job',
    });
    const jobId = await asyncPublisher.seedLegacyRawLift({
      swmId: 'swm-main',
      shareOperationId: write.shareOperationId,
      roots: [ENTITY],
      contextGraphId: CONTEXT_GRAPH,
      namespace: 'aloha',
      scope: 'person-profile',
      transitionType: 'CREATE',
      authority: { type: 'owner', proofRef: 'proof:owner:1' },
    });
    const payload = await asyncPublisher.inspectPreparedPayload(jobId);
    // GH #1122 — the async lift preserves caller root IRIs (parity with sync):
    // the prepared payload carries the verbatim caller subjects (root + its
    // skolemized child), not a dkg:<cg>:<ns>:<scope>/… rewrite.
    expect(payload?.publishOptions.quads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: ENTITY,
          predicate: 'http://schema.org/name',
          object: '"Synced Snapshot"',
          graph: '',
        }),
        expect.objectContaining({
          subject: `${ENTITY}/.well-known/genid/child`,
          predicate: 'http://schema.org/value',
          object: '"Nested"',
          graph: '',
        }),
      ]),
    );
  });

  it('drops oversized graph-scoped replacement metadata without retrying the sync forever', async () => {
    const nodeADataDir = await tempDataDir();
    const nodeBDataDir = await tempDataDir();
    const nodeA = await createAgent(nodeADataDir, 'SnapshotSyncOversizeA');
    const nodeB = await createAgent(nodeBDataDir, 'SnapshotSyncOversizeB');
    const sourceSnapshots = new FileWorkspacePublicSnapshotStore(join(nodeADataDir, 'swm-public-snapshots'));

    const write = await nodeA.publisher.writeToWorkspace(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Oversize metadata guard"', graph: '' },
    ], { publisherPeerId: 'peer-a' });
    const metaGraph = contextGraphWorkspaceMetaGraphUri(CONTEXT_GRAPH);
    const operationSubject = `urn:dkg:share:${CONTEXT_GRAPH}:${write.shareOperationId}`;
    const publisherPeerPredicate = 'http://dkg.io/ontology/publisherPeerId';
    await nodeA.store.deleteByPattern({
      graph: metaGraph,
      subject: operationSubject,
      predicate: publisherPeerPredicate,
    });
    const oversizedPeerId = 'x'.repeat(61_000);
    await nodeA.store.insert([{
      graph: metaGraph,
      subject: operationSubject,
      predicate: publisherPeerPredicate,
      object: `"${oversizedPeerId}"`,
    }]);

    installSharedMemorySyncMock(nodeB, nodeA, sourceSnapshots);
    const detailedSync = () => (nodeB as unknown as {
      syncSharedMemoryFromPeerDetailed(peerId: string, contextGraphIds: string[]): Promise<{
        failedPeers: number;
        failedPhases: number;
        completedPhases: number;
      }>;
    }).syncSharedMemoryFromPeerDetailed(REMOTE_PEER, [CONTEXT_GRAPH]);

    await expect(detailedSync()).resolves.toMatchObject({
      failedPeers: 0,
      failedPhases: 0,
    });
    // A second complete round pins the no-loop property: the poisoned row is
    // seen again, but the already materialized graph/head remains usable and
    // the phase still completes instead of re-fetching forever.
    await expect(detailedSync()).resolves.toMatchObject({
      failedPeers: 0,
      failedPhases: 0,
    });

    await expect(nodeB.store.query(
      `ASK { GRAPH <${metaGraph}> { ?head <http://dkg.io/ontology/shareOperationId> `
        + `"${write.shareOperationId}" } }`,
    )).resolves.toMatchObject({ type: 'boolean', value: true });
    await expect(nodeB.store.query(
      `ASK { GRAPH <${metaGraph}> { <${operationSubject}> `
        + `<${publisherPeerPredicate}> "${oversizedPeerId}" } }`,
    )).resolves.toMatchObject({ type: 'boolean', value: false });
  });

  it('does not insert dangling publicSnapshotRef metadata when remote snapshots are unavailable', async () => {
    const nodeADataDir = await tempDataDir();
    const nodeBDataDir = await tempDataDir();
    const nodeA = await createAgent(nodeADataDir, 'SnapshotSyncMissingA');
    const nodeB = await createAgent(nodeBDataDir, 'SnapshotSyncMissingB');
    const sourceSnapshots = new FileWorkspacePublicSnapshotStore(join(nodeADataDir, 'swm-public-snapshots'));

    await nodeA.publisher.writeToWorkspace(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Missing Snapshot"', graph: '' },
    ], { publisherPeerId: 'peer-a' });

    installSharedMemorySyncMock(nodeB, nodeA, sourceSnapshots, { omitSnapshots: true });

    const detailed = await (nodeB as unknown as {
      syncSharedMemoryFromPeerDetailed(peerId: string, contextGraphIds: string[]): Promise<{
        failedPeers: number;
        failedPhases: number;
        completedPhases: number;
        insertedDataTriples: number;
        insertedMetaTriples: number;
        insertedTriples: number;
      }>;
    }).syncSharedMemoryFromPeerDetailed(REMOTE_PEER, [CONTEXT_GRAPH]);
    // The peer is reachable and its verified data phase can be retained, but
    // the immutable snapshot is incomplete. Keep the snapshot phase failed so
    // lifecycle readiness retries, while never making its metadata visible.
    expect(detailed.failedPeers).toBe(0);
    expect(detailed.failedPhases).toBe(1);
    expect(detailed.completedPhases).toBe(1);
    expect(detailed.insertedDataTriples).toBe(1);
    expect(detailed.insertedMetaTriples).toBe(0);
    expect(detailed.insertedTriples).toBe(1);

    const metaGraph = contextGraphWorkspaceMetaGraphUri(CONTEXT_GRAPH);
    // RFC ka-metadata-trim Phase 2: the snapshot pointer is the digest row
    // (no more `dkg:publicSnapshotRef`); a failed sync must leave NEITHER.
    const refs = await nodeB.store.query(
      `SELECT ?ref WHERE { GRAPH <${metaGraph}> { ?s <http://dkg.io/ontology/publicSnapshotRef> ?ref } }`,
    );
    expect(refs.type).toBe('bindings');
    if (refs.type === 'bindings') {
      expect(refs.bindings).toHaveLength(0);
    }
    const digests = await nodeB.store.query(
      `SELECT ?digest WHERE { GRAPH <${metaGraph}> { ?s <http://dkg.io/ontology/publicQuadsDigest> ?digest } }`,
    );
    expect(digests.type).toBe('bindings');
    if (digests.type === 'bindings') {
      expect(digests.bindings).toHaveLength(0);
    }
  });

  async function tempDataDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-swm-snapshot-sync-'));
    tempDirs.push(dir);
    return dir;
  }

  async function createAgent(dataDir: string, name: string): Promise<DKGAgent> {
    const agent = await DKGAgent.create({
      name,
      dataDir,
      listenHost: '127.0.0.1',
    });
    agents.push(agent);
    return agent;
  }
});

function installSharedMemorySyncMock(
  target: DKGAgent,
  source: DKGAgent,
  sourceSnapshots: FileWorkspacePublicSnapshotStore,
  options: { omitSnapshots?: boolean } = {},
): void {
  (target as unknown as { canUseSharedMemoryForContextGraph: () => Promise<boolean> }).canUseSharedMemoryForContextGraph = async () => true;
  (target as unknown as {
    fetchSyncPages: (
      ctx: OperationContext,
      remotePeerId: string,
      contextGraphId: string,
      includeSharedMemory: boolean,
      phase: 'data' | 'meta' | 'snapshot',
      graphUri: string,
      deadline: number,
      snapshotRef?: string,
    ) => Promise<SyncPageResult>;
  }).fetchSyncPages = async (_ctx, _remotePeerId, contextGraphId, _includeSharedMemory, phase, graphUri, _deadline, snapshotRef) => {
    let quads: Quad[] = [];
    if (phase === 'snapshot') {
      quads = options.omitSnapshots || !snapshotRef
        ? []
        : (await sourceSnapshots.getSnapshot(snapshotRef)) ?? [];
    } else {
      quads = await selectGraphQuads(source, graphUri || (
        phase === 'meta'
          ? contextGraphWorkspaceMetaGraphUri(contextGraphId)
          : contextGraphWorkspaceGraphUri(contextGraphId)
      ));
    }
    return {
      quads,
      bytesReceived: phase === 'snapshot'
        ? Buffer.byteLength(serializeWorkspacePublicSnapshotQuads(quads), 'utf8')
        : Buffer.byteLength(JSON.stringify(quads), 'utf8'),
      resumedFromOffset: 0,
      nextOffset: quads.length,
      checkpointKey: `mock:${phase}:${snapshotRef ?? 'graph'}`,
      completed: true,
      timedOut: false,
    };
  };
}

async function selectGraphQuads(agent: DKGAgent, graph: string): Promise<Quad[]> {
  const result = await agent.store.query(
    `SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } } ORDER BY ?s ?p ?o`,
  );
  if (result.type !== 'bindings') return [];
  return result.bindings.map((row) => ({
    subject: row['s'],
    predicate: row['p'],
    object: row['o'],
    graph,
  }));
}

async function getSnapshotRef(agent: DKGAgent, shareOperationId: string): Promise<string> {
  const metaGraph = contextGraphWorkspaceMetaGraphUri(CONTEXT_GRAPH);
  // Read-both (RFC ka-metadata-trim Phase 2): `dkg:publicSnapshotRef` is no
  // longer written — for store-backed rows the ref IS `dkg:publicQuadsDigest`
  // (`putSnapshot` returns `ref === digest`). A legacy explicit ref row,
  // when present, still wins.
  const result = await agent.store.query(
    `SELECT ?ref ?digest WHERE {
      GRAPH <${metaGraph}> {
        ?s <http://dkg.io/ontology/shareOperationId> "${shareOperationId}" ;
           <http://dkg.io/ontology/publicQuadsDigest> ?digest .
        OPTIONAL { ?s <http://dkg.io/ontology/publicSnapshotRef> ?ref }
      }
    } LIMIT 1`,
  );
  if (result.type !== 'bindings') throw new Error('Unexpected snapshot ref query result');
  const ref = (result.bindings[0]?.['ref'] ?? result.bindings[0]?.['digest'])?.replace(/^"|"$/g, '');
  if (!ref) throw new Error(`Missing snapshot ref for ${shareOperationId}`);
  return ref;
}
