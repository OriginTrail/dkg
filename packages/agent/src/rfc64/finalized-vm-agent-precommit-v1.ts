import {
  assertCanonicalEvmAddress,
  type AuthorCatalogScopeV1,
  type ContextGraphIdV1,
} from '@origintrail-official/dkg-core';
import { createStrictCurrentFinalizedEvmSnapshotScopeV1 } from '@origintrail-official/dkg-chain';
import type { TripleStore } from '@origintrail-official/dkg-storage';

import type { AcceptedRfc64CatalogAccessSnapshotV1 } from './catalog-access-policy-v1.js';
import type {
  Rfc64PublicCatalogNativeBeforeAppliedHeadCommitHandlerV1,
  Rfc64PublicCatalogNativePrecommitTransactionV1,
} from './public-catalog-native-receiver-v1.js';
import {
  assertRfc64FinalizedPolicyAgentPrecommitSnapshotCurrentV1,
  resolveRfc64FinalizedPolicyAgentPrecommitV1,
} from './finalized-policy-agent-precommit-v1.js';
import { createFinalizedVmRuntimeV1 } from './finalized-vm-runtime-v1.js';
import type {
  FinalizedVmMaterializerV1,
  FinalizedVmTransactionalMaterializerV1,
} from './finalized-vm-runtime-v1.js';
import { FinalizedVmCompositionErrorV1 } from './finalized-vm-composer-v1.js';
import { createFinalizedVmStoreMaterializerV1 } from './finalized-vm-store-materializer-v1.js';

export interface Rfc64FinalizedVmAgentPrecommitOptionsV1 {
  readonly acceptedPolicySnapshotForCatalogScope:
    (scope: Readonly<AuthorCatalogScopeV1>) => AcceptedRfc64CatalogAccessSnapshotV1;
  readonly rpcEndpoints: readonly string[] | null;
  readonly getOnChainContextGraphId:
    (contextGraphId: ContextGraphIdV1, signal: AbortSignal) => Promise<string | null>;
  readonly getEvmChainId: () => Promise<bigint>;
  readonly getKnowledgeAssetStorageAddress: () => Promise<string>;
  readonly getKnowledgeAssetsLifecycleAddress: () => Promise<string>;
  readonly store: TripleStore;
  /** Test or embedding seam; production uses the durable store materializer. */
  readonly materialize?: FinalizedVmMaterializerV1;
}

/**
 * Build the finalized-VM-specific implementation of the receiver's generic
 * pre-CAS barrier. The public catalog receiver owns synchronization ordering;
 * this service owns policy/RPC resolution and VM materialization only.
 */
export function createRfc64FinalizedVmAgentPrecommitV1(
  options: Rfc64FinalizedVmAgentPrecommitOptionsV1,
): Rfc64PublicCatalogNativeBeforeAppliedHeadCommitHandlerV1 {
  return Object.freeze(async (
    plan,
    signal,
  ): Promise<void | Rfc64PublicCatalogNativePrecommitTransactionV1> => {
    if (plan.catalogScope.subGraphName !== null) {
      throw new FinalizedVmCompositionErrorV1(
        'finalized-vm-composition-input',
        'Release 2 private finalized VM recovery supports the root catalog only',
      );
    }
    const resolved = await resolveRfc64FinalizedPolicyAgentPrecommitV1(
      options,
      plan,
      signal,
    );
    if (resolved === null) return;
    const [knowledgeAssetStorageAddress, knowledgeAssetsLifecycleAddress] = await Promise.all([
      options.getKnowledgeAssetStorageAddress(),
      options.getKnowledgeAssetsLifecycleAddress(),
    ]);
    signal.throwIfAborted();
    const canonicalKnowledgeAssetStorageAddress = knowledgeAssetStorageAddress.toLowerCase();
    assertCanonicalEvmAddress(
      canonicalKnowledgeAssetStorageAddress,
      'RFC-64 finalized VM knowledge asset storage address',
    );
    const canonicalKnowledgeAssetsLifecycleAddress = knowledgeAssetsLifecycleAddress.toLowerCase();
    assertCanonicalEvmAddress(
      canonicalKnowledgeAssetsLifecycleAddress,
      'RFC-64 finalized VM knowledge assets lifecycle address',
    );
    const currentAuthority = (): boolean => {
      try {
        assertRfc64FinalizedPolicyAgentPrecommitSnapshotCurrentV1(
          options,
          plan,
          resolved.acceptedPolicy,
        );
        return true;
      } catch {
        return false;
      }
    };
    const materializer = options.materialize
      ?? createFinalizedVmStoreMaterializerV1({
        store: options.store,
        isCurrent: currentAuthority,
      });
    const transaction = isTransactionalMaterializerV1(materializer)
      ? materializer
      : null;
    const runtime = createFinalizedVmRuntimeV1({
      networkId: plan.catalogScope.networkId,
      chainId: resolved.chainId,
      contextGraphStorageAddress: resolved.contextGraphStorageAddress,
      knowledgeAssetStorageAddress: canonicalKnowledgeAssetStorageAddress,
      knowledgeAssetsLifecycleAddress: canonicalKnowledgeAssetsLifecycleAddress,
      snapshot: createStrictCurrentFinalizedEvmSnapshotScopeV1({
        chainId: resolved.chainId,
        endpoints: resolved.rpcEndpoints,
        // This scope is constructed PER precommit invocation, so its admission
        // must come from the process-wide per-chain registry — a gate private
        // to this instance would have contended with nothing, and two
        // concurrent precommits on one chain would both admit.
        owner: 'rfc64',
      }),
      materialize: materializer,
    });
    try {
      await runtime({
        catalogLane: Object.freeze({
          contextGraphId: plan.catalogScope.contextGraphId,
          subGraphName: plan.catalogScope.subGraphName,
        }),
        catalogAuthorAddress: plan.catalogScope.authorAddress,
        onChainContextGraphId: resolved.onChainContextGraphId,
        acceptedPolicy: resolved.acceptedPolicy,
        placements: Object.freeze(plan.rows.map((row) => Object.freeze({
          authorship: row.authorship,
          sealBinding: row.sealBinding,
        }))),
        signal,
      });
      assertRfc64FinalizedPolicyAgentPrecommitSnapshotCurrentV1(
        options,
        plan,
        resolved.acceptedPolicy,
      );
    } catch (cause) {
      if (transaction !== null) {
        try {
          await transaction.rollback(cause);
        } catch (rollbackCause) {
          throw new AggregateError(
            [cause, rollbackCause],
            'RFC-64 finalized VM precommit and exact rollback both failed',
          );
        }
      }
      throw cause;
    }
    if (transaction === null) return;
    return Object.freeze({
      commit: () => transaction.commit(),
      rollback: (cause?: unknown) => transaction.rollback(cause),
    }) satisfies Rfc64PublicCatalogNativePrecommitTransactionV1;
  });
}

function isTransactionalMaterializerV1(
  materializer: FinalizedVmMaterializerV1,
): materializer is FinalizedVmTransactionalMaterializerV1 {
  const candidate = materializer as Partial<FinalizedVmTransactionalMaterializerV1>;
  return typeof candidate.commit === 'function' && typeof candidate.rollback === 'function';
}
