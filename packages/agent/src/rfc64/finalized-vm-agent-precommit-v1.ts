import type {
  AuthorCatalogScopeV1,
  ChainIdV1,
  ContextGraphIdV1,
  DecimalU256V1,
  EvmAddressV1,
} from '@origintrail-official/dkg-core';
import { createStrictCurrentFinalizedEvmSnapshotScopeV1 } from '@origintrail-official/dkg-chain';
import type { TripleStore } from '@origintrail-official/dkg-storage';

import type { AcceptedRfc64CatalogAccessSnapshotV1 } from './catalog-access-policy-v1.js';
import type {
  Rfc64PublicCatalogNativeBeforeAppliedHeadCommitHandlerV1,
} from './public-catalog-native-receiver-v1.js';
import { createFinalizedVmRuntimeV1 } from './finalized-vm-runtime-v1.js';
import { createFinalizedVmStoreMaterializerV1 } from './finalized-vm-store-materializer-v1.js';

export interface Rfc64FinalizedVmAgentPrecommitOptionsV1 {
  readonly acceptedPolicySnapshotForCatalogScope:
    (scope: Readonly<AuthorCatalogScopeV1>) => AcceptedRfc64CatalogAccessSnapshotV1;
  readonly rpcEndpoints: readonly string[] | null;
  readonly getOnChainContextGraphId:
    (contextGraphId: ContextGraphIdV1, signal: AbortSignal) => Promise<string | null>;
  readonly getEvmChainId: () => Promise<bigint>;
  readonly getKnowledgeAssetStorageAddress: () => Promise<string>;
  readonly store: TripleStore;
}

/**
 * Build the finalized-VM-specific implementation of the receiver's generic
 * pre-CAS barrier. The public catalog receiver owns synchronization ordering;
 * this service owns policy/RPC resolution and VM materialization only.
 */
export function createRfc64FinalizedVmAgentPrecommitV1(
  options: Rfc64FinalizedVmAgentPrecommitOptionsV1,
): Rfc64PublicCatalogNativeBeforeAppliedHeadCommitHandlerV1 {
  return Object.freeze(async (plan, signal): Promise<void> => {
    signal.throwIfAborted();
    const acceptedPolicy = options.acceptedPolicySnapshotForCatalogScope(plan.catalogScope);
    const { policy } = acceptedPolicy;
    if (policy.source.kind !== 'finalized-chain') return;
    if (
      policy.accessPolicy !== 0
      || policy.governanceChainId === null
      || policy.governanceContractAddress === null
    ) {
      throw new Error('RFC-64 finalized VM precommit requires one public finalized policy');
    }
    if (options.rpcEndpoints === null || options.rpcEndpoints.length === 0) {
      throw new Error('RFC-64 finalized VM precommit requires trusted RPC configuration');
    }

    const [onChainContextGraphId, liveChainId, knowledgeAssetStorageAddress] =
      await Promise.all([
        options.getOnChainContextGraphId(plan.catalogScope.contextGraphId, signal),
        options.getEvmChainId(),
        options.getKnowledgeAssetStorageAddress(),
      ]);
    signal.throwIfAborted();
    if (onChainContextGraphId === null) {
      throw new Error('RFC-64 finalized VM precommit could not resolve the numeric context graph id');
    }
    if (liveChainId.toString() !== policy.governanceChainId) {
      throw new Error('RFC-64 finalized VM policy differs from the configured chain id');
    }

    const chainId = policy.governanceChainId as ChainIdV1;
    const runtime = createFinalizedVmRuntimeV1({
      networkId: plan.catalogScope.networkId,
      chainId,
      contextGraphStorageAddress: policy.governanceContractAddress,
      knowledgeAssetStorageAddress: knowledgeAssetStorageAddress.toLowerCase() as EvmAddressV1,
      snapshot: createStrictCurrentFinalizedEvmSnapshotScopeV1({
        chainId,
        endpoints: options.rpcEndpoints,
      }),
      materialize: createFinalizedVmStoreMaterializerV1({ store: options.store }),
    });
    await runtime({
      catalogLane: Object.freeze({
        contextGraphId: plan.catalogScope.contextGraphId,
        subGraphName: plan.catalogScope.subGraphName,
      }),
      onChainContextGraphId: onChainContextGraphId as DecimalU256V1,
      acceptedPolicy,
      placements: Object.freeze(plan.rows.map((row) => Object.freeze({
        authorship: row.authorship,
        sealBinding: row.sealBinding,
      }))),
      signal,
    });
  });
}
