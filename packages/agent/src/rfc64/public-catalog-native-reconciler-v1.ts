// SPDX-License-Identifier: Apache-2.0

/**
 * Production scheduler adapter for the bounded RFC-64 public/open native lane.
 *
 * The scheduler reasons about durable semantic application, while the native
 * receiver owns fetch, verification, activation, exact post-read, and the
 * applied-head CAS. This adapter joins those contracts without giving either
 * side transport lifecycle ownership.
 */

import {
  computeAuthorCatalogScopeDigestV1,
  type AuthorCatalogScopeV1,
  type CatalogSealDeploymentProfileV1,
  type CountV1,
  type ContextGraphPolicyV1,
} from '@origintrail-official/dkg-core';

import type { Rfc64InventoryV1OperationsV1 } from './inventory-v1/index.js';
import {
  Rfc64PublicCatalogNativeReceiverErrorV1,
  type Rfc64PublicCatalogNativeReceiverV1,
} from './public-catalog-native-receiver-v1.js';
import type {
  Rfc64PublicCatalogReceiverReconcilerV1,
  Rfc64PublicCatalogReconcileResultV1,
} from './public-catalog-receiver-v1.js';
import type {
  Rfc64PublicCatalogHeadAnnouncementV1,
} from './public-catalog-transport-v1.js';

export type Rfc64PublicOpenCatalogNativeReceiverClientV1 = Pick<
  Rfc64PublicCatalogNativeReceiverV1,
  'synchronizePublicOpenCatalog'
>;

export type Rfc64PublicOpenCatalogDeploymentResolverV1 = (
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  signal: AbortSignal,
) => Promise<CatalogSealDeploymentProfileV1>;

/** Resolve the exact catalog scope from independently accepted local policy state. */
export type Rfc64PublicOpenCatalogTrustedScopeResolverV1 = (
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
) => Readonly<AuthorCatalogScopeV1>;

export interface Rfc64PublicOpenCatalogNativeReconcilerOptionsV1 {
  readonly nativeReceiver: Rfc64PublicOpenCatalogNativeReceiverClientV1;
  readonly inventory: Pick<Rfc64InventoryV1OperationsV1, 'readAppliedCatalogHeadV1'>;
  /** Resolve from accepted policy state; never reconstruct authority from wire fields alone. */
  readonly resolveTrustedCatalogScope: Rfc64PublicOpenCatalogTrustedScopeResolverV1;
  /** Resolve the locally trusted deployment tuple; never copy it from the wire. */
  readonly resolveDeployment: Rfc64PublicOpenCatalogDeploymentResolverV1;
}

/**
 * Derive the one fixed Gate-1 public/open scope from accepted local policy and
 * require the announcement to name that exact owner/network/CG/era/root lane.
 * Policy and signature-variant digests are transport/authentication context,
 * not semantic catalog identity, and therefore do not participate.
 */
export function deriveRfc64PublicOpenCatalogScopeV1(
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  acceptedPolicy: ContextGraphPolicyV1,
): AuthorCatalogScopeV1 {
  if (
    acceptedPolicy.accessPolicy !== 0
    || acceptedPolicy.source.kind !== 'owner-signed-unregistered'
    || acceptedPolicy.networkId !== announcement.networkId
    || acceptedPolicy.contextGraphId !== announcement.contextGraphId
    || acceptedPolicy.governanceChainId !== null
    || acceptedPolicy.governanceContractAddress !== null
    || acceptedPolicy.ownershipTransitionDigest !== null
    || acceptedPolicy.era !== announcement.catalogEra
    || announcement.subGraphName !== null
    || acceptedPolicy.source.ownerAddress !== announcement.authorAddress
  ) {
    throw new Error(
      'RFC-64 Gate 1 announcement is not bound to the accepted null-governance owner policy',
    );
  }
  return Object.freeze({
    networkId: acceptedPolicy.networkId,
    contextGraphId: acceptedPolicy.contextGraphId,
    governanceChainId: acceptedPolicy.governanceChainId,
    governanceContractAddress: acceptedPolicy.governanceContractAddress,
    ownershipTransitionDigest: acceptedPolicy.ownershipTransitionDigest,
    subGraphName: null,
    authorAddress: acceptedPolicy.source.ownerAddress,
    era: acceptedPolicy.era,
    bucketCount: '1' as CountV1,
  });
}

export class Rfc64PublicOpenCatalogNativeReconcilerV1
  implements Rfc64PublicCatalogReceiverReconcilerV1 {
  constructor(
    private readonly options: Rfc64PublicOpenCatalogNativeReconcilerOptionsV1,
  ) {
    if (
      typeof options?.nativeReceiver?.synchronizePublicOpenCatalog !== 'function'
      || typeof options?.inventory?.readAppliedCatalogHeadV1 !== 'function'
      || typeof options?.resolveTrustedCatalogScope !== 'function'
      || typeof options?.resolveDeployment !== 'function'
    ) {
      throw new TypeError('RFC-64 public/open native reconciler dependencies are incomplete');
    }
  }

  async isHeadApplied(
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  ): Promise<boolean> {
    const trustedCatalogScope = this.options.resolveTrustedCatalogScope(announcement);
    const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(
      trustedCatalogScope,
    );
    const current = this.options.inventory.readAppliedCatalogHeadV1(
      catalogScopeDigest,
      announcement.authorAddress,
    );
    const expectedInventoryRowCount = announcement.catalogVersion === '0' ? '0' : '1';
    return current !== null
      && current.catalogScopeDigest === catalogScopeDigest
      && current.authorAddress === announcement.authorAddress
      && current.currentCatalogHeadDigest === announcement.catalogHeadObjectDigest
      && current.catalogVersion === announcement.catalogVersion
      && current.inventoryRowCount === expectedInventoryRowCount;
  }

  async reconcileHead(
    remotePeerId: string,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    signal: AbortSignal,
  ): Promise<Rfc64PublicCatalogReconcileResultV1> {
    throwIfAborted(signal);
    const trustedCatalogScope = this.options.resolveTrustedCatalogScope(announcement);
    throwIfAborted(signal);
    const deployment = await this.options.resolveDeployment(announcement, signal);
    throwIfAborted(signal);
    try {
      await this.options.nativeReceiver.synchronizePublicOpenCatalog(
        remotePeerId,
        announcement,
        trustedCatalogScope,
        deployment,
        signal,
      );
      return 'applied';
    } catch (cause) {
      if (
        cause instanceof Rfc64PublicCatalogNativeReceiverErrorV1
        && cause.code === 'catalog-native-receiver-not-found'
      ) {
        return 'not-found';
      }
      throw cause;
    }
  }
}

/** Construct the production scheduler adapter around one native receiver. */
export function createRfc64PublicOpenCatalogNativeReconcilerV1(
  options: Rfc64PublicOpenCatalogNativeReconcilerOptionsV1,
): Rfc64PublicCatalogReceiverReconcilerV1 {
  return new Rfc64PublicOpenCatalogNativeReconcilerV1(options);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}
