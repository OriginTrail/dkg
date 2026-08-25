import {
  DEFAULT_CG_SHARED_PROJECTION_VERIFICATION_LIMITS_V1,
  MemoryLayer,
  assertSafeIri,
  contextGraphLayerUri,
  contextGraphMetaUri,
  parseDeterministicKnowledgeAssetUal,
  readVerifiedCatalogSealBindingV1,
  type DecimalU64V1,
  type Digest32V1,
} from '@origintrail-official/dkg-core';
import {
  quadsToNQuads,
  readExactGraphPaged,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  computeFlatKCRootV10,
  generateGraphKnowledgeAssetMetadata,
} from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';

import {
  materializeVerifiedGraphScopedAsset,
  type VerifiedGraphScopedAsset,
} from '../sync/requester/graph-scoped-materialization.js';
import type {
  FinalizedVmMaterializationReceiptV1,
  FinalizedVmMaterializerV1,
} from './finalized-vm-runtime-v1.js';

const POST_READ_DIGEST_DOMAIN_V1 = ethers.toUtf8Bytes(
  'OT-RFC-64:finalized-vm-post-read:v1\0',
);
const PUBLISHED_AT_PREDICATE = 'http://dkg.io/ontology/publishedAt';

export interface FinalizedVmStoreMaterializerOptionsV1 {
  readonly store: TripleStore;
}

/**
 * Promote one catalog-verified SWM projection through the existing atomic
 * graph-scoped materializer, then independently verify the exact VM post-read.
 */
export function createFinalizedVmStoreMaterializerV1(
  options: FinalizedVmStoreMaterializerOptionsV1,
): FinalizedVmMaterializerV1 {
  const { store } = options;
  return Object.freeze(async (request): Promise<FinalizedVmMaterializationReceiptV1> => {
    request.signal.throwIfAborted();
    const binding = readVerifiedCatalogSealBindingV1(request.placement.sealBinding);
    const { seal } = binding;
    const identity = parseDeterministicKnowledgeAssetUal(request.candidate.ual);
    const subGraphName = request.catalogLane.subGraphName ?? undefined;
    const publicTripleCount = boundedTripleCount(
      seal.publicTripleCount,
      'publicTripleCount',
    );
    const privateTripleCount = boundedTripleCount(
      seal.privateTripleCount,
      'privateTripleCount',
    );
    const privateMerkleRoot = seal.privateMerkleRoot === null
      ? undefined
      : ethers.getBytes(seal.privateMerkleRoot);
    if ((privateTripleCount > 0) !== (privateMerkleRoot !== undefined)) {
      throw new Error('finalized VM seal private count/root tuple is inconsistent');
    }

    const swmGraph = contextGraphLayerUri(
      request.catalogLane.contextGraphId,
      MemoryLayer.SharedWorkingMemory,
      identity.agentAddress,
      identity.kaNumber,
      subGraphName,
    );
    const vmGraph = contextGraphLayerUri(
      request.catalogLane.contextGraphId,
      MemoryLayer.VerifiableMemory,
      identity.agentAddress,
      identity.kaNumber,
      subGraphName,
    );
    const graphlessProjection = await readExactGraphPaged(store, swmGraph, {
      expectedQuadCount: publicTripleCount,
      maxQuadCount: publicTripleCount,
      maxNQuadsBytes:
        DEFAULT_CG_SHARED_PROJECTION_VERIFICATION_LIMITS_V1.maxProjectionBytes,
      outputGraph: '',
      queryOptions: { source: 'rfc64-finalized-vm-swm-read' },
    });
    assertProjectionRoot(
      graphlessProjection,
      privateMerkleRoot,
      request.candidate.assertionRoot,
    );
    request.signal.throwIfAborted();

    const metaGraph = contextGraphMetaUri(request.catalogLane.contextGraphId);
    const timestamp = new Date(seal.assertionFinalizedAt);
    if (!Number.isFinite(timestamp.getTime())) {
      throw new Error('finalized VM seal timestamp is invalid');
    }
    const metadataQuads = generateGraphKnowledgeAssetMetadata({
      contextGraphId: request.catalogLane.contextGraphId,
      ual: request.candidate.ual,
      merkleRoot: ethers.getBytes(request.candidate.assertionRoot),
      publisherPeerId: 'rfc64-finalized-catalog-v1',
      // RFC-64 private finalized recovery must never label restored VM data as
      // public. CG-level reads are authorized from the current accepted roster.
      accessPolicy: 'ownerOnly',
      allowedPeers: [],
      timestamp,
      assertionVersion: request.candidate.assertionVersion,
      authorAddress: binding.authorAddress,
      publicTripleCount,
      privateTripleCount,
      ...(privateMerkleRoot ? { privateMerkleRoot } : {}),
      assertionGraph: vmGraph,
      ...(subGraphName ? { subGraphName } : {}),
    }, {
      status: 'confirmed',
      confirmation: {
        kind: 'finalized-materialization',
        provenance: {
          batchId: BigInt(request.candidate.kaId),
          materializedVersion: {
            blockNumber: boundedMaterializedBlockNumber(request.candidate.finalizedBlockNumber),
            txIndex: 0,
          },
        },
      },
    });
    const asset = Object.freeze({
      contextGraphId: request.catalogLane.contextGraphId,
      ual: request.candidate.ual,
      assertionVersion: BigInt(request.candidate.assertionVersion),
      assertionGraph: vmGraph,
      metaGraph,
      dataQuads: graphlessProjection.map((quad) => ({ ...quad, graph: vmGraph })),
      metadataQuads: [...metadataQuads],
    }) satisfies VerifiedGraphScopedAsset;
    const existingBefore = await hasExactFinalizedMaterialization(
      store,
      asset,
      graphlessProjection,
    );
    const outcome = existingBefore
      ? 'stale'
      : await materializeVerifiedGraphScopedAsset({
          store,
          asset,
          options: { source: 'rfc64-finalized-vm-materialization' },
        });
    if (outcome === 'quarantined') {
      throw new Error('finalized VM projection was quarantined by store limits');
    }
    request.signal.throwIfAborted();

    const postRead = await readExactGraphPaged(store, vmGraph, {
      expectedQuadCount: publicTripleCount,
      maxQuadCount: publicTripleCount,
      maxNQuadsBytes:
        DEFAULT_CG_SHARED_PROJECTION_VERIFICATION_LIMITS_V1.maxProjectionBytes,
      outputGraph: '',
      queryOptions: { source: 'rfc64-finalized-vm-post-read' },
    });
    assertProjectionRoot(postRead, privateMerkleRoot, request.candidate.assertionRoot);
    if (quadsToNQuads(postRead) !== quadsToNQuads(graphlessProjection)) {
      throw new Error('finalized VM post-read differs from the verified catalog projection');
    }
    if (
      existingBefore
      && !(await hasExactFinalizedMaterialization(store, asset, graphlessProjection))
    ) {
      throw new Error('finalized VM replay metadata changed during exact post-read');
    }
    const postReadDigest = ethers.keccak256(ethers.concat([
      POST_READ_DIGEST_DOMAIN_V1,
      ethers.toUtf8Bytes(quadsToNQuads(postRead)),
    ])).toLowerCase() as Digest32V1;
    return Object.freeze({
      kaId: binding.kaId,
      ordinal: request.candidate.ordinal,
      ual: request.candidate.ual,
      status: outcome === 'stale' ? 'existing' : 'materialized',
      vmGraphIri: vmGraph,
      tripleCount: String(postRead.length) as DecimalU64V1,
      postReadDigest,
    });
  });
}

