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

export interface AgentKeyRecord {
  agentAddress: string;
  publicKey: string;
  privateKey?: string;
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
  return {
    agentAddress: wallet.address,
    publicKey: wallet.signingKey.publicKey,
    privateKey: wallet.privateKey,
    name,
    framework,
    mode: 'custodial',
    authToken: generateAgentToken(),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Register a self-sovereign agent from a provided public key.
 * The node never has the private key.
 */
export function registerSelfSovereignAgent(
  name: string,
  publicKey: string,
  framework?: string,
): AgentKeyRecord {
  const address = ethers.computeAddress(publicKey);
  return {
    agentAddress: address,
    publicKey,
    name,
    framework,
    mode: 'self-sovereign',
    authToken: generateAgentToken(),
    createdAt: new Date().toISOString(),
  };
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
  return {
    agentAddress: wallet.address,
    publicKey: wallet.signingKey.publicKey,
    privateKey,
    name,
    framework,
    mode: 'custodial',
    authToken: generateAgentToken(),
    createdAt: new Date().toISOString(),
  };
}
