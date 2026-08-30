// SPDX-License-Identifier: Apache-2.0

/**
 * Production scheduler adapter for the bounded RFC-64 public root native lane.
 *
 * The scheduler reasons about durable semantic application, while the native
 * receiver owns fetch, verification, activation, exact post-read, and the
 * applied-head CAS. This adapter joins those contracts without giving either
 * side transport lifecycle ownership.
 */

import {
  assertAuthorCatalogHeadScopeBindingV1,
  computeAuthorCatalogScopeDigestV1,
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  type AuthorCatalogScopeV1,
  type CatalogSealDeploymentProfileV1,
  type CountV1,
  type Digest32V1,
  type SignedAuthorCatalogHeadEnvelopeV1,
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
import type { Rfc64PublicCatalogHeadAnnouncementV1 } from './public-catalog-transport-v1.js';

export type Rfc64BoundedPublicRootCatalogNativeReceiverClientV1<
  TPostHeadExtension extends object = Readonly<Record<string, unknown>>,
> = Pick<
  Rfc64PublicCatalogNativeReceiverV1<TPostHeadExtension>,
  'synchronizeBoundedPublicRootCatalog'
>;

export type Rfc64BoundedPublicRootCatalogDeploymentResolverV1 = (
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  signal: AbortSignal,
) => Promise<CatalogSealDeploymentProfileV1>;

/** Resolve the exact catalog scope from independently accepted local policy state. */
export type Rfc64BoundedPublicRootCatalogTrustedScopeResolverV1 = (
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
) => Readonly<AuthorCatalogScopeV1>;

/** Exact verified signature variant loaded from the durable control-object store. */
export interface Rfc64BoundedPublicRootCatalogStagedHeadV1 {
  readonly envelope: SignedAuthorCatalogHeadEnvelopeV1;
  readonly signatureVariantDigest: Digest32V1;
}

export type Rfc64BoundedPublicRootCatalogStagedHeadReaderV1 = (
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
) => Promise<Rfc64BoundedPublicRootCatalogStagedHeadV1 | null>;

export interface Rfc64BoundedPublicRootCatalogNativeReconcilerOptionsV1<
  TPostHeadExtension extends object = Readonly<Record<string, unknown>>,
> {
  readonly nativeReceiver:
    Rfc64BoundedPublicRootCatalogNativeReceiverClientV1<TPostHeadExtension>;
  readonly inventory: Pick<Rfc64InventoryV1OperationsV1, 'readAppliedCatalogHeadV1'>;
  /** Resolve from accepted policy state; never reconstruct authority from wire fields alone. */
  readonly resolveTrustedCatalogScope: Rfc64BoundedPublicRootCatalogTrustedScopeResolverV1;
  /** Resolve the locally trusted deployment tuple; never copy it from the wire. */
  readonly resolveDeployment: Rfc64BoundedPublicRootCatalogDeploymentResolverV1;
  /**
   * Read the exact verified signature variant staged by the native receiver.
   * Optional only for Gate-1 compatibility; a multi-row lane must provide it.
   */
  readonly readStagedCatalogHead?: Rfc64BoundedPublicRootCatalogStagedHeadReaderV1;
  /**
   * Force an exact durable replay through the native receiver's precommit.
   * Private finalized catalogs use this to recheck the accepted policy/roster
   * generation and current chain truth even when the head digest is unchanged.
   */
  readonly requiresAppliedHeadPrecommit?: (
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  ) => boolean;
}

export class Rfc64BoundedPublicRootCatalogNativeReconcilerV1<
  TPostHeadExtension extends object = Readonly<Record<string, unknown>>,
>
  implements Rfc64PublicCatalogReceiverReconcilerV1 {
  constructor(
    private readonly options:
      Rfc64BoundedPublicRootCatalogNativeReconcilerOptionsV1<TPostHeadExtension>,
  ) {
    if (
      typeof options?.nativeReceiver?.synchronizeBoundedPublicRootCatalog !== 'function'
      || typeof options?.inventory?.readAppliedCatalogHeadV1 !== 'function'
      || typeof options?.resolveTrustedCatalogScope !== 'function'
      || typeof options?.resolveDeployment !== 'function'
      || (
        options?.readStagedCatalogHead !== undefined
        && typeof options.readStagedCatalogHead !== 'function'
      )
      || (
        options?.requiresAppliedHeadPrecommit !== undefined
        && typeof options.requiresAppliedHeadPrecommit !== 'function'
      )
    ) {
      throw new TypeError('RFC-64 bounded public root native reconciler dependencies are incomplete');
    }
  }

  async isHeadApplied(
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  ): Promise<boolean> {
    if (this.options.requiresAppliedHeadPrecommit?.(announcement) === true) {
      return false;
    }
    const trustedCatalogScope = this.options.resolveTrustedCatalogScope(announcement);
    const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(
      trustedCatalogScope,
    );
    const current = this.options.inventory.readAppliedCatalogHeadV1(
      catalogScopeDigest,
      announcement.authorAddress,
    );
    if (current === null) return false;
    const expectedInventoryRowCount = await this.readExpectedInventoryRowCount(
      announcement,
      trustedCatalogScope,
      current.inventoryRowCount,
    );
    if (expectedInventoryRowCount === null) return false;
    return current.catalogScopeDigest === catalogScopeDigest
      && current.authorAddress === announcement.authorAddress
      && current.currentCatalogHeadDigest === announcement.catalogHeadObjectDigest
      && current.catalogVersion === announcement.catalogVersion
      && current.inventoryRowCount === expectedInventoryRowCount;
  }

  private async readExpectedInventoryRowCount(
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    trustedCatalogScope: Readonly<AuthorCatalogScopeV1>,
    durableInventoryRowCount: CountV1,
  ): Promise<CountV1 | null> {
    if (this.options.readStagedCatalogHead === undefined) {
      // Preserve the already-qualified Gate-1 behavior. Refuse to bless a
      // multi-row snapshot without the exact staged head that commits its count.
      if (announcement.catalogVersion === '0') return '0' as CountV1;
      return durableInventoryRowCount === '0' || durableInventoryRowCount === '1'
        ? durableInventoryRowCount
        : null;
    }
    const staged = await this.options.readStagedCatalogHead(announcement);
    if (staged === null) return null;
    const head = staged.envelope;
    try {
      if (
        head.objectDigest !== announcement.catalogHeadObjectDigest
        || staged.signatureVariantDigest !== announcement.signatureVariantDigest
        || head.payload.version !== announcement.catalogVersion
      ) {
        throw new Error('staged head identity or exact signature variant differs from announcement');
      }
      assertAuthorCatalogHeadScopeBindingV1(head.payload, trustedCatalogScope);
      const totalRows = BigInt(head.payload.totalRows);
      if (
        totalRows < 0n
        || totalRows > BigInt(MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1)
        || (announcement.catalogVersion === '0' && totalRows !== 0n)
      ) {
        throw new Error('staged head totalRows is outside the bounded lane');
      }
    } catch {
      return null;
    }
    return head.payload.totalRows as CountV1;
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
      await this.options.nativeReceiver.synchronizeBoundedPublicRootCatalog(
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
export function createRfc64BoundedPublicRootCatalogNativeReconcilerV1<
  TPostHeadExtension extends object,
>(
  options: Rfc64BoundedPublicRootCatalogNativeReconcilerOptionsV1<TPostHeadExtension>,
): Rfc64PublicCatalogReceiverReconcilerV1 {
  return new Rfc64BoundedPublicRootCatalogNativeReconcilerV1(options);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}
