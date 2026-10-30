import { observeOutboundBulkFrames } from './observe-bulk-graph-frames.js';
import { afterEach, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { startOxigraphSparqlEndpoint } from '../../../storage/test/helpers/oxigraph-sparql-endpoint.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DKGNode, LibP2PNetwork, ProtocolRouter, PeerResolver, createOperationContext, BULK_GRAPH_KIND as K, type BulkGraphFrame, type BulkGraphSession,
  bulkGraphTransportOptions, MemoryLayer, knowledgeAssetLayerGraphUri, createGraphKnowledgeAssetScope, type DuplexStreamOptions } from '@origintrail-official/dkg-core';
import { BlazegraphStore, OxigraphStore, quadsToNQuads, type StorePriorityScheduler } from '@origintrail-official/dkg-storage';
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
  beforeSend?: (frame: BulkGraphFrame) => Promise<void>; afterSend?: (frame: BulkGraphFrame) => Promise<void>; observe?: () => unknown;
  payloadBytes?: readonly number[]; expandedLengthMismatch?: boolean; tamperDigest?: 'asset' | 'chunk';
  transformPayload?: (plain: string) => string;
  storeScheduler?: StorePriorityScheduler;
  onInboundFailure?: DuplexStreamOptions['onInboundFailure'];
} = {}) {
  const directory = await mkdtemp(join(tmpdir(),'dkg-bulk-test-')); cleanups.push(() => rm(directory,{recursive:true,force:true}));
  const endpoint = await startOxigraphSparqlEndpoint({ maxRequestBytes: 1_048_576 });
  const target = new OxigraphStore(); cleanups.push(endpoint.close, () => target.close());
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
    endpoint.store.load(quadsToNQuads([...data,...metadata]), { format: 'application/n-quads' });
    if (hooks.payloadBytes || hooks.transformPayload) {
      const original = quadsToNQuads(data);
      const plain = Buffer.from(hooks.transformPayload?.(original) ?? original);
      const body = await encodeNegotiatedExactSyncResponse(plain, { request: {
        responseEncoding: 'gzip-nquads-v1', assetUals: [ual], phase: 'data',
      } });
      prepared.set(ual, { body, metadata: Buffer.from(quadsToNQuads(metadata)), plainBytes: plain.length });
    }
  }
  const source = new BlazegraphStore(endpoint.queryEndpoint, { scheduler: hooks.storeScheduler });
  cleanups.push(() => source.close());
  const chain = {chainId:'base:84532',getLatestMerkleRoot:async(id:bigint)=>byId.get(id)!,
    getMerkleRootCount:async()=>1n,getKAContextGraphId:async()=>14n} as unknown as ChainAdapter;
  const nodes = [0,1].map(() => new DKGNode({listenAddresses:['/ip4/127.0.0.1/tcp/0'],enableMdns:false}));
  for (const node of nodes) { await node.start(); cleanups.push(() => node.stop()); }
  const network = new LibP2PNetwork(nodes[0]!);
  await network.addKnownAddresses(nodes[1]!.peerId, [nodes[1]!.multiaddrs[0]!]);
  const peerResolver = new PeerResolver({ network, registry: { lookup: async () => [nodes[1]!.multiaddrs[0]!] },
    agentDirectory: { findRelayForPeer: async () => null } });
  const router = new ProtocolRouter(nodes[0]!, {network,peerResolver,isPeerAccepted:async()=>true,isPeerKnownRejected:()=>false});
  const server = new ProtocolRouter(nodes[1]!,{isPeerAccepted:async()=>true,isPeerKnownRejected:()=>false});
  let resources!: ExperimentalExactBatchResponderResources;
  registerSyncHandler({register:()=>{},protocolSync:'/fixture',syncDeniedResponse:'denied',syncPageSize:500,sharedMemoryTtlMs:0,
    store:source,peerId:nodes[1]!.peerId,parseSyncRequest:parse,authorizeSyncRequest:async()=>true,
    logWarn:()=>{},logDebug:()=>{},onExperimentalExactBatchResources:r=>{resources=r;}});
  const exports: number[] = [], responderErrors: unknown[] = [];
  let markPrefixCommitted!: () => void;
  const prefixCommitted = new Promise<void>(resolve => { markPrefixCommitted = resolve; });
  if (hooks.tamperDigest || hooks.beforeSend || hooks.afterSend) {
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
        await send(frame);
        await hooks.afterSend?.(frame);
      };
      try { return await respond(context); } catch (error) { responderErrors.push(error); throw error; }
    }, options);
  }
  registerPublicBulkGraph(server,{admission:resources,
    onInboundFailure: hooks.onInboundFailure,
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
    observeOutboundBulkFrames(router, frame => {
      if (frame.kind === K.COMMIT && frame.index === 7) markPrefixCommitted();
      hooks.onControl?.(frame);
    });
  }
  if (failClose) {
    const exchange = router.withDuplexStream.bind(router);
    router.withDuplexStream = async (...args) => { await exchange(...args); throw new Error('physical close failed'); };
  }
  const cancellation = new AbortController();
  const run = (outbound: BulkGraphRequest = request) => exchangeBulkGraphVerified(router,nodes[1]!.peerId,outbound,bulkGraphTransportOptions(20_000,cancellation.signal),
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
        return authenticated;
      }});
  return {request,exportCache: resources.exportCache, responderErrors,run,cancellation,source,target,groups,heaps,exports,uals,router,worker,directory,byId, supplierPeer: nodes[1]!.peerId};
}
