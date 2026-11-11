import { ethers } from 'ethers';
import type { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  SYSTEM_CONTEXT_GRAPHS,
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  computeWorkspaceAgentEncryptionKeyProofPayload,
  contextGraphDataUri,
  contextGraphMetaUri,
  encodeWorkspaceEncryptionKey,
  generateWorkspaceRecipientEncryptionKey,
  workspaceAgentEncryptionKeyId,
} from '@origintrail-official/dkg-core';

/** A context graph's agent gates and its agents' encryption keys, written as the recipient resolver reads them. */

export const CONTEXT_GRAPH_ID = 'workspace-agent-recipient-resolution';
export const DATA_GRAPH = contextGraphDataUri(CONTEXT_GRAPH_ID);
export const META_GRAPH = contextGraphMetaUri(CONTEXT_GRAPH_ID);
export const AGENTS_GRAPH = contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
export const DKG = 'https://dkg.network/ontology#';
export const DKG_PUBLIC_ENCRYPTION_KEY = `${DKG}publicEncryptionKey`;
export const DKG_ENCRYPTION_KEY_ALGORITHM = `${DKG}encryptionKeyAlgorithm`;
export const DKG_ENCRYPTION_KEY_PROOF = `${DKG}encryptionKeyProof`;

export function agentUri(address: string): string {
  return `did:dkg:agent:${ethers.getAddress(address)}`;
}

export async function insertAgentGate(
  store: OxigraphStore,
  predicate: string,
  address: string,
): Promise<void> {
  await store.insert([{
    subject: DATA_GRAPH,
    predicate,
    object: `"${address}"`,
    graph: META_GRAPH,
  }]);
}

export async function insertAgentEncryptionKey(
  store: OxigraphStore,
  wallet: ethers.Wallet,
  options: {
    algorithm?: string;
    proofWallet?: ethers.Wallet;
    omitAlgorithm?: boolean;
    omitProof?: boolean;
    keyFill?: number;
    subject?: string;
    graph?: string;
    peerId?: string;
  } = {},
): Promise<{ publicKeyBytes: Uint8Array; keyId: string }> {
  const recipientKey = generateWorkspaceRecipientEncryptionKey(
    agentUri(wallet.address),
    `${agentUri(wallet.address)}#test-x25519`,
    options.keyFill === undefined
      ? undefined
      : (length) => new Uint8Array(length).fill(options.keyFill),
  );
  const publicKeyBytes = recipientKey.publicKeyBytes!;
  const publicEncryptionKey = encodeWorkspaceEncryptionKey(publicKeyBytes);
  const proofSigner = options.proofWallet ?? wallet;
  const proofPayload = computeWorkspaceAgentEncryptionKeyProofPayload({
    agentAddress: wallet.address,
    encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
    publicKeyBytes,
  });
  const proof = proofSigner.signingKey.sign(ethers.hashMessage(proofPayload)).serialized;
  const subject = options.subject ?? agentUri(wallet.address);
  const graph = options.graph ?? 'did:dkg:system/agents';
  const quads = [{
    subject,
    predicate: DKG_PUBLIC_ENCRYPTION_KEY,
    object: `"${publicEncryptionKey}"`,
    graph,
  }];
  if (!options.omitAlgorithm) {
    quads.push({
      subject,
      predicate: DKG_ENCRYPTION_KEY_ALGORITHM,
      object: `"${options.algorithm ?? WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519}"`,
      graph,
    });
  }
  if (!options.omitProof) {
    quads.push({
      subject,
      predicate: DKG_ENCRYPTION_KEY_PROOF,
      object: `"${proof}"`,
      graph,
    });
  }
  if (options.peerId !== undefined) {
    quads.push({
      subject,
      predicate: `${DKG}peerId`,
      object: `"${options.peerId}"`,
      graph,
    });
  }
  await store.insert(quads);
  return {
    publicKeyBytes,
    keyId: workspaceAgentEncryptionKeyId(ethers.getAddress(wallet.address), publicKeyBytes),
  };
}
