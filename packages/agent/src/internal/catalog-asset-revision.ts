// SPDX-License-Identifier: Apache-2.0
import {
  MemoryLayer, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri,
  canonicalizeCanonicalGraphScopedAuthorSealV1,
  type AuthorCatalogScopeV1,
} from '@origintrail-official/dkg-core';
import { readConfirmedGraphKnowledgeAssetMetadataEnvelope } from '@origintrail-official/dkg-publisher';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
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
  const observed = await readConfirmedGraphKnowledgeAssetMetadataEnvelope(store, {
    contextGraphId: scope.contextGraphId, ual: asset.seal.kaUal,
  });
  throwIfRfc64AbortedV1(signal);
  const conflict = () => new CatalogRepairConditionErrorV1('version_conflict',
    'RFC-64 catalog revision is not supported by the current confirmed VM content');
  if (observed.state === 'invalid') {
    throw new CatalogRepairIntegrityErrorV1('RFC-64 catalog revision has ambiguous VM metadata');
  }
  if (observed.state === 'absent') {
    if (requireConfirmed) throw conflict();
    return;
  }
  const { envelope } = observed, { seal } = asset;
  const vmVersion = BigInt(envelope.assertionVersion), desiredVersion = BigInt(seal.assertionVersion);
  if (vmVersion < desiredVersion && !requireConfirmed) return;
  if (vmVersion !== desiredVersion
    || envelope.batchId !== BigInt(seal.reservedKaId)
    || envelope.subGraphName !== undefined
    || envelope.assertionGraph !== knowledgeAssetLayerGraphUri(scope.contextGraphId,
      MemoryLayer.VerifiableMemory, createGraphKnowledgeAssetScope(seal.kaUal, seal.assertionVersion))
    || ethers.hexlify(envelope.merkleRoot) !== seal.assertionMerkleRoot
    || envelope.publicTripleCount !== Number(seal.publicTripleCount)
    || envelope.privateTripleCount !== Number(seal.privateTripleCount)
    || (envelope.privateMerkleRoot === undefined ? null : ethers.hexlify(envelope.privateMerkleRoot)) !== seal.privateMerkleRoot
  ) throw conflict();
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

export function sameRfc64SuccessorAssetV1(
  left: Rfc64CatalogSuccessorAssetInputV1,
  right: Rfc64CatalogSuccessorAssetInputV1,
): boolean {
  return left.assertionCoordinate === right.assertionCoordinate
    && canonicalizeCanonicalGraphScopedAuthorSealV1(left.seal)
      === canonicalizeCanonicalGraphScopedAuthorSealV1(right.seal)
    && equalBytes(left.projectionBytes, right.projectionBytes);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((byte, index) => byte === right[index]);
}
