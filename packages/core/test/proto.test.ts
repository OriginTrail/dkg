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
