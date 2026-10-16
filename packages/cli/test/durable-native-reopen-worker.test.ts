import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { createOperationContext, canonicalGraphScopedAuthorSealFromAssertionSealV1,
  computeCanonicalGraphScopedAuthorSealDigestV1 } from '@origintrail-official/dkg-core';
import { TripleStoreAsyncPromoteQueue } from '@origintrail-official/dkg-publisher';
import { commitDurableShareInventory } from '../../agent/src/internal/promote/durable-share-inventory.js';
import { AUTHOR, AUTHOR_WALLET, CONTEXT_GRAPH_ID, NETWORK_ID, agents, tempDirs,
  seedDurableWorkspaceAssetV1, startRepairAgentV1 } from '../../agent/test/support/rfc64-local-catalog-repair-fixture.js';
import { runPromoteJob, createPromoteWorkerSupervisor } from '../src/daemon/worker/async-promote-worker.js';

describe('native inventory reopen failure retains the original durable worker obligation', () => {
  it('recovers after a healthy disk reopen without replay or a replacement job', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'bound-native-reopen-')); tempDirs.push(dataDir);
    const storePath = join(dataDir, 'store.nq');
    const first = await startRepairAgentV1({ name:'native-reopen-first', dataDir, storePath });
    vi.spyOn(first,'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    first.acceptOpenContextGraphPolicyV1({ networkId:NETWORK_ID,contextGraphId:CONTEXT_GRAPH_ID,ownerAddress:AUTHOR });
    await first.whenRfc64CatalogResponsibilitiesIdleV1();
    await first.whenRfc64CatalogSupervisorsIdleV1();
    await first.closeRfc64SwmCatalogProjectionSupervisorV1();
    const seeded = await seedDurableWorkspaceAssetV1(first,'native-reopen',97n);
    const binding = { version:1 as const,inventoryRequired:true,
      sealDigest:computeCanonicalGraphScopedAuthorSealDigestV1(canonicalGraphScopedAuthorSealFromAssertionSealV1(seeded.seal)),
      intent:{version:1 as const,operationId:seeded.shareOperationId,timestampMs:1,
        confirmationRequired:false,accessPolicy:'public' as const,allowedPeers:[]} };
    const params = {contextGraphId:CONTEXT_GRAPH_ID,assertionCoordinate:seeded.assertionCoordinate,
      lifecycleAgentAddress:AUTHOR,recoveryBinding:binding,ctx:createOperationContext('share')};
    const queue = new TripleStoreAsyncPromoteQueue(first.store,{backoff:()=>0,maxRetries:1});
    const job = await queue.enqueueAndClaim({contextGraphId:CONTEXT_GRAPH_ID,assertionName:seeded.assertionCoordinate,
      entities:'all',agentAddress:AUTHOR,recoveryBinding:binding},'inline');
    const exec = DatabaseSync.prototype.exec, prepare = DatabaseSync.prototype.prepare;
    let writing = false, reopening = false;
    const execSpy = vi.spyOn(DatabaseSync.prototype,'exec').mockImplementation(function(this:DatabaseSync,sql:string) {
      if(sql.trim().toUpperCase()==='BEGIN IMMEDIATE') writing=true;
      if(writing && sql.trim().toUpperCase()==='COMMIT') {
        reopening=true; throw Object.assign(new Error('COMMIT unavailable'),{code:'ERR_SQLITE_ERROR',errcode:10});
      }
      return exec.call(this,sql);
    });
    const prepareSpy = vi.spyOn(DatabaseSync.prototype,'prepare').mockImplementation(function(this:DatabaseSync,sql:string) {
      if(reopening)throw Object.assign(new Error('verified reopen busy'),{code:'ERR_SQLITE_ERROR',errcode:5});
      return prepare.call(this,sql);
    });
    try {
      const outcome=await runPromoteJob({job,queue,workerId:'inline',now:Date.now,heartbeatIntervalMs:60000,log:()=>undefined,
        runPromote:async(_request,markStarted)=>{await markStarted();await commitDurableShareInventory(first,params);return {promotedCount:0};}});
      expect(reopening).toBe(true);
      expect(outcome.outcome).toBe('failed_retrying');
      expect((await queue.getStatus(job.jobId))?.attempt.lastError).toMatchObject({diagnosticCode:'PROMOTE_POST_COMMIT_FAILURE',retryable:true});
      await expect(commitDurableShareInventory(first,params)).rejects.toMatchObject({code:'PROMOTE_POST_COMMIT_FAILURE'});
    } finally {execSpy.mockRestore();prepareSpy.mockRestore();}
    await first.stop();agents.splice(agents.indexOf(first),1);
    const second=await startRepairAgentV1({name:'native-reopen-second',dataDir,storePath});
    vi.spyOn(second,'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    second.acceptOpenContextGraphPolicyV1({networkId:NETWORK_ID,contextGraphId:CONTEXT_GRAPH_ID,ownerAddress:AUTHOR});
    await second.whenRfc64CatalogResponsibilitiesIdleV1();
    const reopenedQueue=new TripleStoreAsyncPromoteQueue(second.store,{backoff:()=>0,maxRetries:1});
    vi.spyOn(second,'promoteQueue','get').mockReturnValue(reopenedQueue);
    const assertion=second.assertion;
    vi.spyOn(second,'assertion','get').mockReturnValue({...assertion,promote:async(_cg,_name,options)=>{
      expect(options?.recoveryBinding).toEqual(binding);
      await commitDurableShareInventory(second,params);
      return {promotedCount:0,sealed:true,publishReady:true,shareOperationId:seeded.shareOperationId};
    }});
    const worker=createPromoteWorkerSupervisor({agent:second,workerConcurrency:1,pollIntervalMs:10,log:()=>undefined});
    try {await worker.start();await vi.waitFor(async()=>expect((await reopenedQueue.getStatus(job.jobId))?.state).toBe('succeeded'));}
    finally {await worker.stop();}
    const jobs=await reopenedQueue.list();expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({jobId:job.jobId,request:{recoveryBinding:binding},attempt:{count:2}});
    const snapshot=second.readRfc64SwmAuthorInventorySnapshotV1({inventoryScopeDigest:seeded.scopeDigest,authorAddress:AUTHOR});
    expect(snapshot?.rows).toHaveLength(1);
    expect(snapshot?.rows[0]).toMatchObject({kaUal:seeded.seal.kaUal,assertionVersion:seeded.seal.assertionVersion});
  });
});
