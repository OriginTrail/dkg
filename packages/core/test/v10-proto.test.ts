import { describe, it, expect } from 'vitest';
import {
  encodeVerifyProposal,
  decodeVerifyProposal,
  encodeVerifyApproval,
  decodeVerifyApproval,
  encodeStorageACK,
  decodeStorageACK,
  encodeSwmShareAck,
  decodeSwmShareAck,
  encodeGossipEnvelope,
  decodeGossipEnvelope,
  computeGossipSigningPayload,
  computeGossipSigningPayloadV2,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
  GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED,
  encodePublishIntent,
  decodePublishIntent,
  ACK_PROTOCOL_VERSION_V1_LU5,
  ACK_PROTOCOL_VERSION_V2_LU11,
  PROTOCOL_STORAGE_ACK,
  PROTOCOL_STORAGE_ACK_V2,
  type VerifyProposalMsg,
  type VerifyApprovalMsg,
  type StorageACKMsg,
  type SwmShareAckMsg,
  type GossipEnvelopeMsg,
  type PublishIntentMsg,
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
    verifiableMemoryId: 7,
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
    // skipped verifiableMemoryId and batchId, so a wire-tag drift or
    // field-drop on those two ints would land green. Pin them here so
    // the round-trip guarantee matches the name.
    // protobufjs decodes uint64 fields as a Long object; normalise
    // before comparing against the plain JS-number input values.
    expect(Number(decoded.verifiableMemoryId)).toBe(proposal.verifiableMemoryId);
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

  it('decodes an old ACK (no decline fields) without populating declineCode', async () => {
    const decoded = decodeStorageACK(encodeStorageACK(ack));
    expect(decoded.declineCode == null || decoded.declineCode === '').toBe(true);
    expect(decoded.declineMessage == null || decoded.declineMessage === '').toBe(true);
    const { isStorageACKDecline } = await import('../src/proto/storage-ack.js');
    expect(isStorageACKDecline(decoded)).toBe(false);
  });

  it('decline-only message: empty ACK fields + populated decline code/message round-trip', async () => {
    const { STORAGE_ACK_DECLINE_CODES, isStorageACKDecline } = await import('../src/proto/storage-ack.js');
    const decline: StorageACKMsg = {
      merkleRoot: new Uint8Array(0),
      coreNodeSignatureR: new Uint8Array(0),
      coreNodeSignatureVS: new Uint8Array(0),
      contextGraphId: '15',
      nodeIdentityId: 0,
      declineCode: STORAGE_ACK_DECLINE_CODES.NO_DATA_IN_SWM,
      declineMessage:
        'No data found in SWM graph did:dkg:context-graph:15/_shared_memory for entities: urn:a, urn:b',
    };
    const decoded = decodeStorageACK(encodeStorageACK(decline));
    expect(decoded.declineCode).toBe('NO_DATA_IN_SWM');
    expect(decoded.declineMessage).toContain('No data found in SWM graph');
    expect(decoded.contextGraphId).toBe('15');
    expect(isStorageACKDecline(decoded)).toBe(true);
    expect(new Uint8Array(decoded.merkleRoot).length).toBe(0);
    expect(new Uint8Array(decoded.coreNodeSignatureR).length).toBe(0);
  });

  it('a new decoder reading bytes from an old encoder still yields a valid ACK (forward compat)', () => {
    // Literal pre-decline wire shape from the old 5-field schema:
    // 1=merkleRoot, 2=signatureR, 3=signatureVS, 4=contextGraphId,
    // 5=nodeIdentityId. Keeping this as bytes catches regressions where
    // the new schema stops decoding historical ACK payloads even though
    // the current encoder still omits unset decline fields.
    const wire = Uint8Array.from([
      0x0a, 0x20,
      ...new Array(32).fill(0xa5),
      0x12, 0x20,
      ...new Array(32).fill(0x11),
      0x1a, 0x20,
      ...new Array(32).fill(0x22),
      0x22, 0x06,
      0x63, 0x67, 0x2d, 0x31, 0x30, 0x30,
      0x28, 0x07,
    ]);
    const decoded = decodeStorageACK(wire);
    expect(decoded.contextGraphId).toBe('cg-100');
    expect(Number(decoded.nodeIdentityId)).toBe(7);
    expect(new Uint8Array(decoded.merkleRoot)).toEqual(new Uint8Array(32).fill(0xa5));
    expect(new Uint8Array(decoded.coreNodeSignatureR)).toEqual(new Uint8Array(32).fill(0x11));
    expect(new Uint8Array(decoded.coreNodeSignatureVS)).toEqual(new Uint8Array(32).fill(0x22));
    expect(decoded.declineCode == null || decoded.declineCode === '').toBe(true);
  });
});

