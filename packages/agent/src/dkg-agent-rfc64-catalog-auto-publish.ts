// SPDX-License-Identifier: Apache-2.0

/**
 * Opt-in RFC-64 producer bridge from an ordinary confirmed public KA publish
 * to this provider's durable exact author-catalog head.
 */

import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  assertCanonicalGraphScopedAuthorSealV1,
  assertSignedAuthorCatalogHeadEnvelopeV1,
  assertSignedAuthorCatalogIssuerDelegationEnvelopeV1,
  canonicalizeCanonicalGraphScopedAuthorSealV1,
  computeAuthorCatalogScopeDigestV1,
  computeControlSignatureVariantDigestHex,
  decodeOpaqueKaBundleV1,
  parseCanonicalGraphScopedAuthorSealV1,
  type AssertionCoordinateV1,
  type AssertionSeal,
  type AuthorCatalogScopeV1,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
  type ContextGraphIdV1,
  type CountV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type SubGraphNameV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';
import { serializeWorkspacePublicSnapshotQuads } from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import {
  loadBoundedAuthorCatalogHistoryV1,
  type BoundedAuthorCatalogHistoryV1,
  type Rfc64CatalogAuthorSignerV1,
  type Rfc64CatalogSuccessorAssetInputV1,
  type Rfc64StagedAuthorCatalogHeadRefV1,
} from './dkg-agent-rfc64-catalog.js';
import { snapshotRfc64CatalogDeploymentProfileV1 } from './rfc64/catalog-authority-config-v1.js';
import type { AppliedCatalogHeadSnapshotV1 } from './rfc64/inventory-v1/index.js';
import { computeRfc64AppliedInventoryDigestV1 } from './rfc64/public-catalog-inventory-completeness-v1.js';
import type { Rfc64PersistenceV1 } from './rfc64/persistence-v1.js';

/** Internal normal-publication handoff after VM confirmation is durable locally. */
export interface RecordConfirmedRfc64PublicCatalogAssetParamsV1 {
  readonly contextGraphId: ContextGraphIdV1;
  readonly subGraphName?: SubGraphNameV1 | null;
  readonly assertionCoordinate: AssertionCoordinateV1;
  readonly publicQuads: readonly Quad[];
  readonly seal: AssertionSeal;
}

export class Rfc64CatalogAutoPublishMethods extends DKGAgentBase {
  /**
   * Advance this provider's exact public-root author catalog after an ordinary
   * graph-scoped KA publish has confirmed. The hook is dormant unless the
   * preview config is present. Catalog objects and bundles are staged first,
   * the provider's applied-head pointer advances second, and peer availability
   * hints are sent last.
   */
  async recordConfirmedRfc64PublicCatalogAssetV1(
    this: DKGAgent,
    params: RecordConfirmedRfc64PublicCatalogAssetParamsV1,
  ): Promise<AppliedCatalogHeadSnapshotV1 | null> {
    const autoPublish = this.config.rfc64PublicCatalogAutoPublish;
    if (autoPublish === undefined) return null;
    if (params.subGraphName !== undefined && params.subGraphName !== null) return null;
    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) {
      throw new Error('RFC-64 auto-publish requires durable persistence');
    }

    const seal = canonicalRfc64SealFromAssertionSeal(params.seal);
    if (params.publicQuads.length !== Number(seal.publicTripleCount)) {
      throw new Error(
        'RFC-64 auto-publish public projection count differs from the confirmed author seal',
      );
    }
    const projectionBytes = canonicalPublicProjectionBytes(params.publicQuads);
    const networkId = (this.config.rfc64CatalogDeploymentProfile?.networkId
      ?? this.chain.chainId) as NetworkIdV1;
    if (networkId === 'none') {
      throw new Error('RFC-64 auto-publish requires a trusted deployment network');
    }
    const service = this.rfc64PublicCatalogServiceV1;
    if (service === undefined) {
      throw new Error(
        'RFC-64 public catalog service is not available (agent not started or no dataDir)',
      );
    }
    const acceptedPolicy = service.acceptedPolicySnapshot(networkId, params.contextGraphId);
    if (acceptedPolicy === null || acceptedPolicy.policy.accessPolicy !== 0) {
      throw new Error(
        'RFC-64 auto-publish requires an independently accepted current public policy',
      );
    }
    const scope: AuthorCatalogScopeV1 = Object.freeze({
      networkId,
      contextGraphId: params.contextGraphId,
      governanceChainId: acceptedPolicy.policy.governanceChainId,
      governanceContractAddress: acceptedPolicy.policy.governanceContractAddress,
      ownershipTransitionDigest: acceptedPolicy.policy.ownershipTransitionDigest,
      subGraphName: null,
      authorAddress: seal.authorAddress,
      era: acceptedPolicy.policy.era,
      bucketCount: '1' as CountV1,
    });
    service.acceptedPolicySnapshotForCatalogScope(scope);
    const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(scope);
    const queueKey = `${catalogScopeDigest}\n${seal.authorAddress}`;

