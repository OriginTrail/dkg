import {
  assertCanonicalDecimalU256,
  type AuthorCatalogScopeV1,
  type ContextGraphIdV1,
} from '@origintrail-official/dkg-core';

import type { AcceptedRfc64CatalogAccessSnapshotV1 } from './catalog-access-policy-v1.js';
import type {
  Rfc64PublicCatalogNativeBeforeAppliedHeadCommitHandlerV1,
} from './public-catalog-native-receiver-v1.js';

export interface Rfc64FinalizedPolicyAgentPrecommitOptionsV1 {
  readonly acceptedPolicySnapshotForCatalogScope:
    (scope: Readonly<AuthorCatalogScopeV1>) => AcceptedRfc64CatalogAccessSnapshotV1;
  readonly rpcEndpoints: readonly string[] | null;
  readonly getOnChainContextGraphId:
    (contextGraphId: ContextGraphIdV1, signal: AbortSignal) => Promise<string | null>;
  readonly getEvmChainId: () => Promise<bigint>;
}

/**
 * Guard a finalized-chain SWM catalog before its applied-head CAS without
 * treating catalog rows as a second VM inventory. The chain remains the VM
 * catalog; this barrier establishes only that the already-accepted policy is
 * bound to the configured live chain and to a resolvable on-chain CG id.
 */
export function createRfc64FinalizedPolicyAgentPrecommitV1(
  options: Rfc64FinalizedPolicyAgentPrecommitOptionsV1,
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
      throw new Error('RFC-64 finalized policy precommit requires one public finalized policy');
    }
    if (
      policy.source.chainId !== policy.governanceChainId
      || policy.source.contractAddress !== policy.governanceContractAddress
    ) {
      throw new Error('RFC-64 finalized policy source differs from its governance binding');
    }
    if (options.rpcEndpoints === null || options.rpcEndpoints.length === 0) {
      throw new Error('RFC-64 finalized policy precommit requires trusted RPC configuration');
    }

    const [onChainContextGraphId, liveChainId] = await Promise.all([
      options.getOnChainContextGraphId(plan.catalogScope.contextGraphId, signal),
      options.getEvmChainId(),
    ]);
    signal.throwIfAborted();
    if (onChainContextGraphId === null) {
      throw new Error('RFC-64 finalized policy precommit could not resolve the numeric context graph id');
    }
    if (liveChainId.toString() !== policy.governanceChainId) {
      throw new Error('RFC-64 finalized policy differs from the configured chain id');
    }
    assertCanonicalDecimalU256(
      onChainContextGraphId,
      'RFC-64 finalized policy on-chain context graph id',
    );
  });
}
