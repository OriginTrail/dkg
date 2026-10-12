// SPDX-License-Identifier: Apache-2.0
/**
 * Who signs an authenticated sync request on behalf of an agent: the one
 * signing capability of the claimed agent, resolved here from the key the
 * node holds for it, else the external signer that holds it as an author key.
 * Either way the signature is EIP-191 over the request's 32-byte digest
 * (`computeSyncDigest`), so receivers recover the requester from it exactly
 * as before.
 */
import { ethers } from 'ethers';
import { externalAuthorSignerFor, type ExternalAuthorConfig } from '../../external-author-signing.js';

/** Signs a sync request digest as one account; returns its 65-byte EIP-191 signature. */
export type SyncRequestSigner = (digest: Uint8Array) => Promise<string>;

/**
 * The signer of the sync requests a node makes on behalf of the local agent
 * `address` (`record` is its entry among the node's agents): its key held on
 * the node, as a wallet built when it first signs, else the external signer
 * that holds it as an author key (never a payer). Undefined when there is no
 * such local agent, or the node can sign for it neither way.
 */
export function claimedAgentSyncRequestSigner(
  config: ExternalAuthorConfig | undefined,
  address: string | undefined,
  record: { readonly privateKey?: string } | undefined,
): SyncRequestSigner | undefined {
  if (address === undefined || record === undefined) return undefined;
  const privateKey = record.privateKey;
  if (privateKey) {
    let wallet: ethers.Wallet | undefined;
    return (digest) => (wallet ??= new ethers.Wallet(privateKey)).signMessage(digest);
  }
  return externalAuthorSyncRequestSigner(config, address);
}

/**
 * The external branch: an author key of the external signer, looked up when a
 * request is signed, signing the request digest; undefined without external
 * author keys.
 */
function externalAuthorSyncRequestSigner(
  config: ExternalAuthorConfig | undefined,
  address: string,
): SyncRequestSigner | undefined {
  if (config?.chainConfig?.authors === undefined) return undefined;
  return async (digest) => {
    const author = await externalAuthorSignerFor(config, address);
    if (author === undefined) {
      throw new Error(`Cannot sign a sync request as ${address}: it is not an author key of the external signer`);
    }
    return author.signMessage(digest);
  };
}
