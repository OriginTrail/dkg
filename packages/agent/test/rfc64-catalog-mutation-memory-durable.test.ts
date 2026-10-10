/**
 * GH#3081 / GH#3072 — the catalog mutation memory over a real signed author catalog: the state it
 * carries forward is the state a verified read of the durable store returns, and a state that ends
 * work without a successor is read back from the durable store first.
 */
import {
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1,
  computeAuthorCatalogScopeDigestV1,
  computeControlSignatureVariantDigestHex,
  encodeOpaqueKaBundleV1,
  type Digest32V1,
} from '@origintrail-official/dkg-core';
import { describe, expect, it } from 'vitest';

import {
  Rfc64CatalogMutationMemoryV1,
  readVerifiedRfc64CatalogMutationStateV1,
  resolveCatalogMutationMemoryLimitsV1,
  type Rfc64SignedCatalogSuccessorV1,
} from '../src/internal/catalog-mutation-memory.js';
import type { AppliedCatalogHeadSnapshotV1 } from '../src/rfc64/inventory-v1/index.js';
import type { Rfc64PersistenceV1 } from '../src/rfc64/persistence-v1.js';
import { computeRfc64AppliedInventoryDigestV1 } from
  '../src/rfc64/public-catalog-inventory-completeness-v1.js';
import {
  snapshotRfc64PublicCatalogSuccessorAssetV1,
  type Rfc64PublicCatalogSuccessorAssetInputV1,
} from '../src/rfc64/public-catalog-successor-asset-v1.js';
import { POLICY } from './support/rfc64-catalog-mutation-memory-fixture.js';
import {
  PRODUCER_AUTHOR,
  PRODUCER_DEPLOYMENT,
  producerAssetV1,
  producerGenesisV1,
  producerOverMemoryV1,
  producerSignerV1,
} from './support/rfc64-successor-producer-fixture.js';

/**
 * Durable stores that hold exactly what the successor producer staged. Every read is recorded, and
 * an object named in `unreadable` is there but does not verify.
 */
async function realCatalog() {
  const genesis = await producerGenesisV1();
  const objects = new Map<string, unknown>();
  const bundles = new Map<string, Uint8Array>();
  const unreadable = new Set<string>();
  const reads = { controlObjects: [] as string[], bundles: [] as string[] };
  const delegation = genesis.authorization.catalogIssuerDelegation;
  objects.set(delegation.objectDigest, delegation);
  for (const envelope of [genesis.history.previousHead, ...genesis.history.previousDirectoryPath]) {
    objects.set(envelope.objectDigest, envelope);
  }
  const scopeDigest = computeAuthorCatalogScopeDigestV1(genesis.scope);
  let appliedHead: AppliedCatalogHeadSnapshotV1 | null = null;
  const stored = async ({ objectDigest }: { objectDigest: string }) => {
    reads.controlObjects.push(objectDigest);
    if (unreadable.has(objectDigest)) throw new Error(`control object ${objectDigest} does not verify`);
    const envelope = objects.get(objectDigest);
    return envelope === undefined ? null : { envelope, issuerSignature: {} };
  };
  const persistence = {
    inventory: { readAppliedCatalogHeadV1: () => appliedHead },
    controlObjects: { getVerifiedObject: stored, getVerifiedObjectByDigest: stored },
    kaBundles: {
      readKaBundleByDigest: async (blobDigest: string) => {
        reads.bundles.push(blobDigest);
        return bundles.get(blobDigest) ?? null;
      },
    },
  } as unknown as Rfc64PersistenceV1;
  let history = genesis.history;
  return {
    genesis,
    scopeDigest,
    persistence,
    objects,
    bundles,
    unreadable,
    reads,
    /** The signed head, directory root and bucket of the applied head. */
    history: () => history,
    /** Produce, stage and apply the successor that holds exactly `assets`. */
    async advance(assets: readonly Rfc64PublicCatalogSuccessorAssetInputV1[], step: number) {
      const produced = await producerOverMemoryV1().produceAndStageExactSet({
        ...history,
        assets: [...assets],
        deployment: PRODUCER_DEPLOYMENT,
        issuedAt: String(1773900001000 + step * 1000) as never,
        catalogSigner: producerSignerV1(),
        catalogIssuerAuthorization: genesis.authorization,
      });
      for (const envelope of produced.publication.stagedObjects) objects.set(envelope.objectDigest, envelope);
      for (const { bundleDigest, bundleBytes } of produced.assets) bundles.set(bundleDigest, bundleBytes);
      const head = produced.publication.head;
      history = {
        previousHead: head,
        previousDirectoryPath: produced.publication.directoryPath,
        previousBucket: produced.publication.bucket,
      };
      // The rows the agent derives from the verified successor, and the digest it commits.
      const rows = produced.assets.map((signed) => ({
        kaId: signed.row.kaId,
        catalogRowDigest: signed.sealBinding.catalogRowDigest,
        bundleDigest: signed.bundleDigest,
        contentDigest: signed.projection.projectionDigest,
        sealDigest: signed.sealBinding.sealDigest,
        activatedTripleCount: Number(signed.projection.publicTripleCount),
        contentByteLength: signed.projection.projectionByteLength,
        bundleByteLength: signed.row.transfer.byteLength,
        kaUal: signed.projection.kaUal,
      })) as unknown as Rfc64SignedCatalogSuccessorV1['assets'];
      appliedHead = Object.freeze({
        catalogScopeDigest: scopeDigest,
        authorAddress: PRODUCER_AUTHOR,
        currentCatalogHeadDigest: head.objectDigest as Digest32V1,
        appliedInventoryDigest: computeRfc64AppliedInventoryDigestV1({ catalogScopeDigest: scopeDigest, rows }),
        catalogVersion: head.payload.version,
        inventoryRowCount: head.payload.totalRows as never,
      });
      return {
        applied: appliedHead,
        successor: {
          headObjectDigest: head.objectDigest as Digest32V1,
          signatureVariantDigest: computeControlSignatureVariantDigestHex(
            head.objectDigest,
            head.signature,
          ) as Digest32V1,
          assets: rows,
        },
      };
    },
  };
}

