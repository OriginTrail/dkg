import { beforeEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GraphManager, OxigraphStore, PrivateContentStore, SharedMemoryLiteralBlobStore } from '@origintrail-official/dkg-storage';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { DKGPublisher, FileWorkspacePublicSnapshotStore, generateSubGraphRegistration } from '../src/index.js';
import { resolveLiftWorkspaceSlice, resolveWorkspaceSelection } from '../src/workspace-resolution.js';

const CONTEXT_GRAPH = 'test-workspace';
const ENTITY = 'urn:test:entity:1';
const ENTITY_2 = 'urn:test:entity:2';
const DKG = 'http://dkg.io/ontology/';
const PROV = 'http://www.w3.org/ns/prov#';
const SNAPSHOT_DIGEST = `sha256:${'a'.repeat(64)}`;

describe('FileWorkspacePublicSnapshotStore', () => {
  it('writes graphless N-Quads snapshots and keeps legacy JSON absent for new writes', async () => {
    const snapshotDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-public-snapshots-'));
    const publicSnapshotStore = new FileWorkspacePublicSnapshotStore(snapshotDir);
    const quads = [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
      {
        subject: `${ENTITY}/.well-known/genid/child`,
        predicate: 'http://schema.org/count',
        object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
        graph: '',
      },
      { subject: ENTITY, predicate: 'http://schema.org/lang', object: '"Zdravo"@sr-Latn', graph: '' },
    ];

    try {
      const stored = await publicSnapshotStore.putSnapshot({ digest: SNAPSHOT_DIGEST, quads });

      expect(stored.ref).toBe(SNAPSHOT_DIGEST);
      await expect(access(snapshotFilePath(snapshotDir, SNAPSHOT_DIGEST, 'nq'))).resolves.toBeUndefined();
      await expect(access(snapshotFilePath(snapshotDir, SNAPSHOT_DIGEST, 'json'))).rejects.toMatchObject({ code: 'ENOENT' });

      const raw = await readFile(snapshotFilePath(snapshotDir, SNAPSHOT_DIGEST, 'nq'), 'utf8');
      expect(raw).toContain(`<${ENTITY}> <http://schema.org/name> "One" .`);
      expect(raw).toContain(`<${ENTITY}/.well-known/genid/child> <http://schema.org/count> "42"^^<http://www.w3.org/2001/XMLSchema#integer> .`);
      expect(raw).toContain(`<${ENTITY}> <http://schema.org/lang> "Zdravo"@sr-Latn .`);
      expect(stored.byteLength).toBe(Buffer.byteLength(raw, 'utf8'));

      await expect(publicSnapshotStore.getSnapshot(SNAPSHOT_DIGEST)).resolves.toEqual(quads);
    } finally {
      await rm(snapshotDir, { recursive: true, force: true });
    }
  });

  it('reads legacy JSON snapshots when no N-Quads snapshot exists', async () => {
    const snapshotDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-public-snapshots-'));
    const publicSnapshotStore = new FileWorkspacePublicSnapshotStore(snapshotDir);
    const legacyQuads = [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Legacy JSON"', graph: '' },
    ];
    const jsonPath = snapshotFilePath(snapshotDir, SNAPSHOT_DIGEST, 'json');

    try {
      await mkdir(dirname(jsonPath), { recursive: true });
      await writeFile(
        jsonPath,
        `${JSON.stringify(legacyQuads.map((quad) => [quad.subject, quad.predicate, quad.object, quad.graph]))}\n`,
        'utf8',
      );

      await expect(publicSnapshotStore.getSnapshot(SNAPSHOT_DIGEST)).resolves.toEqual(legacyQuads);
    } finally {
      await rm(snapshotDir, { recursive: true, force: true });
    }
  });

  it('rejects malformed N-Quads snapshots without falling back to legacy JSON', async () => {
    const snapshotDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-public-snapshots-'));
    const publicSnapshotStore = new FileWorkspacePublicSnapshotStore(snapshotDir);
    const nquadsPath = snapshotFilePath(snapshotDir, SNAPSHOT_DIGEST, 'nq');
    const jsonPath = snapshotFilePath(snapshotDir, SNAPSHOT_DIGEST, 'json');

    try {
      await mkdir(dirname(nquadsPath), { recursive: true });
      await writeFile(nquadsPath, `<${ENTITY}> <http://schema.org/name> "broken"\n`, 'utf8');
      await writeFile(
        jsonPath,
        `${JSON.stringify([[ENTITY, 'http://schema.org/name', '"Legacy JSON"', '']])}\n`,
        'utf8',
      );

      await expect(publicSnapshotStore.getSnapshot(SNAPSHOT_DIGEST))
        .rejects.toThrow(`Invalid shared-memory public snapshot blob ${SNAPSHOT_DIGEST}`);
    } finally {
      await rm(snapshotDir, { recursive: true, force: true });
    }
  });
});

