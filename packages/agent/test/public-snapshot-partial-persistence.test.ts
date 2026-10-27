import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import { exactAssetUalsForSelection } from '../src/sync/exact-assets.js';
import * as exactRecovery from '../src/exact-recovery-execution.js';

import { AgentWorkLifetime } from '../src/agent-work-lifetime.js';
import { fixtureRoot } from './verified-asset-root-fixture.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sealPublicGraphSnapshot } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { PublicSnapshotMethods } from '../src/dkg-agent-public-snapshot.js';
import { queryWithPublicSnapshotTrust } from '../src/public-snapshot-evidence.js';
import { DKGQueryEngine } from '../../query/src/dkg-query-engine.js';
import { materializeVerifiedGraphScopedAsset, type VerifiedGraphScopedAsset } from '../src/sync/requester/graph-scoped-materialization.js';
import { createDurableSyncAccumulator, finalizeDurableSyncCompletion } from '../src/sync/durable-progress.js';

afterEach(() => vi.restoreAllMocks());
const graph='partial-persistent-snapshot', address=`0x${'1'.repeat(40)}`;
const meta=`did:dkg:context-graph:${graph}/_meta`, root=`0x${'b'.repeat(64)}`;
function asset(n:number): VerifiedGraphScopedAsset {
  const ual=`did:dkg:evm:31337/${address}/${n}`;
  const assertionGraph=`did:dkg:context-graph:${graph}/_verifiable_memory/${address}/${n}`;
  return {
      merkleRootHex: fixtureRoot([{ predicate: 'http://dkg.io/ontology/merkleRoot', object: JSON.stringify(root), graph: '', subject: '' }]),contextGraphId:graph,ual,assertionVersion:1n,assertionGraph,metaGraph:meta,
    dataQuads:[{subject:`urn:entity:${n}`,predicate:'urn:value',object:'"safe"',graph:assertionGraph}],
    metadataQuads:[['merkleRoot',JSON.stringify(root)],['assertionVersion','"1"']].map(([key,object])=>({subject:ual,predicate:`http://dkg.io/ontology/${key}`,object:object!,graph:meta}))};
}
const empty=()=>finalizeDurableSyncCompletion(createDurableSyncAccumulator());
function fixture(store:OxigraphStore, mode:'core-cache'|'rpc-only', last:'missing'|'refused-once'='missing') {
  let generation=0;
  const count=mode==='core-cache'?11:10;
  const observedAt = Date.now();
  const snapshot=sealPublicGraphSnapshot({version:1,chainId:'evm:31337',deploymentId:'test',contextGraphId:graph,onChainId:'1',nameHash:ethers.id(graph),contextGraphStorage:address,assetStorage:address,blockNumber:'10',blockHash:`0x${'a'.repeat(64)}`,finalityConfirmations:1,observedAt,expiresAt:observedAt+120000,accessPolicy:0,
    assets:Array.from({length:count},(_,i)=>({id:((BigInt(address)<<96n)|BigInt(i+1)).toString(),root,version:'1'}))});
  const assets=new Map(Array.from({length:11},(_,i)=>{const a=asset(i+1);return [a.ual,a];}));
  const a:any={started:true,vmReconcileRotationClosed:false,workLifetime: new AgentWorkLifetime(),
    log:{info:vi.fn(),warn:vi.fn(),debug:vi.fn()},

    subscribedContextGraphs:new Map(),store,
    contextGraphSubscriptionDormancyById: new Map(),
    waitForContextGraphSubscriptionActivation: LifecycleSyncMethods.prototype.waitForContextGraphSubscriptionActivation,
    getSubscribedContextGraphs: () => a.subscribedContextGraphs,
    contextGraphBindingState:{capture:()=>generation,isGenerationCurrent:(_:string,g:number)=>g===generation},
    chain:{chainId:'evm:31337',deploymentId:'test',readPublicGraphSnapshot:async()=>snapshot},
    router:{send:async()=>Buffer.from(JSON.stringify(snapshot))},
    subscribeToContextGraph:(_:string,binding:object)=>{generation++;a.subscribedContextGraphs.set(graph,{subscribed:true,...binding});},
  };
  // Stub only the already-verified transport boundary. The actual job owns the
  // trust marker, evidence authentication, waits, failure and real atomic store writes.
  let refusals=last==='refused-once'?1:0;
  a.recoverSnapshotExactAssets=vi.spyOn(exactRecovery, 'runExactRecovery').mockImplementation(async ({ host: _agent, remotePeerId: _peer, contextGraphId: _graph, policy, authority }) => {
    await expect(query(store,graph)).rejects.toThrow('core-trusted');
    const selection=exactAssetUalsForSelection(policy.selection);
    // This node's sync admission refused the attempt: nothing reached the peer.
    if(selection.some(ual=>ual.endsWith('/11')) && refusals-->0)
      return {admission:'local-admission-deferred',result:{...empty(),deferredBackpressure:1},disposition:'incomplete'};
    const committed:string[]=[];
    for(const ual of selection) {
      const verified=assets.get(ual)!;
      // The peer answers without the second batch's asset on both transports.
      if(verified.ual.endsWith('/11') && last==='missing') continue;
      const authenticated=await authority.authenticate(verified, performance.now() + 120000);
      expect(await materializeVerifiedGraphScopedAsset({store,asset:authenticated.asset})).toBe('applied');
      committed.push(ual);
    }
    return {admission:'work-started',result:empty(),disposition:committed.length===selection.length?'found':'incomplete',committedExactAssetUals:committed};
  });
  return a;
}
const sparql='SELECT ?s WHERE {GRAPH ?g {?s <urn:value> "safe"}}';
// Scoped reads use the raw store once the guard passes; unscoped reads go through
// the engine over the dataset without the marked graphs, as agent.query runs them.
const rawStore=(store:OxigraphStore)=>({query:async()=>{const r=await store.query(sparql);return {bindings:r.type==='bindings'?r.bindings:[]};}});
const query=(store:OxigraphStore,scope?:string,mode?:'core-cache'|'rpc-only')=>queryWithPublicSnapshotTrust(store,
  scope?rawStore(store):new DKGQueryEngine(store),sparql,scope?{contextGraphId:scope}:{},mode);
