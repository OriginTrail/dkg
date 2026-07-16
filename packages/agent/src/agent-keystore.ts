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
  computeWorkspaceAgentEncryptionKeyRevocationPayload,
  decodeWorkspaceEncryptionKey,
  encodeWorkspaceEncryptionKey,
  generateWorkspaceRecipientEncryptionKey,
  workspaceAgentEncryptionKeyId,
} from '@origintrail-official/dkg-core';

/**
 * One workspace X25519 encryption key registered to a DKG agent.
 *
 * Each agent MAY hold multiple keys simultaneously. The wire format supports
 * encrypting to all live keys, so a daemon that only owns the private half of
 * one of them can still decrypt SWM gossip. Keys are retired via a wallet-signed
 * revocation (`revokedAt` + `revocationProof`); revoked entries stay in the
 * keystore so we can decrypt historical messages encrypted to them.
 */
export interface WorkspaceEncryptionKeyEntry {
  encryptionKeyAlgorithm: typeof WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519;
  encryptionKeyId: string;
  publicEncryptionKey: string;
  privateEncryptionKey?: string;
  encryptionKeyProof: string;
  createdAt: string;
  revokedAt?: string;
  revocationProof?: string;
}

/**
 * On-disk per-agent keystore record (v2 shape). v1 records lack
 * `workspaceEncryptionKeys` but still have the legacy singular fields, which the
 * loader folds into the array via {@link migrateLegacyWorkspaceEncryptionFields}.
 * The singular fields stay populated alongside the array on every write so that
 * a daemon binary rolled back to v1 can still read the default key.
 */
export interface KeystoreEntry {
  authToken?: string;
  privateKey?: string;
  workspaceEncryptionKeys?: WorkspaceEncryptionKeyEntry[];
  encryptionKeyAlgorithm?: typeof WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519;
  publicEncryptionKey?: string;
  privateEncryptionKey?: string;
  encryptionKeyProof?: string;
}

export interface AgentKeyRecord {
  agentAddress: string;
  publicKey: string;
  privateKey?: string;
  /**
   * Canonical store of all encryption keys this agent has ever registered.
   * Default-key views below (`publicEncryptionKey`, `privateEncryptionKey`,
   * `encryptionKeyProof`, `encryptionKeyId`, `encryptionKeyAlgorithm`) are
   * derived from the first **active** entry and refreshed whenever this list
   * is mutated. Treat the singular fields as a convenience read; treat
   * `workspaceEncryptionKeys` as the source of truth.
   */
  workspaceEncryptionKeys: WorkspaceEncryptionKeyEntry[];
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
  const record: AgentKeyRecord = {
    agentAddress: wallet.address,
    publicKey: wallet.signingKey.publicKey,
    privateKey: wallet.privateKey,
    workspaceEncryptionKeys: [],
    name,
    framework,
    mode: 'custodial',
    authToken: generateAgentToken(),
    createdAt: new Date().toISOString(),
  };
  mintCustodialWorkspaceEncryptionKey(record);
  return record;
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
    workspaceEncryptionKeys: [],
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
  const record: AgentKeyRecord = {
    agentAddress: wallet.address,
    publicKey: wallet.signingKey.publicKey,
    privateKey,
    workspaceEncryptionKeys: [],
    name,
    framework,
    mode: 'custodial',
    authToken: generateAgentToken(),
    createdAt: new Date().toISOString(),
  };
  mintCustodialWorkspaceEncryptionKey(record);
  return record;
}

/**
 * Ensure the record has at least one active workspace encryption key. Returns
 * `true` if a new key was minted (caller should re-persist + re-publish profile).
 */
export function ensureWorkspaceEncryptionKey(record: AgentKeyRecord): boolean {
  if (record.workspaceEncryptionKeys.some((entry) => !entry.revokedAt)) {
    refreshDefaultEncryptionKeyView(record);
    return false;
  }
  if (record.mode !== 'custodial' || !record.privateKey) {
    refreshDefaultEncryptionKeyView(record);
    return false;
  }
  mintCustodialWorkspaceEncryptionKey(record);
  return true;
}

