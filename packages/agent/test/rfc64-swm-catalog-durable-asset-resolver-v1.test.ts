import {
  ASSERTION_SEAL_PREDICATES,
  buildAssertionSealQuads,
  buildAuthorAttestationTypedData,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeKaProjectionDigestV1,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  contextGraphPrivateUri,
  createGraphKnowledgeAssetScope,
  encodeCanonicalCgSharedPublicRootProjectionV1,
  knowledgeAssetLayerGraphUri,
  MemoryLayer,
  type CanonicalGraphScopedAuthorSealV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type SwmAuthorInventoryRowV1,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  generateGraphKnowledgeAssetMetadata,
  storeKnowledgeAssetOperationPublicQuads,
  storeKnowledgeAssetWorkspaceHead,
} from '@origintrail-official/dkg-publisher';
import { GraphManager, OxigraphStore, StoreSchedulerBusyError, type Quad } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogRepairDiagnosticV1 } from '../src/rfc64/catalog-repair-diagnostics-v1.js';

import {
  resolveRfc64ConfirmedVmRepairCatalogAssetV1,
  resolveRfc64InventoryWorkspaceCatalogAssetV1,
} from
  '../src/rfc64/swm-catalog-durable-asset-resolver-v1.js';

const AUTHOR_WALLET = new ethers.Wallet(`0x${'73'.repeat(32)}`);
const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/durable-vm-fallback' as ContextGraphIdV1;
const ASSERTION_COORDINATE = 'retained-finalized-private-row';
const KAV10 = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
const KA_NUMBER = 17n;
const PROJECTION_QUADS: readonly Quad[] = Object.freeze([
  Object.freeze({
    subject: 'https://example.org/alice',
    predicate: 'https://schema.org/name',
    object: '"Alice"',
    graph: '',
  }),
]);
const PROJECTION_BYTES = encodeCanonicalCgSharedPublicRootProjectionV1(PROJECTION_QUADS);

let store: OxigraphStore;
let seal: CanonicalGraphScopedAuthorSealV1;
let row: SwmAuthorInventoryRowV1;

beforeEach(async () => {
  store = new OxigraphStore();
  seal = await createSeal();
  row = createInventoryRow(seal);
  await seedDurableSeal(store, seal);
});

