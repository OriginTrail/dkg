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

import type {
  AppliedCatalogHeadSnapshotV1,
  Rfc64InventoryV1OperationsV1,
} from './inventory-v1/index.js';
import {
  Rfc64PublicCatalogNativeReceiverErrorV1,
} from './public-catalog-native-receiver-v1.js';
import type {
  Rfc64PublicCatalogCurrentReceiverReconcilerV1,
  Rfc64PublicCatalogReconcileResultV1,
} from './public-catalog-receiver-v1.js';
import type { Rfc64PublicCatalogHeadAnnouncementV1 } from './public-catalog-transport-v1.js';

export interface Rfc64BoundedPublicRootCatalogNativeReceiverClientV1 {
  synchronizeBoundedPublicRootCatalog(
    remotePeerId: string,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    trustedCatalogScope: AuthorCatalogScopeV1,
    deployment: CatalogSealDeploymentProfileV1,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

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

/** Synchronous, read-free counterpart of the staged-head reader: `null` when unknown. */
export type Rfc64BoundedPublicRootCatalogStagedHeadPeekV1 = (
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
) => Rfc64BoundedPublicRootCatalogStagedHeadV1 | null;

/**
 * Staged heads kept by the memo below. Each one is an envelope the reader
 * already returned, so the bound caps memory at a few MiB while still covering
 * every applied head of a heavily replicated core.
 */
export const RFC64_VERIFIED_STAGED_CATALOG_HEAD_MEMO_MAX_ENTRIES_V1 = 4_096;

export interface Rfc64VerifiedStagedCatalogHeadMemoV1 {
  /**
   * Read through the memo. A remembered head is returned without a read; a
   * miss reads, and remembers the result only when it is a head for exactly
   * the announced object and signature-variant digests. Misses, `null` and
   * failures are never remembered.
   */
  readonly read: Rfc64BoundedPublicRootCatalogStagedHeadReaderV1;
  /** The remembered head for the exact announced digests, or `null`. Never reads. */
  readonly peek: Rfc64BoundedPublicRootCatalogStagedHeadPeekV1;
}

/**
 * Remember what a staged-head reader verified, keyed by the exact object and
 * signature-variant digests it is addressed by.
 *
 * Only for a reader whose non-null result is fixed by those two digests: a
 * content-addressed store that never rewrites or removes an object, read back
 * through a signature check that depends on nothing but the envelope. The
 * native reconciler uses the staged head only to decide whether an announced
 * head is already applied; applying or serving a head never reads through
 * this memo, so it never skips a signature check on those paths.
 */
export function createRfc64VerifiedStagedCatalogHeadMemoV1(
  readStagedCatalogHead: Rfc64BoundedPublicRootCatalogStagedHeadReaderV1,
  maxEntries = RFC64_VERIFIED_STAGED_CATALOG_HEAD_MEMO_MAX_ENTRIES_V1,
): Rfc64VerifiedStagedCatalogHeadMemoV1 {
  if (typeof readStagedCatalogHead !== 'function') {
    throw new TypeError('RFC-64 staged-head memo requires a reader');
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new TypeError('RFC-64 staged-head memo bound must be a positive integer');
  }
  const remembered = new Map<string, Rfc64BoundedPublicRootCatalogStagedHeadV1>();
  const keyOf = (announcement: Rfc64PublicCatalogHeadAnnouncementV1): string => (
    `${announcement.catalogHeadObjectDigest}\n${announcement.signatureVariantDigest}`
  );
  const peek: Rfc64BoundedPublicRootCatalogStagedHeadPeekV1 = (announcement) => {
    const key = keyOf(announcement);
    const staged = remembered.get(key);
    if (staged === undefined) return null;
    // Least recently used goes first.
    remembered.delete(key);
    remembered.set(key, staged);
    return staged;
  };
  const read: Rfc64BoundedPublicRootCatalogStagedHeadReaderV1 = async (announcement) => {
    const hit = peek(announcement);
    if (hit !== null) return hit;
    const key = keyOf(announcement);
    const staged = await readStagedCatalogHead(announcement);
    if (
      staged !== null
      && staged.envelope.objectDigest === announcement.catalogHeadObjectDigest
      && staged.signatureVariantDigest === announcement.signatureVariantDigest
    ) {
      remembered.delete(key);
      remembered.set(key, staged);
      while (remembered.size > maxEntries) {
        remembered.delete(remembered.keys().next().value!);
      }
    }
    return staged;
  };
  return Object.freeze({ read, peek });
}

export interface Rfc64BoundedPublicRootCatalogNativeReconcilerOptionsV1 {
  readonly nativeReceiver: Rfc64BoundedPublicRootCatalogNativeReceiverClientV1;
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
   * Read-free lookup of a staged head `readStagedCatalogHead` already returned
   * for the exact announced digests (see
   * {@link createRfc64VerifiedStagedCatalogHeadMemoV1}). Only
   * `isHeadKnownSatisfied` uses it; without it that check proves no head that
   * needs a staged head.
   */
  readonly peekStagedCatalogHead?: Rfc64BoundedPublicRootCatalogStagedHeadPeekV1;
  /**
   * Force an exact durable replay through the native receiver's precommit.
   * Private finalized catalogs use this to recheck the accepted policy/roster
   * generation and current chain truth even when the head digest is unchanged.
   */
  readonly requiresAppliedHeadPrecommit?: (
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  ) => boolean;
}

export class Rfc64BoundedPublicRootCatalogNativeReconcilerV1
  implements Rfc64PublicCatalogCurrentReceiverReconcilerV1 {
  constructor(
    private readonly options: Rfc64BoundedPublicRootCatalogNativeReconcilerOptionsV1,
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
        options?.peekStagedCatalogHead !== undefined
        && typeof options.peekStagedCatalogHead !== 'function'
      )
      || (
        options?.requiresAppliedHeadPrecommit !== undefined
        && typeof options.requiresAppliedHeadPrecommit !== 'function'
      )
    ) {
      throw new TypeError('RFC-64 bounded public root native reconciler dependencies are incomplete');
    }
  }

