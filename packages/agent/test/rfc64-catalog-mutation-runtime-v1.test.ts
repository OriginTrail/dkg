// SPDX-License-Identifier: Apache-2.0

import {
  type AuthorCatalogScopeV1,
  type Digest32V1,
  type SignedAuthorCatalogHeadEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { describe, expect, it, vi } from 'vitest';

import {
  Rfc64CatalogMutationCoordinatorV1,
  rfc64CatalogMutationScopeKeyV1,
} from '../src/rfc64/catalog-mutation-runtime-v1.js';
import {
  rfc64CatalogReplayScopeKeyV1,
  withLockedRfc64CatalogReplaySnapshotV1,
  type Rfc64CatalogReplayHeadV1,
} from '../src/rfc64/catalog-replay-snapshot-runtime-v1.js';
import type { AppliedCatalogHeadSnapshotV1 } from '../src/rfc64/inventory-v1/index.js';
import type { Rfc64PersistenceV1 } from '../src/rfc64/persistence-v1.js';

const AUTHOR = '0x1111111111111111111111111111111111111111';
const OTHER_AUTHOR = '0x2222222222222222222222222222222222222222';
const DIGEST_A = `0x${'aa'.repeat(32)}` as Digest32V1;
const DIGEST_B = `0x${'bb'.repeat(32)}` as Digest32V1;

function catalogScope(
  contextGraphId: string,
  authorAddress = AUTHOR,
): Readonly<AuthorCatalogScopeV1> {
  return Object.freeze({
    networkId: 'hardhat1',
    contextGraphId,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress,
    era: '0',
    bucketCount: '1',
  }) as AuthorCatalogScopeV1;
}

function replayHead(
  scope: Readonly<AuthorCatalogScopeV1>,
  objectDigest: Digest32V1,
): Readonly<Rfc64CatalogReplayHeadV1> {
  const payload = Object.freeze({
    ...scope,
    catalogIssuerDelegationDigest: DIGEST_A,
    version: '0',
    previousHeadDigest: null,
    totalRows: '0',
    directoryHeight: '0',
    directoryRootDigest: DIGEST_B,
    issuedAt: '1773900000000',
  });
  return Object.freeze({
    head: Object.freeze({ payload, objectDigest }) as unknown as SignedAuthorCatalogHeadEnvelopeV1,
  });
}

function persistenceWithInventory(
  readInventory: () => readonly AppliedCatalogHeadSnapshotV1[],
): Rfc64PersistenceV1 {
  return Object.freeze({
    inventory: Object.freeze({ listAppliedCatalogHeadsV1: readInventory }),
  }) as unknown as Rfc64PersistenceV1;
}

class RecordingCatalogMutationCoordinatorV1 extends Rfc64CatalogMutationCoordinatorV1 {
  readonly admissions: string[] = [];

  override run<T>(
    scope: Readonly<AuthorCatalogScopeV1>,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.admissions.push(rfc64CatalogMutationScopeKeyV1(scope));
    return super.run(scope, operation, signal);
  }
}

describe('RFC-64 catalog mutation coordinator', () => {
  it('deduplicates and acquires multiple scopes in canonical order', async () => {
    const coordinator = new RecordingCatalogMutationCoordinatorV1();
    const alpha = catalogScope(`${AUTHOR}/alpha`);
    const omega = catalogScope(`${AUTHOR}/omega`);
    const expectedOrder = [
      rfc64CatalogMutationScopeKeyV1(alpha),
      rfc64CatalogMutationScopeKeyV1(omega),
    ].sort();

    await expect(coordinator.runMany(
      [omega, alpha, omega],
      async () => 'complete',
    )).resolves.toBe('complete');
    expect(coordinator.admissions).toEqual(expectedOrder);
    expect(coordinator.activeScopeCount).toBe(0);
  });
});

describe('RFC-64 locked catalog replay snapshots', () => {
  it('rejects an unscoped replay when durable inventory changes during delivery', async () => {
    const initial = Object.freeze({
      catalogScopeDigest: DIGEST_A,
      authorAddress: AUTHOR,
      currentCatalogHeadDigest: DIGEST_A,
      appliedInventoryDigest: DIGEST_B,
      catalogVersion: '0',
      inventoryRowCount: '0',
    }) as AppliedCatalogHeadSnapshotV1;
    let inventory: readonly AppliedCatalogHeadSnapshotV1[] = [initial];

    await expect(withLockedRfc64CatalogReplaySnapshotV1({
      persistence: persistenceWithInventory(() => inventory),
      mutationCoordinator: new Rfc64CatalogMutationCoordinatorV1(),
      requestedScope: undefined,
      readIndex: async () => new Map(),
      operation: async () => {
        inventory = [Object.freeze({ ...initial, catalogVersion: '1' })];
        return 'delivered';
      },
    })).rejects.toThrow(/durable catalog inventory changed during replay/u);
  });

  it('rejects a scoped replay when a new author scope appears after discovery', async () => {
    const contextGraphId = `${AUTHOR}/catalog`;
    const replayScopeKey = rfc64CatalogReplayScopeKeyV1('hardhat1', contextGraphId);
    const first = replayHead(catalogScope(contextGraphId), DIGEST_A);
    const late = replayHead(catalogScope(contextGraphId, OTHER_AUTHOR), DIGEST_B);
    const readIndex = vi.fn()
      .mockResolvedValueOnce(new Map([[replayScopeKey, [first]]]))
      .mockResolvedValueOnce(new Map([[replayScopeKey, [first, late]]]));
    const operation = vi.fn(async () => 'delivered');

    await expect(withLockedRfc64CatalogReplaySnapshotV1({
      persistence: persistenceWithInventory(() => []),
      mutationCoordinator: new Rfc64CatalogMutationCoordinatorV1(),
      requestedScope: Object.freeze({
        kind: 'Rfc64PublicCatalogHeadReplayV1',
        networkId: 'hardhat1',
        contextGraphId,
        policyDigest: DIGEST_A,
      }),
      readIndex,
      operation,
    })).rejects.toThrow(/scoped catalog inventory changed before replay snapshot/u);
    expect(readIndex).toHaveBeenCalledTimes(2);
    expect(operation).not.toHaveBeenCalled();
  });
});
