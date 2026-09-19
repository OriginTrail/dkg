import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ethers } from 'ethers';
import {
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  encodeWorkspaceEncryptionKey, generateWorkspaceRecipientEncryptionKey,
  workspaceAgentEncryptionKeyId,
} from '@origintrail-official/dkg-core';
import { verifyWorkspaceEncryptionKeyBinding, type WorkspaceEncryptionKeyEntry } from './agent-keystore.js';

export interface EncryptionKeyEnrollment {
  version: 1;
  enrollmentId: string;
  agentAddress: string;
  targetPeerId: string;
  encryptionKeyAlgorithm: typeof WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519;
  encryptionKeyId: string;
  publicEncryptionKey: string;
  expiresAt: number;
}

/** Explicit consent to this node holding this encryption key; conveys no graph or signing rights. */
export function encryptionKeyEnrollmentPayload(enrollment: EncryptionKeyEnrollment): string {
  return JSON.stringify([
    'DKG-ENCRYPTION-KEY-CUSTODY-V1', enrollment.agentAddress.toLowerCase(),
    enrollment.targetPeerId, enrollment.enrollmentId, enrollment.encryptionKeyAlgorithm,
    enrollment.encryptionKeyId, enrollment.publicEncryptionKey, String(enrollment.expiresAt),
  ]);
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value, null, 2));
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

const writes = new Map<string, Promise<unknown>>();
export async function withPrivateFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = writes.get(path) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  writes.set(path, current);
  try { return await current; }
  finally { if (writes.get(path) === current) writes.delete(path); }
}

interface PendingEnrollment { challenge: EncryptionKeyEnrollment; privateEncryptionKey: string }

/** Pending keys survive restart but are never advertised or used until the agent signs both proofs. */
export class EncryptionKeyEnrollments {
  constructor(private readonly path: string, private readonly peerId: string, private readonly now = Date.now) {}

  private async read(): Promise<Record<string, PendingEnrollment>> {
    try { return JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  }

  async prepare(agentAddress: string): Promise<EncryptionKeyEnrollment> {
    return withPrivateFileLock(this.path, async () => {
      const pending = await this.read();
      for (const [id, entry] of Object.entries(pending)) {
        if (entry.challenge.expiresAt <= this.now()) delete pending[id];
      }
      if (Object.keys(pending).length >= 32) throw new Error('Too many pending encryption enrollments; retry after expiry');
      const address = ethers.getAddress(agentAddress);
      const key = generateWorkspaceRecipientEncryptionKey(`did:dkg:agent:${address}`, `did:dkg:agent:${address}#workspace-x25519`);
      const challenge: EncryptionKeyEnrollment = {
        version: 1, enrollmentId: randomBytes(24).toString('hex'), agentAddress: address,
        targetPeerId: this.peerId, encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
        encryptionKeyId: workspaceAgentEncryptionKeyId(address, key.publicKeyBytes!),
        publicEncryptionKey: encodeWorkspaceEncryptionKey(key.publicKeyBytes!), expiresAt: this.now() + 600_000,
      };
      pending[challenge.enrollmentId] = { challenge, privateEncryptionKey: encodeWorkspaceEncryptionKey(key.privateKeyBytes!) };
      await writePrivateJson(this.path, pending);
      return challenge;
    });
  }

  async activate<T>(input: { agentAddress: string; enrollmentId: string; encryptionKeyProof: string; custodyProof: string },
    persist: (publicKey: string, entry: WorkspaceEncryptionKeyEntry) => Promise<T>): Promise<T> {
    return withPrivateFileLock(this.path, async () => {
      const pending = await this.read();
      const entry = Object.hasOwn(pending, input.enrollmentId) ? pending[input.enrollmentId] : undefined;
      if (!entry) throw new Error('Unknown or already completed encryption enrollment');
      const { challenge } = entry;
      if (challenge.targetPeerId !== this.peerId || challenge.agentAddress.toLowerCase() !== input.agentAddress.toLowerCase()) {
        throw new Error('Encryption enrollment targets another node or agent');
      }
      if (challenge.expiresAt <= this.now()) throw new Error('Encryption enrollment expired; prepare a fresh enrollment');
      const publicKey = ethers.SigningKey.recoverPublicKey(ethers.hashMessage(encryptionKeyEnrollmentPayload(challenge)), input.custodyProof);
      if (ethers.computeAddress(publicKey).toLowerCase() !== challenge.agentAddress.toLowerCase()
        || !verifyWorkspaceEncryptionKeyBinding(challenge.agentAddress, challenge.encryptionKeyAlgorithm, challenge.publicEncryptionKey, input.encryptionKeyProof)) {
        throw new Error('Encryption enrollment requires valid agent signatures for custody and the public key');
      }
      const result = await persist(publicKey, {
        encryptionKeyAlgorithm: challenge.encryptionKeyAlgorithm, encryptionKeyId: challenge.encryptionKeyId,
        publicEncryptionKey: challenge.publicEncryptionKey, privateEncryptionKey: entry.privateEncryptionKey,
        encryptionKeyProof: input.encryptionKeyProof, createdAt: new Date(this.now()).toISOString(),
        custodyAuthorization: { enrollment: challenge, custodyProof: input.custodyProof },
      });
      // Failed persistence leaves the challenge retryable. The callback must never revive a revoked key.
      delete pending[input.enrollmentId];
      await writePrivateJson(this.path, pending);
      return result;
    });
  }
}
