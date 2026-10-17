import { literal, uniquenessKey, PROMOTE_UNIQUENESS_KEY, PROMOTE_STATE, PROMOTE_PAYLOAD } from '../src/async-promote-queue-utils.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair, assertionLifecycleUri, contextGraphMetaUri, SwmGossipPayloadTooLargeError } from '@origintrail-official/dkg-core';
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
  it('checks new-operation capability before admission without imposing it on committed recovery', async () => {
    const { publisher, store, queue, request, seal } = await setup();
    const unavailable = new Error('inventory signer unavailable');
    const preflight = vi.fn(async () => { throw unavailable; });
    await expect(publisher.prepareAssertionPromoteRecovery(CG, NAME, AUTHOR, undefined, true, preflight)).rejects.toBe(unavailable);
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(await queue.list()).toHaveLength(0);
    expect(await store.countQuads(seal.graphUri)).toBe(1);
    expect(await store.countQuads(seal.sharedGraphUri)).toBe(0);
    const job = await queue.enqueueAndClaim(request, 'owner');
    await publisher.assertionPromote(CG, NAME, AUTHOR, { recoveryBinding: request.recoveryBinding });
    expect(await publisher.prepareAssertionPromoteRecovery(CG, NAME, AUTHOR, undefined, true, preflight)).toEqual(request.recoveryBinding);
    expect(preflight).toHaveBeenCalledTimes(1);
    expect((await queue.getStatus(job.jobId))?.request.recoveryBinding).toEqual(request.recoveryBinding);
  });

  it.each(['running', 'failed_retrying', 'failed'])('refuses resealing behind an unfinished %s owner after publisher cleanup', async state => {
    const { publisher, store, queue, request, seal } = await setup();
    const job = await queue.enqueueAndClaim(request, 'owner');
    await publisher.assertionPromote(CG, NAME, AUTHOR, { recoveryBinding: request.recoveryBinding });
    if (state !== 'running') await queue.fail(job.jobId, job.lease!.claimToken, {
      classification: state === 'failed' ? 'fatal' : 'transient', retryable: state !== 'failed',
      message: 'inventory handoff incomplete', recordedAt: Date.now(),
    });
    const restore = vi.fn(() => publisher.materializeCanonicalWorkingMemory(CG,
      seal.kaUal, seal.assertionVersion, seal.publicQuads));
    await expect(publisher.prepareAssertionShareSeal(CG, NAME, AUTHOR, undefined, restore))
      .rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_REQUIRED', recoveryJobId: job.jobId });
    expect(restore).not.toHaveBeenCalled();
    expect(await store.countQuads(seal.graphUri)).toBe(0);
    expect(await store.countQuads(seal.sharedGraphUri)).toBe(1);
    expect((await queue.getStatus(job.jobId))?.request.recoveryBinding).toEqual(request.recoveryBinding);
  });

  it('returns the original canonical finalization result when no owner exists', async () => {
    const { publisher, store, seal } = await setup();
    const result = await publisher.prepareAssertionShareSeal(CG, NAME, AUTHOR, undefined,
      () => publisher.materializeCanonicalWorkingMemory(CG, seal.kaUal, seal.assertionVersion, seal.publicQuads));
    expect(result).toBe(seal.graphUri);
    expect(await store.countQuads(seal.graphUri)).toBe(1);
    expect(await store.countQuads(seal.sharedGraphUri)).toBe(0);
  });

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

  it.each(['intent', 'swm', 'intent-and-swm'])('does not certify rejection with %s before the outer commit marker', async persisted => {
    const {publisher,store,queue}=await setup(); const name='partial-too-large';
    await publisher.assertionCreate(CG,name,AUTHOR);
    await publisher.assertionWrite(CG,name,AUTHOR,Array.from({length:80},(_,i)=>({subject:'urn:large',predicate:`urn:p:${i}`,object:JSON.stringify('x'.repeat(55_000))})));
    const seal=await finalizeRootlessAssertionForTest({publisher,store,contextGraphId:CG,name,agentAddress:AUTHOR});
    const binding=await publisher.prepareAssertionPromoteRecovery(CG,name,AUTHOR,{publisherPeerId:'12D3KooWRecovery'},false);
    if('completedResult' in binding)throw new Error('Expected fresh binding');
    const request={contextGraphId:CG,assertionName:name,agentAddress:AUTHOR,entities:'all' as const,recoveryBinding:binding};
    const job=await queue.enqueueAndClaim(request,'inline');
    await queue.recordCommitMarker(job.jobId,job.lease!.claimToken,'promoteStarted');
    // Persist the actual producer's partial-commit records; leave queue.swmInserted false.
    if(persisted.includes('intent'))await store.insert([
      {subject:assertionLifecycleUri(CG,AUTHOR,name),predicate:'http://dkg.io/ontology/shareOperationId',object:JSON.stringify(binding.intent.operationId),graph:contextGraphMetaUri(CG)},
      {subject:assertionLifecycleUri(CG,AUTHOR,name),predicate:'http://dkg.io/ontology/promoteOperationIntent',object:JSON.stringify(JSON.stringify(binding.intent)),graph:contextGraphMetaUri(CG)},
    ]);
    if(persisted.includes('swm'))await store.insert(seal.publicQuads.map(q=>({...q,graph:seal.sharedGraphUri})));
    const error=await publisher.assertionPromote(CG,name,AUTHOR,{recoveryBinding:binding}).catch(e=>e);
    const disposition=getPromoteFailureDisposition(error);
    expect(error).toBeInstanceOf(SwmGossipPayloadTooLargeError);
    const noEffectProof=disposition?.classification==='cap_exceeded'?disposition.noEffectProof:undefined;
    expect(noEffectProof).toBeUndefined();
    expect((await queue.getStatus(job.jobId))?.commitMarker).toMatchObject({promoteStarted:true,swmInserted:false});
    const failed=await queue.fail(job.jobId,job.lease!.claimToken,{classification:'cap_exceeded',
      retryable:false,diagnosticCode:error.code,noEffectProof,
      message:error.message,recordedAt:Date.now()});
    expect(failed).not.toHaveProperty('retiredNoEffect',true);
    expect(await queue.clearTerminalJob(job.jobId)).toMatchObject({outcome:'rejected'});
    await expect(publisher.assertionDiscard(CG,name,AUTHOR)).rejects.toMatchObject({code:'KA_PROMOTE_RECOVERY_REQUIRED',recoveryJobId:job.jobId});
    expect(await store.countQuads(seal.sharedGraphUri)).toBe(persisted.includes('swm')?80:0);
  });

  it('preserves a completed competing operation when a stale binding reaches admission', async()=>{
    const {publisher,queue,request}=await setup();
    const stale=await publisher.prepareAssertionPromoteRecovery(CG,NAME,AUTHOR,undefined,true);
    if('completedResult' in stale)throw new Error('Expected a second prepared binding');
    await publisher.assertionPromote(CG,NAME,AUTHOR,{recoveryBinding:request.recoveryBinding});
    const late={...request,recoveryBinding:stale};
    await expect(publisher.admitPreparedAssertionShare(late,()=>queue.enqueueAndClaim(late,'late')))
      .rejects.toMatchObject({code:'KA_PROMOTE_RECOVERY_BINDING_CONFLICT'});
    expect(await publisher.hasSwmShareComplete(CG,NAME,AUTHOR)).toBe(true);
    expect(await queue.list()).toEqual([]);
  });

  it.each(['corrupt','missing','changed'])('revokes a completed publisher certificate for %s persisted bound authority', async fault=>{
    const {publisher,store,request}=await setup();
    await publisher.assertionPromote(CG,NAME,AUTHOR,{recoveryBinding:request.recoveryBinding});
    expect(await publisher.hasSwmShareComplete(CG,NAME,AUTHOR)).toBe(true);
    const pattern={graph:contextGraphMetaUri(CG),subject:assertionLifecycleUri(CG,AUTHOR,NAME),predicate:'http://dkg.io/ontology/promoteOperationIntent'};
    await store.deleteByPattern(pattern);
    if(fault!=='missing')await store.insert([{...pattern,object:JSON.stringify(fault==='corrupt'?'not-json':JSON.stringify({
      ...request.recoveryBinding.intent,timestampMs:request.recoveryBinding.intent.timestampMs+1}))}]);
    await expect(publisher.assertionPromote(CG,NAME,AUTHOR,{recoveryBinding:request.recoveryBinding})).rejects.toThrow();
    expect(await publisher.hasSwmShareComplete(CG,NAME,AUTHOR)).toBe(false);
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