const run=(a:any,mode:'core-cache'|'rpc-only')=>PublicSnapshotMethods.prototype.syncPublicGraphSnapshot.call(a,{contextGraphId:graph,onChainId:'1',trustedCorePeerIds:['core'],mode});
async function checkGuard(store:OxigraphStore) {
  await expect(query(store,graph)).rejects.toThrow('core-trusted');
  // An unscoped read succeeds and leaves the marked graph out.
  await expect(query(store)).resolves.toMatchObject({bindings:[]});
  await expect(query(store,graph,'rpc-only')).rejects.toThrow('core-trusted');
  const accepted=await query(store,graph,'core-cache');
  expect(accepted.bindings).toHaveLength(10);
}
describe('partial public snapshot durable trust',()=>{
  it('marks before commits and retains query refusal across failure, reopen and RPC replay',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'snapshot-persistence-'));
    let store=new OxigraphStore(join(dir,'store.nq'));
    try {
      // Crossing a millisecond boundary must not make the fixture's lifetime
      // exceed the protocol maximum before recovery even starts.
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(now).mockReturnValueOnce(now + 1);
      const a=fixture(store,'core-cache');
      clock.mockRestore();
      // A peer's answer without the asset, unlike a refusal, ends the job: the
      // batch of ten, the batch of one, then one singleton on the legacy transport.
      await expect(run(a,'core-cache')).rejects.toThrow('Snapshot recovery incomplete: 10/11 committed');
      expect(a.recoverSnapshotExactAssets.mock.calls.map(([request]:any[])=>request.options.exactRecoveryTransportMode))
        .toEqual(['stream-preferred','stream-preferred','legacy']);
      expect(a.workLifetime.physicalRuns.size).toBe(0);
      await checkGuard(store);
      await store.close();
      store=new OxigraphStore(join(dir,'store.nq'));
      await checkGuard(store);
      await expect(run(fixture(store,'rpc-only'),'rpc-only')).resolves.toMatchObject({committed:10,current:true});
      await checkGuard(store);
      await store.close();
      store=new OxigraphStore(join(dir,'store.nq'));
      await checkGuard(store);
    } finally {await store.close();await rm(dir,{recursive:true,force:true});}
  });
  it('waits out a refused admission of the second batch and completes under the same guard',async()=>{
    const store=new OxigraphStore();
    try {
      const a=fixture(store,'core-cache','refused-once');
      await expect(run(a,'core-cache')).resolves.toMatchObject({assets:11,committed:11,alreadyPresent:0,current:true});
      expect(a.recoverSnapshotExactAssets).toHaveBeenCalledTimes(3);
      expect(a.recoverSnapshotExactAssets.mock.calls.every(([request]:any[])=>request.options.exactRecoveryTransportMode==='stream-preferred')).toBe(true);
      await expect(query(store,graph)).rejects.toThrow('core-trusted');
    } finally {await store.close();}
  });
});
