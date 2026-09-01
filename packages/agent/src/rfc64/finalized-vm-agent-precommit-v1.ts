import {
  assertCanonicalEvmAddress,
  type AuthorCatalogScopeV1,
  type ContextGraphIdV1,
} from '@origintrail-official/dkg-core';
import { createStrictCurrentFinalizedEvmSnapshotScopeV1 } from '@origintrail-official/dkg-chain';
import type { TripleStore } from '@origintrail-official/dkg-storage';

import type { AcceptedRfc64CatalogAccessSnapshotV1 } from './catalog-access-policy-v1.js';
import type {
  Rfc64PublicCatalogNativePrimaryPrecommitHandlerV1,
  Rfc64PublicCatalogNativePrecommitTransactionV1,
} from './public-catalog-native-receiver-v1.js';
import {
  assertRfc64FinalizedPolicyAgentPrecommitSnapshotCurrentV1,
  resolveRfc64FinalizedPolicyAgentPrecommitV1,
} from './finalized-policy-agent-precommit-v1.js';
import { createFinalizedVmRuntimeV1 } from './finalized-vm-runtime-v1.js';
import type {
  FinalizedVmMaterializationReceiptV1,
  FinalizedVmTransactionalMaterializerV1,
} from './finalized-vm-runtime-v1.js';
import { FinalizedVmCompositionErrorV1 } from './finalized-vm-composer-v1.js';
import {
  createFinalizedVmStoreExistingMaterializationVerifierV1,
  createFinalizedVmStoreMaterializerV1,
} from './finalized-vm-store-materializer-v1.js';

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
  /** Test or embedding seam; this coordinator-facing path is transactional by construction. */
  readonly materialize?: FinalizedVmTransactionalMaterializerV1;
}

/**
 * Exact process-local proof carried from finalized VM materialization into the
 * catalog applied-head coordinator. The coordinator deliberately refuses to
 * retire an SWM twin without this typed transaction: a generic precommit says
 * nothing about which VM rows were durably post-read.
 */
export interface Rfc64FinalizedVmAgentPrecommitTransactionV1
  extends Rfc64PublicCatalogNativePrecommitTransactionV1 {
  readonly kind: 'rfc64-finalized-vm-agent-precommit-transaction-v1';
  readonly materializationReceipts:
    readonly Readonly<FinalizedVmMaterializationReceiptV1>[];
}

export interface Rfc64FinalizedVmAgentPrecommitHandlerV1 {
  (
    plan: Parameters<Rfc64PublicCatalogNativePrimaryPrecommitHandlerV1>[0],
    signal: AbortSignal,
  ): Promise<Rfc64FinalizedVmAgentPrecommitTransactionV1>;
}

/**
 * Build the finalized-VM-specific implementation of the receiver's generic
 * pre-CAS barrier. The public catalog receiver owns synchronization ordering;
 * this service owns policy/RPC resolution and VM materialization only.
 */
export function createRfc64FinalizedVmAgentPrecommitV1(
  options: Rfc64FinalizedVmAgentPrecommitOptionsV1,
): Rfc64FinalizedVmAgentPrecommitHandlerV1 {
  return Object.freeze(async (
    plan,
    signal,
  ): Promise<Rfc64FinalizedVmAgentPrecommitTransactionV1> => {
    const resolved = await resolveRfc64FinalizedPolicyAgentPrecommitV1(
      options,
      plan,
      signal,
      (acceptedPolicy) => {
        if (
          acceptedPolicy.policy.accessPolicy === 1
          && plan.catalogScope.subGraphName !== null
        ) {
          throw new FinalizedVmCompositionErrorV1(
            'finalized-vm-composition-input',
            'Release 2 private finalized VM recovery supports the root catalog only',
          );
        }
      },
    );
    if (resolved === null) {
      throw new Error(
        'RFC-64 finalized VM precommit requires a finalized-chain policy',
      );
    }
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
      verifyExistingMaterialization:
        createFinalizedVmStoreExistingMaterializationVerifierV1({
          store: options.store,
          isCurrent: currentAuthority,
        }),
    });
    // Runtime materialization owns rollback for failures in its own execution.
    // Only a failure after a successful runtime reaches this layer's rollback,
    // so each failed precommit has exactly one transaction cleanup owner.
    const result = await runtime({
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
    try {
      assertRfc64FinalizedPolicyAgentPrecommitSnapshotCurrentV1(
        options,
        plan,
        resolved.acceptedPolicy,
      );
    } catch (cause) {
      try {
        await materializer.rollback(cause);
      } catch (rollbackCause) {
        throw new AggregateError(
          [cause, rollbackCause],
          'RFC-64 finalized VM precommit and exact rollback both failed',
        );
      }
      throw cause;
    }
    return Object.freeze({
      kind: 'rfc64-finalized-vm-agent-precommit-transaction-v1',
      materializationReceipts: result.receipts,
      commit: () => materializer.commit(),
      rollback: (cause?: unknown) => materializer.rollback(cause),
    }) satisfies Rfc64FinalizedVmAgentPrecommitTransactionV1;
  });
}
