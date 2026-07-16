import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  WORKSPACE_AGENT_ENCRYPTION_KEY_PROOF_DOMAIN,
  WORKSPACE_AGENT_ENCRYPTION_KEY_REVOCATION_DOMAIN,
  computeWorkspaceAgentEncryptionKeyProofPayload,
  computeWorkspaceAgentEncryptionKeyRevocationPayload,
  generateWorkspaceRecipientEncryptionKey,
} from '../src/index.js';

const REVOKED_AT = '2026-05-17T12:34:56.000Z';
const TEST_ADDRESS_A = '0xCdba429ca35B458E83420B8FD101172fd8B7CFA5';
const TEST_ADDRESS_B = '0x1234567890aBcDef1234567890ABcDEf12345678';

function freshPubKey(fill: number): Uint8Array {
  const recipient = generateWorkspaceRecipientEncryptionKey(
    'did:dkg:agent:test',
    'did:dkg:agent:test#x25519',
    (length) => new Uint8Array(length).fill(fill),
  );
  return recipient.publicKeyBytes!;
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('computeWorkspaceAgentEncryptionKeyRevocationPayload', () => {
  it('is deterministic for the same fields', () => {
    const publicKeyBytes = freshPubKey(1);
    const a = computeWorkspaceAgentEncryptionKeyRevocationPayload({
      agentAddress: TEST_ADDRESS_A,
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes,
      revokedAt: REVOKED_AT,
    });
    const b = computeWorkspaceAgentEncryptionKeyRevocationPayload({
      agentAddress: TEST_ADDRESS_A,
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes,
      revokedAt: REVOKED_AT,
    });
    expect(digest(a)).toBe(digest(b));
  });

  it('folds agentAddress to lowercase so checksum/lowercase callers produce the same digest', () => {
    const publicKeyBytes = freshPubKey(2);
    const lower = computeWorkspaceAgentEncryptionKeyRevocationPayload({
      agentAddress: TEST_ADDRESS_A.toLowerCase(),
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes,
      revokedAt: REVOKED_AT,
    });
    const checksum = computeWorkspaceAgentEncryptionKeyRevocationPayload({
      agentAddress: TEST_ADDRESS_A,
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes,
      revokedAt: REVOKED_AT,
    });
    expect(digest(lower)).toBe(digest(checksum));
  });

  it('changes when any input field changes', () => {
    const publicKeyBytes = freshPubKey(3);
    const base = digest(computeWorkspaceAgentEncryptionKeyRevocationPayload({
      agentAddress: TEST_ADDRESS_A,
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes,
      revokedAt: REVOKED_AT,
    }));
    const differentTime = digest(computeWorkspaceAgentEncryptionKeyRevocationPayload({
      agentAddress: TEST_ADDRESS_A,
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes,
      revokedAt: '2026-05-18T00:00:00.000Z',
    }));
    const otherKey = digest(computeWorkspaceAgentEncryptionKeyRevocationPayload({
      agentAddress: TEST_ADDRESS_A,
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes: freshPubKey(4),
      revokedAt: REVOKED_AT,
    }));
    const otherAgent = digest(computeWorkspaceAgentEncryptionKeyRevocationPayload({
      agentAddress: TEST_ADDRESS_B,
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes,
      revokedAt: REVOKED_AT,
    }));

    const distinct = new Set([base, differentTime, otherKey, otherAgent]);
    expect(distinct.size).toBe(4);
  });

  it('is domain-separated from the registration proof payload', () => {
    // CRITICAL invariant: a signature produced over the registration payload
    // must NOT recover as a valid revocation (and vice versa). The wire
    // format encodes the domain string as the very first length-prefixed
    // field, so any digest produced over the two payloads differs at byte 0.
    expect(WORKSPACE_AGENT_ENCRYPTION_KEY_PROOF_DOMAIN).not.toBe(
      WORKSPACE_AGENT_ENCRYPTION_KEY_REVOCATION_DOMAIN,
    );

    const publicKeyBytes = freshPubKey(5);
    const registration = computeWorkspaceAgentEncryptionKeyProofPayload({
      agentAddress: TEST_ADDRESS_A,
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes,
    });
    const revocation = computeWorkspaceAgentEncryptionKeyRevocationPayload({
      agentAddress: TEST_ADDRESS_A,
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes,
      revokedAt: REVOKED_AT,
    });
    expect(digest(registration)).not.toBe(digest(revocation));
    expect(Buffer.from(registration).equals(Buffer.from(revocation))).toBe(false);
  });

  it('rejects unsupported algorithms', () => {
    expect(() =>
      computeWorkspaceAgentEncryptionKeyRevocationPayload({
        agentAddress: TEST_ADDRESS_A,
        // @ts-expect-error invalid algorithm
        encryptionKeyAlgorithm: 'P-256',
        publicKeyBytes: freshPubKey(6),
        revokedAt: REVOKED_AT,
      }),
    ).toThrow(/Unsupported workspace agent encryption key algorithm/);
  });

  it('rejects empty agentAddress, revokedAt, or wrong-length publicKey', () => {
    const publicKeyBytes = freshPubKey(7);
    expect(() =>
      computeWorkspaceAgentEncryptionKeyRevocationPayload({
        agentAddress: '',
        encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
        publicKeyBytes,
        revokedAt: REVOKED_AT,
      }),
    ).toThrow(/agentAddress is required/);

    expect(() =>
      computeWorkspaceAgentEncryptionKeyRevocationPayload({
        agentAddress: TEST_ADDRESS_A,
        encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
        publicKeyBytes: new Uint8Array(16),
        revokedAt: REVOKED_AT,
      }),
    ).toThrow(/publicEncryptionKey must be 32 bytes/);

    expect(() =>
      computeWorkspaceAgentEncryptionKeyRevocationPayload({
        agentAddress: TEST_ADDRESS_A,
        encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
        publicKeyBytes,
        revokedAt: '',
      }),
    ).toThrow(/revokedAt is required/);
  });
});