/**
 * Mint a fresh workspace encryption keypair for a custodial agent and append
 * it (already wallet-signed) to `workspaceEncryptionKeys`. Returns the new
 * entry so callers can publish a new profile / emit triples for just this key.
 */
export function appendCustodialWorkspaceEncryptionKey(
  record: AgentKeyRecord,
): WorkspaceEncryptionKeyEntry {
  if (record.mode !== 'custodial' || !record.privateKey) {
    throw new Error(`Cannot mint encryption key for non-custodial agent ${record.agentAddress}`);
  }
  return mintCustodialWorkspaceEncryptionKey(record);
}

/**
 * Mark a specific encryption key as revoked. Requires the agent's wallet
 * private key (so it must be a custodial agent — self-sovereign callers sign
 * the revocation themselves and call {@link attachRevocationToWorkspaceEncryptionKey}).
 * Idempotent: if the key is already revoked, returns the existing entry without
 * re-signing.
 */
export function revokeCustodialWorkspaceEncryptionKey(
  record: AgentKeyRecord,
  keyId: string,
): WorkspaceEncryptionKeyEntry {
  if (record.mode !== 'custodial' || !record.privateKey) {
    throw new Error(`Cannot revoke encryption key on non-custodial agent ${record.agentAddress}`);
  }
  const entry = record.workspaceEncryptionKeys.find((k) => k.encryptionKeyId === keyId);
  if (!entry) {
    throw new Error(`Encryption key ${keyId} not found for agent ${record.agentAddress}`);
  }
  if (entry.revokedAt && entry.revocationProof) return entry;
  const revokedAt = new Date().toISOString();
  const publicKeyBytes = decodeWorkspaceEncryptionKey(entry.publicEncryptionKey);
  const payload = computeWorkspaceAgentEncryptionKeyRevocationPayload({
    agentAddress: ethers.getAddress(record.agentAddress),
    encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
    publicKeyBytes,
    revokedAt,
  });
  const wallet = new ethers.Wallet(record.privateKey);
  entry.revokedAt = revokedAt;
  entry.revocationProof = wallet.signingKey.sign(ethers.hashMessage(payload)).serialized;
  refreshDefaultEncryptionKeyView(record);
  return entry;
}

/**
 * Attach a pre-computed wallet-signed revocation to an existing entry (used by
 * self-sovereign agents whose wallet lives outside this node). Verifies the
 * proof against the agent's address before mutating the record.
 */
export function attachRevocationToWorkspaceEncryptionKey(
  record: AgentKeyRecord,
  keyId: string,
  revokedAt: string,
  revocationProof: string,
): WorkspaceEncryptionKeyEntry {
  const entry = record.workspaceEncryptionKeys.find((k) => k.encryptionKeyId === keyId);
  if (!entry) {
    throw new Error(`Encryption key ${keyId} not found for agent ${record.agentAddress}`);
  }
  const publicKeyBytes = decodeWorkspaceEncryptionKey(entry.publicEncryptionKey);
  const payload = computeWorkspaceAgentEncryptionKeyRevocationPayload({
    agentAddress: ethers.getAddress(record.agentAddress),
    encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
    publicKeyBytes,
    revokedAt,
  });
  const recovered = ethers.verifyMessage(payload, revocationProof);
  if (recovered.toLowerCase() !== record.agentAddress.toLowerCase()) {
    throw new Error(`Revocation proof for ${keyId} did not recover agent address ${record.agentAddress}`);
  }
  entry.revokedAt = revokedAt;
  entry.revocationProof = revocationProof;
  refreshDefaultEncryptionKeyView(record);
  return entry;
}

/**
 * Sign a fresh workspace encryption key with the agent's wallet and return the
 * components needed to store the proof on disk / on the registry. Kept as a
 * standalone helper for symmetry with {@link verifyWorkspaceEncryptionKeyBinding}
 * (callers in tests + the daemon use it).
 */
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

/**
 * Backfill `workspaceEncryptionKeys` from the legacy singular fields. Used by
 * the keystore v1->v2 migration in {@link DKGAgent.loadKeystore} and by tests
 * that hand-construct records from older fixtures. Idempotent and no-op when
 * the singular view is incomplete or already mirrored in the array.
 */
