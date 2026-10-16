import { afterEach, expect, it, vi } from 'vitest';
import type { AtomicAssetReplacement, TripleStore } from '@origintrail-official/dkg-storage';
import type { VerifiedGraphScopedAsset } from '../src/sync/requester/graph-scoped-materialization.js';
import { executeGraphScopedPublication } from '../src/sync/requester/graph-scoped-publication.js';
import { prepareGraphScopedReplacementUnderLock } from '../src/sync/requester/graph-scoped-replacement.js';
vi.mock('../src/sync/requester/graph-scoped-replacement.js', () => ({ prepareGraphScopedReplacementUnderLock: vi.fn() }));
afterEach(() => vi.resetAllMocks());
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const assets = [1, 2].map(n => ({ ual: `urn:publication:${n}`, metaGraph: 'urn:publication:meta' } as VerifiedGraphScopedAsset));
const replacements = assets.map(a => ({ metadataSubject: a.ual } as AtomicAssetReplacement));
function run(publish: () => Promise<void>) {
  return executeGraphScopedPublication({ store: { getPressureSnapshot: () => ({ normalInflightLimit: 2 }) } as TripleStore, assets, options: {}, assertCurrent: () => {},
    requireCurrentMetadata: true, stale: () => 'stale' as const, complete: () => 'applied' as const,
    publish, quarantine: async () => {} });
}
it.each([false, true])('overlaps bounded preparation and drains every read before releasing locks (reject=%s)', async reject => {
  const entered = [deferred(), deferred()], release = [deferred(), deferred()];
  const failure = new Error('first member failed');
  let calls = 0;
  vi.mocked(prepareGraphScopedReplacementUnderLock).mockImplementation(async ({ asset }) => {
    const index = assets.findIndex(a => a.ual === asset.ual);
    if (calls++ < 2) {
      entered[index]!.resolve(); await release[index]!.promise;
      if (reject && index === 0) throw failure;
    }
    return replacements[index]!;
  });
  const publish = vi.fn(async () => {});
  const pending = run(publish);
  const result = pending.then(value => ({ value }), error => ({ error }));
  let settled = false; void result.then(() => { settled = true; });
  let next: Promise<unknown> | undefined;
  try {
    await Promise.all(entered.map(x => x.promise));
    expect(calls).toBe(2); expect(publish).not.toHaveBeenCalled();
    release[0]!.resolve(); await new Promise(r => setTimeout(r, 10));
    expect(settled).toBe(false); expect(publish).not.toHaveBeenCalled();
    // The second publication must not prepare while the first still owns a read.
    next = run(vi.fn(async () => {}));
    await new Promise(r => setTimeout(r, 10)); expect(calls).toBe(2);
    release[1]!.resolve();
    expect(await result).toEqual(reject ? { error: failure } : { value: 'applied' });
    if (reject) expect(publish).not.toHaveBeenCalled();
    else expect(publish).toHaveBeenCalledWith(replacements, {});
    expect(await next).toBe('applied');
  } finally { release.forEach(x => x.resolve()); await Promise.allSettled([pending, ...(next ? [next] : [])]); }
});
