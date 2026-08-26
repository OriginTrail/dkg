import {
  computeAuthorCatalogScopeDigestV1,
  type CatalogSealDeploymentProfileV1,
  type Digest32V1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';
import { describe, expect, it, vi } from 'vitest';

import type { AppliedCatalogHeadSnapshotV1 } from '../src/rfc64/inventory-v1/index.js';
import { buildOpenOwnerContextGraphPolicyV1 } from '../src/rfc64/open-catalog-policy-v1.js';
import {
  createRfc64BoundedPublicRootCatalogNativeReconcilerV1,
  type Rfc64BoundedPublicRootCatalogNativeReceiverClientV1,
  type Rfc64BoundedPublicRootCatalogStagedHeadV1,
} from '../src/rfc64/public-catalog-native-reconciler-v1.js';
import { deriveRfc64PublicOpenCatalogScopeV1 } from '../src/rfc64/public-open-catalog-scope-v1.js';
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
const ACCEPTED_POLICY = buildOpenOwnerContextGraphPolicyV1({
  networkId: NETWORK_ID,
  contextGraphId: CONTEXT_GRAPH_ID,
  ownerAddress: AUTHOR,
});

const resolveTrustedCatalogScope = (
  input: Rfc64PublicCatalogHeadAnnouncementV1,
) => deriveRfc64PublicOpenCatalogScopeV1(input, ACCEPTED_POLICY);

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
  synchronizeBoundedPublicRootCatalog: Rfc64BoundedPublicRootCatalogNativeReceiverClientV1[
    'synchronizeBoundedPublicRootCatalog'
  ],
): Rfc64BoundedPublicRootCatalogNativeReceiverClientV1 {
  return { synchronizeBoundedPublicRootCatalog };
}

function stagedHead(
  input: Rfc64PublicCatalogHeadAnnouncementV1,
  totalRows: string,
  overrides: Partial<Rfc64BoundedPublicRootCatalogStagedHeadV1> = {},
): Rfc64BoundedPublicRootCatalogStagedHeadV1 {
  return {
    envelope: {
      objectDigest: input.catalogHeadObjectDigest,
      payload: {
        networkId: input.networkId,
        contextGraphId: input.contextGraphId,
        governanceChainId: null,
        governanceContractAddress: null,
        ownershipTransitionDigest: null,
        subGraphName: null,
        authorAddress: input.authorAddress,
        catalogIssuerDelegationDigest: `0x${'12'.repeat(32)}`,
        era: input.catalogEra,
        version: input.catalogVersion,
        previousHeadDigest: input.catalogVersion === '0' ? null : `0x${'13'.repeat(32)}`,
        bucketCount: '1',
        totalRows,
        directoryHeight: '0',
        directoryRootDigest: `0x${'14'.repeat(32)}`,
        issuedAt: '1773900000000',
      },
    } as never,
    signatureVariantDigest: input.signatureVariantDigest,
    ...overrides,
  };
}

