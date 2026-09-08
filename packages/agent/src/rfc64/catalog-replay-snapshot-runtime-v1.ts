// SPDX-License-Identifier: Apache-2.0

import {
  computeAuthorCatalogScopeDigestV1,
  deriveAuthorCatalogScopeFromHeadV1,
  type AuthorCatalogScopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
} from '@origintrail-official/dkg-core';

import {
  rfc64CatalogMutationScopeKeyV1,
  type Rfc64CatalogMutationCoordinatorV1,
} from './catalog-mutation-runtime-v1.js';
import type { AppliedCatalogHeadSnapshotV1 } from './inventory-v1/index.js';
import type { Rfc64PersistenceV1 } from './persistence-v1.js';
import type { Rfc64PublicCatalogHeadReplayRequestV1 } from
  './public-catalog-transport-v1.js';

export interface Rfc64CatalogReplayHeadV1 {
  readonly head: SignedAuthorCatalogHeadEnvelopeV1;
}

interface WithLockedRfc64CatalogReplaySnapshotInputV1<T> {
  readonly persistence: Rfc64PersistenceV1;
  readonly mutationCoordinator: Rfc64CatalogMutationCoordinatorV1;
  readonly requestedScope: Readonly<Rfc64PublicCatalogHeadReplayRequestV1> | undefined;
  readIndex(): Promise<ReadonlyMap<string, readonly Rfc64CatalogReplayHeadV1[]>>;
  operation(entries: readonly Rfc64CatalogReplayHeadV1[]): Promise<T>;
}

export function rfc64CatalogReplayInventoryFingerprintV1(
  snapshots: readonly AppliedCatalogHeadSnapshotV1[],
): string {
  return snapshots
    .map((snapshot) => [
      snapshot.catalogScopeDigest,
      snapshot.authorAddress,
      snapshot.currentCatalogHeadDigest,
      snapshot.appliedInventoryDigest,
      snapshot.catalogVersion,
      snapshot.inventoryRowCount,
    ].join(':'))
    .sort()
    .join('\n');
}

export function rfc64CatalogReplayScopeKeyV1(
  networkId: string,
  contextGraphId: string,
): string {
  return `${networkId}\0${contextGraphId}`;
}

function rfc64CatalogReplayEntriesFingerprintV1(
  entries: readonly Rfc64CatalogReplayHeadV1[],
): string {
  return entries
    .map(({ head }) => [
      computeAuthorCatalogScopeDigestV1(deriveAuthorCatalogScopeFromHeadV1(head.payload)),
      head.payload.authorAddress,
      head.objectDigest,
    ].join(':'))
    .sort()
    .join('\n');
}

function rfc64CatalogReplayMutationScopesV1(
  entries: readonly Rfc64CatalogReplayHeadV1[],
): readonly Readonly<AuthorCatalogScopeV1>[] {
  return [...new Map(entries.map(({ head }) => {
    const scope = deriveAuthorCatalogScopeFromHeadV1(head.payload);
    return [rfc64CatalogMutationScopeKeyV1(scope), scope] as const;
  })).values()];
}

/**
 * Own the complete replay snapshot protocol so refresh and validation cannot
 * be separated from canonical mutation-lock acquisition by a caller.
 */
export async function withLockedRfc64CatalogReplaySnapshotV1<T>(
  input: Readonly<WithLockedRfc64CatalogReplaySnapshotInputV1<T>>,
): Promise<T> {
  if (input.requestedScope === undefined) {
    const inventoryFingerprint = rfc64CatalogReplayInventoryFingerprintV1(
      input.persistence.inventory.listAppliedCatalogHeadsV1(),
    );
    const entries = Object.freeze([
      ...(await input.readIndex()).values(),
    ].flat());
    return input.mutationCoordinator.runMany(
      rfc64CatalogReplayMutationScopesV1(entries),
      async () => {
        if (rfc64CatalogReplayInventoryFingerprintV1(
          input.persistence.inventory.listAppliedCatalogHeadsV1(),
        ) !== inventoryFingerprint) {
          throw new Error('RFC-64 durable catalog inventory changed before replay snapshot');
        }
        const result = await input.operation(entries);
        if (rfc64CatalogReplayInventoryFingerprintV1(
          input.persistence.inventory.listAppliedCatalogHeadsV1(),
        ) !== inventoryFingerprint) {
          throw new Error('RFC-64 durable catalog inventory changed during replay');
        }
        return result;
      },
    );
  }

  const replayScopeKey = rfc64CatalogReplayScopeKeyV1(
    input.requestedScope.networkId,
    input.requestedScope.contextGraphId,
  );
  const discoveredEntries = (await input.readIndex()).get(replayScopeKey) ?? [];
  const mutationScopes = rfc64CatalogReplayMutationScopesV1(discoveredEntries);
  const lockedScopeKeys = new Set(mutationScopes.map(
    (scope) => rfc64CatalogMutationScopeKeyV1(scope),
  ));
  return input.mutationCoordinator.runMany(mutationScopes, async () => {
    // Refresh only after all discovered author scopes are locked so a
    // same-author head advance that raced acquisition joins this snapshot.
    const entries = (await input.readIndex()).get(replayScopeKey) ?? [];
    if (entries.some(({ head }) => !lockedScopeKeys.has(
      rfc64CatalogMutationScopeKeyV1(
        deriveAuthorCatalogScopeFromHeadV1(head.payload),
      ),
    ))) {
      throw new Error('RFC-64 scoped catalog inventory changed before replay snapshot');
    }
    const entriesFingerprint = rfc64CatalogReplayEntriesFingerprintV1(entries);
    const result = await input.operation(entries);
    const currentEntries = (await input.readIndex()).get(replayScopeKey) ?? [];
    if (rfc64CatalogReplayEntriesFingerprintV1(currentEntries) !== entriesFingerprint) {
      throw new Error('RFC-64 scoped catalog inventory changed during replay');
    }
    return result;
  });
}