describe('RFC-64 durable SWM inventory catalog asset resolver', () => {
  it('attributes an actual strict-seal queue timeout without leaking the asset identity', async () => {
    const cause = new StoreSchedulerBusyError('queue_wait_timeout', 'background', 'private-test-source');
    vi.spyOn(store, 'query').mockRejectedValueOnce(cause);
    const error = await resolve('public').catch((failure: unknown) => failure);
    expect(catalogRepairDiagnosticV1(error)).toEqual({
      kind: 'queue_wait', stage: 'seal',
      source: 'agent.rfc64.swmInventory.catalogReconcile.seal', stageElapsedMs: expect.any(Number),
    });
    expect(JSON.stringify(catalogRepairDiagnosticV1(error))).not.toContain(seal.kaUal);
    expect(error).toHaveProperty('cause', cause);
  });

  it('accepts an inventory operation id retained as an equivalent head alias', async () => {
    const graphManager = new GraphManager(store);
    const selectedAlias = 'newer-storage-ack-alias';
    await storeKnowledgeAssetOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH_ID,
      shareOperationId: row.shareOperationId,
      kaUal: seal.kaUal,
      assertionVersion: seal.assertionVersion,
      quads: PROJECTION_QUADS,
      privateTripleCount: 0,
      publisherPeerId: 'rfc64-finalized-catalog-test',
      accessPolicy: 'public',
      agentAddress: AUTHOR,
      timestamp: new Date('2026-09-01T00:00:00.000Z'),
    });
    const metaGraph = graphManager.sharedMemoryMetaUri(CONTEXT_GRAPH_ID);
    const originalSubject = `urn:dkg:share:${CONTEXT_GRAPH_ID}:${row.shareOperationId}`;
    const aliasSubject = `urn:dkg:share:${CONTEXT_GRAPH_ID}:${selectedAlias}`;
    const originalMetadata = await store.query(
      `CONSTRUCT { <${originalSubject}> ?p ?o } WHERE { GRAPH <${metaGraph}> { `
        + `<${originalSubject}> ?p ?o } }`,
    );
    if (originalMetadata.type !== 'quads') throw new Error('expected operation metadata');
    await store.insert(originalMetadata.quads
      .filter((quad) => !quad.predicate.endsWith('publicSnapshotGraph')
        && !quad.predicate.endsWith('publicSnapshotRef'))
      .map((quad) => ({
        ...quad,
        graph: metaGraph,
        subject: aliasSubject,
        object: quad.predicate.endsWith('shareOperationId')
          ? JSON.stringify(selectedAlias)
          : quad.predicate.endsWith('publishedAt')
            ? JSON.stringify('2026-09-01T00:00:01.000Z')
            : quad.object,
      })));
    await storeKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH_ID,
      shareOperationId: row.shareOperationId,
      kaUal: seal.kaUal,
      assertionVersion: seal.assertionVersion,
    });
    await store.insert([{
      subject: `${seal.kaUal}#dkg-swm-head`,
      predicate: 'http://dkg.io/ontology/shareOperationId',
      object: JSON.stringify(selectedAlias),
      graph: metaGraph,
    }]);

    await expect(resolve('public')).resolves.toMatchObject({
      assertionCoordinate: ASSERTION_COORDINATE,
      projectionBytes: PROJECTION_BYTES,
      seal,
    });
  });

  it('uses an exact finalized VM projection for a retained private row without an SWM head', async () => {
    await seedVmProjection(store, seal, PROJECTION_QUADS);

    await expect(resolve('private')).resolves.toMatchObject({
      assertionCoordinate: ASSERTION_COORDINATE,
      projectionBytes: PROJECTION_BYTES,
      seal,
    });
  });

  it('does not permit the finalized VM fallback for a public lane', async () => {
    await seedVmProjection(store, seal, PROJECTION_QUADS);

    await expect(resolve('public')).rejects.toThrow(
      `durable RFC-64 workspace head differs for ${seal.kaUal}`,
    );
  });

  it('rejects a finalized VM projection that differs from the signed inventory row', async () => {
    await seedVmProjection(store, seal, PROJECTION_QUADS);
    row = Object.freeze({
      ...row,
      projectionDigest: `0x${'ef'.repeat(32)}` as Digest32V1,
    });

    await expect(resolve('private')).rejects.toThrow(
      `durable RFC-64 projection differs from signed inventory row ${seal.kaUal}`,
    );
  });

  it('rejects finalized VM bytes that differ from the strict author seal', async () => {
    await seedVmProjection(store, seal, [{
      ...PROJECTION_QUADS[0]!,
      object: '"Mallory"',
    }]);

    await expect(resolve('private')).rejects.toThrow(
      `durable finalized VM projection differs for ${seal.kaUal}`,
    );
  });

  it('rejects a missing finalized VM projection', async () => {
    await seedVmProjection(store, seal, []);

    await expect(resolve('private')).rejects.toThrow(
      `durable finalized VM projection differs for ${seal.kaUal}`,
    );
  });

  it('rejects a headless private update when VM metadata confirms an older version', async () => {
    const confirmedV1 = await createSeal({
      assertionVersion: '1',
      privateMerkleRoot: `0x${'11'.repeat(32)}` as Digest32V1,
    });
    seal = await createSeal({
      assertionVersion: '2',
      privateMerkleRoot: `0x${'22'.repeat(32)}` as Digest32V1,
    });
    row = createInventoryRow(seal);
    store = new OxigraphStore();
    await seedDurableSeal(store, seal);
    await seedVmProjection(store, confirmedV1, PROJECTION_QUADS);

    await expect(resolve('private')).rejects.toThrow(
      `durable finalized VM projection differs for ${seal.kaUal}`,
    );
  });

  it('accepts a headless private update when VM metadata confirms the exact version', async () => {
    seal = await createSeal({
      assertionVersion: '2',
      privateMerkleRoot: `0x${'22'.repeat(32)}` as Digest32V1,
    });
    row = createInventoryRow(seal);
    store = new OxigraphStore();
    await seedDurableSeal(store, seal);
    await seedVmProjection(store, seal, PROJECTION_QUADS);

    await expect(resolve('private')).resolves.toMatchObject({
      assertionCoordinate: ASSERTION_COORDINATE,
      projectionBytes: PROJECTION_BYTES,
      seal,
    });
  });

  it('uses verified VM for confirmed repair when the matching head has no usable locator', async () => {
    seal = await createSeal({ privateMerkleRoot: `0x${'22'.repeat(32)}` as Digest32V1 });
    store = new OxigraphStore();
    await seedDurableSeal(store, seal);
    await seedVmProjection(store, seal, PROJECTION_QUADS);
    const graphManager = new GraphManager(store);
    const operationId = 'confirmed-locatorless';
    await storeKnowledgeAssetOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH_ID,
      shareOperationId: operationId,
      kaUal: seal.kaUal,
      assertionVersion: seal.assertionVersion,
      quads: PROJECTION_QUADS,
      privateMerkleRoot: ethers.getBytes(seal.privateMerkleRoot!),
      privateTripleCount: 1,
      publisherPeerId: 'rfc64-finalized-catalog-test',
      accessPolicy: 'ownerOnly',
      agentAddress: AUTHOR,
      timestamp: new Date('2026-09-01T00:00:00.000Z'),
    });
    await storeKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH_ID,
      shareOperationId: operationId,
      kaUal: seal.kaUal,
      assertionVersion: seal.assertionVersion,
    });
    await store.deleteByPattern({
      graph: graphManager.sharedMemoryMetaUri(CONTEXT_GRAPH_ID),
      subject: `urn:dkg:share:${CONTEXT_GRAPH_ID}:${operationId}`,
      predicate: 'http://dkg.io/ontology/publicSnapshotGraph',
    });

    await expect(resolveRfc64ConfirmedVmRepairCatalogAssetV1({
      store,
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
      identity: {
        assertionCoordinate: ASSERTION_COORDINATE,
        assertionVersion: seal.assertionVersion,
        kaUal: seal.kaUal,
        sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(seal),
      },
    })).resolves.toMatchObject({
      assertionCoordinate: ASSERTION_COORDINATE,
      projectionBytes: PROJECTION_BYTES,
      seal,
    });
  });
});

