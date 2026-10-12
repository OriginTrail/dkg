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
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { addRegistrationParticipantAgent, type RegistrationRoster } from './context-graph-registration-roster.js';
import { externalAuthorSignerFor, signsThroughExternalSigner, type ExternalAuthorConfig } from './external-author-signing.js';

/**
 * Whether the node signs through an external signer and `curator`, which is
 * not the registration signer, is one of that signer's author keys.
 */
export async function isExternalAuthorCurator(
  config: ExternalAuthorConfig | undefined,
  chain: Pick<ChainAdapter, 'operationalSigning'> | undefined,
  curator: string,
  registrationSigner: string,
): Promise<boolean> {
  if (!signsThroughExternalSigner(chain)) return false;
  if (curator.toLowerCase() === registrationSigner.toLowerCase()) return false;
  return (await externalAuthorSignerFor(config, curator)) !== undefined;
}

/**
 * Add the external-author curator as a participant agent of the context graph
 * and return the participant agents to register on-chain.
 */
export async function addExternalAuthorCuratorAsParticipant(
  roster: RegistrationRoster,
  contextGraphId: string,
  curator: string,
  registrationSigner: string,
  logInfo: (message: string) => void,
): Promise<string[]> {
  logInfo(
    `PCA-curated CG "${contextGraphId}": curator ${curator} is an author key of the external signer and signs no transactions. ` +
    `Adding it as a participantAgent; local DKG_CURATOR stays ${curator}; on-chain NFT mints to chain signer ${registrationSigner}.`,
  );
  return addRegistrationParticipantAgent(roster, contextGraphId, curator, 'adding the curator');
}