describe('async lift workspace resolution', () => {
  let store: OxigraphStore;
  let graphManager: GraphManager;
  let publisher: DKGPublisher;
  beforeEach(async () => {
    store = new OxigraphStore();
    graphManager = new GraphManager(store);
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      store,
      chain: new NoChainAdapter(),
      eventBus: new TypedEventBus(),
      keypair,
    });
  });

  it('resolves workspace selection by roots with graphless quads', async () => {
    await publisher.share(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
      { subject: ENTITY_2, predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
    ], { publisherPeerId: 'peer1' });

    const quads = await resolveWorkspaceSelection({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH,
      selection: { rootEntities: [ENTITY] },
    });

    expect(quads).toHaveLength(1);
    expect(quads[0]?.subject).toBe(ENTITY);
    expect(quads[0]?.graph).toBe('');
  });

  it('includes skolemized descendants when resolving by root selection', async () => {
    const skolem = `${ENTITY}/.well-known/genid/child-1`;
    await publisher.share(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
      { subject: skolem, predicate: 'http://schema.org/value', object: '"Nested"', graph: '' },
      { subject: ENTITY_2, predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
    ], { publisherPeerId: 'peer1' });

    const quads = await resolveWorkspaceSelection({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH,
      selection: { rootEntities: [ENTITY] },
    });

    expect(quads).toHaveLength(2);
    expect(quads.map((quad) => quad.subject).sort()).toEqual([ENTITY, skolem].sort());
  });

  it('resolves a LiftRequest slice using shareOperationId and roots', async () => {
    const skolem = `${ENTITY}/.well-known/genid/child-1`;
    const write = await publisher.share(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
      { subject: skolem, predicate: 'http://schema.org/value', object: '"Nested"', graph: '' },
      { subject: ENTITY_2, predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
    ], { publisherPeerId: 'peer1' });

    const resolved = await resolveLiftWorkspaceSlice({
      store,
      graphManager,
      request: {
        swmId: 'swm-main',
        shareOperationId: write.shareOperationId,
        roots: [ENTITY],
        contextGraphId: CONTEXT_GRAPH,
        namespace: 'aloha',
        scope: 'person-profile',
        transitionType: 'CREATE',
        authority: { type: 'owner', proofRef: 'proof:owner:1' },
      },
    });

    expect(resolved.quads).toHaveLength(2);
    expect(resolved.quads.map((quad) => quad.subject).sort()).toEqual([ENTITY, skolem].sort());
    expect(resolved.publisherPeerId).toBe('peer1');
  });

  it('does not store new public payload snapshots in shared-memory metadata', async () => {
    await publisher.share(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
      { subject: ENTITY_2, predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
    ], { publisherPeerId: 'peer1' });

    const metaGraph = graphManager.sharedMemoryMetaUri(CONTEXT_GRAPH);
    const payloads = await store.query(
      `SELECT ?payload WHERE { GRAPH <${metaGraph}> { ?s <${DKG}publicStagedQuads> ?payload } }`,
    );

    expect(payloads.type).toBe('bindings');
    if (payloads.type === 'bindings') {
      expect(payloads.bindings).toHaveLength(0);
    }

    const fingerprints = await store.query(
      `SELECT ?digest ?count WHERE {
        GRAPH <${metaGraph}> {
          ?s <${DKG}publicQuadsDigest> ?digest ;
             <${DKG}publicQuadsCount> ?count .
        }
      }`,
    );

    expect(fingerprints.type).toBe('bindings');
    if (fingerprints.type === 'bindings') {
      expect(fingerprints.bindings).toHaveLength(2);
      expect(fingerprints.bindings.every((row) => row['digest']?.includes('sha256:'))).toBe(true);
      expect(JSON.stringify(fingerprints.bindings)).not.toContain('One');
      expect(JSON.stringify(fingerprints.bindings)).not.toContain('Two');
    }
  });

  it('resolves async lift payloads from the requested sub-graph partition', async () => {
    const subGraphName = 'research';
    const privateStore = new PrivateContentStore(store, graphManager);
    await graphManager.ensureSubGraph(CONTEXT_GRAPH, subGraphName);
    await store.insert(generateSubGraphRegistration({
      contextGraphId: CONTEXT_GRAPH,
      subGraphName,
      createdBy: 'peer1',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    }));

    await publisher.share(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Default"', graph: '' },
    ], { publisherPeerId: 'peer1' });
    const write = await publisher.share(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Research"', graph: '' },
    ], { publisherPeerId: 'peer1', subGraphName });
    await privateStore.storePrivateTriplesForOperation(CONTEXT_GRAPH, write.shareOperationId, ENTITY, [
      { subject: ENTITY, predicate: 'http://schema.org/secret', object: '"subgraph-secret"', graph: '' },
    ], subGraphName);
    expect(await privateStore.getPrivateTriples(CONTEXT_GRAPH, ENTITY, subGraphName)).toEqual([]);

    const resolved = await resolveLiftWorkspaceSlice({
      store,
      graphManager,
      request: {
        swmId: 'swm-main',
        shareOperationId: write.shareOperationId,
        roots: [ENTITY],
        contextGraphId: CONTEXT_GRAPH,
        namespace: 'aloha',
        scope: 'person-profile',
        transitionType: 'CREATE',
        authority: { type: 'owner', proofRef: 'proof:owner:1' },
        subGraphName,
      },
    });

    expect(resolved.quads).toEqual([
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Research"', graph: '' },
    ]);
    expect(resolved.privateQuads).toEqual([
      { subject: ENTITY, predicate: 'http://schema.org/secret', object: '"subgraph-secret"', graph: '' },
    ]);

    const defaultQuads = await resolveWorkspaceSelection({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH,
      selection: { rootEntities: [ENTITY] },
    });
    expect(defaultQuads).toEqual([
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Default"', graph: '' },
    ]);
  });

  it('resolves public and private async lift payloads for the current share operation', async () => {
    const privateStore = new PrivateContentStore(store, graphManager);
    const secretPredicate = 'http://schema.org/secret';
    const write1 = await publisher.share(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
    ], { publisherPeerId: 'peer1' });
    await privateStore.storePrivateTriplesForOperation(CONTEXT_GRAPH, write1.shareOperationId, ENTITY, [
      { subject: ENTITY, predicate: secretPredicate, object: '"first"', graph: '' },
    ]);

    const write2 = await publisher.share(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
    ], { publisherPeerId: 'peer1' });
    await privateStore.storePrivateTriplesForOperation(CONTEXT_GRAPH, write2.shareOperationId, ENTITY, [
      { subject: ENTITY, predicate: secretPredicate, object: '"second"', graph: '' },
    ]);
    expect(await privateStore.getPrivateTriples(CONTEXT_GRAPH, ENTITY)).toEqual([]);

    const resolved = await resolveLiftWorkspaceSlice({
      store,
      graphManager,
      request: {
        swmId: 'swm-main',
        shareOperationId: write2.shareOperationId,
        roots: [ENTITY],
        contextGraphId: CONTEXT_GRAPH,
        namespace: 'aloha',
        scope: 'person-profile',
        transitionType: 'CREATE',
        authority: { type: 'owner', proofRef: 'proof:owner:1' },
      },
    });

    expect(resolved.quads).toEqual([
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
    ]);
    expect(resolved.privateQuads).toEqual([
      { subject: ENTITY, predicate: secretPredicate, object: '"second"', graph: '' },
    ]);
    expect(resolved.publisherPeerId).toBe('peer1');

    const liveQuads = await resolveWorkspaceSelection({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH,
      selection: { rootEntities: [ENTITY] },
    });
    expect(liveQuads).toEqual([
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
    ]);
  });

  it('resolves superseded share operations from immutable public snapshots', async () => {
    const privateStore = new PrivateContentStore(store, graphManager);
    const secretPredicate = 'http://schema.org/secret';
    const write1 = await publisher.share(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
    ], { publisherPeerId: 'peer1' });
    await privateStore.storePrivateTriplesForOperation(CONTEXT_GRAPH, write1.shareOperationId, ENTITY, [
      { subject: ENTITY, predicate: secretPredicate, object: '"first"', graph: '' },
    ]);

    await publisher.share(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
    ], { publisherPeerId: 'peer1' });

    const resolved = await resolveLiftWorkspaceSlice({
      store,
      graphManager,
      request: {
        swmId: 'swm-main',
        shareOperationId: write1.shareOperationId,
        roots: [ENTITY],
        contextGraphId: CONTEXT_GRAPH,
        namespace: 'aloha',
        scope: 'person-profile',
        transitionType: 'CREATE',
        authority: { type: 'owner', proofRef: 'proof:owner:1' },
      },
    });

    expect(resolved.quads).toEqual([
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
    ]);
    expect(resolved.privateQuads).toEqual([
      { subject: ENTITY, predicate: secretPredicate, object: '"first"', graph: '' },
    ]);

    const liveQuads = await resolveWorkspaceSelection({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH,
      selection: { rootEntities: [ENTITY] },
    });
    expect(liveQuads).toEqual([
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
    ]);
  });

  it('does not fall back to live SWM data when compact snapshot metadata is missing', async () => {
    const write = await publisher.share(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
    ], { publisherPeerId: 'peer1' });
    const metaGraph = graphManager.sharedMemoryMetaUri(CONTEXT_GRAPH);

    await store.deleteByPattern({
      graph: metaGraph,
      predicate: `${DKG}publicSnapshotGraph`,
    });

    await expect(
      resolveLiftWorkspaceSlice({
        store,
        graphManager,
        request: {
          swmId: 'swm-main',
          shareOperationId: write.shareOperationId,
          roots: [ENTITY],
          contextGraphId: CONTEXT_GRAPH,
          namespace: 'aloha',
          scope: 'person-profile',
          transitionType: 'CREATE',
          authority: { type: 'owner', proofRef: 'proof:owner:1' },
        },
      }),
    ).rejects.toThrow(`No immutable public snapshot metadata found for context graph ${CONTEXT_GRAPH}`);
  });

  it('keeps legacy publicStagedQuads metadata readable', async () => {
    const shareOperationId = 'legacy-op-1';
    const legacyQuads = [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Legacy"', graph: '' },
    ];
    const legacySubject = `urn:dkg:public-stage:${[
      CONTEXT_GRAPH,
      '_',
      shareOperationId,
      ENTITY,
    ].map((part) => encodeURIComponent(part)).join(':')}`;
    const metaGraph = graphManager.sharedMemoryMetaUri(CONTEXT_GRAPH);

    await store.insert([
      {
        subject: legacySubject,
        predicate: `${DKG}publicStagedQuads`,
        object: JSON.stringify(JSON.stringify(legacyQuads)),
        graph: metaGraph,
      },
      {
        subject: legacySubject,
        predicate: `${PROV}wasAttributedTo`,
        object: JSON.stringify('legacy-peer'),
        graph: metaGraph,
      },
    ]);

    const resolved = await resolveLiftWorkspaceSlice({
      store,
      graphManager,
      request: {
        swmId: 'swm-main',
        shareOperationId,
        roots: [ENTITY],
        contextGraphId: CONTEXT_GRAPH,
        namespace: 'aloha',
        scope: 'person-profile',
        transitionType: 'CREATE',
        authority: { type: 'owner', proofRef: 'proof:owner:1' },
      },
    });

    expect(resolved.quads).toEqual(legacyQuads);
    expect(resolved.publisherPeerId).toBe('legacy-peer');
  });

  it('does not duplicate large public literals into metadata', async () => {
    const marker = 'large-public-literal-marker';
    const largeValue = `${marker}-${'x'.repeat(512 * 1024)}`;

    await publisher.share(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: JSON.stringify(largeValue), graph: '' },
    ], { publisherPeerId: 'peer1' });

    const swmGraph = graphManager.sharedMemoryUri(CONTEXT_GRAPH);
    const swmResult = await store.query(
      `SELECT ?o WHERE { GRAPH <${swmGraph}> { <${ENTITY}> <http://schema.org/name> ?o } } LIMIT 1`,
    );
    expect(swmResult.type).toBe('bindings');
    if (swmResult.type === 'bindings') {
      expect(swmResult.bindings[0]?.['o']).toContain(marker);
    }

    const metaGraph = graphManager.sharedMemoryMetaUri(CONTEXT_GRAPH);
    const metaResult = await store.query(
      `SELECT ?o WHERE { GRAPH <${metaGraph}> { ?s ?p ?o } }`,
    );
    expect(metaResult.type).toBe('bindings');
    if (metaResult.type === 'bindings') {
      expect(JSON.stringify(metaResult.bindings)).not.toContain(marker);
    }
  });

  it('stores immutable public operation snapshots as disk refs when configured', async () => {
    const snapshotDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-public-snapshots-'));
    const publicSnapshotStore = new FileWorkspacePublicSnapshotStore(snapshotDir);
    const keypair = await generateEd25519Keypair();
    const snapshotPublisher = new DKGPublisher({
      store,
      chain: new NoChainAdapter(),
      eventBus: new TypedEventBus(),
      keypair,
      publicSnapshotStore,
    });

    try {
      const marker = 'disk-public-snapshot-marker';
      const write = await snapshotPublisher.share(CONTEXT_GRAPH, [
        { subject: ENTITY, predicate: 'http://schema.org/name', object: JSON.stringify(`${marker}-${'x'.repeat(1024)}`), graph: '' },
      ], { publisherPeerId: 'peer1' });

      const metaGraph = graphManager.sharedMemoryMetaUri(CONTEXT_GRAPH);
      const metadata = await store.query(
        `SELECT ?snapshotRef ?snapshotGraph ?payload WHERE {
          GRAPH <${metaGraph}> {
            ?s <${DKG}shareOperationId> "${write.shareOperationId}" .
            OPTIONAL { ?s <${DKG}publicSnapshotRef> ?snapshotRef }
            OPTIONAL { ?s <${DKG}publicSnapshotGraph> ?snapshotGraph }
            OPTIONAL { ?s <${DKG}publicStagedQuads> ?payload }
          }
        }`,
      );
      expect(metadata.type).toBe('bindings');
      let snapshotRef: string | undefined;
      if (metadata.type === 'bindings') {
        expect(metadata.bindings.some((row) => row['snapshotRef']?.includes('sha256:'))).toBe(true);
        expect(metadata.bindings.some((row) => row['snapshotGraph'])).toBe(false);
        expect(metadata.bindings.some((row) => row['payload'])).toBe(false);
        expect(JSON.stringify(metadata.bindings)).not.toContain(marker);
        snapshotRef = metadata.bindings.map((row) => stripLiteral(row['snapshotRef'])).find(Boolean);
      }
      expect(snapshotRef).toBeDefined();
      const snapshotFile = snapshotFilePath(snapshotDir, snapshotRef!, 'nq');
      await expect(access(snapshotFile)).resolves.toBeUndefined();
      await expect(access(snapshotFilePath(snapshotDir, snapshotRef!, 'json'))).rejects.toMatchObject({ code: 'ENOENT' });
      const snapshotRaw = await readFile(snapshotFile, 'utf8');
      expect(snapshotRaw).toContain(marker);

      const snapshotGraphRows = await store.query(
        `SELECT ?g WHERE {
          GRAPH ?g { ?s ?p ?o }
          FILTER(CONTAINS(STR(?g), "/_shared_memory_snapshots/"))
        } LIMIT 1`,
      );
      expect(snapshotGraphRows.type).toBe('bindings');
      if (snapshotGraphRows.type === 'bindings') {
        expect(snapshotGraphRows.bindings).toHaveLength(0);
      }

      const resolved = await resolveLiftWorkspaceSlice({
        store,
        graphManager,
        publicSnapshotStore,
        request: {
          swmId: 'swm-main',
          shareOperationId: write.shareOperationId,
          roots: [ENTITY],
          contextGraphId: CONTEXT_GRAPH,
          namespace: 'aloha',
          scope: 'person-profile',
          transitionType: 'CREATE',
          authority: { type: 'owner', proofRef: 'proof:owner:1' },
        },
      });
      expect(resolved.quads).toHaveLength(1);
      expect(resolved.quads[0]?.object).toContain(marker);
    } finally {
      await rm(snapshotDir, { recursive: true, force: true });
    }
  });

  it('fails corrupted N-Quads snapshots instead of resolving live SWM data', async () => {
    const snapshotDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-public-snapshots-'));
    const publicSnapshotStore = new FileWorkspacePublicSnapshotStore(snapshotDir);
    const keypair = await generateEd25519Keypair();
    const snapshotPublisher = new DKGPublisher({
      store,
      chain: new NoChainAdapter(),
      eventBus: new TypedEventBus(),
      keypair,
      publicSnapshotStore,
    });

    try {
      const write1 = await snapshotPublisher.share(CONTEXT_GRAPH, [
        { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
      ], { publisherPeerId: 'peer1' });
      await snapshotPublisher.share(CONTEXT_GRAPH, [
        { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
      ], { publisherPeerId: 'peer1' });

      const snapshotRef = await getPublicSnapshotRef(store, graphManager, write1.shareOperationId);
      const snapshotFile = snapshotFilePath(snapshotDir, snapshotRef, 'nq');
      await writeFile(snapshotFile, `<${ENTITY}> <http://schema.org/name> "corrupt"\n`, 'utf8');

      await expect(
        resolveLiftWorkspaceSlice({
          store,
          graphManager,
          publicSnapshotStore,
          request: {
            swmId: 'swm-main',
            shareOperationId: write1.shareOperationId,
            roots: [ENTITY],
            contextGraphId: CONTEXT_GRAPH,
            namespace: 'aloha',
            scope: 'person-profile',
            transitionType: 'CREATE',
            authority: { type: 'owner', proofRef: 'proof:owner:1' },
          },
        }),
      ).rejects.toThrow(`Invalid shared-memory public snapshot blob ${snapshotRef}`);

      const liveQuads = await resolveWorkspaceSelection({
        store,
        graphManager,
        contextGraphId: CONTEXT_GRAPH,
        selection: { rootEntities: [ENTITY] },
      });
      expect(liveQuads).toEqual([
        { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
      ]);
    } finally {
      await rm(snapshotDir, { recursive: true, force: true });
    }
  });

  it('resolves compact share metadata against hydrated external SWM literals', async () => {
    const blobDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-literal-blobs-'));
    const snapshotDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-public-snapshots-'));
    const inner = new OxigraphStore();
    const wrappedStore = new SharedMemoryLiteralBlobStore(inner, { blobDir, thresholdBytes: 20 });
    const wrappedGraphManager = new GraphManager(wrappedStore);
    const publicSnapshotStore = new FileWorkspacePublicSnapshotStore(snapshotDir);
    const keypair = await generateEd25519Keypair();
    const wrappedPublisher = new DKGPublisher({
      store: wrappedStore,
      chain: new NoChainAdapter(),
      eventBus: new TypedEventBus(),
      keypair,
      publicSnapshotStore,
    });
    const largeValue = `externalized-${'x'.repeat(1024)}`;
    const largeLiteral = JSON.stringify(largeValue);

    try {
      const write = await wrappedPublisher.share(CONTEXT_GRAPH, [
        { subject: ENTITY, predicate: 'http://schema.org/name', object: largeLiteral, graph: '' },
      ], { publisherPeerId: 'peer1' });

      const swmGraph = wrappedGraphManager.sharedMemoryUri(CONTEXT_GRAPH);
      const raw = await inner.query(
        `SELECT ?o WHERE { GRAPH <${swmGraph}> { <${ENTITY}> <http://schema.org/name> ?o } } LIMIT 1`,
      );
      expect(raw.type).toBe('bindings');
      if (raw.type === 'bindings') {
        expect(raw.bindings[0]?.['o']).toContain('sha256:');
        expect(raw.bindings[0]?.['o']).not.toContain('externalized-');
      }

      const resolved = await resolveLiftWorkspaceSlice({
        store: wrappedStore,
        graphManager: wrappedGraphManager,
        publicSnapshotStore,
        request: {
          swmId: 'swm-main',
          shareOperationId: write.shareOperationId,
          roots: [ENTITY],
          contextGraphId: CONTEXT_GRAPH,
          namespace: 'aloha',
          scope: 'person-profile',
          transitionType: 'CREATE',
          authority: { type: 'owner', proofRef: 'proof:owner:1' },
        },
      });

      expect(resolved.quads).toEqual([
        { subject: ENTITY, predicate: 'http://schema.org/name', object: largeLiteral, graph: '' },
      ]);

      const metaGraph = wrappedGraphManager.sharedMemoryMetaUri(CONTEXT_GRAPH);
      const metadata = await wrappedStore.query(
        `SELECT ?digest ?count ?payload ?snapshotRef ?snapshotGraph WHERE {
          GRAPH <${metaGraph}> {
            OPTIONAL { ?s <${DKG}publicQuadsDigest> ?digest }
            OPTIONAL { ?s <${DKG}publicQuadsCount> ?count }
            OPTIONAL { ?s <${DKG}publicStagedQuads> ?payload }
            OPTIONAL { ?s <${DKG}publicSnapshotRef> ?snapshotRef }
            OPTIONAL { ?s <${DKG}publicSnapshotGraph> ?snapshotGraph }
          }
        }`,
      );
      expect(metadata.type).toBe('bindings');
      if (metadata.type === 'bindings') {
        expect(metadata.bindings.some((row) => row['digest']?.includes('sha256:'))).toBe(true);
        expect(metadata.bindings.some((row) => row['count'] === '"1"^^<http://www.w3.org/2001/XMLSchema#integer>')).toBe(true);
        expect(metadata.bindings.some((row) => row['payload'])).toBe(false);
        expect(metadata.bindings.some((row) => row['snapshotRef']?.includes('sha256:'))).toBe(true);
        expect(metadata.bindings.some((row) => row['snapshotGraph'])).toBe(false);
        expect(JSON.stringify(metadata.bindings)).not.toContain('externalized-');
      }
    } finally {
      await wrappedStore.close().catch(() => {});
      await rm(blobDir, { recursive: true, force: true });
      await rm(snapshotDir, { recursive: true, force: true });
    }
  });

  it('carries Lift request access policy into resolved publish options', async () => {
    const write = await publisher.share(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
    ], { publisherPeerId: 'peer1' });

    const resolved = await resolveLiftWorkspaceSlice({
      store,
      graphManager,
      request: {
        swmId: 'swm-main',
        shareOperationId: write.shareOperationId,
        roots: [ENTITY],
        contextGraphId: CONTEXT_GRAPH,
        namespace: 'aloha',
        scope: 'person-profile',
        transitionType: 'CREATE',
        authority: { type: 'owner', proofRef: 'proof:owner:1' },
        accessPolicy: 'allowList',
        allowedPeers: ['peer-a', 'peer-b'],
      },
    });

    expect(resolved.accessPolicy).toBe('allowList');
    expect(resolved.allowedPeers).toEqual(['peer-a', 'peer-b']);
  });

  it('resolves a LiftRequest slice with the renamed fields', async () => {
    const write = await publisher.share(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
    ], { publisherPeerId: 'peer1' });

    const resolved = await resolveLiftWorkspaceSlice({
      store,
      graphManager,
      request: {
        swmId: 'swm-main',
        shareOperationId: write.shareOperationId,
        roots: [ENTITY],
        contextGraphId: CONTEXT_GRAPH,
        namespace: 'aloha',
        scope: 'person-profile',
        transitionType: 'CREATE',
        authority: { type: 'owner', proofRef: 'proof:owner:1' },
      },
    });

    expect(resolved.quads).toHaveLength(1);
    expect(resolved.quads[0]?.subject).toBe(ENTITY);
  });

  it('rejects roots not linked to the requested workspace operation', async () => {
    const write = await publisher.share(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
    ], { publisherPeerId: 'peer1' });

    await expect(
      resolveLiftWorkspaceSlice({
        store,
        graphManager,
        request: {
          swmId: 'swm-main',
          shareOperationId: write.shareOperationId,
          roots: [ENTITY_2],
          contextGraphId: CONTEXT_GRAPH,
          namespace: 'aloha',
          scope: 'person-profile',
          transitionType: 'CREATE',
          authority: { type: 'owner', proofRef: 'proof:owner:1' },
        },
      }),
    ).rejects.toThrow(`Lift shared-memory resolution roots are not part of share operation ${write.shareOperationId}`);
  });

  it('rejects unsafe shareOperationId values before querying workspace metadata', async () => {
    await expect(
      resolveLiftWorkspaceSlice({
        store,
        graphManager,
        request: {
          swmId: 'swm-main',
          shareOperationId: 'bad>op',
          roots: [ENTITY],
          contextGraphId: CONTEXT_GRAPH,
          namespace: 'aloha',
          scope: 'person-profile',
          transitionType: 'CREATE',
          authority: { type: 'owner', proofRef: 'proof:owner:1' },
        },
      }),
    ).rejects.toThrow('Shared-memory resolution rejected unsafe shareOperationId: bad>op');
  });
});

