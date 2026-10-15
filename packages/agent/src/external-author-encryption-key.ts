// SPDX-License-Identifier: Apache-2.0
/**
 * The workspace encryption key of an agent whose signing key an external
 * signer holds.
 *
 * Private shared memory is encrypted to X25519 keys that each agent binds to
 * itself with an EIP-191 signature by its own key over a framed,
 * domain-separated proof payload (`computeWorkspaceAgentEncryptionKeyProofPayload`).
 * Members encrypt to every agent of a private context graph, so an agent
 * without such a key keeps the graph from being shared into at all. For an
 * agent whose author key the external signer holds, the node generates and
 * keeps the X25519 key, as it does for an agent whose key it holds (the key
 * only decrypts the shared memory addressed to the agent and signs nothing),
 * and asks the signer to sign the proof payload itself (`eth_sign`). The
 * signer receives the whole payload, not a digest, so it can check its domain,
 * agent address, algorithm and public key before it signs.
 */
import { ethers } from 'ethers';
import type { ExternalAuthorSigners } from '@origintrail-official/dkg-chain';
import {
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  computeWorkspaceAgentEncryptionKeyProofPayload,
  createOperationContext,
  encodeWorkspaceEncryptionKey,
  generateWorkspaceRecipientEncryptionKey,
  workspaceAgentEncryptionKeyId,
  type Logger,
} from '@origintrail-official/dkg-core';
import {
  activeWorkspaceEncryptionKeys,
  ensureWorkspaceEncryptionKey,
  refreshDefaultEncryptionKeyView,
  verifyWorkspaceEncryptionKeyBinding,
  type AgentKeyRecord,
  type WorkspaceEncryptionKeyEntry,
} from './agent-keystore.js';
import { externalAuthorSignerFor } from './author-signer.js';

/**
 * Give `record` a node-held workspace encryption key bound by the external
 * signer, unless the node holds its key, it already has an active key, or the
 * external signer does not hold it as an author key (`authors`). Returns the
 * new key entry, if any.
 */
export async function provideExternalAuthorEncryptionKey(
  authors: ExternalAuthorSigners | undefined,
  record: AgentKeyRecord,
): Promise<WorkspaceEncryptionKeyEntry | undefined> {
  if (record.privateKey || activeWorkspaceEncryptionKeys(record).length > 0) return undefined;
  const signer = await externalAuthorSignerFor(authors, record.agentAddress);
  if (signer === undefined) return undefined;
  const agentAddress = ethers.getAddress(record.agentAddress);
  const key = generateWorkspaceRecipientEncryptionKey(
    `did:dkg:agent:${agentAddress}`,
    `did:dkg:agent:${agentAddress}#workspace-x25519`,
  );
  const publicKeyBytes = key.publicKeyBytes!;
  const publicEncryptionKey = encodeWorkspaceEncryptionKey(publicKeyBytes);
  const encryptionKeyProof = await signer.signMessage(computeWorkspaceAgentEncryptionKeyProofPayload({
    agentAddress,
    encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
    publicKeyBytes,
  }));
  if (!verifyWorkspaceEncryptionKeyBinding(
    agentAddress,
    WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
    publicEncryptionKey,
    encryptionKeyProof,
  )) {
    throw new Error(`The external signer did not bind the workspace encryption key to ${agentAddress}`);
  }
  const entry: WorkspaceEncryptionKeyEntry = {
    encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
    encryptionKeyId: workspaceAgentEncryptionKeyId(agentAddress, publicKeyBytes),
    publicEncryptionKey,
    privateEncryptionKey: encodeWorkspaceEncryptionKey(key.privateKeyBytes!),
    encryptionKeyProof,
    createdAt: new Date().toISOString(),
  };
  record.workspaceEncryptionKeys.push(entry);
  refreshDefaultEncryptionKeyView(record);
  return entry;
}

/**
 * {@link provideExternalAuthorEncryptionKey} without failing its caller: the
 * agent works without the key except in private context graphs, so a signer
 * that refuses the proof is logged and the agent is kept. Returns whether a
 * key was added.
 */
export async function tryProvideExternalAuthorEncryptionKey(
  authors: ExternalAuthorSigners | undefined,
  record: AgentKeyRecord,
  log: Pick<Logger, 'warn'>,
): Promise<boolean> {
  try {
    return (await provideExternalAuthorEncryptionKey(authors, record)) !== undefined;
  } catch (err) {
    log.warn(
      createOperationContext('system'),
      `No workspace encryption key for agent ${record.agentAddress}, so it cannot take part in private context graphs: `
        + `the external signer did not sign its key proof (${err instanceof Error ? err.message : String(err)})`,
    );
    return false;
  }
}

/**
 * Give an agent loaded from the store the workspace encryption key it lacks:
 * a custodial agent's, minted and signed on the node
 * (`ensureWorkspaceEncryptionKey`), else, for an agent the external signer
 * holds as an author key, a node-held key the signer binds. Returns whether a
 * key was added.
 */
export async function ensureAgentEncryptionKey(
  authors: ExternalAuthorSigners | undefined,
  record: AgentKeyRecord,
  log: Pick<Logger, 'warn'>,
): Promise<boolean> {
  return ensureWorkspaceEncryptionKey(record) || tryProvideExternalAuthorEncryptionKey(authors, record, log);
}
