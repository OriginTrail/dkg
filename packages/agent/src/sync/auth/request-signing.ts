// SPDX-License-Identifier: Apache-2.0
/**
 * Who signs an authenticated sync request on behalf of an agent whose key the
 * node does not hold. The signature is EIP-191 over the request's 32-byte
 * digest (`computeSyncDigest`), as with a key held on the node, so receivers
 * recover the requester from it exactly as before.
 */
import { externalAuthorSignerFor, type ExternalAuthorConfig } from '../../external-author-signing.js';

/** Signs a sync request digest as one account; returns its 65-byte EIP-191 signature. */
export type SyncRequestSigner = (digest: Uint8Array) => Promise<string>;

/**
 * The sync request signer of `agent` when the node holds no key for it and the
 * external signer holds it as an author key (never a payer): the author key's
 * message signing, looked up when a request is signed. Undefined for an agent
 * whose key is on the node, or without external author keys.
 */
export function externalAgentSyncRequestSigner(
  config: ExternalAuthorConfig | undefined,
  agent: { readonly agentAddress: string; readonly privateKey?: string } | undefined,
): SyncRequestSigner | undefined {
  if (agent === undefined || agent.privateKey || config?.chainConfig?.authors === undefined) return undefined;
  const address = agent.agentAddress;
  return async (digest) => {
    const author = await externalAuthorSignerFor(config, address);
    if (author === undefined) {
      throw new Error(`Cannot sign a sync request as ${address}: it is not an author key of the external signer`);
    }
    return author.signMessage(digest);
  };
}
