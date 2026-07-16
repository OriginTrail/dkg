import { describe, expect, it } from 'vitest';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  TypedEventBus,
  createGraphKnowledgeAssetScope,
  decodePublishAck,
  encodePublishRequest,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { PublishHandler } from '../src/publish-handler.js';

const CONTEXT_GRAPH = '42';
const CHAIN_ID = 'otp:20430';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const KA_NUMBER = 7n;
const KA_ID = (BigInt(AUTHOR) << 96n) | KA_NUMBER;
const UAL = `did:dkg:${CHAIN_ID}/${AUTHOR}/${KA_NUMBER}`;
const SCOPE = createGraphKnowledgeAssetScope(UAL, 1);
const VM_GRAPH = knowledgeAssetLayerGraphUri(
  CONTEXT_GRAPH,
  MemoryLayer.VerifiableMemory,
  SCOPE,
);
const SWM_GRAPH = knowledgeAssetLayerGraphUri(
  CONTEXT_GRAPH,
  MemoryLayer.SharedWorkingMemory,
  SCOPE,
);
const PEER = { toString: () => '12D3KooWPublisher' };

function request(graph = VM_GRAPH): Uint8Array {
  return encodePublishRequest({
    ual: UAL,
    nquads: new TextEncoder().encode(
      `<urn:asset:subject> <urn:asset:predicate> "value" <${graph}> .`,
    ),
    contextGraphId: CONTEXT_GRAPH,
    kas: [],
    publisherIdentity: new Uint8Array(32),
    publisherAddress: AUTHOR,
    startKAId: KA_ID,
    endKAId: KA_ID,
    chainId: CHAIN_ID,
    publisherSignatureR: new Uint8Array(0),
    publisherSignatureVs: new Uint8Array(0),
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    assertionVersion: '1',
    publicTripleCount: 1,
    privateTripleCount: 0,
    accessPolicy: 'allowList',
    allowedPeers: ['12D3KooWReader'],
  });
}

describe('PublishHandler graph-scoped protocol', () => {
  it('stores one exact tentative VM graph, confirms it, and drops exact SWM', async () => {
    const store = new OxigraphStore();
    const handler = new PublishHandler(store, new TypedEventBus());

    const ack = decodePublishAck(await handler.handler(request(), PEER));

    expect(ack.accepted).toBe(true);
    expect(await store.countQuads(VM_GRAPH)).toBe(1);
    expect(await store.countQuads(`did:dkg:context-graph:${CONTEXT_GRAPH}`)).toBe(0);
    const metaGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`;
    const metadata = await store.query(
      `CONSTRUCT { <${UAL}> ?p ?o } WHERE { GRAPH <${metaGraph}> { <${UAL}> ?p ?o } }`,
    );
    expect(metadata.type).toBe('quads');
    if (metadata.type !== 'quads') throw new Error('expected graph-scoped metadata');
    expect(metadata.quads.some((quad) => quad.predicate.endsWith('rootEntity'))).toBe(false);
    expect(metadata.quads.some((quad) => quad.predicate.endsWith('tokenId'))).toBe(false);
    expect(metadata.quads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        predicate: 'http://dkg.io/ontology/accessPolicy',
        object: '"allowList"',
      }),
      expect.objectContaining({
        predicate: 'http://dkg.io/ontology/allowedPeer',
        object: '"12D3KooWReader"',
      }),
    ]));

    await store.insert([{
      subject: 'urn:asset:subject',
      predicate: 'urn:asset:predicate',
      object: '"value"',
      graph: SWM_GRAPH,
    }]);
    const confirmed = await handler.confirmPublish(UAL, {
      publisherAddress: AUTHOR,
      merkleRoot: new Uint8Array(ack.merkleRoot),
      startKAId: KA_ID,
      endKAId: KA_ID,
    });

    expect(confirmed).toBe(true);
    expect(await store.countQuads(SWM_GRAPH)).toBe(0);
    const status = await store.query(
      `SELECT ?status WHERE { GRAPH <${metaGraph}> { <${UAL}> <http://dkg.io/ontology/status> ?status } }`,
    );
    expect(status.type).toBe('bindings');
    expect(status.type === 'bindings' ? status.bindings[0]?.status : undefined).toBe('"confirmed"');

    const replayAck = decodePublishAck(await handler.handler(request(), PEER));
    expect(replayAck.accepted).toBe(false);
    expect(replayAck.rejectionReason).toContain('already confirmed');
    expect(await store.countQuads(VM_GRAPH)).toBe(1);
    const statusAfterReplay = await store.query(
      `SELECT ?status WHERE { GRAPH <${metaGraph}> { <${UAL}> <http://dkg.io/ontology/status> ?status } }`,
    );
    expect(statusAfterReplay.type).toBe('bindings');
    expect(statusAfterReplay.type === 'bindings'
      ? statusAfterReplay.bindings[0]?.status
      : undefined).toBe('"confirmed"');
  });

  it('rejects graph-scoped protocol data aimed at a forged graph', async () => {
    const store = new OxigraphStore();
    const handler = new PublishHandler(store, new TypedEventBus());

    const ack = decodePublishAck(await handler.handler(request('urn:forged:graph'), PEER));

    expect(ack.accepted).toBe(false);
    expect(ack.rejectionReason).toContain('UAL-derived VM graph');
    expect(await store.countQuads(VM_GRAPH)).toBe(0);
  });
});
