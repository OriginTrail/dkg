// SPDX-License-Identifier: Apache-2.0

import {
  assertSignedAuthorCatalogHeadEnvelopeV1,
  computeAuthorCatalogScopeDigestV1,
  deriveAuthorCatalogScopeFromHeadV1,
  type AuthorCatalogScopeV1,
  type Digest32V1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type SignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';

import {
  rfc64CatalogMutationScopeKeyV1,
  type Rfc64CatalogMutationCoordinatorV1,
} from './catalog-mutation-runtime-v1.js';
import type { AppliedCatalogHeadSnapshotV1 } from './inventory-v1/index.js';

export interface Rfc64CatalogReplayHeadV1 {
  readonly head: SignedAuthorCatalogHeadEnvelopeV1;
}

export type Rfc64CatalogReplaySelectionV1 = Readonly<{
  readonly kind: 'all';
}> | Readonly<{
  readonly kind: 'scope';
  readonly networkId: string;
  readonly contextGraphId: string;
}>;

export interface Rfc64CatalogReplaySnapshotStorageV1 {
  listAppliedCatalogHeadsV1(): readonly AppliedCatalogHeadSnapshotV1[];
  readVerifiedCatalogHeadV1(
    objectDigest: Digest32V1,
  ): Promise<SignedControlEnvelopeV1 | null>;
}

interface WithRfc64CatalogReplaySnapshotInputV1<T> {
  readonly selection: Rfc64CatalogReplaySelectionV1;
  operation(entries: readonly Rfc64CatalogReplayHeadV1[]): Promise<T>;
}

function rfc64CatalogReplayInventoryFingerprintV1(
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

function rfc64CatalogReplayScopeKeyV1(
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

/** Own index construction, cache invalidation, and the complete locked snapshot protocol. */
export class Rfc64CatalogReplaySnapshotRuntimeV1 {
  readonly #storage: Rfc64CatalogReplaySnapshotStorageV1;
  readonly #mutationCoordinator: Rfc64CatalogMutationCoordinatorV1;
  #indexFingerprint: string | null = null;
  #indexByScope: ReadonlyMap<string, readonly Rfc64CatalogReplayHeadV1[]> = new Map();

  constructor(
    storage: Rfc64CatalogReplaySnapshotStorageV1,
    mutationCoordinator: Rfc64CatalogMutationCoordinatorV1,
  ) {
    this.#storage = storage;
    this.#mutationCoordinator = mutationCoordinator;
  }

  async withSnapshot<T>(
    input: Readonly<WithRfc64CatalogReplaySnapshotInputV1<T>>,
  ): Promise<T> {
    if (input.selection.kind === 'all') {
      const inventoryFingerprint = rfc64CatalogReplayInventoryFingerprintV1(
        this.#storage.listAppliedCatalogHeadsV1(),
      );
      const entries = Object.freeze([
        ...(await this.#readIndex()).values(),
      ].flat());
      return this.#mutationCoordinator.runMany(
        rfc64CatalogReplayMutationScopesV1(entries),
        async () => {
          if (rfc64CatalogReplayInventoryFingerprintV1(
            this.#storage.listAppliedCatalogHeadsV1(),
          ) !== inventoryFingerprint) {
            throw new Error('RFC-64 durable catalog inventory changed before replay snapshot');
          }
          const result = await input.operation(entries);
          if (rfc64CatalogReplayInventoryFingerprintV1(
            this.#storage.listAppliedCatalogHeadsV1(),
          ) !== inventoryFingerprint) {
            throw new Error('RFC-64 durable catalog inventory changed during replay');
          }
          return result;
        },
      );
    }

    const replayScopeKey = rfc64CatalogReplayScopeKeyV1(
      input.selection.networkId,
      input.selection.contextGraphId,
    );
    const discoveredEntries = (await this.#readIndex()).get(replayScopeKey) ?? [];
    const mutationScopes = rfc64CatalogReplayMutationScopesV1(discoveredEntries);
    const lockedScopeKeys = new Set(mutationScopes.map(
      (scope) => rfc64CatalogMutationScopeKeyV1(scope),
    ));
    return this.#mutationCoordinator.runMany(mutationScopes, async () => {
      // Refresh only after all discovered author scopes are locked so a
      // same-author head advance that raced acquisition joins this snapshot.
      const entries = (await this.#readIndex()).get(replayScopeKey) ?? [];
      if (entries.some(({ head }) => !lockedScopeKeys.has(
        rfc64CatalogMutationScopeKeyV1(
          deriveAuthorCatalogScopeFromHeadV1(head.payload),
        ),
      ))) {
        throw new Error('RFC-64 scoped catalog inventory changed before replay snapshot');
      }
      const entriesFingerprint = rfc64CatalogReplayEntriesFingerprintV1(entries);
      const result = await input.operation(entries);
      const currentEntries = (await this.#readIndex()).get(replayScopeKey) ?? [];
      if (rfc64CatalogReplayEntriesFingerprintV1(currentEntries) !== entriesFingerprint) {
        throw new Error('RFC-64 scoped catalog inventory changed during replay');
      }
      return result;
    });
  }

  async #readIndex(): Promise<ReadonlyMap<string, readonly Rfc64CatalogReplayHeadV1[]>> {
    const snapshots = this.#storage.listAppliedCatalogHeadsV1();
    const fingerprint = rfc64CatalogReplayInventoryFingerprintV1(snapshots);
    if (this.#indexFingerprint === fingerprint) return this.#indexByScope;

    const index = new Map<string, Rfc64CatalogReplayHeadV1[]>();
    for (const applied of snapshots) {
      const head = await this.#storage.readVerifiedCatalogHeadV1(
        applied.currentCatalogHeadDigest,
      ).catch(() => null);
      if (head === null) {
        throw new Error('RFC-64 durable catalog head is missing or unverifiable');
      }
      try {
        assertSignedAuthorCatalogHeadEnvelopeV1(head);
        const scope = deriveAuthorCatalogScopeFromHeadV1(head.payload);
        if (
          computeAuthorCatalogScopeDigestV1(scope) !== applied.catalogScopeDigest
          || head.payload.authorAddress !== applied.authorAddress
          || head.payload.version !== applied.catalogVersion
        ) {
          throw new Error('RFC-64 durable catalog head does not match its applied inventory row');
        }
        const key = rfc64CatalogReplayScopeKeyV1(
          head.payload.networkId,
          head.payload.contextGraphId,
        );
        const entries = index.get(key) ?? [];
        entries.push(Object.freeze({ head }));
        index.set(key, entries);
      } catch (cause) {
        throw new Error('RFC-64 durable catalog inventory contains an invalid head', {
          cause,
        });
      }
    }
    this.#indexFingerprint = fingerprint;
    this.#indexByScope = new Map([...index].map(([key, entries]) => [
      key,
      Object.freeze(entries),
    ]));
    return this.#indexByScope;
  }
}
