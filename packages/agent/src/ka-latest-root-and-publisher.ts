// SPDX-License-Identifier: Apache-2.0

import type { ChainAdapter } from '@origintrail-official/dkg-chain';

/** A Knowledge Asset's latest Merkle root and the address that published it. */
export interface LatestMerkleRootAndPublisher {
  readonly merkleRoot: Uint8Array;
  /** `''` when the adapter reads no publisher, as callers have always taken it. */
  readonly publisherAddress: string;
}

/**
 * Read a Knowledge Asset's latest Merkle root and its publisher together.
 *
 * The EVM adapter sends background views issued in the same turn as one
 * Multicall3 request, evaluated at one block. Read one after the other, the
 * two views cost a request each. A failure is reported as it was when the
 * publisher was read after the root: the root's first.
 */
export async function readLatestMerkleRootAndPublisher(
  chain: Pick<ChainAdapter, 'getLatestMerkleRoot' | 'getLatestMerkleRootPublisher'>,
  kaId: bigint,
): Promise<LatestMerkleRootAndPublisher> {
  const [root, publisher] = await Promise.allSettled([
    chain.getLatestMerkleRoot!(kaId),
    chain.getLatestMerkleRootPublisher ? chain.getLatestMerkleRootPublisher(kaId) : '',
  ]);
  if (root.status === 'rejected') throw root.reason;
  if (publisher.status === 'rejected') throw publisher.reason;
  return { merkleRoot: root.value, publisherAddress: publisher.value ?? '' };
}
