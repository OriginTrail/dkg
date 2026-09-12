// SPDX-License-Identifier: Apache-2.0

import { computeAuthorCatalogScopeDigestV1 } from '@origintrail-official/dkg-core';

import {
  ASSET_NUMBERS,
  CONTEXT_GRAPH_ID,
  DEPLOYMENT,
  UPDATED_ASSERTION_ROOT,
  UPDATED_PROJECTION,
  UPDATED_PROJECTION_QUADS,
  createCatalogAssets,
  createPrivateCatalogScope,
  createPrivatePolicyAndRoster,
  ownerWallet,
  privateCatalogSwmShareOperationId,
  roleAgentAddress,
} from './fixture.mjs';
import { assertFinalizedRuntimeV1 } from './agent-runtime.mjs';

export async function publishCatalogBaselineV1(context) {
  assertOwnerPublisherV1(context);
  context.publication.beginBaseline();
  const { policyDigest } = createPrivatePolicyAndRoster();
  const scope = createPrivateCatalogScope();
  const assets = await createCatalogAssets();
  let applied;
  for (const asset of assets) {
    applied = await context.agent.upsertConfirmedRfc64PublicRootCatalogAssetV1({
      scope,
      author: ownerWallet(),
      asset,
      deployment: DEPLOYMENT,
      peers: [],
      catalogIssuerDelegationEffectiveAt: '0',
      catalogIssuerDelegationExpiresAt: '1893456000000',
    });
  }
  context.publication.commitBaseline(scope, assets);
  return publishedFieldsV1(applied, policyDigest, scope);
}

export async function publishCatalogUpdateV1(context) {
  assertOwnerPublisherV1(context);
  const baseline = context.publication.requireBaseline();
  const { policyDigest } = createPrivatePolicyAndRoster();
  // The catalog establishes the finalized VM baseline first. These staged
  // version-2 snapshots represent a later, not-yet-finalized SWM generation,
  // so finalized version-1 twin retirement must preserve them.
  for (const [index, asset] of baseline.assets.entries()) {
    const kaNumber = ASSET_NUMBERS[index];
    if (kaNumber === undefined) throw new Error('catalog fixture asset number is missing');
    await context.agent.publisher.stageKnowledgeAssetSharedWorkingMemoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      shareOperationId: privateCatalogSwmShareOperationId(kaNumber),
      kaUal: asset.seal.kaUal,
      assertionVersion: '2',
      quads: UPDATED_PROJECTION_QUADS,
      privateTripleCount: 0,
      publisherPeerId: context.agent.peerId,
      accessPolicy: 'ownerOnly',
      agentAddress: roleAgentAddress('owner'),
      timestamp: new Date(),
    });
  }
  const updatedAssets = await createCatalogAssets({
    assertionRoot: UPDATED_ASSERTION_ROOT,
    assertionVersion: '2',
    projectionBytes: UPDATED_PROJECTION,
  });
  let applied;
  for (const asset of updatedAssets) {
    applied = await context.agent.upsertConfirmedRfc64PublicRootCatalogAssetV1({
      scope: baseline.scope,
      author: ownerWallet(),
      asset,
      deployment: DEPLOYMENT,
      peers: [],
      catalogIssuerDelegationEffectiveAt: '0',
      catalogIssuerDelegationExpiresAt: '1893456000000',
    });
  }
  return publishedFieldsV1(applied, policyDigest, baseline.scope);
}

function assertOwnerPublisherV1(context) {
  assertFinalizedRuntimeV1(context);
  if (context.role !== 'owner' || context.publication === null) {
    throw new Error('only the owner role can publish');
  }
}

function publishedFieldsV1(applied, policyDigest, scope) {
  if (applied === undefined) throw new Error('catalog upsert produced no applied head');
  return {
    headObjectDigest: applied.currentCatalogHeadDigest,
    policyDigest,
    catalogVersion: applied.catalogVersion,
    inventoryRowCount: applied.inventoryRowCount,
    scopeDigest: computeAuthorCatalogScopeDigestV1(scope),
  };
}