function snapshotFilePath(directory: string, ref: string, extension: 'json' | 'nq'): string {
  const hash = ref.replace(/^"?(?:sha256:)?/, '').replace(/"?$/, '');
  return join(directory, hash.slice(0, 2), hash.slice(2, 4), `${hash}.${extension}`);
}

function stripLiteral(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!value.startsWith('"')) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, value.lastIndexOf('"'));
  }
}

async function getPublicSnapshotRef(store: OxigraphStore, graphManager: GraphManager, shareOperationId: string): Promise<string> {
  const metaGraph = graphManager.sharedMemoryMetaUri(CONTEXT_GRAPH);
  const result = await store.query(
    `SELECT ?snapshotRef WHERE {
      GRAPH <${metaGraph}> {
        ?s <${DKG}shareOperationId> "${shareOperationId}" ;
           <${DKG}publicSnapshotRef> ?snapshotRef .
      }
    } LIMIT 1`,
  );
  expect(result.type).toBe('bindings');
  if (result.type !== 'bindings') throw new Error('Unexpected snapshot metadata result');
  const snapshotRef = stripLiteral(result.bindings[0]?.['snapshotRef']);
  if (!snapshotRef) throw new Error(`Missing public snapshot ref for ${shareOperationId}`);
  return snapshotRef;
}