describe('RFC-64 durable catalog asset resolver after the assertion was re-opened for editing', () => {
  function resolveConfirmedRepair(canonicalSeal: CanonicalGraphScopedAuthorSealV1) {
    return resolveRfc64ConfirmedVmRepairCatalogAssetV1({
      store,
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
      identity: {
        assertionCoordinate: ASSERTION_COORDINATE,
        assertionVersion: canonicalSeal.assertionVersion,
        kaUal: canonicalSeal.kaUal,
        sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(canonicalSeal),
      },
    });
  }

  it('places a confirmed repair from the archived seal when the active seal is gone', async () => {
    await seedVmProjection(store, seal, PROJECTION_QUADS);
    await reopenForEditing(store);

    await expect(resolveConfirmedRepair(seal)).resolves.toMatchObject({
      assertionCoordinate: ASSERTION_COORDINATE,
      projectionBytes: PROJECTION_BYTES,
      seal,
    });
  });

  it('places a retained private row from the archived seal when the next version is already sealed', async () => {
    const nextVersion = await createSeal({
      assertionVersion: '2',
      privateMerkleRoot: `0x${'22'.repeat(32)}` as Digest32V1,
    });
    await seedVmProjection(store, seal, PROJECTION_QUADS);
    await reopenForEditing(store);
    await seedDurableSeal(store, nextVersion);

    await expect(resolve('private')).resolves.toMatchObject({
      assertionCoordinate: ASSERTION_COORDINATE,
      projectionBytes: PROJECTION_BYTES,
      seal,
    });
    await expect(resolveConfirmedRepair(seal)).resolves.toMatchObject({ seal });
  });

  it('keeps a shared public row resolvable for the ordinary projection', async () => {
    // The row is still in the author's signed inventory while its assertion is open for editing,
    // and one row that cannot be resolved fails the whole projection of that author.
    const graphManager = new GraphManager(store);
    await storeKnowledgeAssetOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH_ID,
      shareOperationId: row.shareOperationId,
      kaUal: seal.kaUal,
      assertionVersion: seal.assertionVersion,
      quads: PROJECTION_QUADS,
      privateTripleCount: 0,
      publisherPeerId: 'rfc64-finalized-catalog-test',
      accessPolicy: 'public',
      agentAddress: AUTHOR,
      timestamp: new Date('2026-09-01T00:00:00.000Z'),
    });
    await storeKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH_ID,
      shareOperationId: row.shareOperationId,
      kaUal: seal.kaUal,
      assertionVersion: seal.assertionVersion,
    });
    await reopenForEditing(store);

    await expect(resolve('public')).resolves.toMatchObject({
      assertionCoordinate: ASSERTION_COORDINATE,
      projectionBytes: PROJECTION_BYTES,
      seal,
    });
  });

  it('keeps refusing an identity that neither the active nor the archived seal carries', async () => {
    const other = await createSeal({
      assertionVersion: '2',
      privateMerkleRoot: `0x${'22'.repeat(32)}` as Digest32V1,
    });
    await seedVmProjection(store, seal, PROJECTION_QUADS);
    await reopenForEditing(store);

    // Only the archive exists and it holds version 1: version 2 has no seal at all.
    await expect(resolveConfirmedRepair(other)).rejects.toThrow(
      `durable RFC-64 catalog asset ${other.kaUal} has no strict author seal`,
    );
    // With version 2 sealed as the active seal, a third identity differs from both.
    await seedDurableSeal(store, other);
    const third = await createSeal({
      assertionVersion: '3',
      privateMerkleRoot: `0x${'33'.repeat(32)}` as Digest32V1,
    });
    await expect(resolveConfirmedRepair(third)).rejects.toThrow(
      `durable RFC-64 catalog asset ${third.kaUal} has a different author seal`,
    );
  });

  it('does not let an active seal that cannot be canonicalized shadow the archived one', async () => {
    const nextVersion = await createSeal({
      assertionVersion: '2',
      privateMerkleRoot: `0x${'22'.repeat(32)}` as Digest32V1,
    });
    await seedVmProjection(store, seal, PROJECTION_QUADS);
    await reopenForEditing(store);
    // The active subject carries a seal without the reserved-id binding: it parses, and it has no
    // canonical form.
    await seedDurableSeal(store, nextVersion);
    await store.deleteByPattern({
      graph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
      subject: contextGraphAssertionUri(CONTEXT_GRAPH_ID, AUTHOR, ASSERTION_COORDINATE),
      predicate: ASSERTION_SEAL_PREDICATES.RESERVED_KA_ID,
    });

    await expect(resolveConfirmedRepair(seal)).resolves.toMatchObject({ seal });
    // An identity the archive does not carry either is still reported by the strict path.
    await expect(resolveConfirmedRepair(nextVersion)).rejects.toThrow(
      'conversion requires a complete graph-scoped v2 author seal',
    );
  });

  it('still verifies the content against the archived seal', async () => {
    await seedVmProjection(store, seal, [{ ...PROJECTION_QUADS[0]!, object: '"Mallory"' }]);
    await reopenForEditing(store);

    await expect(resolveConfirmedRepair(seal)).rejects.toThrow(
      `durable finalized VM projection differs for ${seal.kaUal}`,
    );
  });

  it('does not read the archive while the active seal is the identity\'s', async () => {
    await seedVmProjection(store, seal, PROJECTION_QUADS);
    const query = vi.spyOn(store, 'query');

    await expect(resolveConfirmedRepair(seal)).resolves.toMatchObject({ seal });
    expect(query.mock.calls.filter(([sparql]) => String(sparql).includes('_recovery_seal'))).toEqual([]);
  });
});

