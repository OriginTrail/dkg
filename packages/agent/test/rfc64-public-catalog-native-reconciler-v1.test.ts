import {
  computeAuthorCatalogScopeDigestV1,
  type CatalogSealDeploymentProfileV1,
  type Digest32V1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';
import { describe, expect, it, vi } from 'vitest';

import type { AppliedCatalogHeadSnapshotV1 } from '../src/rfc64/inventory-v1/index.js';
import {
  createRfc64PublicOpenCatalogNativeReconcilerV1,
  deriveRfc64PublicOpenCatalogScopeV1,
  type Rfc64PublicOpenCatalogNativeReceiverClientV1,
} from '../src/rfc64/public-catalog-native-reconciler-v1.js';
import {
  Rfc64PublicCatalogNativeReceiverErrorV1,
} from '../src/rfc64/public-catalog-native-receiver-v1.js';
import type {
  Rfc64PublicCatalogHeadAnnouncementV1,
} from '../src/rfc64/public-catalog-transport-v1.js';

const NETWORK_ID = 'otp:20430' as const;
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/native-reconciler' as const;
const AUTHOR = '0x2222222222222222222222222222222222222222' as EvmAddressV1;
const KAV10 = '0x3333333333333333333333333333333333333333' as EvmAddressV1;
const HEAD = `0x${'44'.repeat(32)}` as Digest32V1;
const INVENTORY = `0x${'55'.repeat(32)}` as Digest32V1;
const POLICY = `0x${'66'.repeat(32)}` as Digest32V1;
const SIGNATURE_VARIANT = `0x${'77'.repeat(32)}` as Digest32V1;
const DEPLOYMENT = Object.freeze({
  networkId: NETWORK_ID,
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
}) as CatalogSealDeploymentProfileV1;

function announcement(
  catalogVersion = '0',
  overrides: Partial<Rfc64PublicCatalogHeadAnnouncementV1> = {},
): Rfc64PublicCatalogHeadAnnouncementV1 {
  return Object.freeze({
    kind: 'rfc64-author-catalog-head-availability-v1',
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    subGraphName: null,
    authorAddress: AUTHOR,
    catalogEra: '0',
    catalogVersion,
    policyDigest: POLICY,
    catalogHeadObjectDigest: HEAD,
    signatureVariantDigest: SIGNATURE_VARIANT,
    ...overrides,
  }) as Rfc64PublicCatalogHeadAnnouncementV1;
}

function snapshot(
  input: Rfc64PublicCatalogHeadAnnouncementV1,
  overrides: Partial<AppliedCatalogHeadSnapshotV1> = {},
): AppliedCatalogHeadSnapshotV1 {
  const catalogScopeDigest = computeAuthorCatalogScopeDigestV1({
    networkId: input.networkId,
    contextGraphId: input.contextGraphId,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: input.authorAddress,
    era: input.catalogEra,
    bucketCount: '1',
  });
  return {
    catalogScopeDigest,
    authorAddress: input.authorAddress,
    currentCatalogHeadDigest: input.catalogHeadObjectDigest,
    appliedInventoryDigest: INVENTORY,
    catalogVersion: input.catalogVersion,
    inventoryRowCount: input.catalogVersion === '0' ? '0' : '1',
    ...overrides,
  } as AppliedCatalogHeadSnapshotV1;
}

function receiver(
  synchronizePublicOpenCatalog: Rfc64PublicOpenCatalogNativeReceiverClientV1[
    'synchronizePublicOpenCatalog'
  ],
): Rfc64PublicOpenCatalogNativeReceiverClientV1 {
  return { synchronizePublicOpenCatalog };
}

describe('RFC-64 public/open native reconciler v1', () => {
  it('maps both genesis and successor evidence to applied and passes deployment plus cancellation', async () => {
    const synchronize = vi.fn(async () => ({ inventoryRowCount: 0 } as never));
    const resolveDeployment = vi.fn(async () => DEPLOYMENT);
    const reconciler = createRfc64PublicOpenCatalogNativeReconcilerV1({
      nativeReceiver: receiver(synchronize),
      inventory: { readAppliedCatalogHeadV1: () => null },
      resolveDeployment,
    });
    const signal = new AbortController().signal;
    const genesis = announcement('0');
    const successor = announcement('1');

    await expect(reconciler.reconcileHead('peer-a', genesis, signal)).resolves.toBe('applied');
    await expect(reconciler.reconcileHead('peer-b', successor, signal)).resolves.toBe('applied');

    expect(resolveDeployment).toHaveBeenNthCalledWith(1, genesis, signal);
    expect(resolveDeployment).toHaveBeenNthCalledWith(2, successor, signal);
    expect(synchronize).toHaveBeenNthCalledWith(1, 'peer-a', genesis, DEPLOYMENT, signal);
    expect(synchronize).toHaveBeenNthCalledWith(2, 'peer-b', successor, DEPLOYMENT, signal);
  });

  it('dedupes only an exact fixed public/open applied head', async () => {
    const readAppliedCatalogHeadV1 = vi.fn();
    const reconciler = createRfc64PublicOpenCatalogNativeReconcilerV1({
      nativeReceiver: receiver(vi.fn()),
      inventory: { readAppliedCatalogHeadV1 },
      resolveDeployment: async () => DEPLOYMENT,
    });
    const genesis = announcement('0');
    readAppliedCatalogHeadV1.mockReturnValue(snapshot(genesis));

    await expect(reconciler.isHeadApplied(genesis)).resolves.toBe(true);
    await expect(reconciler.isHeadApplied(announcement('0', {
      policyDigest: `0x${'88'.repeat(32)}` as Digest32V1,
      signatureVariantDigest: `0x${'99'.repeat(32)}` as Digest32V1,
    }))).resolves.toBe(true);

    const successor = announcement('1');
    readAppliedCatalogHeadV1.mockReturnValue(snapshot(successor));
    await expect(reconciler.isHeadApplied(successor)).resolves.toBe(true);

    for (const mismatch of [
      { currentCatalogHeadDigest: `0x${'aa'.repeat(32)}` as Digest32V1 },
      { catalogVersion: '2' },
      { inventoryRowCount: '0' },
      { catalogScopeDigest: `0x${'bb'.repeat(32)}` as Digest32V1 },
      { authorAddress: '0xcccccccccccccccccccccccccccccccccccccccc' as EvmAddressV1 },
    ] satisfies Array<Partial<AppliedCatalogHeadSnapshotV1>>) {
      readAppliedCatalogHeadV1.mockReturnValue(snapshot(successor, mismatch));
      await expect(reconciler.isHeadApplied(successor)).resolves.toBe(false);
    }

    const expectedScopeDigest = computeAuthorCatalogScopeDigestV1(
      deriveRfc64PublicOpenCatalogScopeV1(successor),
    );
    expect(readAppliedCatalogHeadV1).toHaveBeenLastCalledWith(expectedScopeDigest, AUTHOR);
    expect(() => deriveRfc64PublicOpenCatalogScopeV1(announcement('1', {
      subGraphName: 'not-root' as never,
    }))).toThrow('root catalog lane');
  });

  it('maps only the explicit native not-found error and propagates all other failures', async () => {
    const notFound = new Rfc64PublicCatalogNativeReceiverErrorV1(
      'catalog-native-receiver-not-found',
      'missing',
    );
    const synchronize = vi.fn(async () => { throw notFound; });
    const reconciler = createRfc64PublicOpenCatalogNativeReconcilerV1({
      nativeReceiver: receiver(synchronize),
      inventory: { readAppliedCatalogHeadV1: () => null },
      resolveDeployment: async () => DEPLOYMENT,
    });
    const signal = new AbortController().signal;

    await expect(reconciler.reconcileHead('peer-a', announcement(), signal))
      .resolves.toBe('not-found');

    const historyFailure = new Rfc64PublicCatalogNativeReceiverErrorV1(
      'catalog-native-receiver-history',
      'fork',
    );
    synchronize.mockRejectedValueOnce(historyFailure);
    await expect(reconciler.reconcileHead('peer-a', announcement(), signal))
      .rejects.toBe(historyFailure);

    const integrityFailure = new Error('deployment binding changed');
    synchronize.mockRejectedValueOnce(integrityFailure);
    await expect(reconciler.reconcileHead('peer-a', announcement(), signal))
      .rejects.toBe(integrityFailure);
  });

  it('propagates deployment and cancellation failures without entering the native receiver', async () => {
    const synchronize = vi.fn();
    const deploymentFailure = new Error('trusted deployment unavailable');
    const resolveDeployment = vi.fn(async () => { throw deploymentFailure; });
    const reconciler = createRfc64PublicOpenCatalogNativeReconcilerV1({
      nativeReceiver: receiver(synchronize),
      inventory: { readAppliedCatalogHeadV1: () => null },
      resolveDeployment,
    });
    const signal = new AbortController().signal;
    await expect(reconciler.reconcileHead('peer-a', announcement(), signal))
      .rejects.toBe(deploymentFailure);
    expect(synchronize).not.toHaveBeenCalled();

    const controller = new AbortController();
    const cancellation = new Error('closing');
    controller.abort(cancellation);
    await expect(reconciler.reconcileHead('peer-a', announcement(), controller.signal))
      .rejects.toBe(cancellation);
    expect(resolveDeployment).toHaveBeenCalledTimes(1);
    expect(synchronize).not.toHaveBeenCalled();
  });
});
