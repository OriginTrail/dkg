// SPDX-License-Identifier: Apache-2.0
/**
 * A context graph curated by an author key of the node's external signer.
 *
 * Author keys only sign author attestations and never sign a transaction, so
 * such a curator can never be the signer of the graph's on-chain registration.
 * A PCA-backed curated graph is then registered by the payer that signs for the
 * node, which must still be the PCA owner or a registered agent of that exact
 * PCA, and that payer owns the Context Graph NFT. The author key stays the
 * local curator and is added as a participant agent (locally and in the
 * registration's `participantAgents`), as the EOA auto-promotion in
 * `registerContextGraph` does for a curator that is not the chain signer.
 */
import { ethers } from 'ethers';
import { DKG_ONTOLOGY, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import type { ChainAdapter, EvmSigner, ExternalAuthorSigners } from '@origintrail-official/dkg-chain';
import { MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS } from './dkg-agent-constants.js';
import type { DKGAgent } from './dkg-agent.js';
import { externalAuthorSignerFor, signsThroughExternalSigner } from './external-author-signing.js';

interface ExternalSignerConfig {
  readonly chainConfig?: {
    readonly signers?: readonly EvmSigner[];
    readonly authors?: ExternalAuthorSigners;
  };
}

/**
 * Whether the node signs through an external signer and `curator`, which is
 * not the registration signer, is one of that signer's author keys.
 */
export async function isExternalAuthorCurator(
  config: ExternalSignerConfig | undefined,
  chain: Pick<ChainAdapter, 'usesExternalSigner'> | undefined,
  curator: string,
  registrationSigner: string,
): Promise<boolean> {
  if (!signsThroughExternalSigner(config, chain)) return false;
  if (curator.toLowerCase() === registrationSigner.toLowerCase()) return false;
  return (await externalAuthorSignerFor(config, curator)) !== undefined;
}

/**
 * Add the external-author curator as a participant agent of the context graph
 * and return the participant agents to register on-chain. The agent's store
 * marks the metadata projection dirty on write, so the re-read includes it.
 */
export async function addExternalAuthorCuratorAsParticipant(
  agent: DKGAgent,
  contextGraphId: string,
  curator: string,
  registrationSigner: string,
  logInfo: (message: string) => void,
): Promise<string[]> {
  logInfo(
    `PCA-curated CG "${contextGraphId}": curator ${curator} is an author key of the external signer and signs no transactions. ` +
    `Adding it as a participantAgent; local DKG_CURATOR stays ${curator}; on-chain NFT mints to chain signer ${registrationSigner}.`,
  );
  await agent.store.insert([
    {
      subject: `did:dkg:context-graph:${contextGraphId}`,
      predicate: DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT,
      object: `"${ethers.getAddress(curator)}"`,
      graph: contextGraphMetaUri(contextGraphId),
    },
  ]);
  const participantAgents = await agent.getContextGraphParticipantAgentAddresses(contextGraphId);
  if (participantAgents.length > MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS) {
    throw new Error(
      `Context graph "${contextGraphId}" cannot be registered on-chain: participantAgents cannot exceed ` +
      `${MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS} addresses after adding the curator as a participant.`,
    );
  }
  return participantAgents;
}
