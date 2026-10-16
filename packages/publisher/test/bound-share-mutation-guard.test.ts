import { literal, uniquenessKey, PROMOTE_UNIQUENESS_KEY, PROMOTE_STATE, PROMOTE_PAYLOAD } from '../src/async-promote-queue-utils.js';
import { afterEach, describe, expect, it } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGPublisher, TripleStoreAsyncPromoteQueue, getPromoteFailureDisposition } from '../src/index.js';
import { finalizeRootlessAssertionForTest } from './_helpers/rootless-lifecycle.js';
const CG = 'bound-mutation', NAME = 'asset', AUTHOR = `0x${'11'.repeat(20)}`;
const triples = [{subject:'urn:asset',predicate:'urn:value',object:'"original"'}];
const stores: OxigraphStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });
async function setup() {
  const store = new OxigraphStore(); stores.push(store);
  const keypair = await generateEd25519Keypair();
  const readOwner = TripleStoreAsyncPromoteQueue.ownershipReader(store, {graphUri:'urn:test:bound-control'});
  const reopen = () => new DKGPublisher({store,promoteOwnershipReader:readOwner,chain:new MockChainAdapter(),eventBus:new TypedEventBus(),keypair});
  const publisher = reopen();
  await publisher.assertionCreate(CG, NAME, AUTHOR);
  await publisher.assertionWrite(CG, NAME, AUTHOR, triples);
  const seal = await finalizeRootlessAssertionForTest({publisher,store,contextGraphId:CG,name:NAME,agentAddress:AUTHOR});
  const queue = new TripleStoreAsyncPromoteQueue(store, { graphUri:'urn:test:bound-control', backoff:()=>0 });
  const binding = await publisher.prepareAssertionPromoteRecovery(CG, NAME, AUTHOR, undefined, true);
  if ('completedResult' in binding) throw new Error('Expected an unshared seal');
  const request = {contextGraphId:CG,assertionName:NAME,agentAddress:AUTHOR,entities:'all' as const,recoveryBinding:binding};
  return {store,publisher,reopen,queue,request,seal};
}
describe('bound ownership extends the publisher lifecycle mutation fence', () => {
  it('persists a real fresh oversized rejection as a retired owner without changing SWM', async () => {
    const {publisher,store,queue}=await setup();const name='too-large';
    await publisher.assertionCreate(CG,name,AUTHOR);
    await publisher.assertionWrite(CG,name,AUTHOR,Array.from({length:80},(_,i)=>({subject:'urn:large',predicate:`urn:p:${i}`,object:JSON.stringify('x'.repeat(55_000))})));
    const seal=await finalizeRootlessAssertionForTest({publisher,store,contextGraphId:CG,name,agentAddress:AUTHOR});
    const binding=await publisher.prepareAssertionPromoteRecovery(CG,name,AUTHOR,{publisherPeerId:'12D3KooWRecovery'},false);
    if('completedResult' in binding)throw new Error('Expected fresh binding');
    const request={contextGraphId:CG,assertionName:name,agentAddress:AUTHOR,entities:'all' as const,recoveryBinding:binding};
    const job=await queue.enqueueAndClaim(request,'inline');await queue.recordCommitMarker(job.jobId,job.lease!.claimToken,'promoteStarted');
    const error=await publisher.assertionPromote(CG,name,AUTHOR,{recoveryBinding:binding}).catch(e=>e);
    const result=getPromoteFailureDisposition(error);
    if(result?.classification!=='cap_exceeded')throw new Error('Expected certified cap rejection');
    expect(await queue.fail(job.jobId,job.lease!.claimToken,{classification:result.classification,retryable:result.retryable,
      diagnosticCode:result.diagnostic.code,noEffectProof:result.noEffectProof,message:error.message,recordedAt:Date.now()})).toMatchObject({retiredNoEffect:true});
    expect(await store.countQuads(seal.sharedGraphUri)).toBe(0);
    await publisher.assertionDiscard(CG,name,AUTHOR);
    await expect(queue.recover(job.jobId)).rejects.toThrow('retired no-effect rejection');
    expect(await queue.clearTerminalJob(job.jobId)).toEqual({outcome:'cleared'});
  });

  it('does not acquire authority over a different graph when another queue is constructed', async () => {
    const {publisher,request,store}=await setup();
    const unrelated=new TripleStoreAsyncPromoteQueue(store,{graphUri:'urn:unrelated-control'});
    await unrelated.enqueueAndClaim(request,'unrelated');
    await publisher.assertionPromote(CG,NAME,AUTHOR,{recoveryBinding:request.recoveryBinding});
    expect(await publisher.assertionPullFrom(CG,NAME,AUTHOR,'swm')).toMatchObject({seeded:1});
  });
  it.each(['wrong-binding','later-attempt','committed'])('does not retire %s ownership from an invalid no-effect receipt', async kind => {
    const {publisher,queue,request}=await setup();
    let job=await queue.enqueueAndClaim(request,'inline');
    if(kind==='later-attempt'){
      await queue.fail(job.jobId,job.lease!.claimToken,{classification:'transient',retryable:true,message:'read interrupted',recordedAt:Date.now()});
      job=(await queue.claimNext('retry'))!;
    }
    if(kind==='committed')await queue.recordCommitMarker(job.jobId,job.lease!.claimToken,'swmInserted');
    await queue.fail(job.jobId,job.lease!.claimToken,{classification:'cap_exceeded',retryable:false,message:'too large',recordedAt:Date.now(),
      diagnosticCode:'PROMOTE_NO_EFFECT_REJECTION',noEffectProof:{sealDigest:request.recoveryBinding.sealDigest,
        operationId:kind==='wrong-binding'?'different-operation':request.recoveryBinding.intent.operationId}});
    expect(await queue.clearTerminalJob(job.jobId)).toMatchObject({outcome:'rejected'});
    await expect(publisher.assertionDiscard(CG,NAME,AUTHOR)).rejects.toMatchObject({code:'KA_PROMOTE_RECOVERY_REQUIRED',recoveryJobId:job.jobId});
  });

  it('keeps completed content sealed across a fresh publisher and terminal hold, then permits reopening after success', async () => {
    const {publisher,reopen,queue,request,store,seal} = await setup();
    const job = await publisher.admitPreparedAssertionShare(request,()=>queue.enqueueAndClaim(request,'inline'));
    const first = await publisher.assertionPromote(CG,NAME,AUTHOR,{recoveryBinding:request.recoveryBinding});
    expect(first.promotedCount).toBe(1);
    await queue.fail(job.jobId,job.lease!.claimToken,{classification:'fatal',retryable:false,message:'inspection',recordedAt:Date.now()});
    const restarted = reopen();
    await expect(restarted.assertionPullFrom(CG,NAME,AUTHOR,'swm')).rejects.toMatchObject({code:'KA_PROMOTE_RECOVERY_REQUIRED',recoveryJobId:job.jobId});
    await expect(restarted.assertionWrite(CG,NAME,AUTHOR,triples)).rejects.toMatchObject({code:'KA_PROMOTE_RECOVERY_REQUIRED'});
    expect(await store.countQuads(seal.sharedGraphUri)).toBe(1);
    await queue.recover(job.jobId); const claimed = await queue.claimNext('worker');
    const replay = await restarted.assertionPromote(CG,NAME,AUTHOR,{recoveryBinding:request.recoveryBinding});
    expect(replay).toMatchObject({promotedCount:0,shareOperationId:first.shareOperationId});
    await queue.recordCommitMarker(job.jobId,claimed!.lease!.claimToken,'swmInserted');
    await queue.succeed(job.jobId,claimed!.lease!.claimToken,{promotedCount:0,succeededAt:Date.now()});
    expect(await restarted.assertionPullFrom(CG,NAME,AUTHOR,'swm')).toMatchObject({seeded:1});
  });
  it('rejects admission if a completed asset was reopened after binding preparation', async () => {
    const {publisher,queue,request} = await setup();
    await publisher.assertionPromote(CG,NAME,AUTHOR,{recoveryBinding:request.recoveryBinding});
    await publisher.assertionPullFrom(CG,NAME,AUTHOR,'swm');
    await expect(publisher.admitPreparedAssertionShare(request,()=>queue.enqueueAndClaim(request,'inline')))
      .rejects.toMatchObject({code:'KA_PROMOTE_RECOVERY_BINDING_CONFLICT'});
    expect(await queue.list()).toEqual([]);
  });
  it('ignores ownership predicates in untrusted user content but refuses unreadable trusted ownership', async () => {
    const {publisher,queue,request,store} = await setup();
    const quads = [
      {subject:'urn:attacker',predicate:PROMOTE_UNIQUENESS_KEY,object:literal(uniquenessKey(request)),graph:'urn:other-author:working-memory'},
      {subject:'urn:attacker',predicate:PROMOTE_STATE,object:'"queued"',graph:'urn:other-author:working-memory'},
      {subject:'urn:attacker',predicate:PROMOTE_PAYLOAD,object:literal('{}'),graph:'urn:other-author:working-memory'},
    ];
    const attacker = `0x${'22'.repeat(20)}`;
    await publisher.assertionCreate(CG,'attacker',attacker);
    await publisher.assertionWrite(CG,'attacker',attacker,quads.map(q=>({subject:q.subject,predicate:q.predicate,object:q.object})));
    await publisher.assertionPromote(CG,NAME,AUTHOR,{recoveryBinding:request.recoveryBinding});
    expect(await publisher.assertionPullFrom(CG,NAME,AUTHOR,'swm')).toMatchObject({seeded:1});
    await store.insert(quads.map(q=>({...q,graph:'urn:test:bound-control'})));
    await expect(publisher.assertionWrite(CG,NAME,AUTHOR,triples)).rejects.toMatchObject({code:'KA_PROMOTE_RECOVERY_REQUIRED'});
    await expect(queue.enqueue(request)).rejects.toThrow('ownership record is unreadable');
  });
  it('does not block a different storage author lane with a genuine bound owner', async () => {
    const {publisher,queue,request} = await setup();
    await queue.enqueueAndClaim({...request,agentAddress:`0x${'22'.repeat(20)}`},'other-author');
    await publisher.assertionPromote(CG,NAME,AUTHOR,{recoveryBinding:request.recoveryBinding});
    expect(await publisher.assertionPullFrom(CG,NAME,AUTHOR,'swm')).toMatchObject({seeded:1});
  });
  it('does not extend bound ownership rules to an ordinary queued job', async () => {
    const {publisher,queue,request} = await setup();
    await publisher.assertionPromote(CG,NAME,AUTHOR,{recoveryBinding:request.recoveryBinding});
    const {recoveryBinding:_,...ordinary}=request;
    await queue.enqueue(ordinary);
    expect(await publisher.assertionPullFrom(CG,NAME,AUTHOR,'swm')).toMatchObject({seeded:1});
  });
});
