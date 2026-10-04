// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519, decodeWorkspaceEncryptionKey, workspaceAgentEncryptionKeyId } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { computeWorkspaceEncryptionKeysAttestationDigest, verifyAgentDelegation, type SignedAgentDelegation } from './auth/agent-delegation.js';
import { verifyWorkspaceEncryptionKeyBinding } from './agent-keystore.js';

const JOIN_ENCRYPTION_KEY_LIMIT = 8;

interface VerifiedJoinEncryptionKeyBundle {
  readonly issuedAtMs: number;
  readonly keySetDigest: string;
  readonly keys: NonNullable<SignedAgentDelegation['workspaceEncryptionKeys']>;
}

export function verifiedDelegationKeyIds(
  agentAddress: string,
  keys: VerifiedJoinEncryptionKeyBundle['keys'],
): Set<string> {
  return new Set(keys.map((key) => workspaceAgentEncryptionKeyId(
    agentAddress,
    decodeWorkspaceEncryptionKey(key.publicEncryptionKey),
  ).toLowerCase()));
}

export function verifyJoinEncryptionKeyBundle(
  delegation: SignedAgentDelegation,
  carrierPeerId: string,
): VerifiedJoinEncryptionKeyBundle | null {
  const keys = delegation.workspaceEncryptionKeys;
  if (keys === undefined) return null;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > JOIN_ENCRYPTION_KEY_LIMIT) {
    throw new Error(
      `Join request must carry between 1 and ${JOIN_ENCRYPTION_KEY_LIMIT} workspace encryption keys.`,
    );
  }
  // Preserve the existing admission contract for a signed carrier mismatch:
  // policy evaluation reports a bounded pending decision. Do not accept the
  // bundle because the carrier has not proven it is the signed delegatee.
  if (delegation.delegateePeerId !== carrierPeerId) return null;

  // issuedAtMs becomes the durable cross-CG cache high-water, so authenticate
  // the base delegation here as well as at the admission boundary.
  verifyAgentDelegation(delegation);
  if (!Number.isSafeInteger(delegation.issuedAtMs) || delegation.issuedAtMs < 0) {
    throw new Error('Join request carries an invalid encryption-key freshness timestamp.');
  }
  const verified = keys.map((key) => {
    if (
      key === null
      || typeof key !== 'object'
      || key.encryptionKeyAlgorithm !== WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519
      || typeof key.publicEncryptionKey !== 'string'
      || typeof key.encryptionKeyProof !== 'string'
    ) {
      throw new Error('Join request carries a malformed workspace encryption key.');
    }
    let valid = false;
    try {
      valid = verifyWorkspaceEncryptionKeyBinding(
        delegation.agentAddress,
        key.encryptionKeyAlgorithm,
        key.publicEncryptionKey,
        key.encryptionKeyProof,
      );
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new Error('Join request carries an invalid workspace encryption key proof.');
    }
    return key;
  });
  if (typeof delegation.workspaceEncryptionKeysSignature !== 'string') {
    throw new Error('Join request is missing its workspace encryption-key attestation.');
  }
  let attestationSigner = '';
  try {
    attestationSigner = ethers.verifyMessage(
      computeWorkspaceEncryptionKeysAttestationDigest(delegation),
      delegation.workspaceEncryptionKeysSignature,
    );
  } catch {
    attestationSigner = '';
  }
  if (attestationSigner.toLowerCase() !== delegation.agentAddress.toLowerCase()) {
    throw new Error('Join request carries an invalid workspace encryption-key attestation.');
  }

  const canonicalKeySet = [...new Set(verified.map((key) => JSON.stringify({
    encryptionKeyAlgorithm: key.encryptionKeyAlgorithm,
    publicEncryptionKey: key.publicEncryptionKey,
  })))].sort();
  return {
    issuedAtMs: delegation.issuedAtMs,
    keySetDigest: `0x${createHash('sha256').update(JSON.stringify(canonicalKeySet)).digest('hex')}`,
    keys: verified,
  };
}
