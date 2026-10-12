// SPDX-License-Identifier: Apache-2.0
/**
 * Who signs as an agent of the node, resolved into one signing capability:
 * the agent's key held on the node, as a wallet, else the external signer that
 * holds the agent's address as an author key (never a payer). Author
 * attestations (EIP-712 typed data), sync requests and shared-memory gossip
 * (EIP-191 messages) sign through it, and no protocol builds a wallet from a
 * stored key itself. Which agent may sign stays each protocol's decision; a
 * pre-signed attestation, an author callback and the publisher's own fallback
 * stay explicit at their call sites.
 */
import { ethers } from 'ethers';
import type { AuthorSigner, ExternalAuthorSigners } from '@origintrail-official/dkg-chain';

/** The node's local agents, as far as author signing needs them. */
interface LocalAgentKeys {
  getLocalAgentMode(address: string): 'custodial' | 'self-sovereign' | undefined;
  getCustodialAgentPrivateKey(address: string): string | undefined;
}

/**
 * The wallet of an agent key held on the node, the key stored with or without
 * its 0x prefix: the one place where an agent key becomes a signer.
 */
export function agentKeyWallet(privateKey: string): ethers.Wallet {
  return new ethers.Wallet(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`);
}

/** The external signer for `address`, when it is one of the author keys `authors`. */
export async function externalAuthorSignerFor(
  authors: ExternalAuthorSigners | undefined,
  address: string,
): Promise<AuthorSigner | undefined> {
  if (authors === undefined || !ethers.isAddress(address)) return undefined;
  return authors.signerFor(address);
}

/**
 * The signer of the agent `address`: `privateKey`, the agent's key held on
 * the node, as a wallet, which takes precedence and asks the external signer
 * nothing; else the external signer that holds `address` as one of the author
 * keys `authors`. Undefined when the node can sign as the agent neither way.
 */
export async function agentSigner(
  authors: ExternalAuthorSigners | undefined,
  address: string,
  privateKey: string | undefined,
): Promise<AuthorSigner | undefined> {
  return privateKey ? agentKeyWallet(privateKey) : externalAuthorSignerFor(authors, address);
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
  return agentSigner(authors, address, agents.getCustodialAgentPrivateKey(address));
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
  return agentKeyWallet(custodialKey);
}
