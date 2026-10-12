// SPDX-License-Identifier: Apache-2.0
/**
 * Who signs an authenticated sync request on behalf of an agent: the claimed
 * agent's signer (`agentSigner`), its key held on the node, else the external
 * signer that holds it as an author key. Either way the signature is EIP-191
 * over the request's 32-byte digest (`computeSyncDigest`), so receivers
 * recover the requester from it exactly as before.
 */
import type { ExternalAuthorSigners } from '@origintrail-official/dkg-chain';
import { agentSigner } from '../../author-signer.js';

/** Signs a sync request digest as one account; returns its 65-byte EIP-191 signature. */
export type SyncRequestSigner = (digest: Uint8Array) => Promise<string>;

/**
 * The signer of the sync requests a node makes on behalf of the local agent
 * `address` (`record` is its entry among the node's agents), or undefined when
 * there is no such local agent, or it has no key on the node and there are no
 * external author keys. The agent's signer is resolved only when a request is
 * signed as the agent, never when the node identity signs it: its key first,
 * else an author key of the external signer (never a payer), looked up then.
 */
export function claimedAgentSyncRequestSigner(
  authors: ExternalAuthorSigners | undefined,
  address: string | undefined,
  record: { readonly privateKey?: string } | undefined,
): SyncRequestSigner | undefined {
  if (address === undefined || record === undefined) return undefined;
  const privateKey = record.privateKey;
  if (!privateKey && authors === undefined) return undefined;
  return async (digest) => {
    const signer = await agentSigner(authors, address, privateKey);
    if (signer === undefined) {
      throw new Error(`Cannot sign a sync request as ${address}: it is not an author key of the external signer`);
    }
    return signer.signMessage(digest);
  };
}