    return this.runSerializedRfc64AuthorCatalogMutationV1(queueKey, async () => {
      const signer = this.createRfc64CatalogAuthorSignerV1(seal.authorAddress);
      let current = persistence.inventory.readAppliedCatalogHeadV1(
        catalogScopeDigest,
        seal.authorAddress,
      );
      if (current === null) {
        const genesis = await this.publishAuthorCatalogGenesisV1({
          scope,
          author: signer,
          peers: [],
          issuedAt: Date.now().toString() as TimestampMsV1,
          catalogIssuerDelegationEffectiveAt:
            autoPublish.catalogIssuerDelegationEffectiveAt ?? ('0' as TimestampMsV1),
          catalogIssuerDelegationExpiresAt:
            autoPublish.catalogIssuerDelegationExpiresAt,
        });
        const emptyInventoryDigest = computeRfc64AppliedInventoryDigestV1({
          catalogScopeDigest,
          rows: [],
        });
        current = persistence.inventory.compareAndSwapAppliedCatalogHeadV1({
          catalogScopeDigest,
          authorAddress: seal.authorAddress,
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
      const nextAsset: Rfc64CatalogSuccessorAssetInputV1 = Object.freeze({
        assertionCoordinate: params.assertionCoordinate,
        projectionBytes,
        seal,
      });
      const existingIndex = assets.findIndex(
        (asset) => asset.seal.reservedKaId === seal.reservedKaId,
      );
      if (existingIndex >= 0 && sameRfc64SuccessorAssetV1(assets[existingIndex]!, nextAsset)) {
        return current;
      }
      if (existingIndex >= 0) assets[existingIndex] = nextAsset;
      else assets.push(nextAsset);

      const storedDelegation = await persistence.controlObjects.getVerifiedObjectByDigest({
        objectDigest: history.previousHead.payload.catalogIssuerDelegationDigest,
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      });
      if (storedDelegation === null) {
        throw new Error('RFC-64 applied author head delegation is not durably staged');
      }
      assertSignedAuthorCatalogIssuerDelegationEnvelopeV1(storedDelegation.envelope);
      const deployment = await this.resolveRfc64AutoPublishDeploymentProfileV1(networkId);
      const successor = await this.publishAuthorCatalogExactSetSuccessorV1({
        previousHead,
        author: signer,
        catalogIssuerAuthorization: Object.freeze({
          catalogIssuerDelegation: storedDelegation.envelope,
          parentAuthorAgentEvidence: null,
        }),
        assets,
        deployment,
        issuedAt: Date.now().toString() as TimestampMsV1,
        peers: [],
      });
      const appliedInventoryDigest = computeRfc64AppliedInventoryDigestV1({
        catalogScopeDigest: successor.catalogScopeDigest,
        rows: successor.assets,
      });
      const applied = persistence.inventory.compareAndSwapAppliedCatalogHeadV1({
        catalogScopeDigest: successor.catalogScopeDigest,
        authorAddress: seal.authorAddress,
        currentCatalogHeadDigest: successor.headObjectDigest,
        appliedInventoryDigest,
        catalogVersion: successor.announcement.catalogVersion,
        inventoryRowCount: successor.signedBucketRowCount,
        expectedCurrentCatalogHeadDigest: current.currentCatalogHeadDigest,
      }).snapshot;
      await this.announceRfc64PublicCatalogHeadV1({
        announcement: successor.announcement,
        peers: autoPublish.peers,
      });
      return applied;
    });
  }

  private createRfc64CatalogAuthorSignerV1(
    this: DKGAgent,
    authorAddress: EvmAddressV1,
  ): Rfc64CatalogAuthorSignerV1 {
    const custodialKey = this.getCustodialAgentPrivateKey(authorAddress);
    if (custodialKey !== undefined) {
      const wallet = new ethers.Wallet(
        custodialKey.startsWith('0x') ? custodialKey : `0x${custodialKey}`,
      );
      if (wallet.address.toLowerCase() !== authorAddress) {
        throw new Error('RFC-64 custodial author key does not match the confirmed seal');
      }
      return Object.freeze({
        address: authorAddress,
        signMessage: (message: Uint8Array) => wallet.signMessage(message),
      });
    }
    const signMessageAs = this.chain.signMessageAs?.bind(this.chain);
    const signMessage = this.chain.signMessage?.bind(this.chain);
    return Object.freeze({
      address: authorAddress,
      signMessage: async (message: Uint8Array) => {
        const compact = signMessageAs !== undefined
          ? await signMessageAs(authorAddress, message)
          : signMessage !== undefined
            ? await signMessage(message)
            : (() => { throw new Error('RFC-64 configured chain has no message signer'); })();
        const signature = ethers.Signature.from({
          r: ethers.hexlify(compact.r),
          yParityAndS: ethers.hexlify(compact.vs),
        }).serialized;
        if (ethers.verifyMessage(message, signature).toLowerCase() !== authorAddress) {
          throw new Error('RFC-64 configured publisher cannot sign for the confirmed KA author');
        }
        return signature;
      },
    });
  }

  private async resolveRfc64AutoPublishDeploymentProfileV1(
    this: DKGAgent,
    networkId: NetworkIdV1,
  ): Promise<CatalogSealDeploymentProfileV1> {
    let deployment = this.config.rfc64CatalogDeploymentProfile;
    const trustedNetworkId = deployment?.networkId ?? this.chain.chainId;
    if (trustedNetworkId === 'none' || trustedNetworkId !== networkId) {
      throw new Error('RFC-64 auto-publish network differs from the trusted deployment');
    }
    if (deployment === undefined) {
      const [chainId, kav10Address] = await Promise.all([
        this.chain.getEvmChainId(),
        this.chain.getKnowledgeAssetsLifecycleAddress(),
      ]);
      deployment = snapshotRfc64CatalogDeploymentProfileV1({
        networkId,
        assertedAtChainId: chainId.toString() as never,
        assertedAtKav10Address: kav10Address as EvmAddressV1,
      });
      if (deployment === undefined) {
        throw new Error('RFC-64 chain deployment profile resolution failed');
      }
    }
    return deployment;
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

function canonicalRfc64SealFromAssertionSeal(
  seal: AssertionSeal,
): Readonly<CanonicalGraphScopedAuthorSealV1> {
  if (
    seal.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION
    || seal.kaUal === undefined
    || seal.assertionVersion === undefined
    || seal.publicTripleCount === undefined
    || seal.privateTripleCount === undefined
    || seal.reservedKaId === undefined
    || seal.authorSchemeVersion !== 1
  ) {
    throw new Error('RFC-64 auto-publish requires a complete graph-scoped v2 author seal');
  }
  const canonical = {
    assertionMerkleRoot: ethers.hexlify(seal.merkleRoot).toLowerCase(),
    authorAddress: seal.authorAddress.toLowerCase(),
    authorAttestationR: ethers.hexlify(seal.authorAttestationR).toLowerCase(),
    authorAttestationVS: ethers.hexlify(seal.authorAttestationVS).toLowerCase(),
    authorSchemeVersion: '1',
    assertedAtChainId: seal.chainId.toString(),
    assertedAtKav10Address: seal.kav10Address.toLowerCase(),
    reservedKaId: seal.reservedKaId.toString(),
    assertionFinalizedAt: seal.finalizedAtIso,
    contentScopeVersion: '2',
    kaUal: seal.kaUal,
    assertionVersion: seal.assertionVersion,
    publicTripleCount: seal.publicTripleCount.toString(),
    privateTripleCount: seal.privateTripleCount.toString(),
    privateMerkleRoot: seal.privateMerkleRoot === undefined
      ? null
      : ethers.hexlify(seal.privateMerkleRoot).toLowerCase(),
  } as unknown as CanonicalGraphScopedAuthorSealV1;
  assertCanonicalGraphScopedAuthorSealV1(canonical);
  return Object.freeze(canonical);
}

function canonicalPublicProjectionBytes(quads: readonly Quad[]): Uint8Array {
  const sorted = quads
    .map((quad) => ({ ...quad, graph: '' }))
    .sort((left, right) => (
      left.subject.localeCompare(right.subject)
      || left.predicate.localeCompare(right.predicate)
      || left.object.localeCompare(right.object)
    ));
  return new TextEncoder().encode(serializeWorkspacePublicSnapshotQuads(sorted));
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
