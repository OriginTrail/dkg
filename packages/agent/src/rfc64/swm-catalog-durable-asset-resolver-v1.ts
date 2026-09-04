// SPDX-License-Identifier: Apache-2.0

/** Source-owned durable SWM catalog asset loading and strict validation. */

import {
  assertSafeIri,
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
  GraphManager,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  computeFlatKCRootV10,
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

/** Resolve one exact durable workspace row; missing or divergent heads fail closed. */
export async function resolveRfc64InventoryWorkspaceCatalogAssetV1(
  params: Readonly<DurableCatalogAssetResolverBaseV1 & {
    readonly row: Readonly<SwmAuthorInventoryRowV1>;
    readonly laneKind: 'public' | 'private';
    readonly publicSnapshotStore?: WorkspacePublicSnapshotStore;
  }>,
): Promise<Rfc64PublicCatalogSuccessorAssetInputV1> {
  const { graphManager, seal } = await resolveStrictSealV1(params, params.row);
  const head = await resolvePublishedKnowledgeAssetWorkspaceHead({
    store: params.store,
    graphManager,
    contextGraphId: params.contextGraphId,
    kaUal: params.row.kaUal,
  });
  throwIfAbortedV1(params.signal);
  // Finalized private placements remain in the tier-neutral author inventory
  // after their byte-identical SWM twin is retired. Rebuild those rows from
  // the exact VM graph; public lanes must continue to require a workspace head.
  if (head === undefined && params.laneKind === 'private') {
    const projectionBytes = await resolveFinalizedVmProjectionBytesV1(
      params,
      params.row,
      seal,
      'agent.rfc64.swmInventory.catalogReconcile.vmProjection',
    );
    if (computeKaProjectionDigestV1(projectionBytes) !== params.row.projectionDigest) {
      throw new Error(
        `durable RFC-64 projection differs from signed inventory row ${params.row.kaUal}`,
      );
    }
    return catalogAssetV1(params.row.assertionCoordinate, projectionBytes, seal);
  }
  if (
    head === undefined
    || head.assertionVersion !== params.row.assertionVersion
    || head.shareOperationId !== params.row.shareOperationId
    || head.publicTripleCount !== Number(params.row.publicTripleCount)
    || head.privateTripleCount !== Number(params.row.privateTripleCount)
    || !laneAcceptsWorkspaceHeadV1(params.laneKind, head.accessPolicy)
  ) {
    throw new Error(`durable RFC-64 workspace head differs for ${params.row.kaUal}`);
  }
  const snapshot = await resolveKnowledgeAssetOperationPublicQuads({
    store: params.store,
    graphManager,
    contextGraphId: params.contextGraphId,
    shareOperationId: head.shareOperationId,
    kaUal: params.row.kaUal,
    assertionVersion: params.row.assertionVersion,
    publicSnapshotStore: params.publicSnapshotStore,
  });
  throwIfAbortedV1(params.signal);
  assertProjectionMatchesSealV1(snapshot.quads, seal, params.row.kaUal);
  const projectionBytes = encodeCanonicalCgSharedPublicRootProjectionV1(snapshot.quads);
  if (computeKaProjectionDigestV1(projectionBytes) !== params.row.projectionDigest) {
    throw new Error(
      `durable RFC-64 projection differs from signed inventory row ${params.row.kaUal}`,
    );
  }
  return catalogAssetV1(params.row.assertionCoordinate, projectionBytes, seal);
}

/** Resolve one confirmed-VM repair from an exact workspace or finalized VM graph. */
export async function resolveRfc64ConfirmedVmRepairCatalogAssetV1(
  params: Readonly<DurableCatalogAssetResolverBaseV1 & {
    readonly identity: Readonly<Rfc64DurableCatalogAssetIdentityV1>;
    readonly publicSnapshotStore?: WorkspacePublicSnapshotStore;
  }>,
): Promise<Rfc64PublicCatalogSuccessorAssetInputV1> {
  const { graphManager, seal } = await resolveStrictSealV1(params, params.identity);
  const head = await resolvePublishedKnowledgeAssetWorkspaceHead({
    store: params.store,
    graphManager,
    contextGraphId: params.contextGraphId,
    kaUal: params.identity.kaUal,
  });
  throwIfAbortedV1(params.signal);

  let projectionBytes: Uint8Array;
  if (head === undefined) {
    projectionBytes = await resolveFinalizedVmProjectionBytesV1(
      params,
      params.identity,
      seal,
      'agent.rfc64.finalizedPrivateCatalogRepair.vmProjection',
    );
  } else {
    if (
      head.assertionVersion !== params.identity.assertionVersion
      || head.publicTripleCount !== Number(seal.publicTripleCount)
      || head.privateTripleCount !== Number(seal.privateTripleCount)
      || !laneAcceptsWorkspaceHeadV1('private', head.accessPolicy)
    ) {
      throw new Error(`durable RFC-64 workspace head differs for ${params.identity.kaUal}`);
    }
    const snapshot = await resolveKnowledgeAssetOperationPublicQuads({
      store: params.store,
      graphManager,
      contextGraphId: params.contextGraphId,
      shareOperationId: head.shareOperationId,
      kaUal: params.identity.kaUal,
      assertionVersion: params.identity.assertionVersion,
      publicSnapshotStore: params.publicSnapshotStore,
    });
    throwIfAbortedV1(params.signal);
    assertProjectionMatchesSealV1(snapshot.quads, seal, params.identity.kaUal);
    projectionBytes = encodeCanonicalCgSharedPublicRootProjectionV1(snapshot.quads);
  }
  return catalogAssetV1(params.identity.assertionCoordinate, projectionBytes, seal);
}

async function resolveFinalizedVmProjectionBytesV1(
  params: Readonly<DurableCatalogAssetResolverBaseV1>,
  identity: Readonly<Rfc64DurableCatalogAssetIdentityV1>,
  seal: Readonly<CanonicalGraphScopedAuthorSealV1>,
  source: string,
): Promise<Uint8Array> {
  const vmGraph = knowledgeAssetLayerGraphUri(
    params.contextGraphId,
    MemoryLayer.VerifiableMemory,
    createGraphKnowledgeAssetScope(identity.kaUal, identity.assertionVersion),
  );
  const result = await params.store.query(
    `CONSTRUCT { ?subject ?predicate ?object } WHERE { GRAPH <${assertSafeIri(vmGraph)}> { ?subject ?predicate ?object } }`,
    { source, signal: params.signal },
  );
  throwIfAbortedV1(params.signal);
  if (result.type !== 'quads' || result.quads.length !== Number(seal.publicTripleCount)) {
    throw new Error(`durable finalized VM projection differs for ${identity.kaUal}`);
  }
  assertProjectionMatchesSealV1(result.quads, seal, identity.kaUal);
  return encodeCanonicalCgSharedPublicRootProjectionV1(result.quads);
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