/**
 * What a pull-from leaves of the seal: the active seal's predicates copied to the archive subject
 * in the private partition, and the active subject cleared.
 */
async function reopenForEditing(target: OxigraphStore): Promise<void> {
  const assertionUri = contextGraphAssertionUri(CONTEXT_GRAPH_ID, AUTHOR, ASSERTION_COORDINATE);
  const metaGraph = contextGraphMetaUri(CONTEXT_GRAPH_ID);
  const active = await target.query(
    `CONSTRUCT { <${assertionUri}> ?p ?o } WHERE { GRAPH <${metaGraph}> { <${assertionUri}> ?p ?o } }`,
  );
  if (active.type !== 'quads' || active.quads.length === 0) throw new Error('expected an active seal');
  await target.insert(active.quads.map((quad) => ({
    ...quad,
    subject: `${assertionUri}/_recovery_seal`,
    graph: contextGraphPrivateUri(CONTEXT_GRAPH_ID),
  })));
  await target.deleteByPattern({ graph: metaGraph, subject: assertionUri });
}

function resolve(laneKind: 'public' | 'private') {
  return resolveRfc64InventoryWorkspaceCatalogAssetV1({
    store,
    contextGraphId: CONTEXT_GRAPH_ID,
    authorAddress: AUTHOR,
    laneKind,
    row,
  });
}

