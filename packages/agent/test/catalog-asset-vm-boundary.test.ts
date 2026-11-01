import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryLayer, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, contextGraphMetaUri,
  type AuthorCatalogScopeV1,
  type AssertionCoordinateV1,
} from '@origintrail-official/dkg-core';
import { generateGraphKnowledgeAssetMetadata, withMaterializationLock } from '@origintrail-official/dkg-publisher';
import { OxigraphStore, StorePriorityScheduler, withDefaultStoreWorkPriority } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { assertCatalogAssetVmBoundaryV1, assertCatalogTargetRevisionsV1 } from '../src/internal/catalog-asset-revision.js';
import { AUTHOR, CONTEXT_GRAPH_ID, NETWORK_ID, authorSealV1 } from './support/rfc64-local-catalog-repair-fixture.js';

const scope = { networkId: NETWORK_ID, contextGraphId: CONTEXT_GRAPH_ID,
  governanceChainId: null, governanceContractAddress: null, ownershipTransitionDigest: null,
  subGraphName: null, authorAddress: AUTHOR, era: '0', bucketCount: '1',
} as AuthorCatalogScopeV1;
const stores: OxigraphStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });

async function fixture(version = '1') {
  const store = new OxigraphStore(); stores.push(store);
  const seal = await authorSealV1(1n, version);
  const asset = { assertionCoordinate: 'revision' as AssertionCoordinateV1, seal, projectionBytes: new Uint8Array() };
  const check = (required = false) => assertCatalogAssetVmBoundaryV1(store, scope, asset, required);
  const confirmed = async (changes: Record<string, unknown> = {}, status: 'confirmed' | 'tentative' = 'confirmed') => {
    const assertionVersion = String(changes.assertionVersion ?? version);
    const metadata = generateGraphKnowledgeAssetMetadata({ contextGraphId: CONTEXT_GRAPH_ID,
      ual: seal.kaUal, merkleRoot: ethers.getBytes(seal.assertionMerkleRoot),
      publisherPeerId: 'confirmed', accessPolicy: 'public', allowedPeers: [],
      timestamp: new Date(seal.assertionFinalizedAt), assertionVersion, authorAddress: AUTHOR,
      publicTripleCount: Number(seal.publicTripleCount), privateTripleCount: 0,
      assertionGraph: knowledgeAssetLayerGraphUri(CONTEXT_GRAPH_ID, MemoryLayer.VerifiableMemory,
        createGraphKnowledgeAssetScope(seal.kaUal, assertionVersion)), ...changes,
    }, status === 'confirmed' ? { status: 'confirmed', confirmation: { kind: 'finalized-materialization', provenance: {
      batchId: BigInt(seal.reservedKaId), materializedVersion: { blockNumber: 124, txIndex: 0 },
    } } } : { status: 'tentative' });
    await store.insert(metadata);
  };
  return { store, asset, check, confirmed };
}