export function migrateLegacyWorkspaceEncryptionFields(record: AgentKeyRecord): void {
  if (!record.workspaceEncryptionKeys) {
    record.workspaceEncryptionKeys = [];
  }
  const algorithm = record.encryptionKeyAlgorithm;
  const publicEncryptionKey = record.publicEncryptionKey;
  const encryptionKeyProof = record.encryptionKeyProof;
  if (!algorithm || !publicEncryptionKey || !encryptionKeyProof) {
    refreshDefaultEncryptionKeyView(record);
    return;
  }
  let encryptionKeyId = record.encryptionKeyId;
  if (!encryptionKeyId) {
    try {
      encryptionKeyId = workspaceAgentEncryptionKeyId(
        ethers.getAddress(record.agentAddress),
        decodeWorkspaceEncryptionKey(publicEncryptionKey),
      );
    } catch {
      refreshDefaultEncryptionKeyView(record);
      return;
    }
  }
  if (record.workspaceEncryptionKeys.some((k) => k.encryptionKeyId === encryptionKeyId)) {
    refreshDefaultEncryptionKeyView(record);
    return;
  }
  record.workspaceEncryptionKeys.push({
    encryptionKeyAlgorithm: algorithm,
    encryptionKeyId,
    publicEncryptionKey,
    privateEncryptionKey: record.privateEncryptionKey,
    encryptionKeyProof,
    createdAt: record.createdAt || new Date().toISOString(),
  });
  refreshDefaultEncryptionKeyView(record);
}

/** All non-revoked encryption keys for this agent, oldest-first. */
export function activeWorkspaceEncryptionKeys(record: AgentKeyRecord): WorkspaceEncryptionKeyEntry[] {
  return record.workspaceEncryptionKeys.filter((k) => !k.revokedAt);
}

/**
 * Refresh the singular-field "default-key view" so existing call sites that
 * still read `record.publicEncryptionKey` etc see the first ACTIVE entry.
 * Always call this after appending, revoking, or re-loading the array.
 */
export function refreshDefaultEncryptionKeyView(record: AgentKeyRecord): void {
  const active = activeWorkspaceEncryptionKeys(record)[0];
  if (active) {
    record.encryptionKeyAlgorithm = active.encryptionKeyAlgorithm;
    record.publicEncryptionKey = active.publicEncryptionKey;
    record.privateEncryptionKey = active.privateEncryptionKey;
    record.encryptionKeyProof = active.encryptionKeyProof;
    record.encryptionKeyId = active.encryptionKeyId;
  } else {
    record.encryptionKeyAlgorithm = undefined;
    record.publicEncryptionKey = undefined;
    record.privateEncryptionKey = undefined;
    record.encryptionKeyProof = undefined;
    record.encryptionKeyId = undefined;
  }
}

function mintCustodialWorkspaceEncryptionKey(record: AgentKeyRecord): WorkspaceEncryptionKeyEntry {
  if (!record.privateKey) {
    throw new Error(`Cannot mint encryption key without a custodial wallet for agent ${record.agentAddress}`);
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
  const entry: WorkspaceEncryptionKeyEntry = {
    encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
    encryptionKeyId,
    publicEncryptionKey,
    privateEncryptionKey,
    encryptionKeyProof,
    createdAt: new Date().toISOString(),
  };
  record.workspaceEncryptionKeys.push(entry);
  refreshDefaultEncryptionKeyView(record);
  return entry;
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
  const encryptionKeyId = workspaceAgentEncryptionKeyId(record.agentAddress, publicKeyBytes);
  if (!record.workspaceEncryptionKeys.some((k) => k.encryptionKeyId === encryptionKeyId)) {
    record.workspaceEncryptionKeys.push({
      encryptionKeyAlgorithm: workspaceEncryption.encryptionKeyAlgorithm,
      encryptionKeyId,
      publicEncryptionKey: workspaceEncryption.publicEncryptionKey,
      encryptionKeyProof: workspaceEncryption.encryptionKeyProof,
      createdAt: new Date().toISOString(),
    });
  }
  refreshDefaultEncryptionKeyView(record);
}
