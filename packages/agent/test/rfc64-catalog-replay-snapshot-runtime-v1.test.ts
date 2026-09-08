// SPDX-License-Identifier: Apache-2.0

import {
  AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
  assertSignedAuthorCatalogHeadEnvelopeV1,
  computeAuthorCatalogHeadObjectDigestV1,
  computeAuthorCatalogScopeDigestV1,
  deriveAuthorCatalogScopeFromHeadV1,
  type AuthorCatalogHeadV1,
  type AuthorCatalogScopeV1,
  type Digest32V1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { describe, expect, it, vi } from 'vitest';

import { Rfc64CatalogMutationCoordinatorV1 } from
  '../src/rfc64/catalog-mutation-runtime-v1.js';
import { Rfc64CatalogReplaySnapshotRuntimeV1 } from
  '../src/rfc64/catalog-replay-snapshot-runtime-v1.js';
import type { AppliedCatalogHeadSnapshotV1 } from '../src/rfc64/inventory-v1/index.js';
import type { Rfc64PersistenceV1 } from '../src/rfc64/persistence-v1.js';

const NETWORK_ID = 'hardhat1';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const OTHER_AUTHOR = '0x2222222222222222222222222222222222222222';
const CONTEXT_GRAPH_ID = `${AUTHOR}/catalog`;
const OTHER_CONTEXT_GRAPH_ID = `${AUTHOR}/unrelated`;
const DELEGATION_DIGEST = `0x${'66'.repeat(32)}` as Digest32V1;
const APPLIED_INVENTORY_DIGEST = `0x${'99'.repeat(32)}` as Digest32V1;
const SIGNATURE = `0x${'77'.repeat(65)}`;

function catalogScope(
  contextGraphId: string,
  authorAddress = AUTHOR,
): Readonly<AuthorCatalogScopeV1> {
  return Object.freeze({
    networkId: NETWORK_ID,
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

function signedHead(
  scope: Readonly<AuthorCatalogScopeV1>,
  version: string,
): SignedAuthorCatalogHeadEnvelopeV1 {
  const directoryByte = (BigInt(version) + 1n).toString(16).padStart(2, '0');
  const payload = Object.freeze({
    ...scope,
    catalogIssuerDelegationDigest: DELEGATION_DIGEST,
    version,
    previousHeadDigest: null,
    totalRows: '0',
    directoryHeight: '0',
    directoryRootDigest: `0x${directoryByte.repeat(32)}`,
    issuedAt: String(1_773_900_000_000n + BigInt(version)),
  }) as AuthorCatalogHeadV1;
  const unsigned = Object.freeze({
    issuer: scope.authorAddress,
    objectType: AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
    payload,
    signatureEvidence: Object.freeze({ kind: 'none' }),
    signatureSuite: 'eip191-personal-sign-digest-v1',
  }) as UnsignedControlEnvelopeV1;
  const head = Object.freeze({
    ...unsigned,
    objectDigest: computeAuthorCatalogHeadObjectDigestV1(unsigned),
    signature: SIGNATURE,
  });
  assertSignedAuthorCatalogHeadEnvelopeV1(head);
  return head;
}

function appliedSnapshot(
  head: Readonly<SignedAuthorCatalogHeadEnvelopeV1>,
): AppliedCatalogHeadSnapshotV1 {
  const scope = deriveAuthorCatalogScopeFromHeadV1(head.payload);
  return Object.freeze({
    catalogScopeDigest: computeAuthorCatalogScopeDigestV1(scope),
    authorAddress: head.payload.authorAddress,
    currentCatalogHeadDigest: head.objectDigest,
    appliedInventoryDigest: APPLIED_INVENTORY_DIGEST,
    catalogVersion: head.payload.version,
    inventoryRowCount: head.payload.totalRows,
  });
}

function replayRequest(contextGraphId = CONTEXT_GRAPH_ID) {
  return Object.freeze({
    kind: 'Rfc64PublicCatalogHeadReplayV1' as const,
    networkId: NETWORK_ID,
    contextGraphId,
    policyDigest: DELEGATION_DIGEST,
  });
}

function createReplayFixture(initialHeads: readonly SignedAuthorCatalogHeadEnvelopeV1[]) {
  let inventory = initialHeads.map(appliedSnapshot);
  const storedHeads = new Map<string, SignedAuthorCatalogHeadEnvelopeV1>(
    initialHeads.map((head) => [head.objectDigest, head]),
  );
  const getVerifiedObjectByDigest = vi.fn(async (
    input: Readonly<{ objectDigest: Digest32V1 }>,
  ) => {
    const envelope = storedHeads.get(input.objectDigest);
    if (envelope === undefined) return null;
    return Object.freeze({
      envelope,
      issuerSignature: Object.freeze({}),
    });
  });
  const persistence = Object.freeze({
    inventory: Object.freeze({
      listAppliedCatalogHeadsV1: () => inventory,
    }),
    controlObjects: Object.freeze({ getVerifiedObjectByDigest }),
  }) as unknown as Rfc64PersistenceV1;
  const coordinator = new Rfc64CatalogMutationCoordinatorV1();
  const runtime = new Rfc64CatalogReplaySnapshotRuntimeV1(persistence, coordinator);
  return Object.freeze({
    coordinator,
    getVerifiedObjectByDigest,
    runtime,
    stage(head: SignedAuthorCatalogHeadEnvelopeV1): void {
      storedHeads.set(head.objectDigest, head);
    },
    storeAtDigest(digest: Digest32V1, head: SignedAuthorCatalogHeadEnvelopeV1): void {
      storedHeads.set(digest, head);
    },
    remove(digest: Digest32V1): void {
      storedHeads.delete(digest);
    },
    replaceAppliedHeads(heads: readonly SignedAuthorCatalogHeadEnvelopeV1[]): void {
      for (const head of heads) storedHeads.set(head.objectDigest, head);
      inventory = heads.map(appliedSnapshot);
    },
  });
}

async function holdScope(
  coordinator: Rfc64CatalogMutationCoordinatorV1,
  scope: Readonly<AuthorCatalogScopeV1>,
) {
  let release!: () => void;
  let markEntered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const completion = coordinator.run(scope, async () => {
    markEntered();
    await gate;
  });
  await entered;
  return Object.freeze({ release, completion });
}

describe('RFC-64 catalog replay snapshot runtime', () => {
  it('reuses its index until the durable inventory fingerprint changes', async () => {
    const initial = signedHead(catalogScope(CONTEXT_GRAPH_ID), '0');
    const successor = signedHead(catalogScope(CONTEXT_GRAPH_ID), '1');
    const fixture = createReplayFixture([initial]);
    const readDigests = async () => fixture.runtime.withSnapshot({
      requestedScope: replayRequest(),
      operation: async (entries) => entries.map(({ head }) => head.objectDigest),
    });

    await expect(readDigests()).resolves.toEqual([initial.objectDigest]);
    await expect(readDigests()).resolves.toEqual([initial.objectDigest]);
    expect(fixture.getVerifiedObjectByDigest).toHaveBeenCalledTimes(1);

    fixture.replaceAppliedHeads([successor]);
    await expect(readDigests()).resolves.toEqual([successor.objectDigest]);
    expect(fixture.getVerifiedObjectByDigest).toHaveBeenCalledTimes(2);
  });

  it('rejects an unscoped replay when inventory changes before the locks settle', async () => {
    const scope = catalogScope(CONTEXT_GRAPH_ID);
    const initial = signedHead(scope, '0');
    const successor = signedHead(scope, '1');
    const fixture = createReplayFixture([initial]);
    const held = await holdScope(fixture.coordinator, scope);
    const operation = vi.fn(async () => 'delivered');

    const replay = fixture.runtime.withSnapshot({ requestedScope: undefined, operation });
    await vi.waitFor(() => {
      expect(fixture.getVerifiedObjectByDigest).toHaveBeenCalledTimes(1);
    });
    fixture.replaceAppliedHeads([successor]);
    held.release();
    await held.completion;

    await expect(replay).rejects.toThrow(/inventory changed before replay snapshot/u);
    expect(operation).not.toHaveBeenCalled();
  });

  it('rejects an unscoped replay when inventory changes during delivery', async () => {
    const initial = signedHead(catalogScope(CONTEXT_GRAPH_ID), '0');
    const successor = signedHead(catalogScope(CONTEXT_GRAPH_ID), '1');
    const fixture = createReplayFixture([initial]);

    await expect(fixture.runtime.withSnapshot({
      requestedScope: undefined,
      operation: async () => {
        fixture.replaceAppliedHeads([successor]);
        return 'delivered';
      },
    })).rejects.toThrow(/durable catalog inventory changed during replay/u);
  });

  it('refreshes a scoped replay after its current head advances before lock acquisition', async () => {
    const scope = catalogScope(CONTEXT_GRAPH_ID);
    const initial = signedHead(scope, '0');
    const successor = signedHead(scope, '1');
    const fixture = createReplayFixture([initial]);
    fixture.stage(successor);
    const held = await holdScope(fixture.coordinator, scope);

    const replay = fixture.runtime.withSnapshot({
      requestedScope: replayRequest(),
      operation: async (entries) => entries.map(({ head }) => head.objectDigest),
    });
    await vi.waitFor(() => {
      expect(fixture.getVerifiedObjectByDigest).toHaveBeenCalledTimes(1);
    });
    fixture.replaceAppliedHeads([successor]);
    held.release();
    await held.completion;

    await expect(replay).resolves.toEqual([successor.objectDigest]);
  });

  it('rejects a scoped replay when a new author scope appears after discovery', async () => {
    const initialScope = catalogScope(CONTEXT_GRAPH_ID);
    const initial = signedHead(initialScope, '0');
    const late = signedHead(catalogScope(CONTEXT_GRAPH_ID, OTHER_AUTHOR), '0');
    const fixture = createReplayFixture([initial]);
    fixture.stage(late);
    const held = await holdScope(fixture.coordinator, initialScope);
    const operation = vi.fn(async () => 'delivered');

    const replay = fixture.runtime.withSnapshot({
      requestedScope: replayRequest(),
      operation,
    });
    await vi.waitFor(() => {
      expect(fixture.getVerifiedObjectByDigest).toHaveBeenCalledTimes(1);
    });
    fixture.replaceAppliedHeads([initial, late]);
    held.release();
    await held.completion;

    await expect(replay).rejects.toThrow(/scoped catalog inventory changed before replay snapshot/u);
    expect(operation).not.toHaveBeenCalled();
  });

  it('rejects a scoped replay when its locked snapshot changes during delivery', async () => {
    const scope = catalogScope(CONTEXT_GRAPH_ID);
    const initial = signedHead(scope, '0');
    const successor = signedHead(scope, '1');
    const fixture = createReplayFixture([initial]);

    await expect(fixture.runtime.withSnapshot({
      requestedScope: replayRequest(),
      operation: async () => {
        fixture.replaceAppliedHeads([successor]);
        return 'delivered';
      },
    })).rejects.toThrow(/scoped catalog inventory changed during replay/u);
  });

  it('keeps a scoped replay stable when an unrelated catalog changes during delivery', async () => {
    const requested = signedHead(catalogScope(CONTEXT_GRAPH_ID), '0');
    const unrelatedScope = catalogScope(OTHER_CONTEXT_GRAPH_ID);
    const unrelated = signedHead(unrelatedScope, '0');
    const unrelatedSuccessor = signedHead(unrelatedScope, '1');
    const fixture = createReplayFixture([requested, unrelated]);

    await expect(fixture.runtime.withSnapshot({
      requestedScope: replayRequest(),
      operation: async (entries) => {
        fixture.replaceAppliedHeads([requested, unrelatedSuccessor]);
        return entries.map(({ head }) => head.objectDigest);
      },
    })).resolves.toEqual([requested.objectDigest]);
  });

  it('rejects missing and mismatched durable catalog heads', async () => {
    const initial = signedHead(catalogScope(CONTEXT_GRAPH_ID), '0');
    const mismatched = signedHead(catalogScope(CONTEXT_GRAPH_ID), '1');
    const missingFixture = createReplayFixture([initial]);
    missingFixture.remove(initial.objectDigest);
    await expect(missingFixture.runtime.withSnapshot({
      requestedScope: replayRequest(),
      operation: async () => undefined,
    })).rejects.toThrow(/durable catalog head is missing or unverifiable/u);

    const mismatchFixture = createReplayFixture([initial]);
    mismatchFixture.storeAtDigest(initial.objectDigest, mismatched);
    await expect(mismatchFixture.runtime.withSnapshot({
      requestedScope: replayRequest(),
      operation: async () => undefined,
    })).rejects.toThrow(/durable catalog inventory contains an invalid head/u);
  });
});