  async isHeadSatisfied(
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  ): Promise<boolean> {
    const applied = this.readAppliedHeadForSatisfaction(announcement);
    if (typeof applied === 'boolean') return applied;
    const expectedInventoryRowCount = await this.readExpectedInventoryRowCount(
      announcement,
      applied.trustedCatalogScope,
      applied.current.inventoryRowCount,
    );
    return appliedHeadMatchesAnnouncementV1(
      announcement,
      applied.current,
      expectedInventoryRowCount,
    );
  }

  /**
   * The same decision as {@link isHeadSatisfied}, taken synchronously and
   * without reading or verifying a staged head: `true` only when that check
   * would resolve `true` right now, and `false` whenever it cannot tell
   * without I/O beyond the applied-head row (or when any step throws). A
   * caller may skip work on `true`; `false` means "run the full check".
   */
  isHeadKnownSatisfied(
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  ): boolean {
    try {
      const applied = this.readAppliedHeadForSatisfaction(announcement);
      if (typeof applied === 'boolean') return applied;
      let expectedInventoryRowCount: CountV1 | null;
      if (this.options.readStagedCatalogHead === undefined) {
        expectedInventoryRowCount = gate1ExpectedInventoryRowCountV1(
          announcement,
          applied.current.inventoryRowCount,
        );
      } else {
        const staged = this.options.peekStagedCatalogHead?.(announcement) ?? null;
        if (staged === null) return false;
        expectedInventoryRowCount = stagedHeadExpectedInventoryRowCountV1(
          announcement,
          applied.trustedCatalogScope,
          staged,
        );
      }
      return appliedHeadMatchesAnnouncementV1(
        announcement,
        applied.current,
        expectedInventoryRowCount,
      );
    } catch {
      return false;
    }
  }

  /** @deprecated Use isHeadSatisfied for its explicit supersession semantics. */
  isHeadApplied(
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  ): Promise<boolean> {
    return this.isHeadSatisfied(announcement);
  }

  /**
   * Every step of the satisfaction check that needs no staged head: a boolean
   * when the applied row alone decides, else the row and scope to finish with.
   */
  private readAppliedHeadForSatisfaction(
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  ): boolean | Readonly<{
    trustedCatalogScope: Readonly<AuthorCatalogScopeV1>;
    current: AppliedCatalogHeadSnapshotV1;
  }> {
    const trustedCatalogScope = this.options.resolveTrustedCatalogScope(announcement);
    const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(
      trustedCatalogScope,
    );
    const current = this.options.inventory.readAppliedCatalogHeadV1(
      catalogScopeDigest,
      announcement.authorAddress,
    );
    if (current === null) return false;
    if (
      current.catalogScopeDigest !== catalogScopeDigest
      || current.authorAddress !== announcement.authorAddress
    ) {
      return false;
    }
    // A previously queued announcement can begin after a newer same-scope
    // head has already committed. It is then durably dominated, not a history
    // failure. Equal-version/different-digest announcements still proceed to
    // the native receiver and fail the strict fork/history checks.
    if (BigInt(current.catalogVersion) > BigInt(announcement.catalogVersion)) {
      return true;
    }
    if (this.options.requiresAppliedHeadPrecommit?.(announcement) === true) {
      return false;
    }
    return Object.freeze({ trustedCatalogScope, current });
  }

  private async readExpectedInventoryRowCount(
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    trustedCatalogScope: Readonly<AuthorCatalogScopeV1>,
    durableInventoryRowCount: CountV1,
  ): Promise<CountV1 | null> {
    if (this.options.readStagedCatalogHead === undefined) {
      return gate1ExpectedInventoryRowCountV1(announcement, durableInventoryRowCount);
    }
    const staged = await this.options.readStagedCatalogHead(announcement);
    if (staged === null) return null;
    return stagedHeadExpectedInventoryRowCountV1(announcement, trustedCatalogScope, staged);
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
export function createRfc64BoundedPublicRootCatalogNativeReconcilerV1(
  options: Rfc64BoundedPublicRootCatalogNativeReconcilerOptionsV1,
): Rfc64PublicCatalogCurrentReceiverReconcilerV1 {
  return new Rfc64BoundedPublicRootCatalogNativeReconcilerV1(options);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

function appliedHeadMatchesAnnouncementV1(
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  current: AppliedCatalogHeadSnapshotV1,
  expectedInventoryRowCount: CountV1 | null,
): boolean {
  if (expectedInventoryRowCount === null) return false;
  return current.currentCatalogHeadDigest === announcement.catalogHeadObjectDigest
    && current.catalogVersion === announcement.catalogVersion
    && current.inventoryRowCount === expectedInventoryRowCount;
}

function gate1ExpectedInventoryRowCountV1(
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  durableInventoryRowCount: CountV1,
): CountV1 | null {
  // Preserve the already-qualified Gate-1 behavior. Refuse to bless a
  // multi-row snapshot without the exact staged head that commits its count.
  if (announcement.catalogVersion === '0') return '0' as CountV1;
  return durableInventoryRowCount === '0' || durableInventoryRowCount === '1'
    ? durableInventoryRowCount
    : null;
}

function stagedHeadExpectedInventoryRowCountV1(
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  trustedCatalogScope: Readonly<AuthorCatalogScopeV1>,
  staged: Rfc64BoundedPublicRootCatalogStagedHeadV1,
): CountV1 | null {
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
