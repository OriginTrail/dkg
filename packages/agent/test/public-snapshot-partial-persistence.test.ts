import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import { sealPublicGraphSnapshot } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { PublicSnapshotMethods } from '../src/dkg-agent-public-snapshot.js';
import { withPublicSnapshotQueryTrust } from '../src/public-snapshot-evidence.js';
import { materializeVerifiedGraphScopedAsset, type VerifiedGraphScopedAsset } from '../src/sync/requester/graph-scoped-materialization.js';

const graph='partial-persistent-snapshot', address=`0x${'1'.repeat(40)}`;
const meta=`did:dkg:context-graph:${graph}/_meta`, root=`0x${'b'.repeat(64)}`;
function asset(n:number): VerifiedGraphScopedAsset {
  const ual=`did:dkg:evm:31337/${address}/${n}`;
  const assertionGraph=`did:dkg:context-graph:${graph}/_verifiable_memory/${address}/${n}`;
  return {contextGraphId:graph,ual,assertionVersion:1n,assertionGraph,metaGraph:meta,
    dataQuads:[{subject:`urn:entity:${n}`,predicate:'urn:value',object:'"safe"',graph:assertionGraph}],
    metadataQuads:[['merkleRoot',JSON.stringify(root)],['assertionVersion','"1"']].map(([key,object])=>({subject:ual,predicate:`http://dkg.io/ontology/${key}`,object:object!,graph:meta}))};
}
function fixture(store:OxigraphStore, mode:'core-cache'|'rpc-only') {
  let generation=0;
  const count=mode==='core-cache'?11:10;
  const snapshot=sealPublicGraphSnapshot({version:1,chainId:'evm:31337',deploymentId:'test',contextGraphId:graph,onChainId:'1',nameHash:ethers.id(graph),contextGraphStorage:address,assetStorage:address,blockNumber:'10',blockHash:`0x${'a'.repeat(64)}`,finalityConfirmations:1,observedAt:Date.now(),expiresAt:Date.now()+120000,accessPolicy:0,
    assets:Array.from({length:count},(_,i)=>({id:((BigInt(address)<<96n)|BigInt(i+1)).toString(),root,version:'1'}))});
  const assets=new Map(Array.from({length:11},(_,i)=>{const a=asset(i+1);return [a.ual,a];}));
  const a:any={started:true,vmReconcileRotationClosed:false,vmReconcileLifecycleGeneration:1,
    vmReconcileLifecycleController:new AbortController(),vmReconcilePhysicalRuns:new Set(),
    subscribedContextGraphs:new Map(),store,
    contextGraphBindingState:{capture:()=>generation,isGenerationCurrent:(_:string,g:number)=>g===generation},
    chain:{chainId:'evm:31337',deploymentId:'test',readPublicGraphSnapshot:async()=>snapshot},
    router:{send:async()=>Buffer.from(JSON.stringify(snapshot))},
    subscribeToContextGraph:()=>{generation++;a.subscribedContextGraphs.set(graph,{subscribed:true,onChainId:'1'});},
  };
  // Stub only the already-verified transport boundary. The actual job owns the
  // trust marker, evidence authentication, failure and real atomic store writes.
  a.syncExactKnowledgeAssetsFromPeerDetailed=vi.fn(async (_peer:string,_graph:string,uals:string[],options:any)=>{
    await expect(query(store,graph)).rejects.toThrow('core-trusted');
    const committed:string[]=[];
    for(const ual of uals) {
      const verified=assets.get(ual)!;
      if(verified.ual.endsWith('/11')) continue; // Second batch fails on both transports.
      const authenticated=await options.authenticateGraphScopedAsset(verified);
      expect(await materializeVerifiedGraphScopedAsset({store,asset:authenticated.asset})).toBe('applied');
      committed.push(ual);
    }
    return {committedExactAssetUals:committed};
  });
  return a;
}
const query=(store:OxigraphStore,scope?:string,mode?:'core-cache'|'rpc-only')=>withPublicSnapshotQueryTrust(store,scope,mode,()=>store.query('SELECT ?s WHERE {GRAPH ?g {?s <urn:value> "safe"}}'));
const run=(a:any,mode:'core-cache'|'rpc-only')=>PublicSnapshotMethods.prototype.syncPublicGraphSnapshot.call(a,{contextGraphId:graph,onChainId:'1',trustedCorePeerIds:['core'],mode});
async function checkGuard(store:OxigraphStore) {
  await expect(query(store,graph)).rejects.toThrow('core-trusted');
  await expect(query(store)).rejects.toThrow('core-trusted');
  await expect(query(store,graph,'rpc-only')).rejects.toThrow('core-trusted');
  const accepted=await query(store,graph,'core-cache');
  expect(accepted.type).toBe('bindings');
  if(accepted.type==='bindings') expect(accepted.bindings).toHaveLength(10);
}
describe('partial public snapshot durable trust',()=>{
  it('marks before commits and retains query refusal across failure, reopen and RPC replay',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'snapshot-persistence-'));
    let store=new OxigraphStore(join(dir,'store.nq'));
    try {
      const a=fixture(store,'core-cache');
      await expect(run(a,'core-cache')).rejects.toThrow('10/11 committed');
      expect(a.syncExactKnowledgeAssetsFromPeerDetailed).toHaveBeenCalledTimes(3);
      expect(a.vmReconcilePhysicalRuns.size).toBe(0);
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
});
