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
  readExactGraphPagedWithDiscoveredCount,
  tryReplaceGraphAndSubjectAtomically,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  computeFlatKCRootV10,
  generateGraphKnowledgeAssetMetadata,
  withMaterializationLock,
} from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';

import {
  materializeVerifiedGraphScopedAsset,
  type VerifiedGraphScopedAsset,
} from '../sync/requester/graph-scoped-materialization.js';
import type {
  FinalizedVmMaterializationReceiptV1,
  FinalizedVmMaterializerV1,
  FinalizedVmTransactionalMaterializerV1,
} from './finalized-vm-runtime-v1.js';

const POST_READ_DIGEST_DOMAIN_V1 = ethers.toUtf8Bytes(
  'OT-RFC-64:finalized-vm-post-read:v1\0',
);
const PUBLISHED_AT_PREDICATE = 'http://dkg.io/ontology/publishedAt';
const MAX_ROLLBACK_METADATA_ROWS_V1 = 1_024;

export interface FinalizedVmStoreMaterializerOptionsV1 {
  readonly store: TripleStore;
  /** Accepted-current guard checked at every atomic materialization boundary. */
  readonly isCurrent?: () => boolean;
}

interface FinalizedVmStoreStateV1 {
  readonly graphQuads: readonly Quad[];
  readonly metadataQuads: readonly Quad[];
  readonly identity: string;
}

interface FinalizedVmStoreRollbackEntryV1 {
  readonly assertionGraph: string;
  readonly metaGraph: string;
  readonly ual: string;
  readonly before: FinalizedVmStoreStateV1;
  readonly after: FinalizedVmStoreStateV1;
}

/**
 * Promote one catalog-verified SWM projection through the existing atomic
 * graph-scoped materializer, then independently verify the exact VM post-read.
 */
export function createFinalizedVmStoreMaterializerV1(
  options: FinalizedVmStoreMaterializerOptionsV1,
): FinalizedVmTransactionalMaterializerV1 {
  const { store, isCurrent } = options;
  const rollbackJournal: FinalizedVmStoreRollbackEntryV1[] = [];
  let closed = false;
  const materialize: FinalizedVmMaterializerV1 = async (
    request,
  ): Promise<FinalizedVmMaterializationReceiptV1> => {
    if (closed) throw new Error('finalized VM materialization transaction is closed');
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
      // Derive the persisted access mode from the exact accepted policy. The
      // materializer is policy-neutral: private recovery must remain
      // owner-only, while public finalized recovery must remain public.
      accessPolicy: request.acceptedPolicy.accessPolicy === 0
        ? 'public'
        : 'ownerOnly',
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
    return withMaterializationLock(metaGraph, asset.ual, async () => {
      if (isCurrent?.() === false) {
        throw new Error('finalized VM accepted policy or roster is no longer current');
      }
      const existingBefore = await hasExactFinalizedMaterialization(
        store,
        asset,
        graphlessProjection,
      );
      const before = existingBefore
        ? null
        : await snapshotFinalizedVmStoreStateV1(store, asset);
      const outcome = existingBefore
        ? 'stale'
        : await materializeVerifiedGraphScopedAsset({
            store,
            asset,
            isCurrent,
            lockAlreadyHeldByCaller: true,
            options: { source: 'rfc64-finalized-vm-materialization' },
          });
      if (before !== null) {
        let after: FinalizedVmStoreStateV1;
        try {
          after = await snapshotFinalizedVmStoreStateV1(store, asset);
        } catch (cause) {
          // The replacement is already durable, but its exact identity could
          // not be captured for conflict-safe deferred rollback. Restore the
          // predecessor immediately while this asset's materialization lock is
          // still held, before propagating the read failure.
          const restored = await tryReplaceGraphAndSubjectAtomically(
            store,
            asset.assertionGraph,
            [...before.graphQuads],
            asset.metaGraph,
            asset.ual,
            [...before.metadataQuads],
            { source: 'rfc64-finalized-vm-snapshot-failure-rollback' },
          );
          if (!restored) {
            throw new AggregateError(
              [cause],
              `finalized VM store cannot restore ${asset.ual} after snapshot failure`,
            );
          }
          throw cause;
        }
        rollbackJournal.push(Object.freeze({
          assertionGraph: asset.assertionGraph,
          metaGraph: asset.metaGraph,
          ual: asset.ual,
          before,
          after,
        }));
      }
      if (outcome === 'quarantined') {
        throw new Error('finalized VM projection lost accepted-current authority during commit');
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
    }, { signal: request.signal });
  };
  return Object.freeze(Object.assign(materialize, {
    commit(): void {
      closed = true;
      rollbackJournal.length = 0;
    },
    async rollback(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const entry of rollbackJournal.reverse()) {
        await restoreFinalizedVmStoreStateV1(store, entry);
      }
      rollbackJournal.length = 0;
    },
  }));
}

