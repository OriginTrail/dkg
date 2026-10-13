import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlazegraphStore, OxigraphStore, type QueryOptions } from '@origintrail-official/dkg-storage';
import { parseNQuadsTextTolerant } from '../../storage/src/nquads-text.js';
import { replaceLocallyTrustedKnowledgeAssetControls } from '@origintrail-official/dkg-publisher';
import { materializeVerifiedGraphScopedGroup } from '../src/sync/requester/graph-scoped-group.js';
import { materializeVerifiedGraphScopedAsset, type VerifiedGraphScopedAsset } from '../src/sync/requester/graph-scoped-materialization.js';

const stores: OxigraphStore[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const store of stores.splice(0)) await store.close(); });
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
  it('quarantines a confirmed Blazegraph publication despite failed cleanup, before releasing locks', async () => {
    const { store, group, asset } = setup();
    const cleanupEntered = deferred(), releaseCleanup = deferred();
    let revoked = false, cleanupFailed = false;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = String(init.body);
      if (init.headers['Content-Type'] === 'text/x-nquads') await store.insert(parseNQuadsTextTolerant(body));
      else if (body.startsWith('ASK')) {
        const reply = await store.query(body);
        if (reply.type !== 'boolean') throw new Error('Expected receipt');
        revoked = reply.value;
        return new Response(JSON.stringify({ boolean: reply.value }));
      } else if (body.startsWith('DROP SILENT GRAPH') && !cleanupFailed) {
        cleanupFailed = true;
        cleanupEntered.resolve(); await releaseCleanup.promise;
        return new Response('', { status: 500 });
      } else await store.update(body);
      return new Response('');
    }));
    const transport = new BlazegraphStore('http://fixture.invalid/sparql');
    store.replaceAssetGroup = transport.replaceAssetGroup.bind(transport);
    const run = materializeVerifiedGraphScopedGroup({ store, assets: group,
      assertCurrent: () => {}, shouldQuarantineCommitted: () => revoked });
    try {
      await Promise.race([cleanupEntered.promise, run]);
      let newerStarted = false;
      const singletonWrite = store.replaceGraphAndSubject.bind(store);
      vi.spyOn(store, 'replaceGraphAndSubject').mockImplementation(async (...args) => {
        newerStarted = true;
        expect(await store.countQuads('urn:data:1')).toBe(0);
        expect(await store.countQuads('urn:data:2')).toBe(0);
        return singletonWrite(...args);
      });
      const newer = materializeVerifiedGraphScopedAsset({ store, asset: asset(2, 2) });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(newerStarted).toBe(false);
      releaseCleanup.resolve();
      expect(await run).toBe('quarantined');
      expect(await newer).toBe('applied');
    } finally { releaseCleanup.resolve(); await transport.close(); }
  });

  it.each(['singleton', 'group'] as const)('retains same-version metadata and trusted controls through %s', async mode => {
    const { store, asset } = setup();
    const member = asset(1);
    const control = (name: string, object: string) => ({ graph: member.metaGraph, subject: member.ual,
      predicate: `http://dkg.io/ontology/${name}`, object: JSON.stringify(object) });
    const trusted = [...member.metadataQuads, control('accessPolicy', 'allowList'), control('allowedPeer', 'trusted'), control('publisherPeerId', 'publisher')];
    // This trusted confirmed timestamp must survive a same-version replay.
    const published = control('publishedAt', '2026-01-01T00:00:00Z');
    await store.insert([...trusted, published]);
    await replaceLocallyTrustedKnowledgeAssetControls(store, member.ual, trusted);
    const poisoned = { ...member, metadataQuads: [...member.metadataQuads,
      control('accessPolicy', 'public'), control('allowedPeer', 'untrusted')] };
    if (mode === 'singleton') expect(await materializeVerifiedGraphScopedAsset({ store, asset: poisoned })).toBe('applied');
    else expect(await materializeVerifiedGraphScopedGroup({ store, assets: [poisoned],
      assertCurrent: () => {}, shouldQuarantineCommitted: () => false })).toBe('applied');
    const result = await store.query(`SELECT ?p ?o WHERE { GRAPH <${member.metaGraph}> { <${member.ual}> ?p ?o } }`);
    expect(result).toMatchObject({ bindings: expect.arrayContaining([
      { p: published.predicate, o: published.object },
      { p: control('accessPolicy', '').predicate, o: '"allowList"' },
      { p: control('allowedPeer', '').predicate, o: '"trusted"' },
    ]) });
    expect(JSON.stringify(result)).not.toContain('untrusted');
  });
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
      shouldQuarantineCommitted: () => revoked })).toBe('quarantined');
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

it.each(['singleton','group'] as const)('holds publication and quarantine locks through %s settlement', async mode => {
  const {store,group,asset} = setup();
  const published=deferred(), releasePublish=deferred(), quarantining=deferred(), releaseQuarantine=deferred();
  let calls=0;
  if(mode==='group') {
    const write=store.replaceAssetGroup.bind(store);
    vi.spyOn(store,'replaceAssetGroup').mockImplementation(async (...args) => {
      if(++calls===1){published.resolve();await releasePublish.promise;}
      else if(calls===2){quarantining.resolve();await releaseQuarantine.promise;}
      await write(...args);
    });
  } else {
    const write=store.replaceGraphAndSubject.bind(store);
    vi.spyOn(store,'replaceGraphAndSubject').mockImplementation(async (...args) => {
      if(++calls===1){published.resolve();await releasePublish.promise;}
      else if(calls===2){quarantining.resolve();await releaseQuarantine.promise;}
      await write(...args);
    });
  }
  const pending=mode==='group'
    ? materializeVerifiedGraphScopedGroup({store,assets:group,assertCurrent:()=>{},shouldQuarantineCommitted:()=>true})
    : materializeVerifiedGraphScopedAsset({store,asset:group[0]!,shouldQuarantineCommitted:()=>true});
  await Promise.race([published.promise,pending]);
  let newerSettled=false;
  const newer=materializeVerifiedGraphScopedAsset({store,asset:asset(1,2)}).then(r=>{newerSettled=true;return r;});
  try {
    await new Promise(r=>setTimeout(r,10));expect(newerSettled).toBe(false);
    releasePublish.resolve();await Promise.race([quarantining.promise,pending]);
    await new Promise(r=>setTimeout(r,10));expect(newerSettled).toBe(false);
    releaseQuarantine.resolve();expect(await pending).toBe('quarantined');expect(await newer).toBe('applied');
  } finally {releasePublish.resolve();releaseQuarantine.resolve();await Promise.allSettled([pending,newer]);}
});
