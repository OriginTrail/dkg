import { describe, it, expect } from 'vitest';
import {
  encodePublishRequest,
  decodePublishRequest,
  encodePublishAck,
  decodePublishAck,
  encodeAccessRequest,
  decodeAccessRequest,
  encodeAccessResponse,
  decodeAccessResponse,
  encodeWorkspacePublishRequest,
  decodeWorkspacePublishRequest,
  encodeFinalizationMessage,
  decodeFinalizationMessage,
  encodeKAUpdateRequest,
  decodeKAUpdateRequest,
} from '../src/index.js';

describe('Protobuf: PublishRequest round-trip', () => {
  it('encodes and decodes correctly', () => {
    const original = {
      ual: 'did:dkg:base:8453/0xKCS/1',
      nquads: new TextEncoder().encode('<s> <p> <o> .'),
      paranetId: 'agent-registry',
      kas: [
        {
          tokenId: 1,
          rootEntity: 'did:dkg:agent:QmBot',
          privateMerkleRoot: new Uint8Array(32),
          privateTripleCount: 5,
        },
      ],
      publisherIdentity: new Uint8Array(32),
    };
    const encoded = encodePublishRequest(original);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBeGreaterThan(0);

    const decoded = decodePublishRequest(encoded);
    expect(decoded.ual).toBe(original.ual);
    expect(decoded.paranetId).toBe(original.paranetId);
    expect(decoded.kas).toHaveLength(1);
    expect(decoded.kas[0].rootEntity).toBe('did:dkg:agent:QmBot');
    expect(decoded.kas[0].privateTripleCount).toBe(5);
  });
});

describe('Protobuf: PublishAck round-trip', () => {
  it('encodes and decodes correctly', () => {
    const original = {
      merkleRoot: new Uint8Array(32).fill(0xab),
      identityId: 7,
      signatureR: new Uint8Array(32),
      signatureVs: new Uint8Array(32),
      accepted: true,
      rejectionReason: '',
    };
    const decoded = decodePublishAck(encodePublishAck(original));
    expect(decoded.accepted).toBe(true);
    expect(new Uint8Array(decoded.merkleRoot)).toEqual(original.merkleRoot);
  });
});

describe('Protobuf: AccessRequest round-trip', () => {
  it('encodes and decodes correctly', () => {
    const original = {
      kaUal: 'did:dkg:base:8453/0xKCS/1/1',
      requesterPeerId: 'QmRequester',
      paymentProof: new Uint8Array(64),
      requesterSignature: new Uint8Array(64),
    };
    const decoded = decodeAccessRequest(encodeAccessRequest(original));
    expect(decoded.kaUal).toBe(original.kaUal);
    expect(decoded.requesterPeerId).toBe('QmRequester');
  });

  it('round-trips requesterPublicKey', () => {
    const pubKey = new Uint8Array(32).fill(0xab);
    const original = {
      kaUal: 'did:dkg:base:8453/0xKCS/1/1',
      requesterPeerId: 'QmRequester',
      paymentProof: new Uint8Array(0),
      requesterSignature: new Uint8Array(64).fill(0xcd),
      requesterPublicKey: pubKey,
    };
    const encoded = encodeAccessRequest(original);
    const decoded = decodeAccessRequest(encoded);
    expect(decoded.requesterPublicKey).toBeDefined();
    expect(new Uint8Array(decoded.requesterPublicKey!)).toEqual(pubKey);
  });
});

