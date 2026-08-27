import { describe, expect, it, vi } from 'vitest';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  generateKnowledgeAssetShareMetadata,
  swmKaWriteLockKey,
  withKeyedLocks,
  workspacePublicQuadsDigest,
} from '@origintrail-official/dkg-publisher';
import { OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import {
  reconcileFinalizedSwmTwin,
  reconcileFinalizedSwmTwinFromCatalogProjection,
  reconcileFinalizedSwmTwinFromDescriptor,
  type FinalizedSwmTwinRetirement,
} from '../src/sync/requester/finalized-swm-twin-reconciliation.js';
import { parseGraphScopedSwmRecoveryDescriptors } from '../src/sync/graph-scoped-swm-recovery.js';
import type { VerifiedGraphScopedAsset } from '../src/sync/requester/graph-scoped-materialization.js';

const CG = 'durable-vm-swm-twin';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const UAL = `did:dkg:base:8453/${AUTHOR}/17`;
const DKG = 'http://dkg.io/ontology/';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const OPERATION_ID = 'op-finalized-twin';

function fixture(
  subGraphName?: string,
  privateCommitment?: Readonly<{ tripleCount: number; merkleRoot: string }>,
): Readonly<{
  asset: VerifiedGraphScopedAsset;
  swmGraph: string;
  swmMetaGraph: string;
  headSubject: string;
  payload: Quad[];
  privateTripleCount: number;
  privateMerkleRoot?: string;
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
  const privateTripleCount = privateCommitment?.tripleCount ?? 0;
  const privateMerkleRoot = privateCommitment?.merkleRoot;
  const merkleRoot = ethers.hexlify(computeFlatKCRootV10(
    payload.map((quad) => ({ ...quad, graph: '' })),
    privateMerkleRoot === undefined ? [] : [ethers.getBytes(privateMerkleRoot)],
  ));
  const metaGraph = `did:dkg:context-graph:${CG}/_meta`;
  const metadataQuads: Quad[] = [
    { subject: UAL, predicate: `${DKG}assertionVersion`, object: `"3"^^<${XSD_INTEGER}>`, graph: metaGraph },
    { subject: UAL, predicate: `${DKG}assertionGraph`, object: vmGraph, graph: metaGraph },
    { subject: UAL, predicate: `${DKG}status`, object: '"confirmed"', graph: metaGraph },
    { subject: UAL, predicate: `${DKG}publicTripleCount`, object: `"${payload.length}"^^<${XSD_INTEGER}>`, graph: metaGraph },
    { subject: UAL, predicate: `${DKG}privateTripleCount`, object: `"${privateTripleCount}"^^<${XSD_INTEGER}>`, graph: metaGraph },
    ...(privateMerkleRoot === undefined
      ? []
      : [{ subject: UAL, predicate: `${DKG}privateMerkleRoot`, object: `"${privateMerkleRoot}"`, graph: metaGraph }]),
    { subject: UAL, predicate: `${DKG}merkleRoot`, object: `"${merkleRoot}"`, graph: metaGraph },
    ...(subGraphName === undefined
      ? []
      : [{ subject: UAL, predicate: `${DKG}subGraphName`, object: `"${subGraphName}"`, graph: metaGraph }]),
  ];
  return {
    asset: {
      contextGraphId: CG,
      ual: UAL,
      assertionVersion: 3n,
      assertionGraph: vmGraph,
      metaGraph,
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
    ...(privateMerkleRoot === undefined ? {} : { privateMerkleRoot }),
  };
}

async function seedTwin(
  store: OxigraphStore,
  input: ReturnType<typeof fixture>,
  options: Readonly<{
    swmObject?: string;
    vmObject?: string;
    headVersion?: bigint;
  }> = {},
): Promise<void> {
  const version = options.headVersion ?? input.asset.assertionVersion;
  await store.insert([
    ...input.payload.map((quad) => ({
      ...quad,
      ...(options.vmObject === undefined ? {} : { object: options.vmObject }),
    })),
    ...input.asset.metadataQuads,
    ...input.payload.map((quad) => ({
      ...quad,
      graph: input.swmGraph,
      ...(options.swmObject === undefined ? {} : { object: options.swmObject }),
    })),
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
      object: `"${OPERATION_ID}"`,
      graph: input.swmMetaGraph,
    },
    {
      subject: `urn:dkg:share:${CG}:${OPERATION_ID}`,
      predicate: `${DKG}shareOperationId`,
      object: `"${OPERATION_ID}"`,
      graph: input.swmMetaGraph,
    },
    {
      subject: `urn:dkg:share:${CG}:${OPERATION_ID}`,
      predicate: `${DKG}kaUal`,
      object: UAL,
      graph: input.swmMetaGraph,
    },
    {
      subject: `urn:dkg:share:${CG}:${OPERATION_ID}`,
      predicate: `${DKG}assertionVersion`,
      object: `"${version.toString()}"^^<${XSD_INTEGER}>`,
      graph: input.swmMetaGraph,
    },
    {
      subject: `urn:dkg:share:${CG}:${OPERATION_ID}`,
      predicate: `${DKG}publicQuadsDigest`,
      object: `"${workspacePublicQuadsDigest(input.payload)}"`,
      graph: input.swmMetaGraph,
    },
    {
      subject: `urn:dkg:share:${CG}:${OPERATION_ID}`,
      predicate: `${DKG}publicQuadsCount`,
      object: `"${input.payload.length}"^^<${XSD_INTEGER}>`,
      graph: input.swmMetaGraph,
    },
    {
      subject: `urn:dkg:share:${CG}:${OPERATION_ID}`,
      predicate: `${DKG}privateTripleCount`,
      object: `"${input.privateTripleCount}"^^<${XSD_INTEGER}>`,
      graph: input.swmMetaGraph,
    },
    ...(input.privateMerkleRoot === undefined
      ? []
      : [{
          subject: `urn:dkg:share:${CG}:${OPERATION_ID}`,
          predicate: `${DKG}privateMerkleRoot`,
          object: `"${input.privateMerkleRoot}"`,
          graph: input.swmMetaGraph,
        }]),
  ]);
}

function descriptorFor(input: ReturnType<typeof fixture>) {
  return {
    metaGraph: input.swmMetaGraph,
    headSubject: input.headSubject,
    operationSubject: `urn:dkg:share:${CG}:${OPERATION_ID}`,
    kaUal: UAL,
    assertionVersion: input.asset.assertionVersion.toString(),
    assertionGraph: input.swmGraph,
    shareOperationId: OPERATION_ID,
    publicQuadsDigest: workspacePublicQuadsDigest(input.payload),
    publicQuadsCount: input.payload.length,
    privateTripleCount: input.privateTripleCount,
    ...(input.privateMerkleRoot === undefined
      ? {}
      : { privateMerkleRoot: input.privateMerkleRoot }),
    publicSnapshotRef: workspacePublicQuadsDigest(input.payload),
    publisherPeerId: 'peer-source',
    metadataQuads: [],
  } as const;
}

function catalogEvidenceFor(input: ReturnType<typeof fixture>) {
  const expectedMerkleRoot = ethers.hexlify(computeFlatKCRootV10(
    input.payload.map((quad) => ({ ...quad, graph: '' })),
    input.privateMerkleRoot === undefined ? [] : [ethers.getBytes(input.privateMerkleRoot)],
  ));
  return {
    contextGraphId: CG,
    kaUal: UAL,
    assertionVersion: input.asset.assertionVersion.toString(),
    publicQuadsDigest: workspacePublicQuadsDigest(input.payload),
    publicQuadsCount: input.payload.length,
    privateTripleCount: input.privateTripleCount,
    ...(input.privateMerkleRoot === undefined
      ? {}
      : { privateMerkleRoot: input.privateMerkleRoot }),
    expectedMerkleRoot,
  } as const;
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
      descriptor: descriptorFor(input),
      retire,
    })).resolves.toBe('retired');

    expect(retire).toHaveBeenCalledTimes(1);
    expect(await store.countQuads(input.swmGraph)).toBe(0);
  });

  it('retires an exact catalog-staged SWM twin without a WorkspaceOperation head', async () => {
    const store = new OxigraphStore();
    const input = fixture();
    await seedTwin(store, input);
    await store.deleteByPattern({ graph: input.swmMetaGraph, subject: input.headSubject });
    await store.deleteByPattern({
      graph: input.swmMetaGraph,
      subject: `urn:dkg:share:${CG}:${OPERATION_ID}`,
    });
    const retire = vi.fn(async (candidate: FinalizedSwmTwinRetirement) => {
      await store.dropGraph(candidate.swmGraph);
    });

    await expect(reconcileFinalizedSwmTwinFromCatalogProjection({
      store,
      writeLocks: new Map(),
      evidence: catalogEvidenceFor(input),
      retire,
    })).resolves.toBe('retired');

    expect(retire).toHaveBeenCalledTimes(1);
    expect(await store.countQuads(input.swmGraph)).toBe(0);
  });

  it('preserves a catalog-staged SWM twin when the author-signed root differs', async () => {
    const store = new OxigraphStore();
    const input = fixture();
    await seedTwin(store, input);
    await store.deleteByPattern({ graph: input.swmMetaGraph, subject: input.headSubject });
    await store.deleteByPattern({
      graph: input.swmMetaGraph,
      subject: `urn:dkg:share:${CG}:${OPERATION_ID}`,
    });
    const retire = vi.fn(async () => {});

    await expect(reconcileFinalizedSwmTwinFromCatalogProjection({
      store,
      writeLocks: new Map(),
      evidence: {
        ...catalogEvidenceFor(input),
        expectedMerkleRoot: `0x${'ff'.repeat(32)}`,
      },
      retire,
    })).resolves.toBe('vm-metadata-mismatch');

    expect(retire).not.toHaveBeenCalled();
    expect(await store.countQuads(input.swmGraph)).toBe(input.payload.length);
  });

  it.each(['vm-arrival', 'swm-arrival'] as const)(
    'retires a byte-identical twin with matching private commitments on %s',
    async (arrival) => {
      const store = new OxigraphStore();
      const privateMerkleRoot = `0x${'ab'.repeat(32)}`;
      const input = fixture(undefined, { tripleCount: 1, merkleRoot: privateMerkleRoot });
      await seedTwin(store, input);
      const retire = vi.fn(async (candidate: FinalizedSwmTwinRetirement) => {
        await store.dropGraph(candidate.swmGraph);
      });

      const result = arrival === 'vm-arrival'
        ? reconcileFinalizedSwmTwin({
            store,
            writeLocks: new Map(),
            asset: input.asset,
            retire,
          })
        : reconcileFinalizedSwmTwinFromDescriptor({
            store,
            writeLocks: new Map(),
            contextGraphId: CG,
            descriptor: descriptorFor(input),
            retire,
          });

      await expect(result).resolves.toBe('retired');
      expect(retire).toHaveBeenCalledTimes(1);
      expect(await store.countQuads(input.swmGraph)).toBe(0);
    },
  );

  it('parses and reconciles a matching non-zero private commitment end to end', async () => {
    const store = new OxigraphStore();
    const privateMerkleRoot = `0x${'cd'.repeat(32)}`;
    const input = fixture(undefined, { tripleCount: 1, merkleRoot: privateMerkleRoot });
    await seedTwin(store, input);
    const operationSubject = `urn:dkg:share:${CG}:${OPERATION_ID}`;
    const parsedMeta: Quad[] = [
      ...generateKnowledgeAssetShareMetadata({
        shareOperationId: OPERATION_ID,
        contextGraphId: CG,
        kaUal: UAL,
        assertionVersion: 3,
        publicTripleCount: input.payload.length,
        privateTripleCount: 1,
        privateMerkleRoot: ethers.getBytes(privateMerkleRoot),
        publisherPeerId: 'peer-source',
        timestamp: new Date(0),
      }, input.swmMetaGraph),
      {
        subject: operationSubject,
        predicate: `${DKG}publicQuadsDigest`,
        object: `"${workspacePublicQuadsDigest(input.payload)}"`,
        graph: input.swmMetaGraph,
      },
      {
        subject: operationSubject,
        predicate: `${DKG}publicSnapshotRef`,
        object: `"${workspacePublicQuadsDigest(input.payload)}"`,
        graph: input.swmMetaGraph,
      },
      {
        subject: input.headSubject,
        predicate: `${DKG}contentScopeVersion`,
        object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${XSD_INTEGER}>`,
        graph: input.swmMetaGraph,
      },
      { subject: input.headSubject, predicate: `${DKG}kaUal`, object: UAL, graph: input.swmMetaGraph },
      {
        subject: input.headSubject,
        predicate: `${DKG}assertionVersion`,
        object: `"3"^^<${XSD_INTEGER}>`,
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
        object: `"${OPERATION_ID}"`,
        graph: input.swmMetaGraph,
      },
    ];
    const descriptors = parseGraphScopedSwmRecoveryDescriptors({
      contextGraphId: CG,
      metaQuads: parsedMeta,
    });
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      privateTripleCount: 1,
      privateMerkleRoot: privateMerkleRoot.toLowerCase(),
    });
    const retire = vi.fn(async (candidate: FinalizedSwmTwinRetirement) => {
      await store.dropGraph(candidate.swmGraph);
    });

    await expect(reconcileFinalizedSwmTwinFromDescriptor({
      store,
      writeLocks: new Map(),
      contextGraphId: CG,
      descriptor: descriptors[0]!,
      retire,
    })).resolves.toBe('retired');
    expect(retire).toHaveBeenCalledTimes(1);
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

  it('preserves SWM when its active operation has a different private commitment', async () => {
    const store = new OxigraphStore();
    const input = fixture();
    await seedTwin(store, input);
    const operationSubject = `urn:dkg:share:${CG}:${OPERATION_ID}`;
    await store.deleteByPattern({
      graph: input.swmMetaGraph,
      subject: operationSubject,
      predicate: `${DKG}privateTripleCount`,
    });
    await store.insert([
      {
        subject: operationSubject,
        predicate: `${DKG}privateTripleCount`,
        object: `"1"^^<${XSD_INTEGER}>`,
        graph: input.swmMetaGraph,
      },
      {
        subject: operationSubject,
        predicate: `${DKG}privateMerkleRoot`,
        object: `"0x${'11'.repeat(32)}"`,
        graph: input.swmMetaGraph,
      },
    ]);
    const retire = vi.fn(async () => {});

    await expect(reconcileFinalizedSwmTwin({
      store,
      writeLocks: new Map(),
      asset: input.asset,
      retire,
    })).resolves.toBe('swm-commitment-mismatch');
    expect(retire).not.toHaveBeenCalled();
  });

  it('requires current VM metadata to remain confirmed at the exact assertion version', async () => {
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

    await expect(reconcileFinalizedSwmTwinFromDescriptor({
      store,
      writeLocks: new Map(),
      contextGraphId: CG,
      descriptor: descriptorFor(input),
      retire,
    })).resolves.toBe('vm-metadata-mismatch');
    expect(retire).not.toHaveBeenCalled();
  });

  it('fails closed when the current head points at another assertion graph', async () => {
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
      object: `${input.swmGraph}-other`,
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

  it('finishes metadata retirement after a prior attempt removed only the SWM graph', async () => {
    const store = new OxigraphStore();
    const input = fixture();
    await seedTwin(store, input);
    const firstRetire = vi.fn(async (candidate: FinalizedSwmTwinRetirement) => {
      await store.dropGraph(candidate.swmGraph);
      throw new Error('metadata delete failed');
    });
    await expect(reconcileFinalizedSwmTwin({
      store,
      writeLocks: new Map(),
      asset: input.asset,
      retire: firstRetire,
    })).rejects.toThrow('metadata delete failed');

    const retryRetire = vi.fn(async () => {});
    await expect(reconcileFinalizedSwmTwin({
      store,
      writeLocks: new Map(),
      asset: input.asset,
      retire: retryRetire,
    })).resolves.toBe('retired');
    expect(retryRetire).toHaveBeenCalledTimes(1);
  });

  it('classifies a concurrently completed SWM cleanup as terminal for bulk metadata', async () => {
    const store = new OxigraphStore();
    const input = fixture();
    await seedTwin(store, input);
    await store.dropGraph(input.swmGraph);
    await store.deleteByPattern({ graph: input.swmMetaGraph, subject: input.headSubject });
    await store.deleteByPattern({
      graph: input.swmMetaGraph,
      subject: `urn:dkg:share:${CG}:${OPERATION_ID}`,
    });
    const retire = vi.fn(async () => {});

    await expect(reconcileFinalizedSwmTwinFromDescriptor({
      store,
      writeLocks: new Map(),
      contextGraphId: CG,
      descriptor: descriptorFor(input),
      retire,
    })).resolves.toBe('already-retired-finalized');
    expect(retire).not.toHaveBeenCalled();
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
        predicate: `${DKG}assertionVersion`,
      });
      await store.insert([{
        subject: input.headSubject,
        predicate: `${DKG}assertionVersion`,
        object: `"4"^^<${XSD_INTEGER}>`,
        graph: input.swmMetaGraph,
      }]);
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
});
