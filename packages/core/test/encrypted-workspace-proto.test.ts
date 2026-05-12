import { describe, expect, it } from 'vitest';
import {
  ENCRYPTED_WORKSPACE_AAD_DOMAIN,
  ENCRYPTED_WORKSPACE_CIPHER_ALGORITHM,
  ENCRYPTED_WORKSPACE_ENVELOPE_TYPE,
  ENCRYPTED_WORKSPACE_ENVELOPE_VERSION,
  ENCRYPTED_WORKSPACE_KEY_AGREEMENT_ALGORITHM,
  ENCRYPTED_WORKSPACE_KEY_WRAP_ALGORITHM,
  computeEncryptedWorkspaceAAD,
  decodeEncryptedWorkspacePayload,
  encodeEncryptedWorkspacePayload,
  timestampForAAD,
  type EncryptedWorkspacePayloadMsg,
} from '../src/index.js';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

const EPHEMERAL_PUBLIC_KEY = bytes(
  0, 1, 2, 3, 4, 5, 6, 7,
  8, 9, 10, 11, 12, 13, 14, 15,
  16, 17, 18, 19, 20, 21, 22, 23,
  24, 25, 26, 27, 28, 29, 30, 31,
);

describe('EncryptedWorkspacePayload', () => {
  const payload: EncryptedWorkspacePayloadMsg = {
    version: ENCRYPTED_WORKSPACE_ENVELOPE_VERSION,
    type: ENCRYPTED_WORKSPACE_ENVELOPE_TYPE,
    contextGraphId: 'cg-private',
    senderIdentity: 'did:dkg:agent:0x1234',
    operationId: 'op-1',
    workspaceOperationId: 'swm-op-1',
    timestampMs: 1_770_000_000_000,
    subGraphName: 'chat',
    cipherAlgorithm: ENCRYPTED_WORKSPACE_CIPHER_ALGORITHM,
    nonce: bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12),
    ciphertext: bytes(0xaa, 0xbb, 0xcc),
    keyAgreementAlgorithm: ENCRYPTED_WORKSPACE_KEY_AGREEMENT_ALGORITHM,
    ephemeralPublicKey: EPHEMERAL_PUBLIC_KEY,
    recipients: [
      {
        recipientId: 'did:dkg:agent:0xabcd',
        recipientKeyId: 'recipient-key-1',
        algorithm: ENCRYPTED_WORKSPACE_KEY_WRAP_ALGORITHM,
        nonce: bytes(12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1),
        encryptedKey: bytes(0x01, 0x02, 0x03),
      },
    ],
  };

  it('encodes and decodes the versioned encrypted workspace envelope', () => {
    const decoded = decodeEncryptedWorkspacePayload(encodeEncryptedWorkspacePayload(payload));

    expect(decoded.version).toBe(ENCRYPTED_WORKSPACE_ENVELOPE_VERSION);
    expect(decoded.type).toBe(ENCRYPTED_WORKSPACE_ENVELOPE_TYPE);
    expect(decoded.contextGraphId).toBe(payload.contextGraphId);
    expect(decoded.senderIdentity).toBe(payload.senderIdentity);
    expect(decoded.operationId).toBe(payload.operationId);
    expect(decoded.workspaceOperationId).toBe(payload.workspaceOperationId);
    expect(decoded.timestampMs).toBe(payload.timestampMs);
    expect(decoded.subGraphName).toBe(payload.subGraphName);
    expect(decoded.cipherAlgorithm).toBe(ENCRYPTED_WORKSPACE_CIPHER_ALGORITHM);
    expect(decoded.keyAgreementAlgorithm).toBe(ENCRYPTED_WORKSPACE_KEY_AGREEMENT_ALGORITHM);
    expect(new Uint8Array(decoded.ephemeralPublicKey)).toEqual(payload.ephemeralPublicKey);
    expect(new Uint8Array(decoded.nonce)).toEqual(payload.nonce);
    expect(new Uint8Array(decoded.ciphertext)).toEqual(payload.ciphertext);
    expect(decoded.recipients).toHaveLength(1);
    expect(decoded.recipients[0].recipientId).toBe(payload.recipients[0].recipientId);
    expect(decoded.recipients[0].recipientKeyId).toBe(payload.recipients[0].recipientKeyId);
    expect(decoded.recipients[0].algorithm).toBe(ENCRYPTED_WORKSPACE_KEY_WRAP_ALGORITHM);
    expect(new Uint8Array(decoded.recipients[0].nonce)).toEqual(payload.recipients[0].nonce);
    expect(new Uint8Array(decoded.recipients[0].encryptedKey)).toEqual(payload.recipients[0].encryptedKey);
  });

  it('keeps the encrypted payload schema nestable in the existing gossip envelope payload', () => {
    const encryptedBytes = encodeEncryptedWorkspacePayload(payload);
    const decoded = decodeEncryptedWorkspacePayload(encryptedBytes);

    expect(decoded.type).toBe(ENCRYPTED_WORKSPACE_ENVELOPE_TYPE);
    expect(new Uint8Array(decoded.ciphertext)).toEqual(payload.ciphertext);
  });
});

