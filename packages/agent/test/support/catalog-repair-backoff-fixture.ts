import { afterEach, beforeEach, vi } from 'vitest';
import { createOperationContext, type ContextGraphIdV1, type EvmAddressV1 } from '@origintrail-official/dkg-core';
import { Rfc64SwmCatalogProjectionOwnerV1 } from '../../src/dkg-agent-rfc64-swm-catalog-projection-supervisor.js';
import type { CatalogRepairRevisionHintV1 } from '../../src/rfc64/catalog-repair-retry-v1.js';
import type { Rfc64FinalizedPrivatePlacementRepairV1 } from '../../src/rfc64/finalized-private-placement-repair-store-v1.js';
import type { FinalizedPlacementAuthorityV1 } from '../../src/internal/finalized-placement-decision.js';
import { pinnedPrivatePlacementAuthorityV1 } from './finalized-placement-decision-fixture.js';
export const CG = 'repair-backoff' as ContextGraphIdV1;
export const AUTHOR = `0x${'11'.repeat(20)}` as EvmAddressV1;
const owners: Rfc64SwmCatalogProjectionOwnerV1[] = [];
export const ctx = createOperationContext('system');

/** Scheduling suites opt in; pure data builders never install clock hooks. */
export function setupCatalogRepairBackoffFixture(): void {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(async () => {
    await Promise.all(owners.splice(0).map(owner => owner.close()));
    vi.useRealTimers();
  });
}

export function fixture(retryIntervalMs = 5_000, overrides: Partial<ConstructorParameters<typeof Rfc64SwmCatalogProjectionOwnerV1>[0]> = {}) {
  let revision: CatalogRepairRevisionHintV1 = { scopeIdentity: 'scope-1', headRevision: 'head-1' };
  let available = true;
  const durableScopes = vi.fn((): {contextGraphId: ContextGraphIdV1; authorAddress: EvmAddressV1}[] => []);
  let privateRepairs: readonly Rfc64FinalizedPrivatePlacementRepairV1[] = [];
  const reconcile = vi.fn(async (): Promise<null> => { throw new Error('unchanged repair failure'); });
  const repairPrivate = vi.fn(async (_repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>): Promise<void> => {
    throw new Error('unchanged private repair failure');
  });
  const readRevision = vi.fn(() => available ? revision : null);
  const listPrivateRepairs = vi.fn(() => privateRepairs);
  const readAuthority = vi.fn<(contextGraphId: string) => FinalizedPlacementAuthorityV1>(
    () => pinnedPrivatePlacementAuthorityV1(privateRepair(), available),
  );
  const warn = vi.fn();
  const dependencies = {
    resolvePartition: () => ({ retryIntervalMs, track2Policies: [], track2Targets: [], recoveryProviderPeerIds: [] }),
    listDurableInventoryScopes: durableScopes,
    listLocalAuthorAddresses: () => [AUTHOR],
    acceptsPublicRootLane: () => available,
    readFinalizedPlacementAuthority: readAuthority,
    readRepairRevision: readRevision,
    readPrivateFailure: () => null,
    writePrivateFailures: () => {},
    listFinalizedPrivateRepairs: listPrivateRepairs,
    repairFinalizedPrivatePlacement: repairPrivate,
    reconcile,
    warn,
    ...overrides,
  };
  const owner = new Rfc64SwmCatalogProjectionOwnerV1(dependencies);
  owners.push(owner);
  return {
    owner, reconcile, repairPrivate, readRevision, listPrivateRepairs, readAuthority, warn, durableScopes,
    request: () => owner.request({ contextGraphId: CG, authorAddress: AUTHOR, ctx }),
    setRevision: (value: string | CatalogRepairRevisionHintV1) => { revision = typeof value === 'string' ? { scopeIdentity: 'scope-1', headRevision: value } : value; },
    setAvailable: (value: boolean) => { available = value; },
    setPrivateRepairs: (value: readonly Rfc64FinalizedPrivatePlacementRepairV1[]) => { privateRepairs = value; },
    advance: async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await owner.whenIdle(); },
  };
}

export function privateRepair(): Rfc64FinalizedPrivatePlacementRepairV1 {
  return {
    version: 1, contextGraphId: CG, authorAddress: AUTHOR,
    inventoryScope: {
      networkId: 'otp:20430', contextGraphId: CG, governanceChainId: null,
      governanceContractAddress: null, ownershipTransitionDigest: null,
      authorAddress: AUTHOR, subGraphName: null, era: '1',
    },
    assertionCoordinate: 'repair', assertionVersion: '1',
    kaUal: `did:dkg:otp:20430/${AUTHOR}/1`, sealDigest: `0x${'22'.repeat(32)}`,
  } as Rfc64FinalizedPrivatePlacementRepairV1;
}