// ── SwmShareAck (rc.9 PR-D) ───────────────────────────────────────────

describe('SwmShareAckMsg', () => {
  const ack: SwmShareAckMsg = {
    shareOperationId: 'op-01HXYZABCDEFGHJKMNPQRSTVWX',
    ackPeerId: '12D3KooWPeerAck',
  };

  it('encode → decode round-trip preserves both fields', () => {
    const encoded = encodeSwmShareAck(ack);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBeGreaterThan(0);

    const decoded = decodeSwmShareAck(encoded);
    expect(decoded.shareOperationId).toBe(ack.shareOperationId);
    expect(decoded.ackPeerId).toBe(ack.ackPeerId);
  });

  it('deterministic encoding', () => {
    expect(encodeSwmShareAck(ack)).toEqual(encodeSwmShareAck(ack));
  });

  it('handles long peerIds and operation IDs', () => {
    const long: SwmShareAckMsg = {
      shareOperationId: 'op-' + 'x'.repeat(200),
      ackPeerId: '12D3KooW' + 'y'.repeat(200),
    };
    const decoded = decodeSwmShareAck(encodeSwmShareAck(long));
    expect(decoded.shareOperationId).toBe(long.shareOperationId);
    expect(decoded.ackPeerId).toBe(long.ackPeerId);
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

  it('length-frames fields before payload bytes', () => {
    const payload = new Uint8Array([0xde, 0xad]);
    const result = computeGossipSigningPayload('t', 'c', '1', payload);
    expect(result).toEqual(new Uint8Array([
      0, 0, 0, 1, 0x74,
      0, 0, 0, 1, 0x63,
      0, 0, 0, 1, 0x31,
      0, 0, 0, 2, 0xde, 0xad,
    ]));
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
      verifiableMemoryId: 0,
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

// ── LU-11 / RFC-39 — chunked-commitment wire-format additions ──────────

describe('GossipEnvelope LU-11 — swmMessageIndex + chunked type discriminator', () => {
  const baseEnvelope: GossipEnvelopeMsg = {
    version: '10.0.0',
    type: GOSSIP_TYPE_WORKSPACE_PUBLISH,
    contextGraphId: 'cg-42',
    agentAddress: '0xAbc123',
    timestamp: '2026-04-02T12:00:00Z',
    signature: randomBytes(65),
    payload: new TextEncoder().encode('chunk-bytes'),
  };

  it('chunked vs legacy type marker are distinct strings', () => {
    expect(GOSSIP_TYPE_WORKSPACE_PUBLISH).toBe('share-write');
    expect(GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED).toBe('share-write-chunked');
  });

  it('legacy envelope round-trips with swmMessageIndex defaulting to proto3 zero', () => {
    // proto3 elides zero/absent fields on the wire and decoders return
    // the default (0 for uint32). That's WHY we can't use field-presence
    // as the V1-vs-V2 discriminator — `type` is the discriminator instead.
    const decoded = decodeGossipEnvelope(encodeGossipEnvelope(baseEnvelope));
    expect(decoded.type).toBe(GOSSIP_TYPE_WORKSPACE_PUBLISH);
    expect(decoded.swmMessageIndex ?? 0).toBe(0);
  });

  it('chunked envelope round-trips swmMessageIndex when present (including chunkId 0)', () => {
    for (const chunkId of [0, 1, 42]) {
      const decoded = decodeGossipEnvelope(
        encodeGossipEnvelope({
          ...baseEnvelope,
          type: GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED,
          swmMessageIndex: chunkId,
        }),
      );
      expect(decoded.type).toBe(GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED);
      expect(decoded.swmMessageIndex ?? 0).toBe(chunkId);
    }
  });

  it('LU-11 envelope keeps every original field bit-identical (additive proto3 extension)', () => {
    const encoded = encodeGossipEnvelope({
      ...baseEnvelope,
      type: GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED,
      swmMessageIndex: 7,
    });
    const decoded = decodeGossipEnvelope(encoded);
    expect(decoded.version).toBe(baseEnvelope.version);
    expect(decoded.contextGraphId).toBe(baseEnvelope.contextGraphId);
    expect(decoded.agentAddress).toBe(baseEnvelope.agentAddress);
    expect(decoded.timestamp).toBe(baseEnvelope.timestamp);
    expect(new Uint8Array(decoded.signature)).toEqual(baseEnvelope.signature);
    expect(new Uint8Array(decoded.payload)).toEqual(baseEnvelope.payload);
    expect(decoded.swmMessageIndex ?? 0).toBe(7);
  });
});

describe('computeGossipSigningPayloadV2 (LU-11)', () => {
  const payload = new TextEncoder().encode('chunk-bytes');

  it('produces a different signing payload from V1 (carries swmMessageIndex)', () => {
    const v1 = computeGossipSigningPayload('share-write', 'cg-42', '2026-04-02T12:00:00Z', payload);
    const v2 = computeGossipSigningPayloadV2('share-write', 'cg-42', '2026-04-02T12:00:00Z', payload, 0);
    expect(v1).not.toEqual(v2);
  });

  it('extends V1 by exactly one length-framed 4-byte big-endian uint32 field', () => {
    const v1 = computeGossipSigningPayload('t', 'c', '1', new Uint8Array([0xde, 0xad]));
    const v2 = computeGossipSigningPayloadV2('t', 'c', '1', new Uint8Array([0xde, 0xad]), 0);
    // V2 == V1 || [4-byte length-prefix == 4] || [4-byte BE uint32(0)]
    expect(v2.slice(0, v1.length)).toEqual(v1);
    expect(Array.from(v2.slice(v1.length))).toEqual([
      0, 0, 0, 4, // length prefix
      0, 0, 0, 0, // BE uint32(0)
    ]);
  });

  it('rotates with swmMessageIndex (changing the index changes the signing payload)', () => {
    const a = computeGossipSigningPayloadV2('share-write', 'cg-42', '2026-04-02T12:00:00Z', payload, 0);
    const b = computeGossipSigningPayloadV2('share-write', 'cg-42', '2026-04-02T12:00:00Z', payload, 1);
    expect(a).not.toEqual(b);
  });

  it('rejects negative or non-integer swmMessageIndex', () => {
    expect(() => computeGossipSigningPayloadV2('t', 'c', '1', payload, -1)).toThrow(/non-negative integer/);
    expect(() => computeGossipSigningPayloadV2('t', 'c', '1', payload, 1.5)).toThrow(/non-negative integer/);
  });
});

describe('PublishIntent — LU-11 fields (ciphertextChunksRoot, ciphertextChunkCount, ackProtocolVersion)', () => {
  function baseIntent(): PublishIntentMsg {
    return {
      merkleRoot: new Uint8Array(32).fill(0xab),
      contextGraphId: '42',
      publisherPeerId: '12D3KooWPublisher',
      publicByteSize: 1024,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:entity:root'],
    };
  }

  it('legacy v1 intent decodes with LU-11 fields at their proto3 zero defaults', () => {
    // proto3 elides missing scalars and bytes; decoders return defaults:
    // - bytes → empty Uint8Array (length 0)
    // - uint32 → 0
    // Receivers MUST treat `ackProtocolVersion < 2` as "V1 single-blob"
    // because field-presence isn't a reliable discriminator in proto3.
    const decoded = decodePublishIntent(encodePublishIntent(baseIntent()));
    expect(decoded.ciphertextChunksRoot?.length ?? 0).toBe(0);
    expect(decoded.ciphertextChunkCount ?? 0).toBe(0);
    expect(decoded.ackProtocolVersion ?? 0).toBe(0);
  });

  it('encode → decode round-trips the three LU-11 fields together', () => {
    const root = new Uint8Array(32).fill(0xcd);
    const intent: PublishIntentMsg = {
      ...baseIntent(),
      isEncryptedPayload: true,
      ciphertextChunksRoot: root,
      ciphertextChunkCount: 5,
      ackProtocolVersion: ACK_PROTOCOL_VERSION_V2_LU11,
    };
    const decoded = decodePublishIntent(encodePublishIntent(intent));
    expect(new Uint8Array(decoded.ciphertextChunksRoot!)).toEqual(root);
    expect(decoded.ciphertextChunkCount).toBe(5);
    expect(decoded.ackProtocolVersion).toBe(ACK_PROTOCOL_VERSION_V2_LU11);
    // Legacy fields still round-trip verbatim.
    expect(decoded.contextGraphId).toBe('42');
    expect(decoded.isEncryptedPayload).toBe(true);
    expect(decoded.kaCount).toBe(1);
  });

  it('OT-RFC-49: catalogRoot/catalogLeafCount (fields 18/19) round-trip and default to zero', () => {
    // Public-CG intents omit the catalog fields → proto3 zero defaults.
    const pub = decodePublishIntent(encodePublishIntent(baseIntent()));
    expect(pub.catalogRoot?.length ?? 0).toBe(0);
    expect(pub.catalogLeafCount ?? 0).toBe(0);

    // Curated intents carry the catalog commitment inline.
    const catalogRoot = new Uint8Array(32).fill(0x49);
    const curated: PublishIntentMsg = {
      ...baseIntent(),
      isEncryptedPayload: true,
      catalogRoot,
      catalogLeafCount: 3,
    };
    const decoded = decodePublishIntent(encodePublishIntent(curated));
    expect(new Uint8Array(decoded.catalogRoot!)).toEqual(catalogRoot);
    expect(decoded.catalogLeafCount).toBe(3);
    // Additive: the legacy LU-11 fields still decode at their zero defaults.
    expect(decoded.ciphertextChunkCount ?? 0).toBe(0);
  });

  it('folded-private privateMerkleRoots (field 20) round-trip and default empty', () => {
    const pub = decodePublishIntent(encodePublishIntent(baseIntent()));
    expect(pub.privateMerkleRoots ?? []).toHaveLength(0);

    const privateMerkleRoots = [
      new Uint8Array(32).fill(0x61),
      new Uint8Array(32).fill(0x62),
    ];
    const folded: PublishIntentMsg = {
      ...baseIntent(),
      isPrivate: true,
      privateMerkleRoots,
    };
    const decoded = decodePublishIntent(encodePublishIntent(folded));
    expect(decoded.privateMerkleRoots).toHaveLength(2);
    expect(new Uint8Array(decoded.privateMerkleRoots![0])).toEqual(privateMerkleRoots[0]);
    expect(new Uint8Array(decoded.privateMerkleRoots![1])).toEqual(privateMerkleRoots[1]);
  });

  it('ackProtocolVersion constants are stable wire values', () => {
    expect(ACK_PROTOCOL_VERSION_V1_LU5).toBe(1);
    expect(ACK_PROTOCOL_VERSION_V2_LU11).toBe(2);
  });

  it('PROTOCOL_STORAGE_ACK_V2 is a sibling of (not replacement for) V1', () => {
    expect(PROTOCOL_STORAGE_ACK).toBe('/dkg/10.0.1/storage-ack');
    expect(PROTOCOL_STORAGE_ACK_V2).toBe('/dkg/10.0.2/storage-ack');
    expect(PROTOCOL_STORAGE_ACK).not.toBe(PROTOCOL_STORAGE_ACK_V2);
  });
});
