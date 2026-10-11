// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import {
  DKG_ONTOLOGY,
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  computeWorkspaceAgentEncryptionKeyProofPayload,
  encodeWorkspaceEncryptionKey,
  generateWorkspaceRecipientEncryptionKey,
  workspaceAgentEncryptionKeyId,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';

// Signed recipient keys and the shared constants of the accepted-private authority tests.
export const CONTEXT_GRAPH_ID = '0x1111111111111111111111111111111111111111/accepted-private';
export const PROFILE_GRAPH = 'did:dkg:context-graph:agents';

export function signedKeyFixture(wallet: ethers.HDNodeWallet, peerId?: string): {
  quads: Quad[];
  publicKeyBytes: Uint8Array;
  recipientKeyId: string;
} {
  const agentUri = `did:dkg:agent:${ethers.getAddress(wallet.address)}`;
  const key = generateWorkspaceRecipientEncryptionKey(
    agentUri,
    `${agentUri}#accepted-private-x25519`,
  );
  const publicKeyBytes = key.publicKeyBytes!;
  const proof = wallet.signingKey.sign(ethers.hashMessage(
    computeWorkspaceAgentEncryptionKeyProofPayload({
      agentAddress: wallet.address,
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes,
    }),
  )).serialized;
  return {
    publicKeyBytes,
    recipientKeyId: workspaceAgentEncryptionKeyId(wallet.address, publicKeyBytes),
    quads: [
      {
        subject: agentUri,
        predicate: DKG_ONTOLOGY.DKG_PUBLIC_ENCRYPTION_KEY,
        object: `"${encodeWorkspaceEncryptionKey(publicKeyBytes)}"`,
        graph: PROFILE_GRAPH,
      },
      {
        subject: agentUri,
        predicate: DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_ALGORITHM,
        object: `"${WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519}"`,
        graph: PROFILE_GRAPH,
      },
      {
        subject: agentUri,
        predicate: DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_PROOF,
        object: `"${proof}"`,
        graph: PROFILE_GRAPH,
      },
      ...(peerId === undefined ? [] : [{
        subject: agentUri,
        predicate: DKG_ONTOLOGY.DKG_PEER_ID,
        object: `"${peerId}"`,
        graph: PROFILE_GRAPH,
      }]),
    ],
  };
}

export function signedKeyQuads(wallet: ethers.HDNodeWallet, peerId?: string): Quad[] {
  return signedKeyFixture(wallet, peerId).quads;
}

export const TRANSPORT_CHANGED = {
  reason: 'chain-participant-authority-unavailable',
  detail: 'retry recipient resolution against the current private authority',
  site: 'transport-changed',
};
/** The resolved (agent, key, peer) set differed after a revision moved. */
export const ROUTES_CHANGED = {
  reason: 'chain-participant-authority-unavailable',
  detail: 'recipient routes changed while retrying against current private authority',
  site: 'recipient-set-changed',
};

export const JOIN_KEY_CACHE_GRAPH = 'urn:dkg:local:join-encryption-key-cache';
