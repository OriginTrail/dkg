// SPDX-License-Identifier: Apache-2.0

/** Source-owned durable SWM catalog asset loading and strict validation. */

import {
  canonicalGraphScopedAuthorSealFromAssertionSealV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeKaProjectionDigestV1,
  createGraphKnowledgeAssetScope,
  encodeCanonicalCgSharedPublicRootProjectionV1,
  knowledgeAssetLayerGraphUri,
  MemoryLayer,
  type CanonicalDeterministicUalV1,
  type CanonicalGraphScopedAuthorSealV1,
  type ContextGraphIdV1,
  type EvmAddressV1,
  type SwmAuthorInventoryRowV1,
} from '@origintrail-official/dkg-core';
import {
  ExactGraphReadError,
  GraphManager,
  readExactGraphPaged,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  computeFlatKCRootV10,
  readConfirmedGraphKnowledgeAssetMetadataEnvelope,
  resolveKnowledgeAssetOperationPublicQuads,
  resolvePublishedKnowledgeAssetWorkspaceHead,
  type WorkspacePublicSnapshotStore,
} from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';

import type { Rfc64PublicCatalogSuccessorAssetInputV1 } from
  './public-catalog-successor-asset-v1.js';
import { resolveDurableGraphScopedAuthorSealCandidateV1 } from
  '../durable-author-seal-resolver-v1.js';
import { throwIfRfc64AbortedV1 as throwIfAbortedV1 } from './abort-v1.js';

export interface Rfc64DurableCatalogAssetIdentityV1 {
  readonly assertionCoordinate: SwmAuthorInventoryRowV1['assertionCoordinate'];
  readonly assertionVersion: SwmAuthorInventoryRowV1['assertionVersion'];
  readonly kaUal: CanonicalDeterministicUalV1;
  readonly sealDigest: SwmAuthorInventoryRowV1['sealDigest'];
}

interface DurableCatalogAssetResolverBaseV1 {
  readonly store: TripleStore;
  readonly contextGraphId: ContextGraphIdV1;
  readonly authorAddress: EvmAddressV1;
  readonly signal?: AbortSignal;
}

interface ResolvedStrictSealV1 {
  readonly graphManager: GraphManager;
  readonly seal: CanonicalGraphScopedAuthorSealV1;
}

type DurableCatalogAssetResolutionV1 =
  | Readonly<{
      kind: 'inventory-row';
      row: Readonly<SwmAuthorInventoryRowV1>;
      laneKind: 'public' | 'private';
    }>
  | Readonly<{
      kind: 'confirmed-vm-repair';
      identity: Readonly<Rfc64DurableCatalogAssetIdentityV1>;
    }>;

interface DurableCatalogAssetResolverInputV1 extends DurableCatalogAssetResolverBaseV1 {
  readonly resolution: DurableCatalogAssetResolutionV1;
  readonly publicSnapshotStore?: WorkspacePublicSnapshotStore;
}

/** Resolve one exact durable workspace row; missing or divergent heads fail closed. */
export async function resolveRfc64InventoryWorkspaceCatalogAssetV1(
  params: Readonly<DurableCatalogAssetResolverBaseV1 & {
    readonly row: Readonly<SwmAuthorInventoryRowV1>;
    readonly laneKind: 'public' | 'private';
    readonly publicSnapshotStore?: WorkspacePublicSnapshotStore;
  }>,
): Promise<Rfc64PublicCatalogSuccessorAssetInputV1> {
  return resolveDurableCatalogAssetV1({
    store: params.store,
    contextGraphId: params.contextGraphId,
    authorAddress: params.authorAddress,
    ...(params.signal === undefined ? {} : { signal: params.signal }),
    ...(params.publicSnapshotStore === undefined
      ? {}
      : { publicSnapshotStore: params.publicSnapshotStore }),
    resolution: Object.freeze({
      kind: 'inventory-row',
      row: params.row,
      laneKind: params.laneKind,
    }),
  });
}

/** Resolve one confirmed-VM repair from an exact workspace or finalized VM graph. */
export async function resolveRfc64ConfirmedVmRepairCatalogAssetV1(
  params: Readonly<DurableCatalogAssetResolverBaseV1 & {
    readonly identity: Readonly<Rfc64DurableCatalogAssetIdentityV1>;
    readonly publicSnapshotStore?: WorkspacePublicSnapshotStore;
  }>,
): Promise<Rfc64PublicCatalogSuccessorAssetInputV1> {
  return resolveDurableCatalogAssetV1({
    store: params.store,
    contextGraphId: params.contextGraphId,
    authorAddress: params.authorAddress,
    ...(params.signal === undefined ? {} : { signal: params.signal }),
    ...(params.publicSnapshotStore === undefined
      ? {}
      : { publicSnapshotStore: params.publicSnapshotStore }),
    resolution: Object.freeze({
      kind: 'confirmed-vm-repair',
      identity: params.identity,
    }),
  });
}

