import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore, type QueryOptions } from '@origintrail-official/dkg-storage';
import { materializeVerifiedGraphScopedGroup } from '../src/sync/requester/graph-scoped-group.js';
import { materializeVerifiedGraphScopedAsset, type VerifiedGraphScopedAsset } from '../src/sync/requester/graph-scoped-materialization.js';

const stores: OxigraphStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });
function setup() {
  const store = new OxigraphStore(); stores.push(store);
  const asset = (n: number, version = 1): VerifiedGraphScopedAsset => ({
    contextGraphId: 'group-fence', ual: `urn:asset:${n}`, assertionVersion: BigInt(version),
    assertionGraph: `urn:data:${n}`, metaGraph: 'urn:metadata',
    dataQuads: [{ subject: `urn:entity:${n}`, predicate: 'urn:value', object: `"${version}"`, graph: `urn:data:${n}` }],
    metadataQuads: [
      { subject: `urn:asset:${n}`, predicate: 'http://dkg.io/ontology/assertionVersion', object: `"${version}"`, graph: 'urn:metadata' },
      { subject: `urn:asset:${n}`, predicate: 'http://dkg.io/ontology/merkleRoot', object: JSON.stringify('0x' + String(version).padStart(64, '0')), graph: 'urn:metadata' },
    ],
  });
  return { store, asset, group: [asset(1), asset(2)] };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
describe('group materialization fences and physical completion', () => {
  it('drains the dispatched transaction on cancellation and retains every member lock', async () => {
    const { store, group, asset } = setup(); const controller = new AbortController();
    const entered = deferred(), release = deferred(); const write = store.replaceAssetGroup.bind(store);
    let dispatchedSignal: AbortSignal | undefined;
    vi.spyOn(store, 'replaceAssetGroup').mockImplementation(async (members, options?: QueryOptions) => {
      dispatchedSignal = options?.signal; entered.resolve(); await release.promise; await write(members, options);
    });
    const run = materializeVerifiedGraphScopedGroup({ store, assets: group, options: { signal: controller.signal },
      assertCurrent: () => controller.signal.throwIfAborted(), shouldQuarantineCommitted: () => false });
    const result = run.then(() => 'applied', e => e.message); await Promise.race([entered.promise, run]);
    controller.abort(new Error('owned job cancelled'));
    let settled = false; void result.then(() => { settled = true; });
    let newerSettled = false;
    const newer = materializeVerifiedGraphScopedAsset({ store, asset: asset(2, 2) }).then(value => { newerSettled = true; return value; });
    await new Promise(r => setTimeout(r, 20));
    expect(dispatchedSignal).toBeUndefined(); expect(settled).toBe(false); expect(newerSettled).toBe(false);
    release.resolve(); expect(await result).toBe('owned job cancelled'); expect(await newer).toBe('applied');
    expect(await store.query('SELECT ?o WHERE { GRAPH <urn:data:2> { ?s <urn:value> ?o } }'))
      .toMatchObject({ bindings: [{ o: '"2"' }] });
  });
  it('quarantines every member if graph ownership is revoked during publication', async () => {
    const { store, group } = setup(); const write = store.replaceAssetGroup.bind(store); let revoked = false;
    const spy = vi.spyOn(store, 'replaceAssetGroup').mockImplementation(async (members, options) => {
      await write(members, options); revoked = true;
    });
    expect(await materializeVerifiedGraphScopedGroup({ store, assets: group, assertCurrent: () => {},
      shouldQuarantineCommitted: () => revoked })).toEqual(['quarantined', 'quarantined']);
    expect(spy).toHaveBeenCalledTimes(2); expect(await store.countQuads()).toBe(0);
  });
  it('rejects the entire group before mutation when one local version is newer', async () => {
    const { store, group, asset } = setup(); await materializeVerifiedGraphScopedAsset({ store, asset: asset(2, 2) });
    const spy = vi.spyOn(store, 'replaceAssetGroup');
    await expect(materializeVerifiedGraphScopedGroup({ store, assets: group, assertCurrent: () => {},
      shouldQuarantineCommitted: () => false })).rejects.toThrow('newer local assertion');
    expect(spy).not.toHaveBeenCalled(); expect(await store.countQuads('urn:data:1')).toBe(0);
  });
});
