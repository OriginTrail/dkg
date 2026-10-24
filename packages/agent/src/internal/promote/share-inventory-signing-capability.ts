import { RemoteSignerError } from '@origintrail-official/dkg-chain';
import { createPromoteRetryableFailure } from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';
import type { EvmAddressV1 } from '@origintrail-official/dkg-core';
import type { DKGAgent } from '../../dkg-agent.js';

/** This domain-separated challenge is not a control object or publication authorization. */
const challenge = ethers.getBytes(ethers.id('DKG share inventory signing capability v1; no mutation authorized'));

/** A pre-signed seal alone cannot authorize the additional signed inventory head. */
export async function assertShareInventorySigningCapability(agent: DKGAgent, address: string): Promise<void> {
  try {
    const author = ethers.getAddress(address).toLowerCase() as EvmAddressV1;
    const signer = agent.createRfc64CatalogAuthorSignerV1(author);
    const signature = await signer.signMessage(challenge);
    if (ethers.verifyMessage(challenge, signature).toLowerCase() !== author) {
      throw new Error('Inventory signing capability does not recover to the asset author');
    }
  } catch (cause) {
    if (isTransientInventorySignerFailure(cause)) throw createPromoteRetryableFailure(cause);
    throw Object.assign(new Error('This graph requires an author-signed inventory handoff. Configure the asset author as a local or external author signer before sharing. Working Memory has not been consumed.', { cause }),
      { code: 'KA_SHARE_INVENTORY_SIGNER_UNAVAILABLE' });
  }
}

/** Only transport failure of a read-only author message signature is retryable here. */
export function isTransientInventorySignerFailure(cause: unknown): boolean {
  return cause instanceof RemoteSignerError && (
    cause.code === 'REMOTE_SIGNER_UNAVAILABLE' || cause.code === 'REMOTE_SIGNER_TIMEOUT'
    || (cause.code === 'REMOTE_SIGNER_HTTP_ERROR' && [408, 429, 500, 502, 503, 504].includes(cause.httpStatus ?? 0))
  );
}
