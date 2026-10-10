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
import {
  Rfc64CatalogReplaySnapshotRuntimeV1,
  type Rfc64CatalogReplaySnapshotStorageV1,
} from '../src/rfc64/catalog-replay-snapshot-runtime-v1.js';
import {
  createAppliedCatalogHeadsSnapshotV1,
  type AppliedCatalogHeadSnapshotV1,
} from '../src/rfc64/inventory-v1/index.js';

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

function scopedSelection(contextGraphId = CONTEXT_GRAPH_ID) {
  return Object.freeze({
    kind: 'scope' as const,
    networkId: NETWORK_ID,
    contextGraphId,
  });
}

function createReplayFixture(
  initialHeads: readonly SignedAuthorCatalogHeadEnvelopeV1[],
) {
  // Listed again by every inventory write, as the durable inventory's is.
  let inventory = createAppliedCatalogHeadsSnapshotV1(initialHeads.map(appliedSnapshot));
  const storedHeads = new Map<string, SignedAuthorCatalogHeadEnvelopeV1>(
    initialHeads.map((head) => [head.objectDigest, head]),
  );
  const readVerifiedCatalogHeadV1 = vi.fn(async (objectDigest: Digest32V1) => (
    storedHeads.get(objectDigest) ?? null
  ));
  const readAppliedCatalogHeadsSnapshotV1 = vi.fn(() => inventory);
  const storage: Rfc64CatalogReplaySnapshotStorageV1 = Object.freeze({
    readAppliedCatalogHeadsSnapshotV1,
    readVerifiedCatalogHeadV1,
  });
  const coordinator = new Rfc64CatalogMutationCoordinatorV1();
  const runtime = new Rfc64CatalogReplaySnapshotRuntimeV1(storage, coordinator);
  return Object.freeze({
    coordinator,
    readVerifiedCatalogHeadV1,
    runtime,
    /** A write that changed no row: the same rows, listed again. */
    relist(): void {
      inventory = createAppliedCatalogHeadsSnapshotV1(inventory.heads);
    },
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
      inventory = createAppliedCatalogHeadsSnapshotV1(heads.map(appliedSnapshot));
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
      selection: scopedSelection(),
      prepare: (entries) => entries.map(({ head }) => head.objectDigest),
      deliver: async (digests) => digests,
    });

    await expect(readDigests()).resolves.toEqual([initial.objectDigest]);
    await expect(readDigests()).resolves.toEqual([initial.objectDigest]);
    expect(fixture.readVerifiedCatalogHeadV1).toHaveBeenCalledTimes(1);

    fixture.replaceAppliedHeads([successor]);
    await expect(readDigests()).resolves.toEqual([successor.objectDigest]);
    expect(fixture.readVerifiedCatalogHeadV1).toHaveBeenCalledTimes(2);
  });

  it('rejects an unscoped replay when inventory changes before the locks settle', async () => {
    const scope = catalogScope(CONTEXT_GRAPH_ID);
    const initial = signedHead(scope, '0');
    const successor = signedHead(scope, '1');
    const fixture = createReplayFixture([initial]);
    const held = await holdScope(fixture.coordinator, scope);
    const prepare = vi.fn(() => 'prepared');
    const deliver = vi.fn(async () => 'delivered');

    const replay = fixture.runtime.withSnapshot({
      selection: Object.freeze({ kind: 'all' }),
      prepare,
      deliver,
    });
    await vi.waitFor(() => {
      expect(fixture.readVerifiedCatalogHeadV1).toHaveBeenCalledTimes(1);
    });
    fixture.replaceAppliedHeads([successor]);
    held.release();
    await held.completion;

    await expect(replay).rejects.toThrow(/inventory changed before replay snapshot/u);
    expect(prepare).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('rejects an unscoped replay when inventory changes during delivery', async () => {
    const initial = signedHead(catalogScope(CONTEXT_GRAPH_ID), '0');
    const successor = signedHead(catalogScope(CONTEXT_GRAPH_ID), '1');
    const fixture = createReplayFixture([initial]);

    await expect(fixture.runtime.withSnapshot({
      selection: Object.freeze({ kind: 'all' }),
      prepare: () => 'prepared',
      deliver: async () => {
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
      selection: scopedSelection(),
      prepare: (entries) => entries.map(({ head }) => head.objectDigest),
      deliver: async (digests) => digests,
    });
    await vi.waitFor(() => {
      expect(fixture.readVerifiedCatalogHeadV1).toHaveBeenCalledTimes(1);
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
    const prepare = vi.fn(() => 'prepared');
    const deliver = vi.fn(async () => 'delivered');

    const replay = fixture.runtime.withSnapshot({
      selection: scopedSelection(),
      prepare,
      deliver,
    });
    await vi.waitFor(() => {
      expect(fixture.readVerifiedCatalogHeadV1).toHaveBeenCalledTimes(1);
    });
    fixture.replaceAppliedHeads([initial, late]);
    held.release();
    await held.completion;

    await expect(replay).rejects.toThrow(/scoped catalog inventory changed before replay snapshot/u);
    expect(prepare).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('rejects a scoped replay when its locked snapshot changes during delivery', async () => {
    const scope = catalogScope(CONTEXT_GRAPH_ID);
    const initial = signedHead(scope, '0');
    const successor = signedHead(scope, '1');
    const fixture = createReplayFixture([initial]);

    await expect(fixture.runtime.withSnapshot({
      selection: scopedSelection(),
      prepare: () => 'prepared',
      deliver: async () => {
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
      selection: scopedSelection(),
      prepare: (entries) => entries.map(({ head }) => head.objectDigest),
      deliver: async (digests) => {
        fixture.replaceAppliedHeads([requested, unrelatedSuccessor]);
        return digests;
      },
    })).resolves.toEqual([requested.objectDigest]);
  });

  it('rejects missing and mismatched durable catalog heads', async () => {
    const initial = signedHead(catalogScope(CONTEXT_GRAPH_ID), '0');
    const mismatched = signedHead(catalogScope(CONTEXT_GRAPH_ID), '1');
    const missingFixture = createReplayFixture([initial]);
    missingFixture.remove(initial.objectDigest);
    await expect(missingFixture.runtime.withSnapshot({
      selection: scopedSelection(),
      prepare: () => undefined,
      deliver: async () => undefined,
    })).rejects.toThrow(/durable catalog head is missing or unverifiable/u);

    const mismatchFixture = createReplayFixture([initial]);
    mismatchFixture.storeAtDigest(initial.objectDigest, mismatched);
    await expect(mismatchFixture.runtime.withSnapshot({
      selection: scopedSelection(),
      prepare: () => undefined,
      deliver: async () => undefined,
    })).rejects.toThrow(/durable catalog inventory contains an invalid head/u);
  });

  it('holds the catalog mutation locks while it prepares, and not while it delivers', async () => {
    // GH#3081 — a replay sends head after head to one peer. A peer that does not answer must not
    // keep any change of the replayed catalogs waiting.
    for (const selection of [Object.freeze({ kind: 'all' as const }), scopedSelection()]) {
      const scope = catalogScope(CONTEXT_GRAPH_ID);
      const fixture = createReplayFixture([signedHead(scope, '0')]);
      const order: string[] = [];
      const gate = () => {
        let open!: () => void;
        let markEntered!: () => void;
        const opened = new Promise<void>((resolve) => { open = resolve; });
        const entered = new Promise<void>((resolve) => { markEntered = resolve; });
        return { open, opened, entered, markEntered };
      };
      const preparing = gate();
      const delivering = gate();

      const replay = fixture.runtime.withSnapshot({
        selection,
        prepare: async (entries) => {
          preparing.markEntered();
          await preparing.opened;
          order.push('prepared');
          return entries.length;
        },
        deliver: async (count) => {
          delivering.markEntered();
          await delivering.opened;
          order.push('delivered');
          return count;
        },
      });

      await preparing.entered;
      // A change of the catalog waits for the snapshot that is being taken of it ...
      const changeDuringPrepare = fixture.coordinator.run(scope, async () => {
        order.push('change that waited for the snapshot');
      });
      await new Promise((resolve) => { setImmediate(resolve); });
      expect(order).toEqual([]);
      preparing.open();
      await changeDuringPrepare;

      await delivering.entered;
      // ... and not for the peer the snapshot is then sent to.
      await fixture.coordinator.run(scope, async () => {
        order.push('change during delivery');
      });
      expect(order).toEqual([
        'prepared',
        'change that waited for the snapshot',
        'change during delivery',
      ]);

      // Neither change wrote a row, so the replay completes.
      delivering.open();
      await expect(replay).resolves.toBe(1);
      expect(order.at(-1)).toBe('delivered');
    }
  });

  it('rejects a replay when a catalog change lands while it delivers, without having held that change', async () => {
    for (const [selection, message] of [
      [Object.freeze({ kind: 'all' as const }), /durable catalog inventory changed during replay/u],
      [scopedSelection(), /scoped catalog inventory changed during replay/u],
    ] as const) {
      const scope = catalogScope(CONTEXT_GRAPH_ID);
      const initial = signedHead(scope, '0');
      const successor = signedHead(scope, '1');
      const fixture = createReplayFixture([initial]);
      let finishDelivery!: () => void;
      let markDelivering!: () => void;
      const delivered = new Promise<void>((resolve) => { finishDelivery = resolve; });
      const delivering = new Promise<void>((resolve) => { markDelivering = resolve; });

      const replay = fixture.runtime.withSnapshot({
        selection,
        prepare: (entries) => entries.map(({ head }) => head.objectDigest),
        deliver: async (digests) => {
          markDelivering();
          await delivered;
          return digests;
        },
      });
      const rejected = expect(replay).rejects.toThrow(message);

      await delivering;
      // The catalog's next head is committed through its mutation lock while the peer is slow.
      await fixture.coordinator.run(scope, async () => {
        fixture.replaceAppliedHeads([successor]);
      });
      finishDelivery();

      // What was sent is no longer the current set: the requester has to ask again.
      await rejected;
    }
  });
});

describe('RFC-64 catalog replay snapshot runtime across inventory snapshots', () => {
  it('reads each head once per inventory token across scoped replays', async () => {
    const initial = signedHead(catalogScope(CONTEXT_GRAPH_ID), '0');
    const other = signedHead(catalogScope(OTHER_CONTEXT_GRAPH_ID), '0');
    const successor = signedHead(catalogScope(CONTEXT_GRAPH_ID), '1');
    const fixture = createReplayFixture([initial, other]);
    const readDigests = async (contextGraphId = CONTEXT_GRAPH_ID) => fixture.runtime.withSnapshot({
      selection: scopedSelection(contextGraphId),
      prepare: (entries) => entries.map(({ head }) => head.objectDigest),
      deliver: async (digests) => digests,
    });

    // One connecting peer asks for a scoped replay of every graph.
    for (let connect = 0; connect < 5; connect += 1) {
      await expect(readDigests()).resolves.toEqual([initial.objectDigest]);
      await expect(readDigests(OTHER_CONTEXT_GRAPH_ID)).resolves.toEqual([other.objectDigest]);
    }
    expect(fixture.readVerifiedCatalogHeadV1).toHaveBeenCalledTimes(2);

    // A write that changed nothing: listed again, the index is kept.
    fixture.relist();
    await expect(readDigests()).resolves.toEqual([initial.objectDigest]);
    expect(fixture.readVerifiedCatalogHeadV1).toHaveBeenCalledTimes(2);

    fixture.replaceAppliedHeads([successor, other]);
    await expect(readDigests()).resolves.toEqual([successor.objectDigest]);
    await expect(readDigests()).resolves.toEqual([successor.objectDigest]);
    expect(fixture.readVerifiedCatalogHeadV1).toHaveBeenCalledTimes(4);
  });

  it('keeps a replay when a write that changed no row lands while it runs', async () => {
    const initial = signedHead(catalogScope(CONTEXT_GRAPH_ID), '0');

    const unscoped = createReplayFixture([initial]);
    await expect(unscoped.runtime.withSnapshot({
      selection: Object.freeze({ kind: 'all' }),
      prepare: (entries) => entries.map(({ head }) => head.objectDigest),
      deliver: async (digests) => {
        unscoped.relist();
        return digests;
      },
    })).resolves.toEqual([initial.objectDigest]);

    const scoped = createReplayFixture([initial]);
    await expect(scoped.runtime.withSnapshot({
      selection: scopedSelection(),
      prepare: (entries) => entries.map(({ head }) => head.objectDigest),
      deliver: async (digests) => {
        scoped.relist();
        return digests;
      },
    })).resolves.toEqual([initial.objectDigest]);
    expect(scoped.readVerifiedCatalogHeadV1).toHaveBeenCalledTimes(1);
  });
});