async function hasExactFinalizedMaterialization(
  store: TripleStore,
  asset: VerifiedGraphScopedAsset,
  graphlessProjection: readonly Quad[],
): Promise<boolean> {
  let currentProjection: Quad[];
  try {
    currentProjection = await readExactGraphPaged(store, asset.assertionGraph, {
      expectedQuadCount: graphlessProjection.length,
      maxQuadCount: graphlessProjection.length,
      maxNQuadsBytes:
        DEFAULT_CG_SHARED_PROJECTION_VERIFICATION_LIMITS_V1.maxProjectionBytes,
      outputGraph: '',
      queryOptions: { source: 'rfc64-finalized-vm-replay-read' },
    });
  } catch {
    return false;
  }
  if (quadsToNQuads(currentProjection) !== quadsToNQuads(graphlessProjection)) {
    return false;
  }
  const result = await store.query(`
    SELECT ?predicate ?object WHERE {
      GRAPH <${assertSafeIri(asset.metaGraph)}> {
        <${assertSafeIri(asset.ual)}> ?predicate ?object .
      }
    }
  `, { source: 'rfc64-finalized-vm-replay-meta-read' });
  if (result.type !== 'bindings') return false;
  const current = new Set(result.bindings
    .filter((row) => row.predicate !== PUBLISHED_AT_PREDICATE)
    .map((row) => `${row.predicate}\0${row.object}`));
  const expected = new Set(asset.metadataQuads
    .filter((quad) => quad.predicate !== PUBLISHED_AT_PREDICATE)
    .map((quad) => `${quad.predicate}\0${quad.object}`));
  if (current.size !== expected.size) return false;
  return [...expected].every((row) => current.has(row));
}

function boundedTripleCount(value: string, label: string): number {
  const parsed = BigInt(value);
  if (
    parsed < 0n
    || parsed > BigInt(DEFAULT_CG_SHARED_PROJECTION_VERIFICATION_LIMITS_V1.maxPublicTriples)
  ) {
    throw new RangeError(`${label} exceeds the finalized VM materializer limit`);
  }
  return Number(parsed);
}

function boundedMaterializedBlockNumber(value: string): number {
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('finalized block number exceeds the VM metadata ordering domain');
  }
  return Number(parsed);
}

function assertProjectionRoot(
  quads: readonly Quad[],
  privateMerkleRoot: Uint8Array | undefined,
  expectedRoot: Digest32V1,
): void {
  const actual = ethers.hexlify(computeFlatKCRootV10(
    quads.map((quad) => ({ ...quad, graph: '' })),
    privateMerkleRoot === undefined ? [] : [privateMerkleRoot],
  )).toLowerCase();
  if (actual !== expectedRoot) {
    throw new Error('finalized VM projection differs from the current finalized chain root');
  }
}