function bundleDigestOf(asset: Rfc64PublicCatalogSuccessorAssetInputV1): Digest32V1 {
  return encodeOpaqueKaBundleV1(
    asset.projectionBytes,
    canonicalizeCanonicalGraphScopedAuthorSealBytesV1(asset.seal),
  ).blobDigest;
}

describe('RFC-64 catalog mutation memory over a real author catalog', () => {
  it('carries forward exactly the state a verified read of the durable store returns', async () => {
    const catalog = await realCatalog();
    const memory = new Rfc64CatalogMutationMemoryV1();
    // Three, one, two: the upsert appends, the signed bucket is in KA order.
    await catalog.advance([await producerAssetV1(3)], 1);
    let state = (await memory.read(catalog.persistence, catalog.scopeDigest, PRODUCER_AUTHOR, POLICY))!;
    expect(state.assets.every(({ seal }) => Object.isFrozen(seal))).toBe(true);

    const placements = [await producerAssetV1(1), await producerAssetV1(2), await producerAssetV1(3, '2')];
    for (const [index, incoming] of placements.entries()) {
      // As the upsert does: its own copy of the incoming asset, replaced in place or appended.
      const own = snapshotRfc64PublicCatalogSuccessorAssetV1(incoming);
      const assets = [...state.assets];
      const existing = assets.findIndex(({ seal }) => seal.reservedKaId === own.seal.reservedKaId);
      if (existing >= 0) assets[existing] = own;
      else assets.push(own);
      const step = await catalog.advance(assets, index + 2);
      const carried = memory.advance(state, step.applied, step.successor, assets);

      const fresh = await readVerifiedRfc64CatalogMutationStateV1(catalog.persistence, step.applied);
      expect(carried).toEqual(fresh);
      expect(carried.assets.map(({ seal }) => seal.kaUal)).toEqual(fresh.assets.map(({ seal }) => seal.kaUal));
      expect(await memory.read(catalog.persistence, catalog.scopeDigest, PRODUCER_AUTHOR, POLICY)).toBe(carried);
      // Every row the carried state names is what the durable bucket names, and its bundle is there.
      for (const row of carried.assets) {
        await memory.confirmDurable(catalog.persistence, catalog.scopeDigest, PRODUCER_AUTHOR, carried, row);
      }
      state = carried;
    }
    expect(state.assets.map(({ seal }) => `${seal.kaUal.split('/').at(-1)}@${seal.assertionVersion}`))
      .toEqual(['1@1', '2@1', '3@2']);
  });

  it('refuses an applied head whose durable objects are missing or are not the signed ones', async () => {
    const catalog = await realCatalog();
    const rows = [await producerAssetV1(1), await producerAssetV1(2)];
    await catalog.advance(rows.slice(0, 1), 1);
    const { applied: head } = await catalog.advance(rows, 2);
    const read = () => readVerifiedRfc64CatalogMutationStateV1(catalog.persistence, head);
    await expect(read()).resolves.toMatchObject({ expectedCurrentCatalogHeadDigest: head.currentCatalogHeadDigest });
    // A memory that holds the state refuses the head with the same words, and then holds nothing.
    const warm = new Rfc64CatalogMutationMemoryV1();
    const served = () => warm.read(catalog.persistence, catalog.scopeDigest, PRODUCER_AUTHOR, POLICY);
    const held = await served();

    const [firstDigest, secondDigest] = [...catalog.bundles.keys()];
    const firstBundle = catalog.bundles.get(firstDigest!)!;
    catalog.bundles.set(firstDigest!, catalog.bundles.get(secondDigest!)!);
    await expect(read()).rejects.toThrow('RFC-64 applied catalog bundle differs from its signed predecessor row');
    catalog.bundles.delete(firstDigest!);
    await expect(read()).rejects.toThrow(/RFC-64 applied catalog bundle 0x[0-9a-f]{64} is unavailable/u);
    // A served state does not read every row's bundle again; the row a decision is about, it does.
    await expect(served()).resolves.toBe(held);
    const missingRow = held!.assets.find((asset) => bundleDigestOf(asset) === firstDigest)!;
    await expect(warm.confirmDurable(catalog.persistence, catalog.scopeDigest, PRODUCER_AUTHOR, held!, missingRow))
      .rejects.toThrow(/RFC-64 applied catalog bundle 0x[0-9a-f]{64} is unavailable/u);
    expect(warm.retained.states).toBe(0);
    catalog.bundles.set(firstDigest!, firstBundle);
    await expect(served()).resolves.toEqual(held);

    const delegationDigest = catalog.genesis.authorization.catalogIssuerDelegation.objectDigest;
    const delegation = catalog.objects.get(delegationDigest);
    catalog.objects.delete(delegationDigest);
    await expect(read()).rejects.toThrow('RFC-64 applied author head delegation is not durably staged');
    await expect(served()).rejects.toThrow('RFC-64 applied author head delegation is not durably staged');
    expect(warm.retained.states).toBe(0);
    catalog.objects.set(delegationDigest, delegation);
    await expect(served()).resolves.toEqual(held);

    catalog.objects.delete(head.currentCatalogHeadDigest);
    await expect(read()).rejects.toThrow('RFC-64 applied author head is not durably staged');
    await expect(served()).rejects.toThrow('RFC-64 applied author head is not durably staged');
    expect(warm.retained.states).toBe(0);

    // A read that fails keeps nothing.
    const memory = new Rfc64CatalogMutationMemoryV1();
    await expect(memory.read(catalog.persistence, catalog.scopeDigest, PRODUCER_AUTHOR, POLICY)).rejects.toThrow();
    expect(memory.retained.states).toBe(0);
  });

  describe('before a state ends work without a successor', () => {
    /** A catalog of rows 1 and 2, a memory that holds its state, and that state's first row. */
    async function remembered(memory = new Rfc64CatalogMutationMemoryV1()) {
      const catalog = await realCatalog();
      const rows = [await producerAssetV1(1), await producerAssetV1(2)];
      await catalog.advance(rows.slice(0, 1), 1);
      await catalog.advance(rows, 2);
      const state = (await memory.read(catalog.persistence, catalog.scopeDigest, PRODUCER_AUTHOR, POLICY))!;
      const history = catalog.history();
      catalog.reads.controlObjects.length = 0;
      catalog.reads.bundles.length = 0;
      return {
        catalog,
        memory,
        state,
        row: state.assets[0]!,
        head: history.previousHead.objectDigest,
        root: history.previousDirectoryPath[0]!.objectDigest,
        bucket: history.previousBucket!.objectDigest,
        confirm: (asset?: Rfc64PublicCatalogSuccessorAssetInputV1) => (
          memory.confirmDurable(catalog.persistence, catalog.scopeDigest, PRODUCER_AUTHOR, state, asset)
        ),
      };
    }

    it('reads the head, its directory root and its bucket back, and the bundle of the row it is about', async () => {
      const { catalog, memory, row, head, root, bucket, confirm } = await remembered();

      await expect(confirm(row)).resolves.toBeUndefined();

      expect(catalog.reads.controlObjects).toEqual([head, root, bucket]);
      expect(catalog.reads.bundles).toEqual([bundleDigestOf(row)]);
      expect(memory.retained.states).toBe(1);
    });

    it('reads the head, its directory root and its bucket back for a decision about the whole set', async () => {
      const { catalog, memory, head, root, bucket, confirm } = await remembered();

      await expect(confirm()).resolves.toBeUndefined();

      expect(catalog.reads.controlObjects).toEqual([head, root, bucket]);
      expect(catalog.reads.bundles).toEqual([]);
      expect(memory.retained.states).toBe(1);
    });

    it.each([
      ['directory root', 'root', 'RFC-64 predecessor directory root is not staged'],
      ['bucket', 'bucket', 'RFC-64 predecessor bucket is not staged'],
      ['head', 'head', 'RFC-64 predecessor head is not durably staged'],
    ] as const)('fails the decision and forgets the scope when the %s is not in the durable store', async (_object, which, refusal) => {
      const context = await remembered();
      const { catalog, memory, row, confirm } = context;
      const envelope = catalog.objects.get(context[which]);

      catalog.objects.delete(context[which]);
      await expect(confirm(row)).rejects.toThrow(refusal);
      expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });
      // A decision about the whole set fails the same way.
      await expect(confirm()).rejects.toThrow(refusal);

      catalog.objects.set(context[which], envelope);
      await expect(confirm(row)).resolves.toBeUndefined();
    });

    it.each([
      ['directory root', 'root'],
      ['bucket', 'bucket'],
    ] as const)('fails the decision and forgets the scope when the %s does not verify', async (_object, which) => {
      const context = await remembered();
      const { catalog, memory, row, confirm } = context;

      catalog.unreadable.add(context[which]);
      await expect(confirm(row)).rejects.toThrow(`control object ${context[which]} does not verify`);
      expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });
      await expect(confirm()).rejects.toThrow('does not verify');

      catalog.unreadable.clear();
      await expect(confirm(row)).resolves.toBeUndefined();
    });

    it('fails the decision when another bucket is stored in the place of the head\'s', async () => {
      const context = await remembered();
      const { catalog, memory, row, bucket, confirm } = context;
      // The bucket of the earlier head, which holds one row, under the digest of the current one.
      const earlierBucket = [...catalog.objects.values()].find((envelope) => (
        (envelope as { objectType?: string }).objectType === 'AuthorCatalogBucketV1'
        && (envelope as { objectDigest: string }).objectDigest !== bucket
      ));
      expect(earlierBucket).toBeDefined();

      catalog.objects.set(bucket, earlierBucket);
      await expect(confirm(row)).rejects.toThrow('RFC-64 predecessor bucket row count does not match its head');
      expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });
    });

    it('fails the decision when the durable bucket does not name the remembered row', async () => {
      const { memory, confirm } = await remembered();

      // A row the catalog does not hold, and the next version of one it does.
      await expect(confirm(await producerAssetV1(9)))
        .rejects.toThrow('RFC-64 applied catalog bundle differs from its signed predecessor row');
      expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });
      await expect(confirm(await producerAssetV1(1, '2')))
        .rejects.toThrow('RFC-64 applied catalog bundle differs from its signed predecessor row');
    });

    it('fails the decision and forgets the scope when the row\'s bundle is not there', async () => {
      const { catalog, memory, row, confirm } = await remembered();

      catalog.bundles.delete(bundleDigestOf(row));
      await expect(confirm(row)).rejects.toThrow(/RFC-64 applied catalog bundle 0x[0-9a-f]{64} is unavailable/u);
      expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });
      // The rest of the set is not asked for its bundles.
      await expect(confirm()).resolves.toBeUndefined();
    });

    it('fails the decision and forgets the scope when the stored bundle is not the remembered bytes', async () => {
      const { catalog, memory, row, confirm } = await remembered();
      const digest = bundleDigestOf(row);
      const bytes = catalog.bundles.get(digest)!;
      const other = new Uint8Array(bytes);
      other[other.length - 1] ^= 1;

      catalog.bundles.set(digest, other);
      await expect(confirm(row)).rejects.toThrow('RFC-64 applied catalog bundle differs from its signed predecessor row');
      expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });

      // Nor a bundle that stops short of them.
      catalog.bundles.set(digest, bytes.subarray(0, bytes.byteLength - 1));
      await expect(confirm(row)).rejects.toThrow('differs');
    });

    it('fails the decision and forgets the scope when the bundle store cannot be read', async () => {
      const { catalog, memory, row, confirm } = await remembered();
      (catalog.persistence.kaBundles as unknown as { readKaBundleByDigest: unknown }).readKaBundleByDigest =
        async () => { throw new Error('the bundle store is closed'); };

      await expect(confirm(row)).rejects.toThrow('the bundle store is closed');
      expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });
    });

    it('reads nothing back when the memory is switched off: the state was just read in full', async () => {
      const off = new Rfc64CatalogMutationMemoryV1(resolveCatalogMutationMemoryLimitsV1('0'));
      const { catalog, row, root, confirm } = await remembered(off);

      catalog.objects.delete(root);
      await expect(confirm(row)).resolves.toBeUndefined();

      expect(catalog.reads).toEqual({ controlObjects: [], bundles: [] });
    });
  });
});
