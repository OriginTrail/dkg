import {
  buildAssertionSealQuads,
  buildAuthorAttestationTypedData,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeKaProjectionDigestV1,
  contextGraphAssertionUri,
  contextGraphMetaUri,
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
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { beforeEach, describe, expect, it } from 'vitest';

import { resolveRfc64InventoryWorkspaceCatalogAssetV1 } from
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
  row = Object.freeze({
    assertionCoordinate: ASSERTION_COORDINATE,
    assertionVersion: seal.assertionVersion,
    kaUal: seal.kaUal,
    shareOperationId: 'retired-workspace-operation',
    projectionDigest: computeKaProjectionDigestV1(PROJECTION_BYTES),
    publicTripleCount: seal.publicTripleCount,
    privateTripleCount: seal.privateTripleCount,
    sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(seal),
    sharedAt: '1788192000000',
    expiresAt: null,
  }) as SwmAuthorInventoryRowV1;
  await seedDurableSeal(store, seal);
});

describe('RFC-64 durable SWM inventory catalog asset resolver', () => {
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
    await expect(resolve('private')).rejects.toThrow(
      `durable finalized VM projection differs for ${seal.kaUal}`,
    );
  });
});

function resolve(laneKind: 'public' | 'private') {
  return resolveRfc64InventoryWorkspaceCatalogAssetV1({
    store,
    contextGraphId: CONTEXT_GRAPH_ID,
    authorAddress: AUTHOR,
    laneKind,
    row,
  });
}

async function createSeal(): Promise<CanonicalGraphScopedAuthorSealV1> {
  const assertionMerkleRoot = ethers.hexlify(
    computeFlatKCRootV10([...PROJECTION_QUADS], []),
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
    assertionVersion: '1',
    publicTripleCount: String(PROJECTION_QUADS.length),
    privateTripleCount: '0',
    privateMerkleRoot: null,
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
  await target.insert(quads.map((quad) => ({ ...quad, graph: vmGraph })));
}
