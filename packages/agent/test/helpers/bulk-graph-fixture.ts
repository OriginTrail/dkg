import { afterEach, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DKGNode, LibP2PNetwork, ProtocolRouter, createOperationContext, BULK_GRAPH_KIND as K, type BulkGraphFrame, type BulkGraphSession,
  bulkGraphTransportOptions, MemoryLayer, knowledgeAssetLayerGraphUri, createGraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';
import { BlazegraphStore, OxigraphStore, quadsToNQuads } from '@origintrail-official/dkg-storage';
import { generateGraphKnowledgeAssetMetadata, computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import { registerPublicBulkGraph } from '../../src/sync/responder/bulk-graph-stream.js';
import { exchangeBulkGraphVerified } from '../../src/sync/requester/bulk-graph-stream.js';
import { type BulkGraphRequest } from '../../src/sync/bulk-graph-contract.js';
import { materializeVerifiedGraphScopedGroup } from '../../src/sync/requester/graph-scoped-group.js';
import { authenticateVerifiedGraphScopedAsset } from '../../src/sync/requester/graph-scoped-materialization.js';
import { registerSyncHandler, type ExperimentalExactBatchResponderResources } from '../../src/sync/responder/sync-handler.js';
import { SyncVerifyWorker } from '../../src/sync-verify-worker.js';
import { ContextGraphResolveMethods as Resolve } from '../../src/dkg-agent-cg-resolve.js';
import { encodeNegotiatedExactSyncResponse } from '../../src/sync/wire-compression.js';
import { estimateQuadHeapBytes } from '../../src/sync/memory-telemetry.js';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';

export const cg = 'bulk-fixture', address = '0x0000000000000000000000000000000000000001';
const parse = (bytes: Uint8Array) => Resolve.prototype.parseSyncRequest.call({ parsePipeDelimitedSyncRequest: Resolve.prototype.parsePipeDelimitedSyncRequest } as never, bytes);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.reverse()) await close(); cleanups.length = 0; });
export async function fixture(count = 20, corruptAt = -1, failClose = false, hooks: {
  beforePublish?: () => Promise<void>; onControl?: (frame: BulkGraphFrame) => void;
  beforeSend?: (frame: BulkGraphFrame) => Promise<void>; observe?: () => unknown;
  payloadBytes?: readonly number[]; expandedLengthMismatch?: boolean; tamperDigest?: 'asset' | 'chunk';
} = {}) {
  const directory = await mkdtemp(join(tmpdir(),'dkg-bulk-test-')); cleanups.push(() => rm(directory,{recursive:true,force:true}));
  const backing = new OxigraphStore(), target = new OxigraphStore(); cleanups.push(() => backing.close(), () => target.close());
  const prepared = new Map<string, { body: Uint8Array; metadata: Uint8Array; plainBytes: number }>();
  const uals: string[] = [], byId = new Map<bigint, Uint8Array>();
  for (let i = 1; i <= count; i++) {
    const ual = `did:dkg:base:84532/${address}/${i}`, graph = knowledgeAssetLayerGraphUri(cg, MemoryLayer.VerifiableMemory, createGraphKnowledgeAssetScope(ual, 1));
    const payload = hooks.payloadBytes?.[i-1] ?? 14;
    const data = Array.from({ length: Math.ceil(payload / 32768) }, (_, n) => ({
      subject: `urn:entity:${i}:${n}`, predicate: 'urn:payload',
      object: JSON.stringify('x'.repeat(Math.min(32768, payload - n * 32768))), graph }));
    const root = computeFlatKCRootV10(data, []); byId.set((BigInt(address)<<96n)|BigInt(i),root); uals.push(ual);
    const metadata = generateGraphKnowledgeAssetMetadata({ contextGraphId:cg, ual, assertionGraph:graph,
      assertionVersion:1, publicTripleCount:data.length, privateTripleCount:0, merkleRoot:root, authorAddress:address,
      publisherPeerId:'fixture', accessPolicy:'public', allowedPeers:[], timestamp:new Date() },
    {status:'confirmed',confirmation:{kind:'finalized-materialization', provenance:{batchId:BigInt(i),materializedVersion:{blockNumber:1,txIndex:0}}}});
    await backing.insert([...data,...metadata]);
    if (hooks.payloadBytes) {
      const plain = Buffer.from(quadsToNQuads(data));
      const body = await encodeNegotiatedExactSyncResponse(plain, { request: {
        responseEncoding: 'gzip-nquads-v1', assetUals: [ual], phase: 'data',
      } });
      prepared.set(ual, { body, metadata: Buffer.from(quadsToNQuads(metadata)), plainBytes: plain.length });
    }
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
  let markPrefixCommitted!: () => void;
  const prefixCommitted = new Promise<void>(resolve => { markPrefixCommitted = resolve; });
  if (hooks.tamperDigest || hooks.beforeSend) {
    const register = server.registerDuplexStream.bind(server);
    server.registerDuplexStream = (protocol, prepare, respond, options) => register(protocol, prepare, async context => {
      const session = context.continuation as unknown as BulkGraphSession, send = session.send.bind(session);
      session.send = async frame => {
        await hooks.beforeSend?.(frame);
        if ((hooks.tamperDigest === 'asset' && frame.kind === K.META && frame.index === 0)
          || (hooks.tamperDigest === 'chunk' && frame.kind === K.CHUNK_END)) {
          if (frame.kind === K.CHUNK_END) await prefixCommitted;
          const payload = JSON.parse(Buffer.from(frame.payload).toString()); payload.digest = '0'.repeat(64);
          return send({ ...frame, payload: Buffer.from(JSON.stringify(payload)) });
        }
        return send(frame);
      };
      return respond(context);
    }, options);
  }
  registerPublicBulkGraph(server,{admission:resources,
    exportCache:{ acquireEncoded:async request=>{
      // Byte-boundary cases isolate receiver parsing/verification from exporter budgets.
      const payload = prepared.get(request.assetUal);
      if (payload) return { ...payload, assertCurrent: async () => {}, release: () => {} };
      const lease = await resources.exportCache.acquireEncoded(request);
      if (lease && request.assetUal === uals[corruptAt]) {
        const body = lease.body.slice(); body[body.length-2] ^= 1; return {...lease,body};
      }
      return lease && hooks.expandedLengthMismatch ? { ...lease, plainBytes: lease.plainBytes + 1 } : lease;
    }} as typeof resources.exportCache,
    authorizeSyncRequest:async()=>true,isPublicContextGraph:async graph=>graph===cg,
    onExport:(_,n)=>{ exports.push(n); return hooks.observe?.(); }});
  const worker = new SyncVerifyWorker(); cleanups.push(() => worker.close());
  const request: BulkGraphRequest = {version:1,contextGraphId:cg,snapshotDigest:'a'.repeat(64),assetUals:uals};
  const groups: number[]=[]; const heaps: number[]=[];
  if (hooks.onControl || hooks.tamperDigest === 'chunk') {
    const exchange = router.withDuplexStream.bind(router);
    router.withDuplexStream = (peer, protocol, options, consume) => exchange(peer, protocol, options, (stream, signal) => {
      const send = stream.send.bind(stream);
      stream.send = bytes => {
        const data = bytes.subarray(), header = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const frame = { kind: header.getUint8(4), index: header.getUint32(8), sequence: header.getUint32(12), payload: data.subarray(20) };
        if (frame.kind === K.COMMIT && frame.index === 7) markPrefixCommitted();
        hooks.onControl?.(frame);
        return send(bytes);
      };
      return consume(stream, signal);
    });
  }
  if (failClose) {
    const exchange = router.withDuplexStream.bind(router);
    router.withDuplexStream = async (...args) => { await exchange(...args); throw new Error('physical close failed'); };
  }
  const cancellation = new AbortController();
  const run = () => exchangeBulkGraphVerified(router,nodes[1]!.peerId,request,bulkGraphTransportOptions(20_000,cancellation.signal),
    {stagingRoot:directory, onMetrics: hooks.observe,
      verification:{contextGraphId:cg,assetUals:uals,ctx:createOperationContext('sync'),
        parseAndFilter:worker.parseAndFilter.bind(worker),processDurableBatchInWorker:(data,meta,_ctx,accept,mode)=>worker.processDurableBatch(data,meta,accept,mode),
      },
      commit:async (assets, signal)=>{
        const authenticated=[];
        for(const asset of assets) authenticated.push((await authenticateVerifiedGraphScopedAsset(chain,asset,async()=>true)).asset);
        await hooks.beforePublish?.();
        const outcome=await materializeVerifiedGraphScopedGroup({store:target,assets:authenticated,
          assertCurrent:()=>signal.throwIfAborted(),shouldQuarantineCommitted:()=>false});
        expect(outcome).toBe('applied'); groups.push(assets.length);
        heaps.push(assets.flatMap(a => [...a.dataQuads, ...a.metadataQuads]).reduce((n, q) => n + estimateQuadHeapBytes(q), 0));
      }});
  return {run,source,target,groups,heaps,exports,uals,router,worker,directory,byId, supplierPeer: nodes[1]!.peerId};
}
