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

  it('counts a newer stored version whose own content verifies, as a catch-up does', async () => {
    const pinned = makeSnapshotAssets(graph, 2);
    const newer = makeSnapshotAssets(graph, 2, { version: 2 });
    const store = await storeWith(observe(newer, 'core-cache', '2'), newer);
    // An older snapshot never replaces a newer stored version, so the asset is held in either mode.
    for (const mode of ['core-cache', 'rpc-only'] as const)
      expect(await createPublicSnapshotHeldAssetCheck(store, observe(pinned, mode))(pinned[0]!.ual)).toBe(true);
    // Unless the newer version's own content no longer verifies.
    const [original] = newer[1]!.verified.dataQuads;
    await store.delete([original!]);
    await store.insert([{ ...original!, object: '"altered"' }]);
    expect(await createPublicSnapshotHeldAssetCheck(store, observe(pinned, 'core-cache'))(pinned[1]!.ual)).toBe(false);
    // An older stored version is not held: the job fetches the pinned one.
    const older = await storeWith(observe(pinned, 'core-cache'), pinned);
    expect(await createPublicSnapshotHeldAssetCheck(older, observe(newer, 'core-cache', '2'))(newer[0]!.ual)).toBe(false);
  });

  it('lets an rpc-only job relabel a copy stored with core-cache evidence in the same store', async () => {
    const assets = makeSnapshotAssets(graph, 1);
    const [asset] = assets;
    const store = await storeWith(observe(assets, 'core-cache'), assets);
    const labels = async () => {
      const result = await store.query(`SELECT ?mode ?source WHERE { GRAPH <${asset!.verified.metaGraph}> {
        <${asset!.ual}> <http://dkg.io/ontology/chainEvidenceMode> ?mode ; <http://dkg.io/ontology/chainEvidenceSource> ?source } }`);
      return result.type === 'bindings' ? result.bindings : [];
    };
    expect(await labels()).toEqual([{ mode: '"core-cache"', source: '"core"' }]);
    // The rpc-only job does not skip the core-cache copy, so it transfers and imports it as before.
    const rpcOnly = observe(assets, 'rpc-only');
    expect(await createPublicSnapshotHeldAssetCheck(store, rpcOnly)(asset!.ual)).toBe(false);
    expect(await materializeVerifiedGraphScopedAsset({ store, asset: rpcOnly.authenticate(asset!.verified).asset })).toBe('applied');
    expect(await labels()).toEqual([{ mode: '"rpc-only"', source: '"local-rpc"' }]);
    // A rerun of the rpc-only job now finds it already present.
    expect(await createPublicSnapshotHeldAssetCheck(store, observe(assets, 'rpc-only'))(asset!.ual)).toBe(true);
    // A core-cache job may skip a copy with independent evidence: skipping never rewrites it.
    expect(await createPublicSnapshotHeldAssetCheck(store, observe(assets, 'core-cache'))(asset!.ual)).toBe(true);
    expect(await labels()).toEqual([{ mode: '"rpc-only"', source: '"local-rpc"' }]);
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