describe('computeEncryptedWorkspaceAAD', () => {
  const fields = {
    contextGraphId: 'cg-private',
    senderIdentity: 'did:dkg:agent:0x1234',
    operationId: 'op-1',
    workspaceOperationId: 'swm-op-1',
    timestampMs: 1_770_000_000_000,
    subGraphName: 'chat',
  };

  it('is deterministic and includes the AAD domain', () => {
    const aad = computeEncryptedWorkspaceAAD(fields);

    expect(aad).toEqual(computeEncryptedWorkspaceAAD(fields));
    expect(new TextDecoder().decode(aad)).toContain(ENCRYPTED_WORKSPACE_AAD_DOMAIN);
  });

  it('binds authentication to context graph, envelope constants, sender, operations, timestamp, and sub-graph', () => {
    const base = computeEncryptedWorkspaceAAD(fields);

    expect(computeEncryptedWorkspaceAAD({ ...fields, contextGraphId: 'cg-other' })).not.toEqual(base);
    expect(computeEncryptedWorkspaceAAD({ ...fields, version: '2' })).not.toEqual(base);
    expect(computeEncryptedWorkspaceAAD({ ...fields, type: 'other' })).not.toEqual(base);
    expect(computeEncryptedWorkspaceAAD({ ...fields, senderIdentity: 'did:dkg:agent:0xabcd' })).not.toEqual(base);
    expect(computeEncryptedWorkspaceAAD({ ...fields, operationId: 'op-2' })).not.toEqual(base);
    expect(computeEncryptedWorkspaceAAD({ ...fields, workspaceOperationId: 'swm-op-2' })).not.toEqual(base);
    expect(computeEncryptedWorkspaceAAD({ ...fields, timestampMs: fields.timestampMs + 1 })).not.toEqual(base);
    expect(computeEncryptedWorkspaceAAD({ ...fields, subGraphName: 'tasks' })).not.toEqual(base);
    expect(computeEncryptedWorkspaceAAD({
      ...fields,
      keyAgreementAlgorithm: ENCRYPTED_WORKSPACE_KEY_AGREEMENT_ALGORITHM,
    })).not.toEqual(base);
    expect(computeEncryptedWorkspaceAAD({
      ...fields,
      ephemeralPublicKey: EPHEMERAL_PUBLIC_KEY,
    })).not.toEqual(base);
  });

  it('normalises supported timestamp inputs for AAD', () => {
    expect(timestampForAAD(42)).toBe('42');
    expect(timestampForAAD(42n)).toBe('42');
    expect(timestampForAAD({ low: 42, high: 0, unsigned: true })).toBe('42');
    expect(() => timestampForAAD(-1)).toThrow('timestampMs must be a non-negative safe integer');
  });
});
