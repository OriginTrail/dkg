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

export interface Rfc64PublicOpenCatalogNativeReconcilerOptionsV1 {
  readonly nativeReceiver: Rfc64PublicOpenCatalogNativeReceiverClientV1;
  readonly inventory: Pick<Rfc64InventoryV1OperationsV1, 'readAppliedCatalogHeadV1'>;
  /** Resolve the locally trusted deployment tuple; never copy it from the wire. */
  readonly resolveDeployment: Rfc64PublicOpenCatalogDeploymentResolverV1;
}

/**
 * Derive the one fixed Gate-1 public/open scope represented by an announcement.
 * Policy and signature-variant digests are transport/authentication context,
 * not semantic catalog identity, and therefore do not participate.
 */
export function deriveRfc64PublicOpenCatalogScopeV1(
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
): AuthorCatalogScopeV1 {
  if (announcement.subGraphName !== null) {
    throw new Error('RFC-64 Gate 1 public/open reconciler requires the root catalog lane');
  }
  return Object.freeze({
    networkId: announcement.networkId,
    contextGraphId: announcement.contextGraphId,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: announcement.authorAddress,
    era: announcement.catalogEra,
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
      || typeof options?.resolveDeployment !== 'function'
    ) {
      throw new TypeError('RFC-64 public/open native reconciler dependencies are incomplete');
    }
  }

  async isHeadApplied(
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  ): Promise<boolean> {
    const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(
      deriveRfc64PublicOpenCatalogScopeV1(announcement),
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
    const deployment = await this.options.resolveDeployment(announcement, signal);
    throwIfAborted(signal);
    try {
      await this.options.nativeReceiver.synchronizePublicOpenCatalog(
        remotePeerId,
        announcement,
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