describe('Protobuf: WorkspacePublishRequest round-trip', () => {
  it('encodes and decodes correctly', () => {
    const original = {
      paranetId: 'test-para',
      nquads: new TextEncoder().encode('<urn:entity> <http://purl.org/dc/terms/title> "Hello" .'),
      manifest: [{ rootEntity: 'urn:entity', privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWTest',
      workspaceOperationId: 'ws-123',
      timestampMs: Date.now(),
    };
    const encoded = encodeWorkspacePublishRequest(original);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBeGreaterThan(0);
    const decoded = decodeWorkspacePublishRequest(encoded);
    expect(decoded.paranetId).toBe(original.paranetId);
    expect(decoded.publisherPeerId).toBe(original.publisherPeerId);
    expect(decoded.workspaceOperationId).toBe(original.workspaceOperationId);
    expect(decoded.manifest).toHaveLength(1);
    expect(decoded.manifest[0].rootEntity).toBe('urn:entity');
  });
});

describe('Protobuf: AccessResponse round-trip', () => {
  it('encodes and decodes correctly', () => {
    const original = {
      granted: true,
      nquads: new TextEncoder().encode('<s> <p> "private" .'),
      privateMerkleRoot: new Uint8Array(32).fill(0xcc),
      rejectionReason: '',
    };
    const decoded = decodeAccessResponse(encodeAccessResponse(original));
    expect(decoded.granted).toBe(true);
    expect(new Uint8Array(decoded.privateMerkleRoot)).toEqual(
      original.privateMerkleRoot,
    );
  });
});

describe('Protobuf: FinalizationMessage round-trip', () => {
  it('encodes and decodes correctly', () => {
    const original = {
      ual: 'did:dkg:base:8453/0xKCS/42',
      paranetId: 'test-finalization',
      kcMerkleRoot: new Uint8Array(32).fill(0xab),
      txHash: '0x1234567890abcdef',
      blockNumber: 12345,
      batchId: 42,
      startKAId: 100,
      endKAId: 103,
      publisherAddress: '0x1111111111111111111111111111111111111111',
      rootEntities: ['http://example.org/entity/1', 'http://example.org/entity/2'],
      timestampMs: Date.now(),
    };
    const encoded = encodeFinalizationMessage(original);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBeGreaterThan(0);

    const decoded = decodeFinalizationMessage(encoded);
    expect(decoded.ual).toBe(original.ual);
    expect(decoded.paranetId).toBe(original.paranetId);
    expect(decoded.txHash).toBe(original.txHash);
    expect(decoded.publisherAddress).toBe(original.publisherAddress);
    expect(decoded.rootEntities).toEqual(original.rootEntities);
    expect(new Uint8Array(decoded.kcMerkleRoot)).toEqual(original.kcMerkleRoot);
  });

  it('handles empty rootEntities array', () => {
    const original = {
      ual: 'did:dkg:base:8453/0xKCS/1',
      paranetId: 'test',
      kcMerkleRoot: new Uint8Array(32),
      txHash: '0xabc',
      blockNumber: 1,
      batchId: 1,
      startKAId: 1,
      endKAId: 1,
      publisherAddress: '0x0',
      rootEntities: [],
      timestampMs: 1000,
    };
    const decoded = decodeFinalizationMessage(encodeFinalizationMessage(original));
    expect(decoded.rootEntities).toEqual([]);
  });
});

describe('Protobuf: operationId propagation round-trip', () => {
  const OP_ID = '550e8400-e29b-41d4-a716-446655440000';

  it('PublishRequest preserves operationId', () => {
    const original = {
      ual: 'did:dkg:base:8453/0xKCS/1',
      nquads: new TextEncoder().encode('<s> <p> <o> .'),
      paranetId: 'test',
      kas: [],
      publisherIdentity: new Uint8Array(32),
      publisherAddress: '0x0',
      startKAId: 0,
      endKAId: 0,
      chainId: 'test',
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
      operationId: OP_ID,
    };
    const decoded = decodePublishRequest(encodePublishRequest(original));
    expect(decoded.operationId).toBe(OP_ID);
  });

  it('PublishRequest without operationId decodes as empty string', () => {
    const original = {
      ual: 'did:dkg:base:8453/0xKCS/1',
      nquads: new TextEncoder().encode('<s> <p> <o> .'),
      paranetId: 'test',
      kas: [],
      publisherIdentity: new Uint8Array(32),
      publisherAddress: '0x0',
      startKAId: 0,
      endKAId: 0,
      chainId: 'test',
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
    };
    const decoded = decodePublishRequest(encodePublishRequest(original));
    expect(decoded.operationId).toBeFalsy();
  });

  it('WorkspacePublishRequest preserves operationId', () => {
    const original = {
      paranetId: 'test',
      nquads: new TextEncoder().encode('<s> <p> <o> .'),
      manifest: [],
      publisherPeerId: '12D3KooWTest',
      workspaceOperationId: 'ws-123',
      timestampMs: Date.now(),
      operationId: OP_ID,
    };
    const decoded = decodeWorkspacePublishRequest(encodeWorkspacePublishRequest(original));
    expect(decoded.operationId).toBe(OP_ID);
  });

  it('FinalizationMessage preserves operationId', () => {
    const original = {
      ual: 'did:dkg:base:8453/0xKCS/42',
      paranetId: 'test',
      kcMerkleRoot: new Uint8Array(32),
      txHash: '0xabc',
      blockNumber: 1,
      batchId: 1,
      startKAId: 1,
      endKAId: 1,
      publisherAddress: '0x0',
      rootEntities: ['http://example.org/e'],
      timestampMs: Date.now(),
      operationId: OP_ID,
    };
    const decoded = decodeFinalizationMessage(encodeFinalizationMessage(original));
    expect(decoded.operationId).toBe(OP_ID);
  });

  it('KAUpdateRequest preserves operationId', () => {
    const original = {
      paranetId: 'test',
      batchId: 1,
      nquads: new TextEncoder().encode('<s> <p> <o> .'),
      manifest: [{ rootEntity: 'urn:e', privateTripleCount: 0 }],
      publisherPeerId: 'peer1',
      publisherAddress: '0x0',
      txHash: '0xabc',
      blockNumber: 1,
      newMerkleRoot: new Uint8Array(32),
      timestampMs: Date.now(),
      operationId: OP_ID,
    };
    const decoded = decodeKAUpdateRequest(encodeKAUpdateRequest(original));
    expect(decoded.operationId).toBe(OP_ID);
  });
});
