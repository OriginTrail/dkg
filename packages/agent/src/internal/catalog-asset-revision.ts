// SPDX-License-Identifier: Apache-2.0
import {
  MemoryLayer, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, contextGraphMetaUri,
  type AuthorCatalogScopeV1,
} from '@origintrail-official/dkg-core';
import { withMaterializationLocks, readGraphKnowledgeAssetMetadataEnvelope, type ConfirmedGraphKnowledgeAssetMetadataEnvelope } from '@origintrail-official/dkg-publisher';
import type { Rfc64CatalogTransitionV1 } from './catalog-exact-set-plan.js';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { sameRfc64SuccessorAssetV1 } from '../rfc64/public-catalog-successor-asset-v1.js';
import type { Rfc64CatalogSuccessorAssetInputV1 } from '../dkg-agent-rfc64-catalog.js';
import { CatalogRepairConditionErrorV1, CatalogRepairIntegrityErrorV1 } from '../rfc64/catalog-repair-diagnostics-v1.js';
import { throwIfRfc64AbortedV1 } from '../rfc64/abort-v1.js';

/**
 * An authenticated inventory can revise its unpublished draft number. It cannot replace
 * the content already confirmed under that number. Read only when a row enters/changes,
 * including re-insertion after a crash between the two catalog successors.
 */
export async function assertCatalogAssetVmBoundaryV1(
  store: TripleStore,
  scope: AuthorCatalogScopeV1,
  asset: Rfc64CatalogSuccessorAssetInputV1,
  requireConfirmed: boolean,
  signal?: AbortSignal,
): Promise<void> {
  throwIfRfc64AbortedV1(signal);
  const observed = await readGraphKnowledgeAssetMetadataEnvelope(store, {
    contextGraphId: scope.contextGraphId, ual: asset.seal.kaUal,
  });
  throwIfRfc64AbortedV1(signal);
  const conflict = () => new CatalogRepairConditionErrorV1('version_conflict',
    'RFC-64 catalog revision is not supported by the current confirmed VM content');
  if (observed.state === 'invalid') {
    throw new CatalogRepairIntegrityErrorV1('RFC-64 catalog revision has ambiguous VM metadata');
  }
  if (observed.state === 'absent' || observed.state === 'tentative') {
    if (requireConfirmed) throw conflict();
    return;
  }
  const vmVersion = BigInt(observed.envelope.assertionVersion);
  const desiredVersion = BigInt(asset.seal.assertionVersion);
  if (vmVersion < desiredVersion && !requireConfirmed) return;
  if (!matchesCatalogConfirmedEnvelopeV1(scope.contextGraphId, asset.seal, observed.envelope)) throw conflict();
}

/** Exact content identity shared by mutation authorization and durable VM projection loading. */
export function matchesCatalogConfirmedEnvelopeV1(
  contextGraphId: AuthorCatalogScopeV1['contextGraphId'],
  seal: Rfc64CatalogSuccessorAssetInputV1['seal'],
  envelope: Readonly<ConfirmedGraphKnowledgeAssetMetadataEnvelope>,
): boolean {
  return envelope.assertionVersion === seal.assertionVersion
    && envelope.batchId === BigInt(seal.reservedKaId)
    && envelope.subGraphName === undefined
    && envelope.assertionGraph === knowledgeAssetLayerGraphUri(contextGraphId,
      MemoryLayer.VerifiableMemory, createGraphKnowledgeAssetScope(seal.kaUal, seal.assertionVersion))
    && ethers.hexlify(envelope.merkleRoot) === seal.assertionMerkleRoot
    && envelope.publicTripleCount === Number(seal.publicTripleCount)
    && envelope.privateTripleCount === Number(seal.privateTripleCount)
    && (envelope.privateMerkleRoot === undefined ? null : ethers.hexlify(envelope.privateMerkleRoot)) === seal.privateMerkleRoot;
}

export async function assertCatalogTargetRevisionsV1(
  store: TripleStore,
  scope: AuthorCatalogScopeV1,
  current: readonly Rfc64CatalogSuccessorAssetInputV1[],
  target: readonly Rfc64CatalogSuccessorAssetInputV1[],
  source: 'confirmed' | 'inventory',
  signal?: AbortSignal,
): Promise<void> {
  const currentByKaId = new Map(current.map((asset) => [asset.seal.reservedKaId, asset]));
  for (const targetAsset of target) {
    throwIfRfc64AbortedV1(signal);
    const currentAsset = currentByKaId.get(targetAsset.seal.reservedKaId);
    if (currentAsset !== undefined && sameRfc64SuccessorAssetV1(currentAsset, targetAsset)) continue;
    const currentVersion = currentAsset === undefined ? undefined : BigInt(currentAsset.seal.assertionVersion);
    const targetVersion = BigInt(targetAsset.seal.assertionVersion);
    if (
      currentAsset !== undefined && (currentAsset.assertionCoordinate !== targetAsset.assertionCoordinate
      || targetVersion < currentVersion!)
    ) {
      throw new CatalogRepairConditionErrorV1('version_conflict',
        `RFC-64 exact-set replacement for KA ${targetAsset.seal.reservedKaId} is not a newer assertion version on the same coordinate`,
      );
    }
    await assertCatalogAssetVmBoundaryV1(store, scope, targetAsset,
      source === 'confirmed' && targetVersion === currentVersion, signal);
  }
}

/** Linearize each catalog delta with the node's existing VM writers through signing and CAS. */
export function withCatalogTransitionVmAuthorizationV1<T>(
  store: TripleStore, scope: AuthorCatalogScopeV1,
  transition: Rfc64CatalogTransitionV1,
  source: 'confirmed' | 'inventory', work: () => Promise<T>, signal?: AbortSignal,
): Promise<T> {
  const { currentAsset, targetAsset } = transition;
  const affected = currentAsset ?? targetAsset;
  if (affected === undefined) throw new Error('RFC-64 planner returned an empty KA transition');
  return withMaterializationLocks([{
    metaGraph: contextGraphMetaUri(scope.contextGraphId), ual: affected.seal.kaUal,
  }], async () => {
    // A withdrawal explicitly carries its intended replacement. The same VM lock
    // remains held through the signed successor's applied-head CAS.
    await assertCatalogTargetRevisionsV1(store, scope, currentAsset ? [currentAsset] : [],
      targetAsset ? [targetAsset] : [], source, signal);
    return work();
  }, { signal });
}
