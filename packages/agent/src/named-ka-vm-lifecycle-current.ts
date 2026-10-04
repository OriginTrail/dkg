// SPDX-License-Identifier: Apache-2.0
import { NamedKaVmLifecycleIntegrityError } from './named-ka-vm-lifecycle-integrity-error.js';
import { activeRpcRequestAbortSignal, withRpcRequestContext, type ChainAdapter } from '@origintrail-official/dkg-chain';
import { runBoundedOperation } from './bounded-operation.js';
import type { ConfirmedNamedKaVmLifecycleInput } from './named-ka-vm-lifecycle-repair.js';

/** Caller holds the same-KA lifecycle lock, so an earlier snapshot cannot outlive a newer stamp. */
export async function isConfirmedNamedKaVmLifecycleCurrent(
  chain: Pick<ChainAdapter, 'readKnowledgeAssetVersionSnapshot' | 'getEvmChainId' | 'getKnowledgeAssetsLifecycleAddress'>,
  input: ConfirmedNamedKaVmLifecycleInput,
  requestTimeoutMs: number,
  durableHost: boolean,
): Promise<boolean> {
  // One deadline owns deployment verification and the coherent version read.
  // RPC context carries its cancellation into real getters; the outer boundary
  // also retires non-cooperative adapter promises without holding the KA lock.
  return runBoundedOperation(signal => withRpcRequestContext({ signal }, async () => {
    const deployment = input.publicationDeployment;
    if (deployment === undefined) {
      if ((input.packedKaId !== undefined && chain.readKnowledgeAssetVersionSnapshot)
        || typeof chain.getEvmChainId === 'function') {
        throw new Error('Named KA lifecycle repair awaits original publication deployment evidence');
      }
    } else {
      if (typeof chain.getEvmChainId !== 'function' || typeof chain.getKnowledgeAssetsLifecycleAddress !== 'function') {
        throw new Error('Named KA lifecycle repair awaits configured deployment evidence');
      }
      const [chainId, address] = await Promise.all([chain.getEvmChainId({ signal }), chain.getKnowledgeAssetsLifecycleAddress({ signal })]);
      signal.throwIfAborted();
      if (chainId !== BigInt(deployment.chainId) || address.toLowerCase() !== deployment.lifecycleAddress.toLowerCase()) {
        throw Object.assign(new Error('Named KA lifecycle repair awaits its original chain deployment'), {
          code: 'KA_VM_LIFECYCLE_REPAIR_DEPLOYMENT_MISMATCH',
        });
      }
    }
    if (input.packedKaId === undefined || !chain.readKnowledgeAssetVersionSnapshot) {
      // Standalone/no-chain hosts cannot independently observe a later chain version.
      if (durableHost && typeof chain.getEvmChainId === 'function') {
        throw new Error('Named KA lifecycle repair awaits coherent chain-version support');
      }
      return true;
    }
    const snapshot = await chain.readKnowledgeAssetVersionSnapshot(input.packedKaId, {
      signal,
    });
    signal.throwIfAborted();
    if (!snapshot || snapshot.rootCount < BigInt(input.assertionVersion)) {
      throw new Error('Confirmed named KA lifecycle repair awaits its finalized chain version');
    }
    if (snapshot.rootCount > BigInt(input.assertionVersion)) return false;
    if (snapshot.latestRoot.toLowerCase().replace(/^0x/, '') !== input.merkleRoot.toLowerCase().replace(/^0x/, '')) {
      throw new NamedKaVmLifecycleIntegrityError('Confirmed named KA lifecycle repair root differs from the chain');
    }
    return true;
  }), { timeoutMs: requestTimeoutMs, label: 'Confirmed named KA lifecycle chain read', signal: activeRpcRequestAbortSignal() });
}