async function resolveDurableCatalogAssetV1(
  params: Readonly<DurableCatalogAssetResolverInputV1>,
): Promise<Rfc64PublicCatalogSuccessorAssetInputV1> {
  const { resolution } = params;
  const identity = resolution.kind === 'inventory-row'
    ? resolution.row
    : resolution.identity;
  const laneKind = resolution.kind === 'inventory-row'
    ? resolution.laneKind
    : 'private';
  const { graphManager, seal } = await resolveStrictSealV1(params, identity);
  const head = await resolvePublishedKnowledgeAssetWorkspaceHead({
    store: params.store,
    graphManager,
    contextGraphId: params.contextGraphId,
    kaUal: identity.kaUal,
  });
  throwIfAbortedV1(params.signal);

  let projectionQuads: readonly Quad[];
  // Finalized private placements remain in the tier-neutral author inventory
  // after their byte-identical SWM twin is retired. Rebuild those rows from
  // exact confirmed VM state; public lanes continue to require a workspace head.
  if (head === undefined) {
    if (laneKind !== 'private') {
      throw new Error(`durable RFC-64 workspace head differs for ${identity.kaUal}`);
    }
    projectionQuads = await resolveFinalizedVmProjectionQuadsV1(
      params,
      identity,
      seal,
      resolution.kind === 'inventory-row'
        ? 'agent.rfc64.swmInventory.catalogReconcile.vmProjection'
        : 'agent.rfc64.finalizedPrivateCatalogRepair.vmProjection',
    );
  } else {
    const inventoryRowDiffers = resolution.kind === 'inventory-row' && (
      head.shareOperationId !== resolution.row.shareOperationId
      || head.publicTripleCount !== Number(resolution.row.publicTripleCount)
      || head.privateTripleCount !== Number(resolution.row.privateTripleCount)
    );
    if (
      head.assertionVersion !== identity.assertionVersion
      || head.publicTripleCount !== Number(seal.publicTripleCount)
      || head.privateTripleCount !== Number(seal.privateTripleCount)
      || !laneAcceptsWorkspaceHeadV1(laneKind, head.accessPolicy)
      || inventoryRowDiffers
    ) {
      throw new Error(`durable RFC-64 workspace head differs for ${identity.kaUal}`);
    }
    const snapshot = await resolveKnowledgeAssetOperationPublicQuads({
      store: params.store,
      graphManager,
      contextGraphId: params.contextGraphId,
      shareOperationId: head.shareOperationId,
      kaUal: identity.kaUal,
      assertionVersion: identity.assertionVersion,
      publicSnapshotStore: params.publicSnapshotStore,
    });
    throwIfAbortedV1(params.signal);
    projectionQuads = snapshot.quads;
  }

  assertProjectionMatchesSealV1(projectionQuads, seal, identity.kaUal);
  const projectionBytes = encodeCanonicalCgSharedPublicRootProjectionV1(projectionQuads);
  if (
    resolution.kind === 'inventory-row'
    && computeKaProjectionDigestV1(projectionBytes) !== resolution.row.projectionDigest
  ) {
    throw new Error(
      `durable RFC-64 projection differs from signed inventory row ${identity.kaUal}`,
    );
  }
  return catalogAssetV1(identity.assertionCoordinate, projectionBytes, seal);
}

