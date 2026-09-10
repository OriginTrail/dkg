import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import {
  createRfc64FinalizedPolicyAgentPrecommitV1,
  type Rfc64FinalizedPolicyAgentPrecommitResolutionOptionsV1,
} from './finalized-policy-agent-precommit-v1.js';
import { createRfc64FinalizedVmAgentPrecommitV1 } from './finalized-vm-agent-precommit-v1.js';

interface Rfc64FinalizedAgentPrecommitsOptionsV1 extends Pick<
  Rfc64FinalizedPolicyAgentPrecommitResolutionOptionsV1,
  'acceptedPolicySnapshotForCatalogScope' | 'getOnChainContextGraphId'
> {
  readonly chain: ChainAdapter;
  readonly store: TripleStore;
}

/** Bind both catalog barriers to the adapter and the shared RFC-64 read owner. */
export function createRfc64FinalizedAgentPrecommitsV1(options: Rfc64FinalizedAgentPrecommitsOptionsV1) {
  const shared: Rfc64FinalizedPolicyAgentPrecommitResolutionOptionsV1 = {
    acceptedPolicySnapshotForCatalogScope: options.acceptedPolicySnapshotForCatalogScope,
    getOnChainContextGraphId: options.getOnChainContextGraphId,
    createFinalizedReadBinding: () => options.chain.createFinalizedEvmReadBinding('rfc64'),
  };
  return Object.freeze({
    finalizedPolicyPrecommit: createRfc64FinalizedPolicyAgentPrecommitV1(shared),
    finalizedVmPrecommit: createRfc64FinalizedVmAgentPrecommitV1({
      ...shared,
      getKnowledgeAssetStorageAddress: async () => {
        if (typeof options.chain.getDKGKnowledgeAssetsAddress !== 'function') {
          throw new Error('RFC-64 finalized VM recovery requires KnowledgeAssetStorage');
        }
        return options.chain.getDKGKnowledgeAssetsAddress();
      },
      getKnowledgeAssetsLifecycleAddress: () => options.chain.getKnowledgeAssetsLifecycleAddress(),
      store: options.store,
    }),
  });
}
