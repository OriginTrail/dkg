// SPDX-License-Identifier: Apache-2.0
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { ConfirmedNamedKaVmLifecycleInput } from './named-ka-vm-lifecycle-repair.js';

/** Caller holds the same-KA lifecycle lock, so an earlier snapshot cannot outlive a newer stamp. */
export async function isConfirmedNamedKaVmLifecycleCurrent(
  chain: Pick<ChainAdapter, 'readKnowledgeAssetVersionSnapshot' | 'getEvmChainId'>,
  input: ConfirmedNamedKaVmLifecycleInput,
  requestTimeoutMs: number,
  durableHost: boolean,
): Promise<boolean> {
  if (input.packedKaId === undefined || !chain.readKnowledgeAssetVersionSnapshot) {
    // Standalone/no-chain hosts cannot independently observe a later chain version.
    if (durableHost && typeof chain.getEvmChainId === 'function') {
      throw new Error('Named KA lifecycle repair awaits coherent chain-version support');
    }
    return true;
  }
  const snapshot = await chain.readKnowledgeAssetVersionSnapshot(input.packedKaId, {
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!snapshot || snapshot.rootCount < BigInt(input.assertionVersion)) {
    throw new Error('Confirmed named KA lifecycle repair awaits its finalized chain version');
  }
  if (snapshot.rootCount > BigInt(input.assertionVersion)) return false;
  if (snapshot.latestRoot.toLowerCase().replace(/^0x/, '') !== input.merkleRoot.toLowerCase().replace(/^0x/, '')) {
    throw Object.assign(new Error('Confirmed named KA lifecycle repair root differs from the chain'), {
      code: 'KA_VM_LIFECYCLE_REPAIR_INTEGRITY',
    });
  }
  return true;
}
