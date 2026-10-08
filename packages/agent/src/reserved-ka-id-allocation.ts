// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import { KaNumberAllocator } from './allocator.js';

/** Bind an externally signed KA id to its author lane and exact low-96 slot. */
export function resolveReservedKaIdAllocationV1(
  author: string,
  reservedKaId: bigint,
  chainId: string,
  allocator?: Readonly<{ reconcile(authorAddress: string, observedNumber: bigint): void }>,
): Readonly<{
  author: string;
  expectedKaNumber: bigint;
  allocateKaNumber: () => Promise<{ number: bigint; reservedUal: string }>;
}> {
  const canonicalAuthor = ethers.getAddress(author);
  const { author: reservedAuthor, number } = KaNumberAllocator.unpack(reservedKaId);
  if (reservedAuthor !== canonicalAuthor.toLowerCase()) {
    throw new Error(
      `Reserved KA id ${reservedKaId} is outside author ${canonicalAuthor}'s namespace`,
    );
  }
  return {
    // Lifecycle subjects preserve the caller spelling across create/write/finalize.
    author,
    expectedKaNumber: number,
    allocateKaNumber: async () => {
      // The signed slot is already consumed. Keep local allocation above it.
      allocator?.reconcile(canonicalAuthor, number);
      return {
        number,
        reservedUal: `did:dkg:${chainId}/${canonicalAuthor.toLowerCase()}/${number}`,
      };
    },
  };
}
