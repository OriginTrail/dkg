import { describe, expect, it } from 'vitest';
import { BULK_GRAPH_KIND as K, BULK_GRAPH_CHUNK_BYTES, type BulkGraphFrame, type BulkGraphSession } from '@origintrail-official/dkg-core';
import { servePublicBulkChunk } from '../src/sync/responder/bulk-graph-stream.js';
import { readBulkJson, type BulkGraphRequest } from '../src/sync/bulk-graph-contract.js';
import type { ExactBatchResponderBindingOptions } from '../src/sync/responder/exact-batch-stream.js';

describe('100 MB encoded envelope and bounded credits', () => {
  it('rechecks public authority after a staging-credit wait before exposing the next asset', async () => {
    let publicGraph = true, sent = 0, released = 0;
    const request: BulkGraphRequest = { version: 1, contextGraphId: 'boundary', snapshotDigest: 'a'.repeat(64),
      assetUals: Array.from({ length: 34 }, (_, i) => `fixture-${i}`) };
    const session = { signal: new AbortController().signal,
      send: async (frame: BulkGraphFrame) => { if (frame.kind === K.META) sent++; },
      next: async () => { publicGraph = false; return { kind: K.CREDIT, index: 0, sequence: 1, payload: new Uint8Array() }; },
    } as unknown as BulkGraphSession;
    const options = { isPublicContextGraph: async () => publicGraph,
      exportCache: { acquireEncoded: async () => ({ body: new Uint8Array([1]), metadata: new Uint8Array([1]),
        plainBytes: 1, encodingDurationMs: 0, assertCurrent: async () => {}, release: () => { released++; } }) },
    } as unknown as ExactBatchResponderBindingOptions;
    await expect(servePublicBulkChunk(request, session, options)).rejects.toThrow('public authority changed');
    expect(sent).toBe(32); expect(released).toBe(33);
  });
  it('rechecks asset access after CREDIT while the context graph remains public', async () => {
    let revoked = false, acquired = 0, released = 0;
    const sent: BulkGraphFrame[] = [];
    const request: BulkGraphRequest = { version: 1, contextGraphId: 'boundary', snapshotDigest: 'a'.repeat(64),
      assetUals: Array.from({ length: 34 }, (_, i) => `fixture-${i}`) };
    const session = { signal: new AbortController().signal,
      send: async (frame: BulkGraphFrame) => { sent.push(frame); },
      next: async () => { revoked = true; return { kind: K.CREDIT, index: 0, sequence: 1, payload: new Uint8Array() }; },
    } as unknown as BulkGraphSession;
    const options = { isPublicContextGraph: async () => true,
      exportCache: { acquireEncoded: async () => {
        const index = acquired++;
        return { body: new Uint8Array([1]), metadata: new Uint8Array([1]), plainBytes: 1,
          assertCurrent: async () => { if (index === 32 && revoked) throw new Error('asset access revoked'); },
          release: () => { released++; } };
      } },
    } as unknown as ExactBatchResponderBindingOptions;
    await expect(servePublicBulkChunk(request, session, options)).rejects.toThrow('asset access revoked');
    expect(sent.filter(frame => frame.kind === K.META)).toHaveLength(32);
    expect(sent.some(frame => frame.index === 32 && [K.META, K.DATA].includes(frame.kind))).toBe(false);
    expect(released).toBe(33);
  });
  it('ends before crossing 100,000,000 encoded bytes, without splitting or inventing a committed asset', async () => {
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
      }} as unknown as BulkGraphSession;
    const options={isPublicContextGraph:async()=>true,exportCache:{acquireEncoded:async()=>({body,
      metadata:new Uint8Array([1]),plainBytes:body.length,encodingDurationMs:0,wholePayloadExports:0,
      assertCurrent:async()=>{},release:()=>{releases++;}})}} as unknown as ExactBatchResponderBindingOptions;
    await servePublicBulkChunk(request,session,options);
    expect(metaCount).toBe(23);expect(dataBytes).toBe(23*body.length);expect(dataBytes).toBeLessThanOrEqual(BULK_GRAPH_CHUNK_BYTES);
    expect(nextCalls).toBe(46);expect(releases).toBe(24);
    expect(readBulkJson(end!.payload)).toMatchObject({assets:23,encodedBytes:dataBytes});
  });
  it('refuses a forged durable acknowledgement that has no prior receipt credit', async () => {
    const request: BulkGraphRequest={version:1,contextGraphId:'boundary',snapshotDigest:'a'.repeat(64),assetUals:['fixture']};
    const session={signal:new AbortController().signal,send:async()=>{},next:async()=>({kind:K.COMMIT,index:0,sequence:1,payload:new Uint8Array()})} as unknown as BulkGraphSession;
    const options={isPublicContextGraph:async()=>true,exportCache:{acquireEncoded:async()=>({body:new Uint8Array([1]),
      metadata:new Uint8Array([1]),plainBytes:1,encodingDurationMs:0,assertCurrent:async()=>{},release:()=>{}})}} as unknown as ExactBatchResponderBindingOptions;
    await expect(servePublicBulkChunk(request,session,options)).rejects.toThrow('durable acknowledgement');
  });
});