describe('RFC-64 bounded public root native reconciler v1', () => {
  it('maps both genesis and successor evidence to applied and passes deployment plus cancellation', async () => {
    const synchronize = vi.fn(async () => ({ inventoryRowCount: 0 } as never));
    const resolveDeployment = vi.fn(async () => DEPLOYMENT);
    const reconciler = createRfc64BoundedPublicRootCatalogNativeReconcilerV1({
      nativeReceiver: receiver(synchronize),
      inventory: { readAppliedCatalogHeadV1: () => null },
      resolveTrustedCatalogScope,
      resolveDeployment,
    });
    const signal = new AbortController().signal;
    const genesis = announcement('0');
    const successor = announcement('1');

    await expect(reconciler.reconcileHead('peer-a', genesis, signal)).resolves.toBe('applied');
    await expect(reconciler.reconcileHead('peer-b', successor, signal)).resolves.toBe('applied');

    expect(resolveDeployment).toHaveBeenNthCalledWith(1, genesis, signal);
    expect(resolveDeployment).toHaveBeenNthCalledWith(2, successor, signal);
    expect(synchronize).toHaveBeenNthCalledWith(
      1,
      'peer-a',
      genesis,
      resolveTrustedCatalogScope(genesis),
      DEPLOYMENT,
      signal,
    );
    expect(synchronize).toHaveBeenNthCalledWith(
      2,
      'peer-b',
      successor,
      resolveTrustedCatalogScope(successor),
      DEPLOYMENT,
      signal,
    );
  });

  it('dedupes only an exact bounded public root applied head', async () => {
    const readAppliedCatalogHeadV1 = vi.fn();
    const reconciler = createRfc64BoundedPublicRootCatalogNativeReconcilerV1({
      nativeReceiver: receiver(vi.fn()),
      inventory: { readAppliedCatalogHeadV1 },
      resolveTrustedCatalogScope,
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
      deriveRfc64PublicOpenCatalogScopeV1(successor, ACCEPTED_POLICY),
    );
    expect(readAppliedCatalogHeadV1).toHaveBeenLastCalledWith(expectedScopeDigest, AUTHOR);
    expect(() => deriveRfc64PublicOpenCatalogScopeV1(announcement('1', {
      subGraphName: 'not-root' as never,
    }), ACCEPTED_POLICY)).toThrow('accepted null-governance owner policy');
  });

  it('forces a durable private finalized head through the current-policy precommit', async () => {
    const current = announcement('1');
    const readAppliedCatalogHeadV1 = vi.fn(() => snapshot(current));
    const requiresAppliedHeadPrecommit = vi.fn(() => true);
    const reconciler = createRfc64BoundedPublicRootCatalogNativeReconcilerV1({
      nativeReceiver: receiver(vi.fn()),
      inventory: { readAppliedCatalogHeadV1 },
      resolveTrustedCatalogScope,
      resolveDeployment: async () => DEPLOYMENT,
      requiresAppliedHeadPrecommit,
    });

    await expect(reconciler.isHeadApplied(current)).resolves.toBe(false);
    expect(requiresAppliedHeadPrecommit).toHaveBeenCalledWith(current);
    expect(readAppliedCatalogHeadV1).not.toHaveBeenCalled();
  });

  it('derives a multi-row dedupe count only from the exact staged head variant', async () => {
    const successor = announcement('1');
    const readStagedCatalogHead = vi.fn(async () => stagedHead(successor, '2'));
    const readAppliedCatalogHeadV1 = vi.fn(() => snapshot(successor, {
      inventoryRowCount: '2',
    }));
    const reconciler = createRfc64BoundedPublicRootCatalogNativeReconcilerV1({
      nativeReceiver: receiver(vi.fn()),
      inventory: { readAppliedCatalogHeadV1 },
      resolveTrustedCatalogScope,
      resolveDeployment: async () => DEPLOYMENT,
      readStagedCatalogHead,
    });

    await expect(reconciler.isHeadApplied(successor)).resolves.toBe(true);
    expect(readStagedCatalogHead).toHaveBeenCalledWith(successor);

    readStagedCatalogHead.mockResolvedValueOnce(stagedHead(successor, '3'));
    await expect(reconciler.isHeadApplied(successor)).resolves.toBe(false);

    readStagedCatalogHead.mockResolvedValueOnce(stagedHead(successor, '2', {
      signatureVariantDigest: `0x${'ab'.repeat(32)}` as Digest32V1,
    }));
    await expect(reconciler.isHeadApplied(successor)).resolves.toBe(false);

    readStagedCatalogHead.mockResolvedValueOnce(null);
    await expect(reconciler.isHeadApplied(successor)).resolves.toBe(false);

    const legacyOnly = createRfc64BoundedPublicRootCatalogNativeReconcilerV1({
      nativeReceiver: receiver(vi.fn()),
      inventory: { readAppliedCatalogHeadV1 },
      resolveTrustedCatalogScope,
      resolveDeployment: async () => DEPLOYMENT,
    });
    await expect(legacyOnly.isHeadApplied(successor)).resolves.toBe(false);
  });

  it('maps only the explicit native not-found error and propagates all other failures', async () => {
    const notFound = new Rfc64PublicCatalogNativeReceiverErrorV1(
      'catalog-native-receiver-not-found',
      'missing',
    );
    const synchronize = vi.fn(async () => { throw notFound; });
    const reconciler = createRfc64BoundedPublicRootCatalogNativeReconcilerV1({
      nativeReceiver: receiver(synchronize),
      inventory: { readAppliedCatalogHeadV1: () => null },
      resolveTrustedCatalogScope,
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
    const reconciler = createRfc64BoundedPublicRootCatalogNativeReconcilerV1({
      nativeReceiver: receiver(synchronize),
      inventory: { readAppliedCatalogHeadV1: () => null },
      resolveTrustedCatalogScope,
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
