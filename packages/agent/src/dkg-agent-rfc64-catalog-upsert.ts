// SPDX-License-Identifier: Apache-2.0

/** Catalog-owned, serialized exact-set mutation for one confirmed public asset. */

import {
  assertSignedAuthorCatalogHeadEnvelopeV1,
  assertSignedAuthorCatalogIssuerDelegationEnvelopeV1,
  canonicalizeCanonicalGraphScopedAuthorSealV1,
  computeAuthorCatalogScopeDigestV1,
  computeControlSignatureVariantDigestHex,
  decodeOpaqueKaBundleV1,
  parseCanonicalGraphScopedAuthorSealV1,
  type AuthorCatalogScopeV1,
  type CatalogSealDeploymentProfileV1,
  type CountV1,
  type Digest32V1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import {
  loadBoundedAuthorCatalogHistoryV1,
  type BoundedAuthorCatalogHistoryV1,
  type Rfc64CatalogAuthorSignerV1,
  type Rfc64CatalogSuccessorAssetInputV1,
  type Rfc64StagedAuthorCatalogHeadRefV1,
} from './dkg-agent-rfc64-catalog.js';
import type { AppliedCatalogHeadSnapshotV1 } from './rfc64/inventory-v1/index.js';
import { snapshotRfc64PublicCatalogAnnouncementPeersV1 } from './rfc64/catalog-peers-v1.js';
import { computeRfc64AppliedInventoryDigestV1 } from './rfc64/public-catalog-inventory-completeness-v1.js';
import type { Rfc64PersistenceV1 } from './rfc64/persistence-v1.js';

export interface UpsertConfirmedRfc64PublicRootCatalogAssetParamsV1 {
  readonly scope: AuthorCatalogScopeV1;
  readonly author: Rfc64CatalogAuthorSignerV1;
  readonly asset: Rfc64CatalogSuccessorAssetInputV1;
  readonly deployment: CatalogSealDeploymentProfileV1;
  readonly peers: readonly string[];
  readonly catalogIssuerDelegationEffectiveAt: TimestampMsV1;
  readonly catalogIssuerDelegationExpiresAt: TimestampMsV1;
}

export class Rfc64CatalogUpsertMethods extends DKGAgentBase {
  /**
   * Own genesis creation, predecessor reconstruction, exact-set successor,
   * applied-head CAS, and best-effort availability announcement as one
   * serialized catalog mutation.
   */
  async upsertConfirmedRfc64PublicRootCatalogAssetV1(
    this: DKGAgent,
    params: UpsertConfirmedRfc64PublicRootCatalogAssetParamsV1,
  ): Promise<AppliedCatalogHeadSnapshotV1> {
    if (params.scope.subGraphName !== null) {
      throw new Error('RFC-64 confirmed public asset upsert requires the root catalog lane');
    }
    if (params.scope.authorAddress !== params.asset.seal.authorAddress) {
      throw new Error('RFC-64 confirmed public asset author differs from the catalog scope');
    }
    const peers = snapshotRfc64PublicCatalogAnnouncementPeersV1(params.peers);
    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) {
      throw new Error('RFC-64 catalog upsert requires durable persistence');
    }
    const service = this.rfc64PublicCatalogServiceV1;
    if (service === undefined) {
      throw new Error('RFC-64 catalog upsert requires the public catalog service');
    }
    service.acceptedPolicySnapshotForCatalogScope(params.scope);
    const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(params.scope);
    const queueKey = `${catalogScopeDigest}\n${params.scope.authorAddress}`;

    return this.runSerializedRfc64AuthorCatalogMutationV1(queueKey, async () => {
      let current = persistence.inventory.readAppliedCatalogHeadV1(
        catalogScopeDigest,
        params.scope.authorAddress,
      );
      if (current === null) {
        const genesis = await this.publishAuthorCatalogGenesisV1({
          scope: params.scope,
          author: params.author,
          peers: [],
          issuedAt: Date.now().toString() as TimestampMsV1,
          catalogIssuerDelegationEffectiveAt:
            params.catalogIssuerDelegationEffectiveAt,
          catalogIssuerDelegationExpiresAt:
            params.catalogIssuerDelegationExpiresAt,
        });
        const emptyInventoryDigest = computeRfc64AppliedInventoryDigestV1({
          catalogScopeDigest,
          rows: [],
        });
        current = persistence.inventory.compareAndSwapAppliedCatalogHeadV1({
          catalogScopeDigest,
          authorAddress: params.scope.authorAddress,
          currentCatalogHeadDigest: genesis.headObjectDigest,
          appliedInventoryDigest: emptyInventoryDigest,
          catalogVersion: genesis.announcement.catalogVersion,
          inventoryRowCount: '0' as CountV1,
          expectedCurrentCatalogHeadDigest: null,
        }).snapshot;
      }

      const storedHead = await persistence.controlObjects.getVerifiedObjectByDigest({
        objectDigest: current.currentCatalogHeadDigest,
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      });
      if (storedHead === null) {
        throw new Error('RFC-64 applied author head is not durably staged');
      }
      assertSignedAuthorCatalogHeadEnvelopeV1(storedHead.envelope);
      const previousHead: Rfc64StagedAuthorCatalogHeadRefV1 = Object.freeze({
        objectDigest: storedHead.envelope.objectDigest as Digest32V1,
        signatureVariantDigest: computeControlSignatureVariantDigestHex(
          storedHead.envelope.objectDigest,
          storedHead.envelope.signature,
        ) as Digest32V1,
      });
      const history = await loadBoundedAuthorCatalogHistoryV1(persistence, previousHead);
      const assets = await loadRfc64CatalogSuccessorAssetsV1(persistence, history);
      const existingIndex = assets.findIndex(
        (asset) => asset.seal.reservedKaId === params.asset.seal.reservedKaId,
      );
      if (
        existingIndex >= 0
        && sameRfc64SuccessorAssetV1(assets[existingIndex]!, params.asset)
      ) return current;
      if (existingIndex >= 0) assets[existingIndex] = params.asset;
      else assets.push(params.asset);

      const storedDelegation = await persistence.controlObjects.getVerifiedObjectByDigest({
        objectDigest: history.previousHead.payload.catalogIssuerDelegationDigest,
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      });
      if (storedDelegation === null) {
        throw new Error('RFC-64 applied author head delegation is not durably staged');
      }
      assertSignedAuthorCatalogIssuerDelegationEnvelopeV1(storedDelegation.envelope);
      const successor = await this.publishAuthorCatalogExactSetSuccessorV1({
        previousHead,
        author: params.author,
        catalogIssuerAuthorization: Object.freeze({
          catalogIssuerDelegation: storedDelegation.envelope,
          parentAuthorAgentEvidence: null,
        }),
        assets,
        deployment: params.deployment,
        issuedAt: Date.now().toString() as TimestampMsV1,
        peers: [],
      });
      const appliedInventoryDigest = computeRfc64AppliedInventoryDigestV1({
        catalogScopeDigest: successor.catalogScopeDigest,
        rows: successor.assets,
      });
      const applied = persistence.inventory.compareAndSwapAppliedCatalogHeadV1({
        catalogScopeDigest: successor.catalogScopeDigest,
        authorAddress: params.scope.authorAddress,
        currentCatalogHeadDigest: successor.headObjectDigest,
        appliedInventoryDigest,
        catalogVersion: successor.announcement.catalogVersion,
        inventoryRowCount: successor.signedBucketRowCount,
        expectedCurrentCatalogHeadDigest: current.currentCatalogHeadDigest,
      }).snapshot;
      await this.announceRfc64PublicCatalogHeadV1({
        announcement: successor.announcement,
        peers,
      });
      return applied;
    });
  }

  private async runSerializedRfc64AuthorCatalogMutationV1<T>(
    this: DKGAgent,
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const predecessor = this.rfc64AuthorCatalogMutationQueuesV1.get(key);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = (predecessor ?? Promise.resolve()).catch(() => undefined).then(() => gate);
    this.rfc64AuthorCatalogMutationQueuesV1.set(key, tail);
    await predecessor?.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.rfc64AuthorCatalogMutationQueuesV1.get(key) === tail) {
        this.rfc64AuthorCatalogMutationQueuesV1.delete(key);
      }
    }
  }
}

