import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizePublicGraphSnapshot } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { PublicSnapshotEvidence } from '../src/public-snapshot-evidence.js';
import { createPublicSnapshotHeldAssetCheck } from '../src/public-snapshot-held-assets.js';
import { materializeVerifiedGraphScopedAsset } from '../src/sync/requester/graph-scoped-materialization.js';
import { makeSnapshotAssets, sealSnapshotOf, type SnapshotAsset } from './helpers/public-snapshot-assets.js';

const graph = 'held-snapshot-assets';
const stores: OxigraphStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
});

function observe(assets: readonly SnapshotAsset[], mode: 'core-cache' | 'rpc-only', version = '1') {
  const sealed = sealSnapshotOf(graph, assets, version);
  const snapshot = normalizePublicGraphSnapshot(sealed, { ...sealed, now: Date.now() });
  return mode === 'core-cache'
    ? new PublicSnapshotEvidence({ snapshot, mode, sourceCore: 'core' }, () => true)
    : new PublicSnapshotEvidence({ snapshot, mode, sourceCore: null }, () => true);
}

/** Store assets the way a snapshot job does: authenticated by its evidence, written atomically. */
async function storeWith(evidence: PublicSnapshotEvidence, assets: readonly SnapshotAsset[]) {
  const store = new OxigraphStore();
  stores.push(store);
  for (const asset of assets) {
    const { asset: authenticated } = evidence.authenticate(asset.verified);
    expect(await materializeVerifiedGraphScopedAsset({ store, asset: authenticated })).toBe('applied');
  }
  return store;
}

describe('assets a snapshot job already holds', () => {
  it('recognises copies stored at the pinned version and root, and only those', async () => {
    const assets = makeSnapshotAssets(graph, 3);
    const store = await storeWith(observe(assets, 'core-cache'), assets.slice(0, 2));
    const holds = createPublicSnapshotHeldAssetCheck(store, observe(assets, 'core-cache'));
    expect(await Promise.all(assets.map(asset => holds(asset.ual)))).toEqual([true, true, false]);
    // A copy at another version than the snapshot pins is not the snapshot's asset.
    const newer = createPublicSnapshotHeldAssetCheck(store, observe(assets, 'core-cache', '2'));
    expect(await newer(assets[0]!.ual)).toBe(false);
  });

  it('does not skip a copy whose root differs from the pinned root or whose content was altered', async () => {
    const assets = makeSnapshotAssets(graph, 2);
    const store = await storeWith(observe(assets, 'core-cache'), assets);
    // Same asset and version, another pinned root.
    const otherRoot = [{ ...assets[0]!, root: `0x${'c'.repeat(64)}` }, assets[1]!];
    expect(await createPublicSnapshotHeldAssetCheck(store, observe(otherRoot, 'core-cache'))(assets[0]!.ual)).toBe(false);
    // Metadata and triple count kept, one stored literal replaced.
    const holds = createPublicSnapshotHeldAssetCheck(store, observe(assets, 'core-cache'));
    expect(await holds(assets[1]!.ual)).toBe(true);
    const [original] = assets[1]!.verified.dataQuads;
    await store.delete([original!]);
    await store.insert([{ ...original!, object: '"altered"' }]);
    expect(await holds(assets[1]!.ual)).toBe(false);
  });

  it('lets an rpc-only job relabel copies stored with core-cache evidence', async () => {
    const assets = makeSnapshotAssets(graph, 1);
    const cached = await storeWith(observe(assets, 'core-cache'), assets);
    expect(await createPublicSnapshotHeldAssetCheck(cached, observe(assets, 'rpc-only'))(assets[0]!.ual)).toBe(false);
    const independent = await storeWith(observe(assets, 'rpc-only'), assets);
    expect(await createPublicSnapshotHeldAssetCheck(independent, observe(assets, 'rpc-only'))(assets[0]!.ual)).toBe(true);
    // A core-cache job may skip a copy with independent evidence: skipping never rewrites it.
    expect(await createPublicSnapshotHeldAssetCheck(independent, observe(assets, 'core-cache'))(assets[0]!.ual)).toBe(true);
  });

  it('recognises a copy stored in a sub-graph', async () => {
    const assets = makeSnapshotAssets(graph, 1, { subGraphName: 'v1' });
    const store = await storeWith(observe(assets, 'core-cache'), assets);
    expect(await createPublicSnapshotHeldAssetCheck(store, observe(assets, 'core-cache'))(assets[0]!.ual)).toBe(true);
  });

  it('answers false for an asset outside the snapshot and when the store cannot be read', async () => {
    const assets = makeSnapshotAssets(graph, 2);
    const store = await storeWith(observe(assets, 'core-cache'), assets);
    const holds = createPublicSnapshotHeldAssetCheck(store, observe(assets.slice(0, 1), 'core-cache'));
    expect(await holds(assets[1]!.ual)).toBe(false);
    vi.spyOn(store, 'query').mockRejectedValue(new Error('store unavailable'));
    expect(await holds(assets[0]!.ual)).toBe(false);
  });
});
