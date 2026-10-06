// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';

const KA_NUMBER_MASK = (1n << 96n) - 1n;

/** Bind an externally signed KA id to its author lane and exact low-96 slot. */
export function resolveReservedKaIdAllocationV1(
  author: string,
  reservedKaId: bigint,
  chainId: string,
  allocator?: Readonly<{ reconcile(authorAddress: string, observedNumber: bigint): void }>,
): Readonly<{
  author: string;
  allocateKaNumber: () => Promise<{ number: bigint; reservedUal: string }>;
}> {
  const canonicalAuthor = ethers.getAddress(author);
  if ((reservedKaId >> 96n) !== BigInt(canonicalAuthor)) {
    throw new Error(
      `Reserved KA id ${reservedKaId} is outside author ${canonicalAuthor}'s namespace`,
    );
  }
  const number = reservedKaId & KA_NUMBER_MASK;
  return {
    author: canonicalAuthor,
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
