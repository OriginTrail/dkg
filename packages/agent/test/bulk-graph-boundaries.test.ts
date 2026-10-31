import { describe, expect, it } from 'vitest';
import { BULK_GRAPH_KIND as K, BULK_GRAPH_CHUNK_BYTES, type BulkGraphFrame, type BulkGraphSession } from '@origintrail-official/dkg-core';
import { servePublicBulkChunk } from '../src/sync/responder/bulk-graph-stream.js';
import { readBulkJson, type BulkGraphRequest } from '../src/sync/bulk-graph-contract.js';
import type { PublicAssetServingOptions } from '../src/sync/responder/public-asset-responder.js';

describe('100 MB encoded envelope and bounded credits', () => {
  it.each([false, true])('rechecks public authority after a staging-credit wait before exposing the next asset', async prepareAhead => {
    let publicGraph = true, sent = 0, released = 0;
    const request: BulkGraphRequest = { version: 1, contextGraphId: 'boundary', snapshotDigest: 'a'.repeat(64),
      assetUals: Array.from({ length: 34 }, (_, i) => `fixture-${i}`) };
    const session = { signal: new AbortController().signal,
      send: async (frame: BulkGraphFrame) => { if (frame.kind === K.META) sent++; },
      next: async () => { publicGraph = false; return { kind: K.CREDIT, index: 0, sequence: 1, payload: new Uint8Array() }; },
    } satisfies Pick<BulkGraphSession, 'signal' | 'send' | 'next'>;
    const options = { isPublicContextGraph: async () => publicGraph,
      exportCache: { acquireEncoded: async () => ({ identity: 'fixture', wholePayloadExports: 0, body: new Uint8Array([1]), metadata: new Uint8Array([1]),
        plainBytes: 1, encodingDurationMs: 0, assertCurrent: async () => {}, release: () => { released++; } }) },
    } satisfies PublicAssetServingOptions;
    await expect(servePublicBulkChunk(request, session, options, prepareAhead)).rejects.toThrow('public authority changed');
    expect(sent).toBe(32); expect(released).toBe(33);
  });
  it.each([false, true])('rechecks asset access after CREDIT while the context graph remains public', async prepareAhead => {
    let revoked = false, acquired = 0, released = 0;
    const sent: BulkGraphFrame[] = [];
    const request: BulkGraphRequest = { version: 1, contextGraphId: 'boundary', snapshotDigest: 'a'.repeat(64),
      assetUals: Array.from({ length: 34 }, (_, i) => `fixture-${i}`) };
    const session = { signal: new AbortController().signal,
      send: async (frame: BulkGraphFrame) => { sent.push(frame); },
      next: async () => { revoked = true; return { kind: K.CREDIT, index: 0, sequence: 1, payload: new Uint8Array() }; },
    } satisfies Pick<BulkGraphSession, 'signal' | 'send' | 'next'>;
    const options = { isPublicContextGraph: async () => true,
      exportCache: { acquireEncoded: async () => {
        const index = acquired++;
        return { identity: 'fixture', wholePayloadExports: 0, encodingDurationMs: 0, body: new Uint8Array([1]), metadata: new Uint8Array([1]), plainBytes: 1,
          assertCurrent: async () => { if (index === 32 && revoked) throw new Error('asset access revoked'); },
          release: () => { released++; } };
      } },
    } satisfies PublicAssetServingOptions;
    await expect(servePublicBulkChunk(request, session, options, prepareAhead)).rejects.toThrow('asset access revoked');
    expect(sent.filter(frame => frame.kind === K.META)).toHaveLength(32);
    expect(sent.some(frame => frame.index === 32 && (frame.kind === K.META || frame.kind === K.DATA))).toBe(false);
    expect(released).toBe(33);
  });
  it.each([false, true])('ends before crossing 100,000,000 encoded bytes, without splitting or inventing a committed asset', async prepareAhead => {
    const request: BulkGraphRequest = {version:1,contextGraphId:'boundary',snapshotDigest:'a'.repeat(64),
      assetUals:Array.from({length:26},(_,i)=>`did:dkg:base:84532/0x0000000000000000000000000000000000000001/${i+1}`)};
    const body=new Uint8Array(4*1024*1024), replies: BulkGraphFrame[]=[];
    let dataBytes=0, metaCount=0, nextCalls=0, end: BulkGraphFrame | undefined, releases=0;
    const session={signal:new AbortController().signal,
      next:async()=>{nextCalls++;const response=replies.shift();if(!response)throw new Error('Credit deadlock');return response;},
      send:async(frame:BulkGraphFrame)=>{
        if(frame.kind===K.DATA){expect(frame.payload.length).toBeLessThanOrEqual(65536);dataBytes+=frame.payload.length;}
        if(frame.kind===K.META)metaCount++;
        if(frame.kind===K.ASSET_END)replies.push(...[K.CREDIT,K.COMMIT].map(kind=>({kind,index:frame.index,sequence:body.length,payload:new Uint8Array()})));
        if(frame.kind===K.CHUNK_END)end=frame;
      }} satisfies Pick<BulkGraphSession, 'signal' | 'send' | 'next'>;
    const options={isPublicContextGraph:async()=>true,exportCache:{acquireEncoded:async()=>({body,identity:'fixture',
      metadata:new Uint8Array([1]),plainBytes:body.length,encodingDurationMs:0,wholePayloadExports:0,
      assertCurrent:async()=>{},release:()=>{releases++;}})}} satisfies PublicAssetServingOptions;
    await servePublicBulkChunk(request,session,options,prepareAhead);
    expect(metaCount).toBe(23);expect(dataBytes).toBe(23*body.length);expect(dataBytes).toBeLessThanOrEqual(BULK_GRAPH_CHUNK_BYTES);
    expect(nextCalls).toBe(46);expect(releases).toBe(24);
    expect(readBulkJson(end!.payload)).toMatchObject({assets:23,encodedBytes:dataBytes});
  });
  it.each([false, true])('refuses a forged durable acknowledgement that has no prior receipt credit', async prepareAhead => {
    const request: BulkGraphRequest={version:1,contextGraphId:'boundary',snapshotDigest:'a'.repeat(64),assetUals:['fixture']};
    const session={signal:new AbortController().signal,send:async()=>{},next:async()=>({kind:K.COMMIT,index:0,sequence:1,payload:new Uint8Array()})} satisfies Pick<BulkGraphSession, 'signal' | 'send' | 'next'>;
    const options={isPublicContextGraph:async()=>true,exportCache:{acquireEncoded:async()=>({identity:'fixture',wholePayloadExports:0,body:new Uint8Array([1]),
      metadata:new Uint8Array([1]),plainBytes:1,encodingDurationMs:0,assertCurrent:async()=>{},release:()=>{}})}} satisfies PublicAssetServingOptions;
    await expect(servePublicBulkChunk(request,session,options,prepareAhead)).rejects.toThrow('durable acknowledgement');
  });
});
