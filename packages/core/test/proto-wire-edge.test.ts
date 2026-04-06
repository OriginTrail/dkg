/**
 * Wire codec coverage for discover / query / agent messages (03 §14–15) plus
 * malformed-input behavior for protobuf decoders.
 */
import { describe, it, expect } from 'vitest';
import {
  encodeDiscoverRequest,
  decodeDiscoverRequest,
  encodeDiscoverResponse,
  decodeDiscoverResponse,
  encodeQueryRequest,
  decodeQueryRequest,
  encodeQueryResponse,
  decodeQueryResponse,
  encodeAgentMessage,
  decodeAgentMessage,
  encodeKAUpdateRequest,
  decodeKAUpdateRequest,
} from '../src/index.js';

describe('Discover (wire round-trip)', () => {
  it('encodes and decodes DiscoverRequest', () => {
    const msg = {
      type: 'sparql',
      query: 'SELECT ?s WHERE { ?s ?p ?o }',
      paranetId: 'p1',
      limit: 100,
    };
    const decoded = decodeDiscoverRequest(encodeDiscoverRequest(msg));
    expect(decoded).toEqual(msg);
  });

  it('encodes and decodes DiscoverResponse', () => {
    const msg = {
      results: new TextEncoder().encode('[]'),
      count: 0,
      error: '',
    };
    const decoded = decodeDiscoverResponse(encodeDiscoverResponse(msg));
    expect(new Uint8Array(decoded.results)).toEqual(msg.results);
    expect(decoded.count).toBe(0);
    expect(decoded.error).toBe('');
  });
});

describe('Query (wire round-trip)', () => {
  it('encodes and decodes QueryRequest', () => {
    const msg = {
      sparql: 'ASK { ?s ?p ?o }',
      paranetId: 'ctx-1',
      timeout: 30_000,
    };
    const decoded = decodeQueryRequest(encodeQueryRequest(msg));
    expect(decoded).toEqual(msg);
  });

  it('encodes and decodes QueryResponse', () => {
    const msg = {
      nquads: new TextEncoder().encode('<s> <p> <o> .'),
      bindings: new Uint8Array(0),
      error: '',
    };
    const decoded = decodeQueryResponse(encodeQueryResponse(msg));
    expect(new Uint8Array(decoded.nquads)).toEqual(msg.nquads);
    expect(new Uint8Array(decoded.bindings)).toEqual(msg.bindings);
    expect(decoded.error).toBe('');
  });
});

describe('AgentMessage (wire round-trip)', () => {
  it('encodes and decodes AgentMessage with uint64 sequence', () => {
    const msg = {
      conversationId: 'conv-1',
      sequence: 42,
      senderPeerId: '12D3KooWSender',
      recipientPeerId: '12D3KooWRecv',
      encryptedPayload: new Uint8Array([1, 2, 3]),
      nonce: new Uint8Array(12).fill(0xab),
      senderSignature: new Uint8Array(64).fill(0xcd),
      senderPublicKey: new Uint8Array(32).fill(0xef),
    };
    const decoded = decodeAgentMessage(encodeAgentMessage(msg));
    expect(decoded.conversationId).toBe(msg.conversationId);
    expect(decoded.senderPeerId).toBe(msg.senderPeerId);
    expect(decoded.recipientPeerId).toBe(msg.recipientPeerId);
    expect(new Uint8Array(decoded.encryptedPayload)).toEqual(msg.encryptedPayload);
    expect(new Uint8Array(decoded.nonce)).toEqual(msg.nonce);
    expect(new Uint8Array(decoded.senderSignature)).toEqual(msg.senderSignature);
    expect(new Uint8Array(decoded.senderPublicKey)).toEqual(msg.senderPublicKey);
    const seq =
      typeof decoded.sequence === 'object' && decoded.sequence !== null && 'low' in decoded.sequence
        ? (decoded.sequence as { low: number }).low
        : Number(decoded.sequence);
    expect(seq).toBe(42);
  });
});

describe('KAUpdateRequest (full manifest round-trip)', () => {
  it('preserves manifest private fields', () => {
    const msg = {
      paranetId: 'para',
      batchId: 99n,
      nquads: new TextEncoder().encode('<a> <b> <c> .'),
      manifest: [
        {
          rootEntity: 'urn:root',
          privateMerkleRoot: new Uint8Array(32).fill(0x11),
          privateTripleCount: 3,
        },
      ],
      publisherPeerId: 'peer',
      publisherAddress: '0x' + 'aa'.repeat(20),
      txHash: '0xbb',
      blockNumber: 12_345n,
      newMerkleRoot: new Uint8Array(32).fill(0x22),
      timestampMs: 1_700_000_000_000n,
      operationId: 'op-full-ka',
    };
    const decoded = decodeKAUpdateRequest(encodeKAUpdateRequest(msg));
    expect(decoded.paranetId).toBe(msg.paranetId);
    expect(decoded.batchId).toBe(99n);
    expect(decoded.manifest).toHaveLength(1);
    expect(decoded.manifest[0].rootEntity).toBe('urn:root');
    expect(new Uint8Array(decoded.manifest[0].privateMerkleRoot!)).toEqual(msg.manifest[0].privateMerkleRoot);
    expect(decoded.manifest[0].privateTripleCount).toBe(3);
    expect(decoded.operationId).toBe('op-full-ka');
  });
});

describe('Malformed wire input (03 §14–15): decoders fail closed on corrupt protobuf', () => {
  it('decodeDiscoverRequest throws on truncated length-delimited field', () => {
    expect(() => decodeDiscoverRequest(new Uint8Array([0xff, 0xff, 0xff]))).toThrow();
  });

  it('decodeQueryResponse throws on invalid wire', () => {
    expect(() => decodeQueryResponse(new Uint8Array([0x0a, 0x80, 0x80, 0x80]))).toThrow();
  });

  it('decodeAgentMessage throws on invalid wire', () => {
    expect(() => decodeAgentMessage(new Uint8Array([0x12, 0x05, 0x01, 0x02]))).toThrow();
  });

  it('decodeKAUpdateRequest throws on truncated buffer', () => {
    expect(() => decodeKAUpdateRequest(new Uint8Array([0x0a, 0x03, 0x61, 0x62]))).toThrow();
  });

  it('empty buffer decodes to default empty message (callers must validate semantics)', () => {
    const d = decodeDiscoverRequest(new Uint8Array(0));
    expect(d.type).toBe('');
    expect(d.query).toBe('');
  });
});

describe('Schema isolation: wrong decoder rejects foreign bytes', () => {
  it('Discover bytes are not decodable as QueryRequest (throws)', () => {
    const discoverBytes = encodeDiscoverRequest({
      type: 't',
      query: 'q',
      paranetId: 'p',
      limit: 1,
    });
    // NOTE: Protobuf decoding is not a fully reliable schema-isolation boundary.
    // Foreign payloads can sometimes decode as garbage/defaults rather than throwing,
    // depending on field tag/type layout compatibility between schemas. This assertion
    // verifies the *current* behavior; if schemas evolve to become accidentally
    // compatible, this test may need a different approach (e.g., semantic validation).
    expect(() => decodeQueryRequest(discoverBytes)).toThrow();

    // Sanity: the same bytes round-trip correctly with the matching decoder
    const roundTrip = decodeDiscoverRequest(discoverBytes);
    expect(roundTrip.query).toBe('q');
  });
});
