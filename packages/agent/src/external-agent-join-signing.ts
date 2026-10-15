// SPDX-License-Identifier: Apache-2.0
/**
 * The signatures of a join request, for an agent whose key the node holds or
 * whose author key an external signer holds.
 *
 * A join request carries the agent's delegation to this node (EIP-191 over
 * `computeDelegationDigest`) and, binding its workspace encryption keys to
 * that delegation, an attestation (EIP-191 over
 * `computeWorkspaceEncryptionKeysAttestationDigest`). Both are signatures over
 * 32-byte digests, made by the agent's signer (`agentSigner`). An external
 * signer is first offered a method that carries what each digest commits to
 * (`dkg_signAgentDelegation`, `dkg_signJoinEncryptionKeys`), from which it can
 * check it and recompute the digest; only a signer without the method is asked
 * for the digest itself. A key on the node signs the digests.
 */
import { ethers } from 'ethers';
import { signMessageWithPreimage, type ExternalAuthorSigners } from '@origintrail-official/dkg-chain';
import {
  computeDelegationDigest,
  computeWorkspaceEncryptionKeysAttestationDigest,
  type AgentDelegationPayload,
  type SignedAgentDelegation,
} from './auth/agent-delegation.js';
import type { AgentKeyRecord } from './agent-keystore.js';
import { agentSigner } from './author-signer.js';

/** The optional external-signer method that signs an agent delegation from its fields. */
export const AGENT_DELEGATION_SIGNING_METHOD = 'dkg_signAgentDelegation';
/** The optional external-signer method that signs a join request's encryption-key bundle from its fields. */
export const JOIN_ENCRYPTION_KEYS_SIGNING_METHOD = 'dkg_signJoinEncryptionKeys';

type JoinEncryptionKeys = NonNullable<SignedAgentDelegation['workspaceEncryptionKeys']>;

/** The JSON text of the key bundle exactly as the attestation digest commits to it. */
function canonicalJoinEncryptionKeysJson(keys: JoinEncryptionKeys): string {
  return JSON.stringify([...keys]
    .map((key) => ({
      encryptionKeyAlgorithm: key.encryptionKeyAlgorithm,
      publicEncryptionKey: key.publicEncryptionKey,
      encryptionKeyProof: key.encryptionKeyProof,
    }))
    .sort((left, right) => {
      const leftJson = JSON.stringify(left);
      const rightJson = JSON.stringify(right);
      return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
    }));
}

/** `signature` over `digest`, refused unless it recovers to `agentAddress`. */
function recoveringTo(agentAddress: string, digest: Uint8Array, signature: string): string {
  if (ethers.verifyMessage(digest, signature).toLowerCase() !== agentAddress.toLowerCase()) {
    throw new Error(`The join request signature does not recover to agent ${agentAddress}`);
  }
  return signature;
}

/**
 * Sign a join request as `agent`: its delegation of `payload` and, when it
 * has workspace encryption keys, their attestation. The agent's key on the
 * node signs, else the external signer that holds the agent as an author key
 * (`authors`, never a payer).
 */
export async function signJoinDelegation(
  authors: ExternalAuthorSigners | undefined,
  agent: AgentKeyRecord,
  payload: AgentDelegationPayload,
  keys: JoinEncryptionKeys,
): Promise<SignedAgentDelegation> {
  if (!payload.scope || (!payload.delegateePeerId && !payload.delegateeOpKey)) {
    throw new Error('A join delegation needs a scope and at least one delegatee');
  }
  const signer = await agentSigner(authors, agent.agentAddress, agent.privateKey);
  if (signer === undefined) {
    throw new Error(`No private key for agent ${agent.agentAddress} — self-sovereign agents must sign externally`);
  }
  const delegationDigest = computeDelegationDigest(payload);
  const signature = recoveringTo(payload.agentAddress, delegationDigest, await signMessageWithPreimage(signer, {
    method: AGENT_DELEGATION_SIGNING_METHOD,
    preimage: {
      scope: payload.scope,
      agentAddress: payload.agentAddress.toLowerCase(),
      delegateePeerId: payload.delegateePeerId ?? '',
      delegateeOpKey: payload.delegateeOpKey ? payload.delegateeOpKey.toLowerCase() : '',
      issuedAtMs: Math.trunc(payload.issuedAtMs),
      expiresAtMs: Math.trunc(payload.expiresAtMs ?? 0),
    },
    message: delegationDigest,
  }));
  const delegation: SignedAgentDelegation = { ...payload, signature, ...(keys.length > 0 ? { workspaceEncryptionKeys: keys } : {}) };
  if (keys.length === 0) return delegation;
  const keysDigest = computeWorkspaceEncryptionKeysAttestationDigest(delegation);
  const workspaceEncryptionKeysSignature = recoveringTo(payload.agentAddress, keysDigest, await signMessageWithPreimage(signer, {
    method: JOIN_ENCRYPTION_KEYS_SIGNING_METHOD,
    preimage: {
      agentAddress: payload.agentAddress.toLowerCase(),
      delegateePeerId: payload.delegateePeerId ?? '',
      delegationSignature: signature.toLowerCase(),
      workspaceEncryptionKeys: canonicalJoinEncryptionKeysJson(keys),
    },
    message: keysDigest,
  }));
  return { ...delegation, workspaceEncryptionKeysSignature };
}
