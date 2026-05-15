/**
 * Agent keystore — secp256k1 key management for DKG agents.
 *
 * Each agent has a secp256k1 keypair. The Ethereum address derived from the
 * public key is the agent's identity at every protocol layer: Working Memory,
 * Shared Working Memory, PUBLISH, VERIFY, and Context Graph membership.
 *
 * Two modes:
 * - **Custodial**: node generates and stores the key. The private key is
 *   returned once at registration and kept encrypted at rest.
 * - **Self-sovereign**: agent provides its public key. The node never sees
 *   the private key.
 */

import { ethers } from 'ethers';
import { randomBytes, createHash } from 'node:crypto';
import {
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  computeWorkspaceAgentEncryptionKeyProofPayload,
  decodeWorkspaceEncryptionKey,
  encodeWorkspaceEncryptionKey,
  generateWorkspaceRecipientEncryptionKey,
  workspaceAgentEncryptionKeyId,
} from '@origintrail-official/dkg-core';

export interface AgentKeyRecord {
  agentAddress: string;
  publicKey: string;
  privateKey?: string;
  encryptionKeyAlgorithm?: typeof WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519;
  publicEncryptionKey?: string;
  privateEncryptionKey?: string;
  encryptionKeyProof?: string;
  encryptionKeyId?: string;
  name: string;
  framework?: string;
  mode: 'custodial' | 'self-sovereign';
  authToken: string;
  createdAt: string;
}

/**
 * Generate a per-agent Bearer token.
 * Prefix `dkg_at_` makes it distinguishable from node-level tokens.
 */
export function generateAgentToken(): string {
  return `dkg_at_${randomBytes(32).toString('base64url')}`;
}

/**
 * One-way SHA-256 hash of an agent token for safe persistence.
 * The raw token is returned to the caller once at registration;
 * only this hash is stored in the triple store so SPARQL queries
 * never reveal bearer credentials.
 */
export function hashAgentToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Generate a custodial agent keypair.
 * Returns the full key material (private key included).
 */
export function generateCustodialAgent(name: string, framework?: string): AgentKeyRecord {
  const wallet = ethers.Wallet.createRandom();
  return withWorkspaceEncryptionKey({
    agentAddress: wallet.address,
    publicKey: wallet.signingKey.publicKey,
    privateKey: wallet.privateKey,
    name,
    framework,
    mode: 'custodial',
    authToken: generateAgentToken(),
    createdAt: new Date().toISOString(),
  });
}

/**
 * Register a self-sovereign agent from a provided public key.
 * The node never has the private key.
 */
export function registerSelfSovereignAgent(
  name: string,
  publicKey: string,
  framework?: string,
  workspaceEncryption?: {
    encryptionKeyAlgorithm: typeof WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519;
    publicEncryptionKey: string;
    encryptionKeyProof: string;
  },
): AgentKeyRecord {
  const address = ethers.computeAddress(publicKey);
  const record: AgentKeyRecord = {
    agentAddress: address,
    publicKey,
    name,
    framework,
    mode: 'self-sovereign',
    authToken: generateAgentToken(),
    createdAt: new Date().toISOString(),
  };
  if (workspaceEncryption) {
    attachVerifiedWorkspaceEncryptionPublicKey(record, workspaceEncryption);
  }
  return record;
}

/**
 * Derive an agent identity from an existing EVM private key
 * (used for backward-compatible auto-registration of the default "owner" agent
 * from the node's first operational wallet).
 */
export function agentFromPrivateKey(
  privateKey: string,
  name: string,
  framework?: string,
): AgentKeyRecord {
  const wallet = new ethers.Wallet(privateKey);
  return withWorkspaceEncryptionKey({
    agentAddress: wallet.address,
    publicKey: wallet.signingKey.publicKey,
    privateKey,
    name,
    framework,
    mode: 'custodial',
    authToken: generateAgentToken(),
    createdAt: new Date().toISOString(),
  });
}

