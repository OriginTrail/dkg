// SPDX-License-Identifier: Apache-2.0
/**
 * Who signs an authenticated sync request, and what an external signer is
 * shown when it signs one.
 *
 * On behalf of an agent, the claimed agent's signer (`agentSigner`) signs: its
 * key held on the node, else the external signer that holds it as an author
 * key. As the node identity, the chain adapter's primary operational key
 * signs. Either way the signature is EIP-191 over the request's 32-byte digest
 * (`computeSyncDigest`), unchanged, so receivers recover the requester from it
 * exactly as before. An external signer is not asked to sign the digest blind:
 * it is first offered `dkg_signSyncRequest` with the signed fields of the
 * request, from which it can check every field and recompute the digest
 * before it signs. Only a signer that answers "method not found" is asked to
 * sign the digest itself (`eth_sign`); a key on the node signs the digest.
 */
import {
  RemoteSignerError,
  signMessageWithPreimage,
  type ChainAdapter,
  type ExternalAuthorSigners,
  type PreimageSigningRequest,
} from '@origintrail-official/dkg-chain';
import { agentSigner } from '../../author-signer.js';
import type { SyncRequestEnvelope } from './request-build.js';

/** The optional external-signer method that signs a sync request from its fields. */
export const SYNC_REQUEST_SIGNING_METHOD = 'dkg_signSyncRequest';

/**
 * The signed fields of an authenticated sync request, which are the preimage
 * of its digest, in digest order. `requesterAgentAddress` is lowercase (or
 * empty). `authPurpose` and `authSelector` are both present when the request
 * carries either, and both absent otherwise.
 */
export interface SyncRequestSigningPreimage {
  readonly contextGraphId: string;
  readonly offset: number;
  readonly limit: number;
  readonly includeSharedMemory: boolean;
  readonly targetPeerId: string;
  readonly requesterPeerId: string;
  readonly requestId: string;
  readonly issuedAtMs: number;
  readonly requesterAgentAddress: string;
  readonly authPurpose?: string;
  readonly authSelector?: string;
}

/** The preimage of `request`'s digest, read from its signed fields. */
export function syncRequestSigningPreimage(request: SyncRequestEnvelope): SyncRequestSigningPreimage {
  const preimage: SyncRequestSigningPreimage = {
    contextGraphId: request.contextGraphId,
    offset: request.offset,
    limit: request.limit,
    includeSharedMemory: request.includeSharedMemory,
    targetPeerId: request.targetPeerId ?? '',
    requesterPeerId: request.requesterPeerId ?? '',
    requestId: request.requestId ?? '',
    issuedAtMs: request.issuedAtMs ?? 0,
    requesterAgentAddress: (request.requesterAgentAddress ?? '').toLowerCase(),
  };
  if (!request.authPurpose && !request.authSelector) return preimage;
  return { ...preimage, authPurpose: request.authPurpose ?? '', authSelector: request.authSelector ?? '' };
}

/** Signs a sync request digest as one account, given its preimage; returns the 65-byte EIP-191 signature. */
export type SyncRequestSigner = (digest: Uint8Array, preimage: SyncRequestSigningPreimage) => Promise<string>;

/** Signs a sync request digest as the node identity's operational key, given its preimage. */
export type SyncRequestIdentitySigner = (
  digest: Uint8Array,
  preimage: SyncRequestSigningPreimage,
) => Promise<{ r: Uint8Array; vs: Uint8Array }>;

function signingRequest(digest: Uint8Array, preimage: SyncRequestSigningPreimage): PreimageSigningRequest {
  return { method: SYNC_REQUEST_SIGNING_METHOD, preimage: { ...preimage }, message: digest };
}

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
  return async (digest, preimage) => {
    const signer = await agentSigner(authors, address, privateKey);
    if (signer === undefined) {
      throw new RemoteSignerError(
        'REMOTE_SIGNER_ADDRESS_NOT_AVAILABLE',
        `Cannot sign a sync request as ${address}: it is not an author key of the external signer`,
      );
    }
    return signMessageWithPreimage(signer, signingRequest(digest, preimage));
  };
}

/**
 * The node identity's sync request signer: the chain adapter's primary
 * operational key, which is given the preimage when the adapter takes one.
 */
export function chainSyncRequestSigner(
  chain: Pick<ChainAdapter, 'signMessage' | 'signMessageWithPreimage'>,
): SyncRequestIdentitySigner | undefined {
  if (typeof chain.signMessageWithPreimage === 'function') {
    const sign = chain.signMessageWithPreimage.bind(chain);
    return (digest, preimage) => sign(signingRequest(digest, preimage));
  }
  return typeof chain.signMessage === 'function' ? chain.signMessage.bind(chain) : undefined;
}