async function resolveFinalizedVmProjectionQuadsV1(
  params: Readonly<DurableCatalogAssetResolverBaseV1>,
  identity: Readonly<Rfc64DurableCatalogAssetIdentityV1>,
  seal: Readonly<CanonicalGraphScopedAuthorSealV1>,
  source: string,
): Promise<readonly Quad[]> {
  const vmGraph = knowledgeAssetLayerGraphUri(
    params.contextGraphId,
    MemoryLayer.VerifiableMemory,
    createGraphKnowledgeAssetScope(identity.kaUal, identity.assertionVersion),
  );
  const stored = await readConfirmedGraphKnowledgeAssetMetadataEnvelope(params.store, {
    contextGraphId: params.contextGraphId,
    ual: identity.kaUal,
  });
  throwIfAbortedV1(params.signal);
  const expectedPrivateMerkleRoot = seal.privateMerkleRoot === null
    ? undefined
    : ethers.getBytes(seal.privateMerkleRoot);
  const expectedMerkleRoot = ethers.getBytes(seal.assertionMerkleRoot);
  if (
    stored.state !== 'confirmed'
    || stored.envelope.assertionVersion !== identity.assertionVersion
    || stored.envelope.batchId !== BigInt(seal.reservedKaId)
    || stored.envelope.publicTripleCount !== Number(seal.publicTripleCount)
    || stored.envelope.privateTripleCount !== Number(seal.privateTripleCount)
    || !equalOptionalBytesV1(
      stored.envelope.privateMerkleRoot,
      expectedPrivateMerkleRoot,
    )
    || !equalBytesV1(stored.envelope.merkleRoot, expectedMerkleRoot)
    || stored.envelope.assertionGraph !== vmGraph
    || stored.envelope.subGraphName !== undefined
  ) {
    throw new Error(`durable finalized VM projection differs for ${identity.kaUal}`);
  }
  let quads: Quad[];
  try {
    quads = await readExactGraphPaged(params.store, vmGraph, {
      expectedQuadCount: Number(seal.publicTripleCount),
      outputGraph: '',
      queryOptions: { source, signal: params.signal },
    });
  } catch (error) {
    if (error instanceof ExactGraphReadError && error.kind === 'integrity') {
      throw new Error(`durable finalized VM projection differs for ${identity.kaUal}`);
    }
    throw error;
  }
  throwIfAbortedV1(params.signal);
  return quads;
}

async function resolveStrictSealV1(
  params: Readonly<DurableCatalogAssetResolverBaseV1>,
  identity: Readonly<Rfc64DurableCatalogAssetIdentityV1>,
): Promise<ResolvedStrictSealV1> {
  throwIfAbortedV1(params.signal);
  const candidate = await resolveDurableGraphScopedAuthorSealCandidateV1({
    store: params.store,
    contextGraphId: params.contextGraphId,
    agentAddress: params.authorAddress,
    assertionCoordinate: identity.assertionCoordinate,
    source: 'agent.rfc64.swmInventory.catalogReconcile.seal',
    signal: params.signal,
  });
  if (candidate === undefined) {
    throw new Error(`durable RFC-64 catalog asset ${identity.kaUal} has no strict author seal`);
  }
  if (
    candidate.coordinate.scope !== params.contextGraphId
    || candidate.coordinate.agentAddress.toLowerCase() !== params.authorAddress
    || candidate.coordinate.name !== identity.assertionCoordinate
  ) {
    throw new Error(
      `durable RFC-64 catalog asset ${identity.kaUal} has a different seal coordinate`,
    );
  }
  const seal = canonicalGraphScopedAuthorSealFromAssertionSealV1(candidate.seal);
  if (
    seal.assertionVersion !== identity.assertionVersion
    || seal.kaUal !== identity.kaUal
    || computeCanonicalGraphScopedAuthorSealDigestV1(seal) !== identity.sealDigest
  ) {
    throw new Error(`durable RFC-64 catalog asset ${identity.kaUal} has a different author seal`);
  }
  return Object.freeze({ graphManager: new GraphManager(params.store), seal });
}

function laneAcceptsWorkspaceHeadV1(
  laneKind: 'public' | 'private',
  accessPolicy: 'public' | 'ownerOnly' | 'allowList' | undefined,
): boolean {
  return laneKind === 'public'
    ? accessPolicy === 'public'
    : accessPolicy === 'ownerOnly' || accessPolicy === 'allowList';
}

function catalogAssetV1(
  assertionCoordinate: SwmAuthorInventoryRowV1['assertionCoordinate'],
  projectionBytes: Uint8Array,
  seal: CanonicalGraphScopedAuthorSealV1,
): Rfc64PublicCatalogSuccessorAssetInputV1 {
  return Object.freeze({ assertionCoordinate, projectionBytes, seal });
}

function assertProjectionMatchesSealV1(
  quads: readonly Quad[],
  seal: CanonicalGraphScopedAuthorSealV1,
  kaUal: string,
): void {
  if (quads.length !== Number(seal.publicTripleCount)) {
    throw new Error(`durable finalized VM projection differs for ${kaUal}`);
  }
  const privateRoots = seal.privateMerkleRoot === null
    ? []
    : [ethers.getBytes(seal.privateMerkleRoot)];
  const actualRoot = ethers.hexlify(computeFlatKCRootV10([...quads], privateRoots)).toLowerCase();
  if (actualRoot !== seal.assertionMerkleRoot) {
    throw new Error(`durable finalized VM projection differs for ${kaUal}`);
  }
}

function equalBytesV1(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function equalOptionalBytesV1(
  left: Uint8Array | undefined,
  right: Uint8Array | undefined,
): boolean {
  return left === undefined || right === undefined
    ? left === right
    : equalBytesV1(left, right);
}