export function ensureWorkspaceEncryptionKey(record: AgentKeyRecord): boolean {
  if (record.privateEncryptionKey && record.publicEncryptionKey && record.encryptionKeyProof) {
    return false;
  }
  if (!record.privateKey) {
    return false;
  }
  withWorkspaceEncryptionKey(record);
  return true;
}

export function signWorkspaceEncryptionKey(
  agentAddress: string,
  privateKey: string,
  publicEncryptionKey: string,
): { encryptionKeyProof: string; encryptionKeyId: string } {
  const publicKeyBytes = decodeWorkspaceEncryptionKey(publicEncryptionKey);
  const payload = computeWorkspaceAgentEncryptionKeyProofPayload({
    agentAddress: ethers.getAddress(agentAddress),
    encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
    publicKeyBytes,
  });
  const wallet = new ethers.Wallet(privateKey);
  const proof = wallet.signingKey.sign(ethers.hashMessage(payload)).serialized;
  return {
    encryptionKeyProof: proof,
    encryptionKeyId: workspaceAgentEncryptionKeyId(ethers.getAddress(agentAddress), publicKeyBytes),
  };
}

export function verifyWorkspaceEncryptionKeyBinding(
  agentAddress: string,
  encryptionKeyAlgorithm: string,
  publicEncryptionKey: string,
  encryptionKeyProof: string,
): boolean {
  if (encryptionKeyAlgorithm !== WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519) {
    return false;
  }
  const checksum = ethers.getAddress(agentAddress);
  const publicKeyBytes = decodeWorkspaceEncryptionKey(publicEncryptionKey);
  const payload = computeWorkspaceAgentEncryptionKeyProofPayload({
    agentAddress: checksum,
    encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
    publicKeyBytes,
  });
  const recovered = ethers.verifyMessage(payload, encryptionKeyProof);
  return recovered.toLowerCase() === checksum.toLowerCase();
}

function withWorkspaceEncryptionKey(record: AgentKeyRecord): AgentKeyRecord {
  if (!record.privateKey) {
    return record;
  }
  const recipientKey = generateWorkspaceRecipientEncryptionKey(
    `did:dkg:agent:${record.agentAddress}`,
    `did:dkg:agent:${record.agentAddress}#workspace-x25519`,
  );
  const publicEncryptionKey = encodeWorkspaceEncryptionKey(recipientKey.publicKeyBytes!);
  const privateEncryptionKey = encodeWorkspaceEncryptionKey(recipientKey.privateKeyBytes!);
  const { encryptionKeyProof, encryptionKeyId } = signWorkspaceEncryptionKey(
    record.agentAddress,
    record.privateKey,
    publicEncryptionKey,
  );
  record.encryptionKeyAlgorithm = WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519;
  record.publicEncryptionKey = publicEncryptionKey;
  record.privateEncryptionKey = privateEncryptionKey;
  record.encryptionKeyProof = encryptionKeyProof;
  record.encryptionKeyId = encryptionKeyId;
  return record;
}

function attachVerifiedWorkspaceEncryptionPublicKey(
  record: AgentKeyRecord,
  workspaceEncryption: {
    encryptionKeyAlgorithm: typeof WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519;
    publicEncryptionKey: string;
    encryptionKeyProof: string;
  },
): void {
  if (!verifyWorkspaceEncryptionKeyBinding(
    record.agentAddress,
    workspaceEncryption.encryptionKeyAlgorithm,
    workspaceEncryption.publicEncryptionKey,
    workspaceEncryption.encryptionKeyProof,
  )) {
    throw new Error(`Invalid workspace encryption key proof for agent ${record.agentAddress}`);
  }
  const publicKeyBytes = decodeWorkspaceEncryptionKey(workspaceEncryption.publicEncryptionKey);
  record.encryptionKeyAlgorithm = workspaceEncryption.encryptionKeyAlgorithm;
  record.publicEncryptionKey = workspaceEncryption.publicEncryptionKey;
  record.encryptionKeyProof = workspaceEncryption.encryptionKeyProof;
  record.encryptionKeyId = workspaceAgentEncryptionKeyId(record.agentAddress, publicKeyBytes);
}
