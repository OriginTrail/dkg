import { PublicSnapshotEvidence } from '../src/public-snapshot-evidence.js';
import { afterEach, expect, it, vi } from 'vitest';
import { runDurableSync, createDurableSyncBudget } from '../src/sync/requester/durable-sync.js';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
import { SyncVerifyWorker } from '../src/sync-verify-worker.js';
import { createOperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';

const cg = 'snapshot-fallback';
const metaGraph = `did:dkg:context-graph:${cg}/_meta`;
const ual = 'did:dkg:evm:31337/0x00000000000000000000000000000000000000ab/1';
const graph = `did:dkg:context-graph:${cg}/_verifiable_memory/0x00000000000000000000000000000000000000ab/1`;
const workers: SyncVerifyWorker[] = [];
afterEach(async () => { for (const worker of workers.splice(0)) await worker.close(); });
it.each([false, true])('preserves ordinary legacy compatibility while fencing snapshot writes: %s', async snapshot => {
  const worker = new SyncVerifyWorker(); workers.push(worker);
  const data: Quad[] = [{subject:'urn:legacy:root',predicate:'urn:value',object:'"legacy"',graph}];
  const root = computeFlatKCRootV10(data, []);
  const meta: Quad[] = [
    ['rootEntity', data[0]!.subject], ['merkleRoot', JSON.stringify(Buffer.from(root).toString('hex'))],
    ['kaUal', ual], ['assertionGraph', graph],
  ].map(([key, value]) => ({subject:ual,predicate:`http://dkg.io/ontology/${key}`,object:value!,graph:metaGraph}));
  // Include a valid V2 asset first: a mixed page must be rejected before even that asset commits.
  const v2Ual = ual.slice(0,-1) + '2', v2Graph = graph.slice(0,-1) + '2';
  const v2Data: Quad[] = [{subject:'urn:v2',predicate:'urn:value',object:'"valid"',graph:v2Graph}];
  const v2Meta = generateGraphKnowledgeAssetMetadata({contextGraphId:cg,ual:v2Ual,assertionGraph:v2Graph,
    merkleRoot:computeFlatKCRootV10(v2Data,[]),publisherPeerId:'fixture',accessPolicy:'public',allowedPeers:[],
    timestamp:new Date(),assertionVersion:1,publicTripleCount:1}, {status:'tentative'});
  const storeInsert = vi.fn(async () => {}), storeGraphScopedAsset = vi.fn(async () => 'applied' as const);
  const warnings: string[] = [];
  const result = await runDurableSync({
    ctx:createOperationContext('sync'), remotePeerId:'fixture-peer', contextGraphIds:[cg],
    durableSyncBudget:createDurableSyncBudget({fetchTimeoutMs:10000,authenticationTimeoutMs:10000}),
    admitVerifiedPage:snapshot ? page => PublicSnapshotEvidence.prototype.admitVerifiedPage.call({isCurrent:()=>true} as PublicSnapshotEvidence,page) : undefined,
    fetchSyncPages:async ({phase}) => { const quads = phase === 'data' ? [...v2Data,...data] : [...v2Meta,...meta];
      return {quads,bytesReceived:0,resumedFromOffset:0,nextOffset:quads.length,checkpointKey:phase,completed:true,timedOut:false}; },
    processDurableBatchInWorker:(data,meta,_ctx,accept,mode) => worker.processDurableBatch(data,meta,accept,mode),
    storeInsert,storeGraphScopedAsset,deleteCheckpoint:()=>{},setCheckpoint:()=>{},
    logInfo:()=>{},logDebug:()=>{},logWarn:(_ctx,message)=>{warnings.push(message);},
  });
  if (snapshot) {
    expect(result.complete).toBe(false);
    expect(result.failedPhases).toBeGreaterThan(0);
    expect(warnings.join(' ')).toContain('Snapshot recovery requires authenticated graph-scoped rows');
    expect(storeInsert).not.toHaveBeenCalled(); expect(storeGraphScopedAsset).not.toHaveBeenCalled();
  } else {
    expect(result.complete).toBe(true);
    expect(storeGraphScopedAsset).toHaveBeenCalledOnce();
    expect(storeInsert).toHaveBeenCalledTimes(2);
  }
});
