import { describe, it, expect } from 'vitest';
import {
  encodeVerifyProposal,
  decodeVerifyProposal,
  encodeVerifyApproval,
  decodeVerifyApproval,
  encodeStorageACK,
  decodeStorageACK,
  encodeGossipEnvelope,
  decodeGossipEnvelope,
  computeGossipSigningPayload,
  type VerifyProposalMsg,
  type VerifyApprovalMsg,
  type StorageACKMsg,
  type GossipEnvelopeMsg,
} from '../src/index.js';

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}

// ── VerifyProposal ────────────────────────────────────────────────────

describe('VerifyProposalMsg', () => {
  const proposal: VerifyProposalMsg = {
    proposalId: randomBytes(16),
    verifiedMemoryId: 7,
    batchId: 42,
    merkleRoot: randomBytes(32),
    entities: ['http://example.org/alice', 'http://example.org/bob'],
    agentSignatureR: randomBytes(32),
    agentSignatureVS: randomBytes(32),
    expiresAt: '2026-04-02T12:00:00Z',
    contextGraphId: 'cg-42',
  };

  it('encode → decode round-trip preserves all fields', () => {
    const encoded = encodeVerifyProposal(proposal);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBeGreaterThan(0);

    const decoded = decodeVerifyProposal(encoded);
    expect(new Uint8Array(decoded.proposalId)).toEqual(proposal.proposalId);
    expect(new Uint8Array(decoded.merkleRoot)).toEqual(proposal.merkleRoot);
    expect(decoded.entities).toEqual(proposal.entities);
    expect(decoded.expiresAt).toBe(proposal.expiresAt);
    expect(decoded.contextGraphId).toBe(proposal.contextGraphId);
    expect(new Uint8Array(decoded.agentSignatureR)).toEqual(proposal.agentSignatureR);
    expect(new Uint8Array(decoded.agentSignatureVS)).toEqual(proposal.agentSignatureVS);
    // The title claims "all fields"; the previous assertion set silently
    // skipped verifiedMemoryId and batchId, so a wire-tag drift or
    // field-drop on those two ints would land green. Pin them here so
    // the round-trip guarantee matches the name.
    // protobufjs decodes uint64 fields as a Long object; normalise
    // before comparing against the plain JS-number input values.
    expect(Number(decoded.verifiedMemoryId)).toBe(proposal.verifiedMemoryId);
    expect(Number(decoded.batchId)).toBe(proposal.batchId);
  });

  it('deterministic: same input produces same bytes', () => {
    const a = encodeVerifyProposal(proposal);
    const b = encodeVerifyProposal(proposal);
    expect(a).toEqual(b);
  });

  it('handles empty entities array', () => {
    const msg = { ...proposal, entities: [] };
    const decoded = decodeVerifyProposal(encodeVerifyProposal(msg));
    expect(decoded.entities).toEqual([]);
  });
});

// ── VerifyApproval ────────────────────────────────────────────────────

describe('VerifyApprovalMsg', () => {
  const approval: VerifyApprovalMsg = {
    proposalId: randomBytes(16),
    agentSignatureR: randomBytes(32),
    agentSignatureVS: randomBytes(32),
    approverAddress: '0xAbc123Def456',
  };

  it('encode → decode round-trip', () => {
    const encoded = encodeVerifyApproval(approval);
    const decoded = decodeVerifyApproval(encoded);
    expect(new Uint8Array(decoded.proposalId)).toEqual(approval.proposalId);
    expect(decoded.approverAddress).toBe(approval.approverAddress);
    expect(new Uint8Array(decoded.agentSignatureR)).toEqual(approval.agentSignatureR);
    expect(new Uint8Array(decoded.agentSignatureVS)).toEqual(approval.agentSignatureVS);
  });

  it('deterministic encoding', () => {
    expect(encodeVerifyApproval(approval)).toEqual(encodeVerifyApproval(approval));
  });
});

// ── StorageACK ────────────────────────────────────────────────────────

describe('StorageACKMsg', () => {
  const ack: StorageACKMsg = {
    merkleRoot: randomBytes(32),
    coreNodeSignatureR: randomBytes(32),
    coreNodeSignatureVS: randomBytes(32),
    contextGraphId: 'cg-100',
    nodeIdentityId: 5,
  };

  it('encode → decode round-trip', () => {
    const encoded = encodeStorageACK(ack);
    const decoded = decodeStorageACK(encoded);
    expect(new Uint8Array(decoded.merkleRoot)).toEqual(ack.merkleRoot);
    expect(new Uint8Array(decoded.coreNodeSignatureR)).toEqual(ack.coreNodeSignatureR);
    expect(new Uint8Array(decoded.coreNodeSignatureVS)).toEqual(ack.coreNodeSignatureVS);
    expect(decoded.contextGraphId).toBe(ack.contextGraphId);
    // `nodeIdentityId` distinguishes WHICH core node signed the ACK.
    // Dropping it silently would let the publisher count N junk ACKs
    // all attributed to node 0 as if they came from N distinct nodes
    // — a consensus-level false positive. Pin the round-trip.
    // Note: protobufjs decodes uint64 fields as a Long object by
    // default, so we normalise to Number before comparing against the
    // plain JS-number input.
    expect(Number(decoded.nodeIdentityId)).toBe(ack.nodeIdentityId);
  });

  it('deterministic encoding', () => {
    expect(encodeStorageACK(ack)).toEqual(encodeStorageACK(ack));
  });
});

