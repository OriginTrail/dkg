import { describe, expect, it, vi } from 'vitest';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  generateGraphKnowledgeAssetMetadata,
  generateKnowledgeAssetShareMetadata,
  swmKaWriteLockKey,
  withKeyedLocks,
  workspacePublicQuadsDigest,
} from '@origintrail-official/dkg-publisher';
import { OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import {
  reconcileFinalizedSwmTwin,
  reconcileFinalizedSwmTwinFromDescriptor,
  type FinalizedSwmTwinRetirement,
} from '../src/sync/requester/finalized-swm-twin-reconciliation.js';
import type { VerifiedGraphScopedAsset } from '../src/sync/requester/graph-scoped-materialization.js';

const CG = 'durable-vm-swm-twin';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const UAL = `did:dkg:base:8453/${AUTHOR}/17`;
const DKG = 'http://dkg.io/ontology/';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

function fixture(
  subGraphName?: string,
  privateCommitment?: Readonly<{ count: number; root: Uint8Array }>,
): Readonly<{
  asset: VerifiedGraphScopedAsset;
  swmGraph: string;
  swmMetaGraph: string;
  headSubject: string;
  payload: Quad[];
  privateTripleCount: number;
  privateMerkleRoot?: Uint8Array;
  subGraphName?: string;
}> {
  const scope = createGraphKnowledgeAssetScope(UAL, 3);
  const vmGraph = knowledgeAssetLayerGraphUri(
    CG,
    MemoryLayer.VerifiableMemory,
    scope,
    subGraphName,
  );
  const swmGraph = knowledgeAssetLayerGraphUri(
    CG,
    MemoryLayer.SharedWorkingMemory,
    scope,
    subGraphName,
  );
  const payload: Quad[] = [
    { subject: 'urn:asset', predicate: 'urn:value', object: '"finalized"', graph: vmGraph },
    { subject: 'urn:asset', predicate: 'urn:version', object: '"3"', graph: vmGraph },
  ];
  const graphlessPayload = payload.map((quad) => ({ ...quad, graph: '' }));
  const privateTripleCount = privateCommitment?.count ?? 0;
  const privateMerkleRoot = privateCommitment?.root;
  const metadataQuads = generateGraphKnowledgeAssetMetadata({
    contextGraphId: CG,
    ual: UAL,
    merkleRoot: computeFlatKCRootV10(
      graphlessPayload,
      privateMerkleRoot ? [privateMerkleRoot] : [],
    ),
    publisherPeerId: 'peer-source',
    timestamp: new Date(0),
    assertionVersion: 3,
    publicTripleCount: payload.length,
    privateTripleCount,
    ...(privateMerkleRoot ? { privateMerkleRoot } : {}),
    assertionGraph: vmGraph,
    ...(subGraphName ? { subGraphName } : {}),
  }, {
    status: 'confirmed',
    confirmation: {
      kind: 'finalized-materialization',
      provenance: {
        batchId: 17n,
        materializedVersion: { blockNumber: 10, txIndex: 0 },
      },
    },
  });
  return {
    asset: {
      contextGraphId: CG,
      ual: UAL,
      assertionVersion: 3n,
      assertionGraph: vmGraph,
      metaGraph: `did:dkg:context-graph:${CG}/_meta`,
      dataQuads: payload,
      metadataQuads,
    },
    swmGraph,
    swmMetaGraph: subGraphName
      ? `did:dkg:context-graph:${CG}/${subGraphName}/_shared_memory_meta`
      : `did:dkg:context-graph:${CG}/_shared_memory_meta`,
    headSubject: `${UAL}#dkg-swm-head`,
    payload,
    privateTripleCount,
    ...(privateMerkleRoot ? { privateMerkleRoot } : {}),
    ...(subGraphName ? { subGraphName } : {}),
  };
}

async function seedTwin(
  store: OxigraphStore,
  input: ReturnType<typeof fixture>,
  options: Readonly<{
    swmObject?: string;
    vmObject?: string;
    headVersion?: bigint;
    swmPrivateTripleCount?: number;
    swmPrivateMerkleRoot?: Uint8Array;
  }> = {},
): Promise<void> {
  const version = options.headVersion ?? input.asset.assertionVersion;
  const shareOperationId = `op-v${version.toString()}`;
  const operationSubject = `urn:dkg:share:${CG}:${shareOperationId}`;
  const privateTripleCount = options.swmPrivateTripleCount ?? input.privateTripleCount;
  const privateMerkleRoot = options.swmPrivateMerkleRoot ?? input.privateMerkleRoot;
  const publicDigest = workspacePublicQuadsDigest(input.payload);
  await store.insert([
    ...input.payload.map((quad) => ({
      ...quad,
      ...(options.vmObject === undefined ? {} : { object: options.vmObject }),
    })),
    ...input.payload.map((quad) => ({
      ...quad,
      graph: input.swmGraph,
      ...(options.swmObject === undefined ? {} : { object: options.swmObject }),
    })),
    ...input.asset.metadataQuads,
    ...generateKnowledgeAssetShareMetadata({
      shareOperationId,
      contextGraphId: CG,
      kaUal: UAL,
      assertionVersion: version,
      publicTripleCount: input.payload.length,
      privateTripleCount,
      ...(privateMerkleRoot ? { privateMerkleRoot } : {}),
      publisherPeerId: 'peer-source',
      timestamp: new Date(0),
      ...(input.subGraphName ? { subGraphName: input.subGraphName } : {}),
    }, input.swmMetaGraph),
    {
      subject: operationSubject,
      predicate: `${DKG}publicQuadsDigest`,
      object: `"${publicDigest}"`,
      graph: input.swmMetaGraph,
    },
    {
      subject: operationSubject,
      predicate: `${DKG}publicSnapshotRef`,
      object: `"${publicDigest}"`,
      graph: input.swmMetaGraph,
    },
    {
      subject: input.headSubject,
      predicate: `${DKG}contentScopeVersion`,
      object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${XSD_INTEGER}>`,
      graph: input.swmMetaGraph,
    },
    {
      subject: input.headSubject,
      predicate: `${DKG}kaUal`,
      object: UAL,
      graph: input.swmMetaGraph,
    },
    {
      subject: input.headSubject,
      predicate: `${DKG}assertionVersion`,
      object: `"${version.toString()}"^^<${XSD_INTEGER}>`,
      graph: input.swmMetaGraph,
    },
    {
      subject: input.headSubject,
      predicate: `${DKG}assertionGraph`,
      object: input.swmGraph,
      graph: input.swmMetaGraph,
    },
    {
      subject: input.headSubject,
      predicate: `${DKG}shareOperationId`,
      object: `"${shareOperationId}"`,
      graph: input.swmMetaGraph,
    },
  ]);
}

describe('durable VM / SWM tier reconciliation', () => {
  it.each([undefined, 'code'])('retires an exact finalized twin for subgraph %s', async (subGraphName) => {
    const store = new OxigraphStore();
    const input = fixture(subGraphName);
    await seedTwin(store, input);
    const retire = vi.fn(async (candidate: FinalizedSwmTwinRetirement) => {
      await store.dropGraph(candidate.swmGraph);
    });

    await expect(reconcileFinalizedSwmTwin({
      store,
      writeLocks: new Map(),
      asset: input.asset,
      retire,
    })).resolves.toBe('retired');

    expect(retire).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphId: CG,
      kaUal: UAL,
      swmGraph: input.swmGraph,
      agentAddress: AUTHOR,
      kaNumber: 17n,
      ...(subGraphName === undefined ? {} : { subGraphName }),
    }));
    expect(await store.countQuads(input.swmGraph)).toBe(0);
  });

  it('retires an exact SWM snapshot that arrives after finalized VM', async () => {
    const store = new OxigraphStore();
    const input = fixture();
    await seedTwin(store, input);
    const retire = vi.fn(async (candidate: FinalizedSwmTwinRetirement) => {
      await store.dropGraph(candidate.swmGraph);
    });

    await expect(reconcileFinalizedSwmTwinFromDescriptor({
      store,
      writeLocks: new Map(),
      contextGraphId: CG,
      descriptor: {
        metaGraph: input.swmMetaGraph,
        headSubject: input.headSubject,
        operationSubject: `urn:dkg:share:${CG}:op-v3`,
        kaUal: UAL,
        assertionVersion: input.asset.assertionVersion.toString(),
        assertionGraph: input.swmGraph,
        shareOperationId: 'op-v3',
        publicQuadsDigest: workspacePublicQuadsDigest(input.payload),
        publicQuadsCount: input.payload.length,
        privateTripleCount: 0,
        publicSnapshotRef: workspacePublicQuadsDigest(input.payload),
        publisherPeerId: 'peer-source',
        metadataQuads: [],
      },
      retire,
    })).resolves.toBe('retired');

    expect(retire).toHaveBeenCalledTimes(1);
    expect(await store.countQuads(input.swmGraph)).toBe(0);
  });

  it('preserves a newer or different SWM revision', async () => {
    const store = new OxigraphStore();
    const input = fixture();
    await seedTwin(store, input, { swmObject: '"newer"' });
    const retire = vi.fn(async () => {});

    await expect(reconcileFinalizedSwmTwin({
      store,
      writeLocks: new Map(),
      asset: input.asset,
      retire,
    })).resolves.toBe('content-mismatch');
    expect(retire).not.toHaveBeenCalled();
    expect(await store.countQuads(input.swmGraph)).toBe(input.payload.length);
  });

  it('preserves an identical SWM payload when its head is newer than finalized VM', async () => {
    const store = new OxigraphStore();
    const input = fixture();
    await seedTwin(store, input, { headVersion: 4n });
    const retire = vi.fn(async () => {});

    await expect(reconcileFinalizedSwmTwin({
      store,
      writeLocks: new Map(),
      asset: input.asset,
      retire,
    })).resolves.toBe('head-version-mismatch');
    expect(retire).not.toHaveBeenCalled();
  });

  it('preserves SWM when the current VM graph no longer matches the authenticated payload', async () => {
    const store = new OxigraphStore();
    const input = fixture();
    await seedTwin(store, input, { vmObject: '"changed-after-materialization"' });
    const retire = vi.fn(async () => {});

    await expect(reconcileFinalizedSwmTwin({
      store,
      writeLocks: new Map(),
      asset: input.asset,
      retire,
    })).resolves.toBe('vm-changed');
    expect(retire).not.toHaveBeenCalled();
  });

  it('treats the persistent worker empty-CONSTRUCT bindings shape as an absent VM graph', async () => {
    const store = new OxigraphStore();
    const input = fixture();
    await seedTwin(store, input);
    await store.dropGraph(input.asset.assertionGraph);
    const workerShapeStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'query') {
          return async (sparql: string, options?: Parameters<TripleStore['query']>[1]) => {
            if (sparql.includes(`GRAPH <${input.asset.assertionGraph}>`)) {
              return { type: 'bindings' as const, bindings: [] };
            }
            return target.query(sparql, options);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as TripleStore;
    const retire = vi.fn(async () => {});

    await expect(reconcileFinalizedSwmTwin({
      store: workerShapeStore,
      writeLocks: new Map(),
      asset: input.asset,
      retire,
    })).resolves.toBe('vm-changed');
    expect(retire).not.toHaveBeenCalled();
    expect(await store.countQuads(input.swmGraph)).toBe(input.payload.length);
  });

  it('re-checks the SWM head after waiting behind a live writer', async () => {
    const store = new OxigraphStore();
    const input = fixture();
    await seedTwin(store, input);
    const writeLocks = new Map<string, Promise<void>>();
    const lockKey = swmKaWriteLockKey(CG, undefined, UAL);
    let release!: () => void;
    let held!: () => void;
    const acquired = new Promise<void>((resolve) => { held = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const writer = withKeyedLocks(writeLocks, [lockKey], async () => {
      held();
      await gate;
      await store.deleteByPattern({
        graph: input.swmMetaGraph,
        subject: input.headSubject,
      });
      await seedTwin(store, input, { headVersion: 4n });
    });
    await acquired;
    const retire = vi.fn(async () => {});
    const reconciliation = reconcileFinalizedSwmTwin({
      store,
      writeLocks,
      asset: input.asset,
      retire,
    });
    release();
    await writer;

    await expect(reconciliation).resolves.toBe('head-version-mismatch');
    expect(retire).not.toHaveBeenCalled();
  });

  it('preserves unfinalized SWM v4 when finalized VM v3 has the same public bytes', async () => {
    const store = new OxigraphStore();
    const input = fixture();
    await seedTwin(store, input, { headVersion: 4n });
    const retire = vi.fn(async (candidate: FinalizedSwmTwinRetirement) => {
      await store.dropGraph(candidate.swmGraph);
    });

    const outcome = await reconcileFinalizedSwmTwinFromDescriptor({
      store,
      writeLocks: new Map(),
      contextGraphId: CG,
      descriptor: {
        metaGraph: input.swmMetaGraph,
        headSubject: input.headSubject,
        operationSubject: `urn:dkg:share:${CG}:op-v4`,
        kaUal: UAL,
        assertionVersion: '4',
        assertionGraph: input.swmGraph,
        shareOperationId: 'op-v4',
        publicQuadsDigest: workspacePublicQuadsDigest(input.payload),
        publicQuadsCount: input.payload.length,
        privateTripleCount: 0,
        publicSnapshotRef: workspacePublicQuadsDigest(input.payload),
        publisherPeerId: 'peer-source',
        metadataQuads: [],
      },
      retire,
    });

    expect(outcome).toBe('vm-metadata-mismatch');
    expect(retire).not.toHaveBeenCalled();
    expect(await store.countQuads(input.swmGraph)).toBe(input.payload.length);
  });

  it('retries metadata cleanup after a prior retirement removed only the graph', async () => {
    const store = new OxigraphStore();
    const input = fixture();
    await seedTwin(store, input);
    const partialRetire = vi.fn(async (candidate: FinalizedSwmTwinRetirement) => {
      await store.dropGraph(candidate.swmGraph);
      throw new Error('metadata delete failed');
    });

    await expect(reconcileFinalizedSwmTwin({
      store,
      writeLocks: new Map(),
      asset: input.asset,
      retire: partialRetire,
    })).rejects.toThrow('metadata delete failed');

    const retryRetire = vi.fn(async () => {
      await store.deleteByPattern({
        graph: input.swmMetaGraph,
        subject: input.headSubject,
      });
    });
    await expect(reconcileFinalizedSwmTwin({
      store,
      writeLocks: new Map(),
      asset: input.asset,
      retire: retryRetire,
    })).resolves.toBe('retired');
    expect(retryRetire).toHaveBeenCalledTimes(1);
    await expect(store.query(
      `ASK { GRAPH <${input.swmMetaGraph}> { <${input.headSubject}> ?p ?o } }`,
    )).resolves.toMatchObject({ type: 'boolean', value: false });
  });

  it('reports an exact already-retired state when a competing cleanup removed head and graph', async () => {
    const store = new OxigraphStore();
    const input = fixture();
    await seedTwin(store, input);
    await store.dropGraph(input.swmGraph);
    await store.deleteByPattern({
      graph: input.swmMetaGraph,
      subject: input.headSubject,
    });
    const operationSubject = `urn:dkg:share:${CG}:op-v3`;
    const retire = vi.fn(async () => {
      await store.deleteByPattern({
        graph: input.swmMetaGraph,
        subject: operationSubject,
      });
    });

    await expect(reconcileFinalizedSwmTwin({
      store,
      writeLocks: new Map(),
      asset: input.asset,
      retire,
    })).resolves.toBe('already-retired');
    expect(retire).toHaveBeenCalledTimes(1);
    await expect(store.query(
      `ASK { GRAPH <${input.swmMetaGraph}> { <${operationSubject}> ?p ?o } }`,
    )).resolves.toMatchObject({ type: 'boolean', value: false });
  });

  it('preserves matching public bytes when the SWM private commitment differs from VM', async () => {
    const vmPrivateRoot = new Uint8Array(32).fill(0x11);
    const swmPrivateRoot = new Uint8Array(32).fill(0x22);
    const store = new OxigraphStore();
    const input = fixture(undefined, { count: 2, root: vmPrivateRoot });
    await seedTwin(store, input, {
      swmPrivateTripleCount: 2,
      swmPrivateMerkleRoot: swmPrivateRoot,
    });
    const retire = vi.fn(async () => {});

    await expect(reconcileFinalizedSwmTwin({
      store,
      writeLocks: new Map(),
      asset: input.asset,
      retire,
    })).resolves.toBe('commitment-mismatch');
    expect(retire).not.toHaveBeenCalled();
    expect(await store.countQuads(input.swmGraph)).toBe(input.payload.length);
  });

  it('fails closed when the current SWM head points at another assertion graph', async () => {
    const store = new OxigraphStore();
    const input = fixture();
    await seedTwin(store, input);
    await store.deleteByPattern({
      graph: input.swmMetaGraph,
      subject: input.headSubject,
      predicate: `${DKG}assertionGraph`,
    });
    await store.insert([{
      subject: input.headSubject,
      predicate: `${DKG}assertionGraph`,
      object: `${input.swmGraph}/other`,
      graph: input.swmMetaGraph,
    }]);
    const retire = vi.fn(async () => {});

    await expect(reconcileFinalizedSwmTwin({
      store,
      writeLocks: new Map(),
      asset: input.asset,
      retire,
    })).resolves.toBe('head-missing-or-ambiguous');
    expect(retire).not.toHaveBeenCalled();
  });

  it('does not treat tentative VM metadata as finalized evidence', async () => {
    const store = new OxigraphStore();
    const input = fixture();
    await seedTwin(store, input);
    await store.deleteByPattern({
      graph: input.asset.metaGraph,
      subject: UAL,
      predicate: `${DKG}status`,
    });
    await store.insert([{
      subject: UAL,
      predicate: `${DKG}status`,
      object: '"tentative"',
      graph: input.asset.metaGraph,
    }]);
    const retire = vi.fn(async () => {});

    await expect(reconcileFinalizedSwmTwin({
      store,
      writeLocks: new Map(),
      asset: input.asset,
      retire,
    })).resolves.toBe('vm-metadata-mismatch');
    expect(retire).not.toHaveBeenCalled();
  });
});
