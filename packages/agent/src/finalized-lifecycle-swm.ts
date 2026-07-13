// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import type { SharedMemoryGraphScope } from '@origintrail-official/dkg-storage';
import { unpackKnowledgeAssetId } from './ka-identity.js';

/**
 * Derive the SWM identity boundary bound by a finalized seal.
 *
 * This lifecycle/SWM policy is shared by finalize and publish. Legacy or mock
 * seals without a packed KA id retain complete-family compatibility; a real
 * packed namespace must match the sealed author exactly.
 */
export function sharedMemoryScopeForFinalizedLifecycle(
  authorAddress: string,
  packedKaId: bigint | undefined,
): SharedMemoryGraphScope {
  if (packedKaId === undefined) return { kind: 'complete-family' };
  const unpacked = unpackKnowledgeAssetId(packedKaId);
  const sealedAuthor = ethers.getAddress(authorAddress);
  const packedAuthor = BigInt(unpacked.agentAddress);
  // Legacy/mock seals may carry only the low 96-bit KA number. Preserve that
  // compatibility by binding a zero packed namespace to the sealed author;
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