describe('catalog VM content boundary', () => {
  async function targets(count: number) {
    return Promise.all(Array.from({ length: count }, async (_, index) => ({
      assertionCoordinate: `revision-${index}` as AssertionCoordinateV1,
      seal: await authorSealV1(BigInt(index + 1)), projectionBytes: new Uint8Array(),
    })));
  }

  it.each([
    { priority: undefined, width: 8 }, { priority: 'normal', width: 6 }, { priority: 'background', width: 2 },
  ] as const)('bounds independent reads by the $priority store lane ($width)', async ({ priority, width }) => {
    const f = await fixture(), assets = await targets(12), query = f.store.query.bind(f.store);
    if (priority !== undefined) {
      const scheduler = new StorePriorityScheduler({ maxConcurrent: 8, ackReservedSlots: 1,
        healthReservedSlots: 1, normalReservedSlots: 4, backgroundReservedSlots: 2 });
      Object.assign(f.store, { getPressureSnapshot: () => scheduler.snapshot });
    }
    let release!: () => void, active = 0, maximum = 0, started = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(f.store, 'query').mockImplementation(async (...args) => {
      started++; active++; maximum = Math.max(maximum, active);
      try { await gate; return await query(...args); } finally { active--; }
    });
    const read = () => assertCatalogTargetRevisionsV1(f.store, scope, [], assets, 'inventory');
    const check = priority === undefined ? read() : withDefaultStoreWorkPriority(priority, read);
    try {
      await vi.waitFor(() => expect(started).toBe(width));
      expect(active).toBe(width);
    } finally { release(); await check; }
    expect(started).toBe(12); expect(maximum).toBe(width); expect(active).toBe(0);
  });

  it('drains admitted reads and stops scheduling after one fails', async () => {
    const f = await fixture(), assets = await targets(12), query = f.store.query.bind(f.store);
    const unavailable = new Error('metadata unavailable');
    let release!: () => void, started = 0, active = 0, settled = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(f.store, 'query').mockImplementation(async (...args) => {
      const index = started++; active++;
      try { if (index === 1) throw unavailable; await gate; return await query(...args); }
      finally { active--; }
    });
    const outcome = assertCatalogTargetRevisionsV1(f.store, scope, [], assets, 'inventory')
      .then(() => undefined, error => error).finally(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(started).toBeGreaterThan(1));
      expect(settled).toBe(false); expect(active).toBeGreaterThan(0);
    } finally { release(); await outcome; }
    expect(await outcome).toBe(unavailable); expect(started).toBeLessThan(12); expect(active).toBe(0);
  });

  it('cancels a preliminary check waiting behind a VM writer without issuing its read', async () => {
    const f = await fixture(), controller = new AbortController();
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writer = withMaterializationLock(contextGraphMetaUri(CONTEXT_GRAPH_ID), f.asset.seal.kaUal,
      async () => { entered(); await gate; });
    await ready;
    const query = vi.spyOn(f.store, 'query');
    const outcome = assertCatalogTargetRevisionsV1(f.store, scope, [], [f.asset], 'inventory', controller.signal)
      .then(() => undefined, error => error);
    try {
      controller.abort(new Error('caller stopped'));
      expect(await outcome).toMatchObject({ name: 'AbortError' });
      expect(query).not.toHaveBeenCalled();
    } finally { release(); await writer; await outcome; }
  });

  it('permits an unpublished inventory draft, but absence cannot authorize a confirmed same-version replacement', async () => {
    const f = await fixture();
    await expect(f.check()).resolves.toBeUndefined();
    await expect(f.check(true)).rejects.toMatchObject({ kind: 'version_conflict' });
  });

  it('permits valid tentative metadata for a draft without treating it as confirmation', async () => {
    const f = await fixture(); await f.confirmed({}, 'tentative');
    await expect(f.check()).resolves.toBeUndefined();
    await expect(f.check(true)).rejects.toMatchObject({ kind: 'version_conflict' });
  });

  it('permits the exact confirmed content including a same-version replacement', async () => {
    const f = await fixture(); await f.confirmed();
    await expect(f.check(true)).resolves.toBeUndefined();
  });

  it.each([
    { merkleRoot: new Uint8Array(32) }, { publicTripleCount: 3 },
    { privateTripleCount: 1, privateMerkleRoot: new Uint8Array(32) },
  ])('rejects contradictory confirmed content %j', async changes => {
    const f = await fixture(); await f.confirmed(changes);
    await expect(f.check()).rejects.toThrow();
    await expect(f.check(true)).rejects.toThrow();
  });

  it('allows a later unpublished draft but never restores an older version over VM', async () => {
    const later = await fixture('2'); await later.confirmed({ assertionVersion: '1' });
    await expect(later.check()).resolves.toBeUndefined();
    await expect(later.check(true)).rejects.toMatchObject({ kind: 'version_conflict' });
    const older = await fixture('1'); await older.confirmed({ assertionVersion: '2' });
    await expect(older.check()).rejects.toMatchObject({ kind: 'version_conflict' });
  });

  it('does not turn a failed metadata read into absence', async () => {
    const f = await fixture(), unavailable = new Error('store unavailable');
    vi.spyOn(f.store, 'query').mockRejectedValue(unavailable);
    await expect(f.check()).rejects.toBe(unavailable);
  });

  it('fails closed on contradictory metadata instead of treating it as an unpublished draft', async () => {
    const f = await fixture(); await f.confirmed();
    await f.store.insert([{ graph: `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_meta`,
      subject: f.asset.seal.kaUal, predicate: 'http://dkg.io/ontology/merkleRoot', object: '"another-root"' }]);
    await expect(f.check()).rejects.toThrow('ambiguous VM metadata');
  });
});
