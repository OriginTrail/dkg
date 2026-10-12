import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DKGNode, LibP2PNetwork, ProtocolRouter, createOperationContext,
  bulkGraphTransportOptions, MemoryLayer, knowledgeAssetLayerGraphUri, createGraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';
import { BlazegraphStore, OxigraphStore } from '@origintrail-official/dkg-storage';
import { generateGraphKnowledgeAssetMetadata, computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import { registerPublicBulkGraph } from '../src/sync/responder/bulk-graph-stream.js';
import { exchangeBulkGraphVerified, BulkGraphPartialError } from '../src/sync/requester/bulk-graph-stream.js';
import { type BulkGraphRequest } from '../src/sync/bulk-graph-contract.js';
import { materializeVerifiedGraphScopedGroup } from '../src/sync/requester/graph-scoped-group.js';
import { authenticateVerifiedGraphScopedAsset } from '../src/sync/requester/graph-scoped-materialization.js';
import { registerSyncHandler, type ExperimentalExactBatchResponderResources } from '../src/sync/responder/sync-handler.js';
import { SyncVerifyWorker } from '../src/sync-verify-worker.js';
import { ContextGraphResolveMethods as Resolve } from '../src/dkg-agent-cg-resolve.js';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';

const cg = 'bulk-fixture', address = '0x0000000000000000000000000000000000000001';
const parse = (bytes: Uint8Array) => Resolve.prototype.parseSyncRequest.call({ parsePipeDelimitedSyncRequest: Resolve.prototype.parsePipeDelimitedSyncRequest } as never, bytes);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.reverse()) await close(); cleanups.length = 0; });
async function fixture(count = 20, corruptAt = -1, failClose = false) {
  const directory = await mkdtemp(join(tmpdir(),'dkg-bulk-test-')); cleanups.push(() => rm(directory,{recursive:true,force:true}));
  const backing = new OxigraphStore(), target = new OxigraphStore(); cleanups.push(() => backing.close(), () => target.close());
  const uals: string[] = [], byId = new Map<bigint, Uint8Array>();
  for (let i = 1; i <= count; i++) {
    const ual = `did:dkg:base:84532/${address}/${i}`, graph = knowledgeAssetLayerGraphUri(cg, MemoryLayer.VerifiableMemory, createGraphKnowledgeAssetScope(ual, 1));
    const data = [{ subject:`urn:entity:${i}`, predicate:'urn:payload', object:'"verified value"', graph }];
    const root = computeFlatKCRootV10(data, []); byId.set((BigInt(address)<<96n)|BigInt(i),root); uals.push(ual);
    const metadata = generateGraphKnowledgeAssetMetadata({ contextGraphId:cg, ual, assertionGraph:graph,
      assertionVersion:1, publicTripleCount:1, privateTripleCount:0, merkleRoot:root, authorAddress:address,
      publisherPeerId:'fixture', accessPolicy:'public', allowedPeers:[], timestamp:new Date() },
    {status:'confirmed',confirmation:{kind:'finalized-materialization', provenance:{batchId:BigInt(i),materializedVersion:{blockNumber:1,txIndex:0}}}});
    await backing.insert([...data,...metadata]);
  }
  function cell(value: string) {
    if (!value.startsWith('"')) return { type: 'uri', value };
    const match = /^("(?:[^"\\]|\\.)*")(?:(?:\^\^<([^>]+)>)|@([\w-]+))?$/.exec(value);
    if (!match) throw new Error('Invalid fixture literal');
    return { type: 'literal', value: JSON.parse(match[1]!), ...(match[2] ? { datatype: match[2] } : {}), ...(match[3] ? { 'xml:lang': match[3] } : {}) };
  }
  const httpServer = createServer(async (req, res) => {
    try {
      const pieces: Buffer[] = []; let bytes = 0;
      for await (const piece of req) { bytes += piece.length; if (bytes > 1_048_576) throw new Error('Fixture request limit'); pieces.push(Buffer.from(piece)); }
      const result = await backing.query(Buffer.concat(pieces).toString('utf8'));
      if (result.type !== 'bindings') throw new Error('Fixture SELECT only');
      res.setHeader('Content-Type', 'application/sparql-results+json');
      res.end(JSON.stringify({ head: { vars: Object.keys(result.bindings[0] ?? {}) }, results: { bindings: result.bindings.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, cell(value)]))) } }));
    } catch { res.statusCode = 500; res.end('fixture-query-failure'); }
  });
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const endpoint = httpServer.address(); if (!endpoint || typeof endpoint === 'string') throw new Error('Fixture server absent');
  const source = new BlazegraphStore(`http://127.0.0.1:${endpoint.port}/sparql`);
  cleanups.push(() => new Promise<void>((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve())), () => source.close());
  const chain = {chainId:'base:84532',getLatestMerkleRoot:async(id:bigint)=>byId.get(id)!,
    getMerkleRootCount:async()=>1n,getKAContextGraphId:async()=>14n} as unknown as ChainAdapter;
  const nodes = [0,1].map(() => new DKGNode({listenAddresses:['/ip4/127.0.0.1/tcp/0'],enableMdns:false}));
  for (const node of nodes) { await node.start(); cleanups.push(() => node.stop()); }
  const network = new LibP2PNetwork(nodes[0]!);
  const router = new ProtocolRouter(nodes[0]!, {network,peerResolver:{resolve:async()=>{
    await network.addKnownAddresses(nodes[1]!.peerId,[nodes[1]!.multiaddrs[0]!]); return [nodes[1]!.multiaddrs[0]!];
  }},isPeerAccepted:async()=>true,isPeerKnownRejected:()=>false});
  const server = new ProtocolRouter(nodes[1]!,{isPeerAccepted:async()=>true,isPeerKnownRejected:()=>false});
  let resources!: ExperimentalExactBatchResponderResources;
  registerSyncHandler({register:()=>{},protocolSync:'/fixture',syncDeniedResponse:'denied',syncPageSize:500,sharedMemoryTtlMs:0,
    store:source,peerId:nodes[1]!.peerId,parseSyncRequest:parse,authorizeSyncRequest:async()=>true,
    logWarn:()=>{},logDebug:()=>{},onExperimentalExactBatchResources:r=>{resources=r;}});
  const exports: number[] = [];
  registerPublicBulkGraph(server,{localPeerId:nodes[1]!.peerId,store:source,admission:resources,
    exportCache:{ acquireEncoded:async request=>{
      const lease = await resources.exportCache.acquireEncoded(request);
      if (lease && request.assetUal === uals[corruptAt]) {
        const body = lease.body.slice(); body[body.length-2] ^= 1; return {...lease,body};
      }
      return lease;
    }} as typeof resources.exportCache,
    parseSyncRequest:parse,authorizeSyncRequest:async()=>true,isPublicContextGraph:async graph=>graph===cg,
    onExport:(_,n)=>exports.push(n)});
  const worker = new SyncVerifyWorker(); cleanups.push(() => worker.close());
  const request: BulkGraphRequest = {version:1,contextGraphId:cg,snapshotDigest:'a'.repeat(64),assetUals:uals};
  const groups: number[]=[];
  if (failClose) {
    const exchange = router.withDuplexStream.bind(router);
    router.withDuplexStream = async (...args) => { await exchange(...args); throw new Error('physical close failed'); };
  }
  const cancellation = new AbortController();
  const run = () => exchangeBulkGraphVerified(router,nodes[1]!.peerId,request,bulkGraphTransportOptions(20_000,cancellation.signal),
    {stagingRoot:directory,
      verification:{contextGraphId:cg,assetUals:uals,ctx:createOperationContext('sync'),
        parseAndFilter:worker.parseAndFilter.bind(worker),processDurableBatchInWorker:(data,meta,_ctx,accept,mode)=>worker.processDurableBatch(data,meta,accept,mode),
        authenticationDeadline:()=>Date.now()+10_000,storeGraphScopedAsset:async()=>{throw new Error('Singleton write used');}},
      commit:async (assets, signal)=>{
        const authenticated=[];
        for(const asset of assets) authenticated.push((await authenticateVerifiedGraphScopedAsset(chain,asset,async()=>true)).asset);
        const outcomes=await materializeVerifiedGraphScopedGroup({store:target,assets:authenticated,
          assertCurrent:()=>signal.throwIfAborted(),shouldQuarantineCommitted:()=>false});
        expect(outcomes.every(x=>x==='applied')).toBe(true); groups.push(assets.length);
      }});
  return {run,source,target,groups,exports,uals};
}
describe('bulk public graph stream over real Noise sockets and verifier', () => {
  it('transfers more than ten assets, groups atomic publication, and reuses warm payloads', async () => {
    const f=await fixture(); const first=await f.run();
    expect(first.committedAssetUals).toEqual(f.uals); expect(first.metrics.commitGroups).toBeLessThan(20);
    expect(first.metrics.largestGroup).toBeGreaterThan(1); expect(first.metrics.peakStagedBytes).toBeLessThanOrEqual(16*1024*1024);
    expect(f.exports.reduce((a,b)=>a+b,0)).toBe(20);
    const count=await f.target.countQuads(); f.exports.length=0;
    const second=await f.run(); expect(second.committedAssetUals).toEqual(f.uals);
    expect(await f.target.countQuads()).toBe(count); expect(f.exports.every(n=>n===0)).toBe(true);
  },30_000);
  it('retains all completed local commits if physical stream closure subsequently fails', async () => {
    const f = await fixture(12, -1, true);
    let error: unknown; try { await f.run(); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(BulkGraphPartialError);
    expect((error as BulkGraphPartialError).committedAssetUals).toEqual(f.uals);
    expect((error as Error).message).toContain('physical close failed');
  }, 30_000);
  it('does not acknowledge a corrupt asset even when its encoded directory digest agrees', async () => {
    const f=await fixture(20,9);
    let error: unknown; try {await f.run();} catch(e){error=e;}
    expect(error).toBeInstanceOf(BulkGraphPartialError);
    expect((error as BulkGraphPartialError).metrics.receivedAssets).toBeGreaterThanOrEqual(10);
    expect((error as BulkGraphPartialError).committedAssetUals).toEqual(f.uals.slice(0,8));
    expect(await f.target.countQuads(knowledgeAssetLayerGraphUri(cg, MemoryLayer.VerifiableMemory, createGraphKnowledgeAssetScope(f.uals[9]!, 1)))).toBe(0);
  },30_000);
});
