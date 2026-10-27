import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizePublicGraphSnapshot, sealPublicGraphSnapshot } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { PublicSnapshotEvidence, type PublicSnapshotObservation } from '../src/public-snapshot-evidence.js';
import { recoverPublicSnapshotToCurrent } from '../src/public-snapshot-catch-up.js';
import { createPublicSnapshotHeldAssetCheck } from '../src/public-snapshot-held-assets.js';
import { materializeVerifiedGraphScopedAsset } from '../src/sync/requester/graph-scoped-materialization.js';
import { makeSnapshotAssets, sealSnapshotOf, type SnapshotAsset } from './helpers/public-snapshot-assets.js';

const graph = 'changing-public-snapshot';
function observation(assets: SnapshotAsset[], block = '10'): PublicSnapshotObservation {
  const sealed = sealPublicGraphSnapshot({ ...sealSnapshotOf(graph, assets), blockNumber: block,
    assets: assets.map(a => ({ id: a.kaId.toString(), root: a.root, version: String(a.verified.assertionVersion) })) });
  return { mode: 'core-cache', sourceCore: 'core', snapshot: normalizePublicGraphSnapshot(sealed, sealed) };
}
const stores: OxigraphStore[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const s of stores.splice(0)) await s.close(); });

describe('catch-up stays inside one snapshot job', () => {
  it('recovers additions and updated roots while revalidating and retaining unchanged stored assets', async () => {
    const original = makeSnapshotAssets(graph, 2), expanded = makeSnapshotAssets(graph, 3);
    expanded[1] = makeSnapshotAssets(graph, 2, { version: 2 })[1]!;
    const first = observation(original), next = observation(expanded, '11');
    const store = new OxigraphStore(); stores.push(store);
    const readFresh = vi.fn().mockResolvedValueOnce(next).mockResolvedValue(next);
    const imported: string[] = [], checked: string[] = [];
    const result = await recoverPublicSnapshotToCurrent({ initial: first, deadline: Date.now() + 3_600_000,
      signal: new AbortController().signal, assertCurrent() {}, readFresh,
      recover: async pinned => {
        const evidence = new PublicSnapshotEvidence(pinned, () => true);
        const assets = pinned === first ? original : expanded;
        const holds = createPublicSnapshotHeldAssetCheck(store, evidence);
        const committed = new Set<string>(); let alreadyPresent = 0;
        for (const asset of assets) {
          checked.push(`${asset.ual}:${asset.verified.assertionVersion}`);
          if (await holds(asset.ual)) alreadyPresent++;
          else {
            expect(await materializeVerifiedGraphScopedAsset({ store, asset: evidence.authenticate(asset.verified).asset })).toBe('applied');
            imported.push(`${asset.ual}:${asset.verified.assertionVersion}`);
          }
          committed.add(asset.ual);
        }
        return { committed, alreadyPresent };
      } });
    expect(result.rounds).toBe(2);
    expect(result.observation).toBe(next);
    expect(result.recovered.committed.size).toBe(3);
    expect(result.recovered.alreadyPresent).toBe(1);
    expect(imported).toEqual([`${original[0]!.ual}:1`, `${original[1]!.ual}:1`, `${expanded[1]!.ual}:2`, `${expanded[2]!.ual}:1`]);
    expect(checked).toHaveLength(5);
    expect(readFresh).toHaveBeenCalledTimes(2);
  });

  it.each(['assetStorage', 'contextGraphStorage', 'nameHash', 'blockNumber', 'blockHash'] as const)(
    'never claims success or recovers under a changed %s', async field => {
      const initial = observation([]);
      const fresh = { ...initial, snapshot: { ...initial.snapshot, [field]: field === 'blockNumber' ? '9' : 'changed' } } as PublicSnapshotObservation;
      const recover = vi.fn(async () => ({ committed: new Set<string>() }));
      await expect(recoverPublicSnapshotToCurrent({ initial, deadline: Date.now() + 3_600_000,
        signal: new AbortController().signal, assertCurrent() {}, recover, readFresh: async () => fresh })).rejects.toThrow(/scope changed|anchor/);
      expect(recover).toHaveBeenCalledTimes(1);
    });

  it('never resets the original deadline when inventories keep changing', async () => {
    vi.useFakeTimers();
    const start = Date.now(), initial = observation([]), expanded = observation(makeSnapshotAssets(graph, 1), '11');
    const recover = vi.fn(async () => ({ committed: new Set<string>() }));
    const readFresh = vi.fn(async () => { vi.setSystemTime(start + 3_600_000); return expanded; });
    await expect(recoverPublicSnapshotToCurrent({ initial, deadline: start + 3_600_000,
      signal: new AbortController().signal, assertCurrent() {}, recover, readFresh })).rejects.toThrow('original job deadline');
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('refuses a shrinking inventory without claiming current coverage of retained old content', async () => {
    const assets = makeSnapshotAssets(graph, 2), initial = observation(assets), smaller = observation(assets.slice(0, 1), '11');
    const recover = vi.fn(async () => ({ committed: new Set(assets.map(asset => asset.ual)) }));
    await expect(recoverPublicSnapshotToCurrent({ initial, deadline: Date.now() + 3_600_000,
      signal: new AbortController().signal, assertCurrent() {}, recover, readFresh: async () => smaller }))
      .rejects.toThrow('removed previously pinned assets');
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('drains recovery and rejects cancellation before starting another coverage read', async () => {
    const initial = observation([]), caller = new AbortController();
    let finish!: () => void;
    const physical = new Promise<void>(resolve => { finish = resolve; });
    const readFresh = vi.fn();
    const job = recoverPublicSnapshotToCurrent({ initial, deadline: Date.now() + 3_600_000,
      signal: caller.signal, assertCurrent() {}, readFresh,
      recover: async () => { await physical; return { committed: new Set<string>() }; } });
    const rejection = expect(job).rejects.toThrow('cancelled');
    caller.abort(new Error('cancelled'));
    await Promise.resolve(); expect(readFresh).not.toHaveBeenCalled();
    finish(); await rejection;
    expect(readFresh).not.toHaveBeenCalled();
  });
});
