// SPDX-License-Identifier: Apache-2.0
/**
 * Who signs an author attestation (EIP-712 typed data), resolved once into a
 * signing capability: a custodial agent's key held on the node, as a wallet,
 * or the external signer that holds a self-sovereign agent's author key.
 * Finalize, selection publishing and updates sign through it alike and never
 * handle a raw private key. A pre-signed attestation, an author callback and
 * the publisher's own fallback stay explicit at their call sites.
 */
import { ethers } from 'ethers';
import type { AuthorSigner, ExternalAuthorSigners } from '@origintrail-official/dkg-chain';
import { externalAuthorSignerFor } from './external-author-signing.js';

/** The node's local agents, as far as author signing needs them. */
interface LocalAgentKeys {
  getLocalAgentMode(address: string): 'custodial' | 'self-sovereign' | undefined;
  getCustodialAgentPrivateKey(address: string): string | undefined;
}

function custodialWallet(privateKey: string): ethers.Wallet {
  return new ethers.Wallet(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`);
}

/**
 * The signer of `address` when the node can sign for it without the
 * publisher: its custodial key held on the node, else the external signer
 * that holds it as an author key.
 */
export async function heldAuthorSigner(
  agents: LocalAgentKeys,
  authors: ExternalAuthorSigners | undefined,
  address: string,
): Promise<AuthorSigner | undefined> {
  const custodialKey = agents.getCustodialAgentPrivateKey(address);
  return custodialKey ? custodialWallet(custodialKey) : externalAuthorSignerFor(authors, address);
}

/**
 * The signer of a registered local agent named as the author: a
 * self-sovereign agent through the external signer that holds its author key,
 * a custodial agent with its key on the node. Errors start with `label`; the
 * one for a custodial agent without a key on file carries `missingKeyCode`.
 */
export async function registeredAgentAuthorSigner(
  agents: LocalAgentKeys,
  authors: ExternalAuthorSigners | undefined,
  address: string,
  label: string,
  missingKeyCode?: string,
): Promise<AuthorSigner> {
  const mode = agents.getLocalAgentMode(address);
  if (mode === undefined) {
    throw new Error(`${label}: authorAgentAddress ${address} is not a registered local agent on this node`);
  }
  if (mode === 'self-sovereign') {
    const external = await externalAuthorSignerFor(authors, address);
    if (external) return external;
    throw new Error(
      `${label}: agent ${address} is registered as self-sovereign — ` +
        `this node does not hold its private key. Use preSignedAuthorAttestation instead.`,
    );
  }
  const custodialKey = agents.getCustodialAgentPrivateKey(address);
  if (!custodialKey) {
    throw Object.assign(
      new Error(`${label}: custodial agent ${address} has no private key on file`),
      missingKeyCode === undefined ? {} : { code: missingKeyCode },
    );
  }
  return custodialWallet(custodialKey);
}
