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
import type {
  AppliedCatalogHeadsSnapshotV1,
  AppliedCatalogHeadsTokenV1,
} from './inventory-v1/index.js';

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
  readAppliedCatalogHeadsSnapshotV1(): AppliedCatalogHeadsSnapshotV1;
  readVerifiedCatalogHeadV1(
    objectDigest: Digest32V1,
  ): Promise<SignedControlEnvelopeV1 | null>;
}

interface WithRfc64CatalogReplaySnapshotInputV1<Prepared, T> {
  readonly selection: Rfc64CatalogReplaySelectionV1;
  /**
   * Runs while the catalog mutation locks of the snapshot's scopes are held, so `entries` is one
   * consistent set. Every change of those catalogs waits for it: it must not wait for a peer.
   */
  prepare(entries: readonly Rfc64CatalogReplayHeadV1[]): Prepared | Promise<Prepared>;
  /**
   * Runs once the locks are released (GH#3081), so a catalog change never waits for a replay's
   * sends. A change that lands meanwhile makes the replay reject after delivery has ended.
   */
  deliver(prepared: Prepared): Promise<T>;
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

/**
 * Own index construction, cache invalidation, and the complete snapshot protocol.
 *
 * A replay has two phases. `prepare` runs under the catalog mutation locks of every scope in the
 * snapshot and decides what to replay; `deliver` runs after they are released and sends it. The
 * replay completes only if the inventory it was prepared from is still current when delivery
 * ends: it rejects when the inventory moved before the locks settled, or while it delivered. The
 * second check is all that guards delivery now that the locks do not, so a replay that overlaps a
 * catalog change is rejected and its requester asks again.
 */
export class Rfc64CatalogReplaySnapshotRuntimeV1 {
  readonly #storage: Rfc64CatalogReplaySnapshotStorageV1;
  readonly #mutationCoordinator: Rfc64CatalogMutationCoordinatorV1;
  #indexToken: AppliedCatalogHeadsTokenV1 | null = null;
  #indexByScope: ReadonlyMap<string, readonly Rfc64CatalogReplayHeadV1[]> = new Map();

  constructor(
    storage: Rfc64CatalogReplaySnapshotStorageV1,
    mutationCoordinator: Rfc64CatalogMutationCoordinatorV1,
  ) {
    this.#storage = storage;
    this.#mutationCoordinator = mutationCoordinator;
  }

  async withSnapshot<Prepared, T>(
    input: Readonly<WithRfc64CatalogReplaySnapshotInputV1<Prepared, T>>,
  ): Promise<T> {
    if (input.selection.kind === 'all') {
      const inventoryToken = this.#readInventoryToken();
      const entries = Object.freeze([
        ...(await this.#readIndex()).values(),
      ].flat());
      const prepared = await this.#mutationCoordinator.runMany(
        rfc64CatalogReplayMutationScopesV1(entries),
        async () => {
          if (this.#readInventoryToken() !== inventoryToken) {
            throw new Error('RFC-64 durable catalog inventory changed before replay snapshot');
          }
          return input.prepare(entries);
        },
      );
      const result = await input.deliver(prepared);
      if (this.#readInventoryToken() !== inventoryToken) {
        throw new Error('RFC-64 durable catalog inventory changed during replay');
      }
      return result;
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
    const snapshot = await this.#mutationCoordinator.runMany(mutationScopes, async () => {
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
      return {
        entriesFingerprint: rfc64CatalogReplayEntriesFingerprintV1(entries),
        prepared: await input.prepare(entries),
      };
    });
    const result = await input.deliver(snapshot.prepared);
    const currentEntries = (await this.#readIndex()).get(replayScopeKey) ?? [];
    if (rfc64CatalogReplayEntriesFingerprintV1(currentEntries) !== snapshot.entriesFingerprint) {
      throw new Error('RFC-64 scoped catalog inventory changed during replay');
    }
    return result;
  }

  #readInventoryToken(): AppliedCatalogHeadsTokenV1 {
    return this.#storage.readAppliedCatalogHeadsSnapshotV1().token;
  }

  async #readIndex(): Promise<ReadonlyMap<string, readonly Rfc64CatalogReplayHeadV1[]>> {
    const { token, heads } = this.#storage.readAppliedCatalogHeadsSnapshotV1();
    if (this.#indexToken === token) return this.#indexByScope;

    const index = new Map<string, Rfc64CatalogReplayHeadV1[]>();
    for (const applied of heads) {
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
    this.#indexToken = token;
    this.#indexByScope = new Map([...index].map(([key, entries]) => [
      key,
      Object.freeze(entries),
    ]));
    return this.#indexByScope;
  }
}
