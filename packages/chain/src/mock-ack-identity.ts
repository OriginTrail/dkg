// SPDX-License-Identifier: Apache-2.0
import type { ChainReadOptions, VerifyACKIdentityResult } from './chain-adapter.js';

/** The mock treats a registered key as a member; it has no separate staking table. */
export function verifyMockACKIdentity(
  identities: ReadonlyMap<string, bigint>, recoveredAddress: string,
  claimedIdentityId: bigint, options: ChainReadOptions,
): VerifyACKIdentityResult {
  options.signal?.throwIfAborted();
  const normalizedAddress = recoveredAddress.toLowerCase();
  for (const [addr, id] of identities) {
    if (id === claimedIdentityId && addr.toLowerCase() === normalizedAddress) {
      return { valid: true };
    }
  }
  return { valid: false, reason: 'key-not-registered' };
}