function createInventoryRow(
  canonicalSeal: CanonicalGraphScopedAuthorSealV1,
): SwmAuthorInventoryRowV1 {
  return Object.freeze({
    assertionCoordinate: ASSERTION_COORDINATE,
    assertionVersion: canonicalSeal.assertionVersion,
    kaUal: canonicalSeal.kaUal,
    shareOperationId: 'retired-workspace-operation',
    projectionDigest: computeKaProjectionDigestV1(PROJECTION_BYTES),
    publicTripleCount: canonicalSeal.publicTripleCount,
    privateTripleCount: canonicalSeal.privateTripleCount,
    sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(canonicalSeal),
    sharedAt: '1788192000000',
    expiresAt: null,
  }) as SwmAuthorInventoryRowV1;
}

async function createSeal(options: Readonly<{
  assertionVersion?: string;
  privateMerkleRoot?: Digest32V1;
}> = {}): Promise<CanonicalGraphScopedAuthorSealV1> {
  const privateMerkleRoot = options.privateMerkleRoot ?? null;
  const assertionMerkleRoot = ethers.hexlify(
    computeFlatKCRootV10(
      [...PROJECTION_QUADS],
      privateMerkleRoot === null ? [] : [ethers.getBytes(privateMerkleRoot)],
    ),
  ) as Digest32V1;
  const reservedKaId = ((BigInt(AUTHOR) << 96n) | KA_NUMBER).toString();
  const typedData = buildAuthorAttestationTypedData({
    chainId: 20430n,
    kav10Address: KAV10,
    merkleRoot: ethers.getBytes(assertionMerkleRoot),
    authorAddress: AUTHOR,
    reservedKaId: BigInt(reservedKaId),
  });
  const signature = ethers.Signature.from(await AUTHOR_WALLET.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  ));
  return Object.freeze({
    assertionMerkleRoot,
    authorAddress: AUTHOR,
    authorAttestationR: signature.r,
    authorAttestationVS: signature.yParityAndS,
    authorSchemeVersion: '1',
    assertedAtChainId: '20430',
    assertedAtKav10Address: KAV10,
    reservedKaId,
    assertionFinalizedAt: '2026-09-01T00:00:00.000Z',
    contentScopeVersion: '2',
    kaUal: `did:dkg:otp:20430/${AUTHOR}/${KA_NUMBER}`,
    assertionVersion: options.assertionVersion ?? '1',
    publicTripleCount: String(PROJECTION_QUADS.length),
    privateTripleCount: privateMerkleRoot === null ? '0' : '1',
    privateMerkleRoot,
  }) as CanonicalGraphScopedAuthorSealV1;
}

