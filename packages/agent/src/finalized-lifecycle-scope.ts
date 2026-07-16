// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import type { SharedMemoryGraphScope } from '@origintrail-official/dkg-storage';
import { unpackKnowledgeAssetId } from './ka-identity.js';

type NamedLifecycleSharedMemoryScope = Extract<
  SharedMemoryGraphScope,
  { kind: 'named-lifecycle' }
>;

/**
 * Derive the SWM identity boundary bound by a finalized seal.
 *
 * Legacy or mock seals without a packed KA id retain complete-family read
 * compatibility; a real packed namespace must match the sealed author.
 */
export function sharedMemoryScopeForFinalizedLifecycle(
  authorAddress: string,
  packedKaId: bigint | undefined,
): SharedMemoryGraphScope {
  if (packedKaId === undefined) return { kind: 'complete-family' };
  return namedSharedMemoryScopeForFinalizedLifecycle(authorAddress, packedKaId);
}

/** Strict finalized-lifecycle scope for call sites that require a packed id. */
export function namedSharedMemoryScopeForFinalizedLifecycle(
  authorAddress: string,
  packedKaId: bigint,
): NamedLifecycleSharedMemoryScope {
  const unpacked = unpackKnowledgeAssetId(packedKaId);
  const sealedAuthor = ethers.getAddress(authorAddress);
  const packedAuthor = BigInt(unpacked.agentAddress);
  // Legacy/mock seals may carry only the low 96-bit KA number. Preserve that
  // read compatibility by binding a zero packed namespace to the sealed author;
  // a real nonzero namespace must still match exactly.
  if (packedAuthor !== 0n && ethers.getAddress(unpacked.agentAddress) !== sealedAuthor) {
    throw new Error(
      `Finalized lifecycle KA id ${packedKaId} is not in author ${sealedAuthor}'s namespace`,
    );
  }
  return {
    kind: 'named-lifecycle',
    identity: { agentAddress: sealedAuthor, kaNumber: unpacked.kaNumber },
  };
}