// ── GossipEnvelope ────────────────────────────────────────────────────

describe('GossipEnvelopeMsg', () => {
  const envelope: GossipEnvelopeMsg = {
    version: '10.0.0',
    type: 'share-write',
    contextGraphId: 'cg-42',
    agentAddress: '0xAbc123',
    timestamp: '2026-04-02T12:00:00Z',
    signature: randomBytes(65),
    payload: new TextEncoder().encode('{"test":true}'),
  };

  it('encode → decode round-trip with nested payload', () => {
    const encoded = encodeGossipEnvelope(envelope);
    const decoded = decodeGossipEnvelope(encoded);
    expect(decoded.version).toBe('10.0.0');
    expect(decoded.type).toBe('share-write');
    expect(decoded.contextGraphId).toBe('cg-42');
    expect(decoded.agentAddress).toBe('0xAbc123');
    expect(decoded.timestamp).toBe('2026-04-02T12:00:00Z');
    expect(new Uint8Array(decoded.signature)).toEqual(envelope.signature);
    expect(new Uint8Array(decoded.payload)).toEqual(envelope.payload);
  });

  it('deterministic encoding', () => {
    expect(encodeGossipEnvelope(envelope)).toEqual(encodeGossipEnvelope(envelope));
  });

  it('handles empty payload', () => {
    const msg = { ...envelope, payload: new Uint8Array(0) };
    const decoded = decodeGossipEnvelope(encodeGossipEnvelope(msg));
    expect(decoded.payload).toHaveLength(0);
  });

  it('handles large payload', () => {
    const largePayload = randomBytes(10000);
    const msg = { ...envelope, payload: largePayload };
    const decoded = decodeGossipEnvelope(encodeGossipEnvelope(msg));
    expect(new Uint8Array(decoded.payload)).toEqual(largePayload);
  });
});

// ── computeGossipSigningPayload ───────────────────────────────────────

describe('computeGossipSigningPayload', () => {
  it('produces a deterministic payload', () => {
    const payload = new TextEncoder().encode('test');
    const a = computeGossipSigningPayload('share-write', 'cg-42', '2026-04-02T12:00:00Z', payload);
    const b = computeGossipSigningPayload('share-write', 'cg-42', '2026-04-02T12:00:00Z', payload);
    expect(a).toEqual(b);
  });

  it('different types produce different payloads', () => {
    const payload = new TextEncoder().encode('test');
    const a = computeGossipSigningPayload('share-write', 'cg-42', '2026-04-02T12:00:00Z', payload);
    const b = computeGossipSigningPayload('finalization', 'cg-42', '2026-04-02T12:00:00Z', payload);
    expect(a).not.toEqual(b);
  });

  it('different context graphs produce different payloads', () => {
    const payload = new TextEncoder().encode('test');
    const a = computeGossipSigningPayload('share-write', 'cg-1', '2026-04-02T12:00:00Z', payload);
    const b = computeGossipSigningPayload('share-write', 'cg-2', '2026-04-02T12:00:00Z', payload);
    expect(a).not.toEqual(b);
  });

  it('concatenates prefix with payload bytes', () => {
    const payload = new Uint8Array([0xde, 0xad]);
    const result = computeGossipSigningPayload('t', 'c', '1', payload);
    const prefix = new TextEncoder().encode('tc1');
    expect(result).toEqual(new Uint8Array([...prefix, 0xde, 0xad]));
  });
});

// ── Binary compatibility ──────────────────────────────────────────────

describe('binary compatibility', () => {
  it('messages with same content produce identical bytes', () => {
    const sig = new Uint8Array(32).fill(0xab);
    const root = new Uint8Array(32).fill(0xcd);

    const ack1: StorageACKMsg = {
      merkleRoot: root,
      coreNodeSignatureR: sig,
      coreNodeSignatureVS: sig,
      contextGraphId: 'cg-1',
      nodeIdentityId: 1,
    };
    const ack2: StorageACKMsg = { ...ack1 };

    expect(encodeStorageACK(ack1)).toEqual(encodeStorageACK(ack2));
  });

  it('messages with empty optional fields encode gracefully', () => {
    const proposal: VerifyProposalMsg = {
      proposalId: new Uint8Array(0),
      verifiedMemoryId: 0,
      batchId: 0,
      merkleRoot: new Uint8Array(0),
      entities: [],
      agentSignatureR: new Uint8Array(0),
      agentSignatureVS: new Uint8Array(0),
      expiresAt: '',
      contextGraphId: '',
    };
    const encoded = encodeVerifyProposal(proposal);
    const decoded = decodeVerifyProposal(encoded);
    expect(decoded.entities).toEqual([]);
    expect(decoded.contextGraphId).toBe('');
  });
});