async function seedDurableSeal(
  target: OxigraphStore,
  canonicalSeal: CanonicalGraphScopedAuthorSealV1,
): Promise<void> {
  const assertionUri = contextGraphAssertionUri(
    CONTEXT_GRAPH_ID,
    AUTHOR,
    ASSERTION_COORDINATE,
  );
  await target.insert(buildAssertionSealQuads({
    assertionUri,
    metaGraph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
    merkleRoot: ethers.getBytes(canonicalSeal.assertionMerkleRoot),
    authorAddress: canonicalSeal.authorAddress,
    authorAttestationR: ethers.getBytes(canonicalSeal.authorAttestationR),
    authorAttestationVS: ethers.getBytes(canonicalSeal.authorAttestationVS),
    authorSchemeVersion: 1,
    chainId: BigInt(canonicalSeal.assertedAtChainId),
    kav10Address: canonicalSeal.assertedAtKav10Address,
    reservedKaId: BigInt(canonicalSeal.reservedKaId),
    finalizedAtIso: canonicalSeal.assertionFinalizedAt,
    contentScopeVersion: 2,
    kaUal: canonicalSeal.kaUal,
    assertionVersion: canonicalSeal.assertionVersion,
    publicTripleCount: Number(canonicalSeal.publicTripleCount),
    ...(canonicalSeal.privateMerkleRoot === null
      ? {}
      : { privateMerkleRoot: ethers.getBytes(canonicalSeal.privateMerkleRoot) }),
    privateTripleCount: Number(canonicalSeal.privateTripleCount),
  }));
}

async function seedVmProjection(
  target: OxigraphStore,
  canonicalSeal: CanonicalGraphScopedAuthorSealV1,
  quads: readonly Quad[],
): Promise<void> {
  const vmGraph = knowledgeAssetLayerGraphUri(
    CONTEXT_GRAPH_ID,
    MemoryLayer.VerifiableMemory,
    createGraphKnowledgeAssetScope(
      canonicalSeal.kaUal,
      canonicalSeal.assertionVersion,
    ),
  );
  await target.insert([
    ...quads.map((quad) => ({ ...quad, graph: vmGraph })),
    ...generateGraphKnowledgeAssetMetadata({
      contextGraphId: CONTEXT_GRAPH_ID,
      ual: canonicalSeal.kaUal,
      merkleRoot: ethers.getBytes(canonicalSeal.assertionMerkleRoot),
      publisherPeerId: 'rfc64-finalized-catalog-test',
      authorAddress: canonicalSeal.authorAddress,
      accessPolicy: 'ownerOnly',
      allowedPeers: [],
      timestamp: new Date(canonicalSeal.assertionFinalizedAt),
      assertionVersion: canonicalSeal.assertionVersion,
      publicTripleCount: Number(canonicalSeal.publicTripleCount),
      privateTripleCount: Number(canonicalSeal.privateTripleCount),
      ...(canonicalSeal.privateMerkleRoot === null
        ? {}
        : { privateMerkleRoot: ethers.getBytes(canonicalSeal.privateMerkleRoot) }),
      assertionGraph: vmGraph,
    }, {
      status: 'confirmed',
      confirmation: {
        kind: 'finalized-materialization',
        provenance: {
          batchId: BigInt(canonicalSeal.reservedKaId),
          materializedVersion: { blockNumber: 1, txIndex: 0 },
        },
      },
    }),
  ]);
}