async function loadRfc64CatalogSuccessorAssetsV1(
  persistence: Rfc64PersistenceV1,
  history: BoundedAuthorCatalogHistoryV1,
): Promise<Rfc64CatalogSuccessorAssetInputV1[]> {
  const assets: Rfc64CatalogSuccessorAssetInputV1[] = [];
  for (const row of history.previousBucket?.payload.rows ?? []) {
    const bundleBytes = await persistence.kaBundles.readKaBundleByDigest(row.transfer.blobDigest);
    if (bundleBytes === null) {
      throw new Error(`RFC-64 applied catalog bundle ${row.transfer.blobDigest} is unavailable`);
    }
    const decoded = decodeOpaqueKaBundleV1(bundleBytes);
    if (
      decoded.blobDigest !== row.transfer.blobDigest
      || decoded.projectionDigest !== row.projectionDigest
    ) {
      throw new Error('RFC-64 applied catalog bundle differs from its signed predecessor row');
    }
    assets.push(Object.freeze({
      assertionCoordinate: row.assertionCoordinate,
      projectionBytes: new Uint8Array(decoded.projectionBytes),
      seal: parseCanonicalGraphScopedAuthorSealV1(decoded.sealBytes),
    }));
  }
  return assets;
}

function sameRfc64SuccessorAssetV1(
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