async function snapshotFinalizedVmStoreStateV1(
  store: TripleStore,
  asset: Pick<VerifiedGraphScopedAsset, 'assertionGraph' | 'metaGraph' | 'ual'>,
): Promise<FinalizedVmStoreStateV1> {
  const graphQuads = await readExactGraphPagedWithDiscoveredCount(store, asset.assertionGraph, {
    maxQuadCount: DEFAULT_CG_SHARED_PROJECTION_VERIFICATION_LIMITS_V1.maxPublicTriples,
    maxNQuadsBytes: DEFAULT_CG_SHARED_PROJECTION_VERIFICATION_LIMITS_V1.maxProjectionBytes,
    queryOptions: { source: 'rfc64-finalized-vm-rollback-graph-snapshot' },
  });
  const metadata = await store.query(`
    SELECT ?predicate ?object WHERE {
      GRAPH <${assertSafeIri(asset.metaGraph)}> {
        <${assertSafeIri(asset.ual)}> ?predicate ?object .
      }
    }
    LIMIT ${MAX_ROLLBACK_METADATA_ROWS_V1 + 1}
  `, { source: 'rfc64-finalized-vm-rollback-meta-snapshot' });
  if (
    metadata.type !== 'bindings'
    || metadata.bindings.length > MAX_ROLLBACK_METADATA_ROWS_V1
    || metadata.bindings.some((row) => row.predicate === undefined || row.object === undefined)
  ) {
    throw new Error('finalized VM metadata predecessor exceeds the exact rollback bound');
  }
  const metadataQuads = metadata.bindings.map((row) => ({
    subject: asset.ual,
    predicate: row.predicate!,
    object: row.object!,
    graph: asset.metaGraph,
  }));
  return Object.freeze({
    graphQuads: Object.freeze(graphQuads.map((quad) => Object.freeze({ ...quad }))),
    metadataQuads: Object.freeze(metadataQuads.map((quad) => Object.freeze({ ...quad }))),
    identity: storeStateIdentityV1(graphQuads, metadataQuads),
  });
}

async function restoreFinalizedVmStoreStateV1(
  store: TripleStore,
  entry: FinalizedVmStoreRollbackEntryV1,
): Promise<void> {
  await withMaterializationLock(entry.metaGraph, entry.ual, async () => {
    const current = await snapshotFinalizedVmStoreStateV1(store, entry);
    if (current.identity !== entry.after.identity) {
      throw new Error(
        `finalized VM rollback conflict for ${entry.ual}: current state was replaced externally`,
      );
    }
    const restored = await tryReplaceGraphAndSubjectAtomically(
      store,
      entry.assertionGraph,
      [...entry.before.graphQuads],
      entry.metaGraph,
      entry.ual,
      [...entry.before.metadataQuads],
      { source: 'rfc64-finalized-vm-exact-rollback' },
    );
    if (!restored) {
      throw new Error('finalized VM store cannot atomically restore rollback state');
    }
    const postRead = await snapshotFinalizedVmStoreStateV1(store, entry);
    if (postRead.identity !== entry.before.identity) {
      throw new Error(`finalized VM exact rollback post-read differs for ${entry.ual}`);
    }
  });
}

function storeStateIdentityV1(
  graphQuads: readonly Quad[],
  metadataQuads: readonly Quad[],
): string {
  const lines = [...graphQuads, ...metadataQuads]
    .map((quad) => `${quad.subject}\0${quad.predicate}\0${quad.object}\0${quad.graph}`)
    .sort();
  return ethers.keccak256(ethers.toUtf8Bytes(lines.join('\n'))).toLowerCase();
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
