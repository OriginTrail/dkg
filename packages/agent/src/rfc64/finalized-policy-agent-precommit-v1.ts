import {
  assertCanonicalDecimalU256,
  assertCanonicalDigest,
  canonicalizeContextGraphPolicyPayloadV1,
  parseCanonicalContextGraphPolicyPayloadV1,
  type AuthorCatalogScopeV1,
  type ChainIdV1,
  type ContextGraphIdV1,
  type DecimalU256V1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';
import { createStrictCurrentFinalizedEvmSnapshotScopeV1 } from '@origintrail-official/dkg-chain';

import type { AcceptedRfc64CatalogAccessSnapshotV1 } from './catalog-access-policy-v1.js';
import {
  resolveAndVerifyRfc64FinalizedPolicyInSnapshotV1,
} from './finalized-policy-verifier-v1.js';
import type {
  Rfc64PublicCatalogNativeBeforeAppliedHeadCommitHandlerV1,
  Rfc64PublicCatalogNativeBeforeAppliedHeadCommitPlanV1,
} from './public-catalog-native-receiver-v1.js';

export interface Rfc64FinalizedPolicyAgentPrecommitResolutionOptionsV1 {
  readonly acceptedPolicySnapshotForCatalogScope:
    (scope: Readonly<AuthorCatalogScopeV1>) => AcceptedRfc64CatalogAccessSnapshotV1;
  readonly rpcEndpoints: readonly string[] | null;
  readonly getOnChainContextGraphId:
    (contextGraphId: ContextGraphIdV1, signal: AbortSignal) => Promise<string | null>;
  readonly getEvmChainId: () => Promise<bigint>;
}

export interface Rfc64FinalizedPolicyAgentPrecommitOptionsV1
  extends Rfc64FinalizedPolicyAgentPrecommitResolutionOptionsV1 {}

export interface ResolvedRfc64FinalizedPolicyAgentPrecommitV1 {
  readonly acceptedPolicy: AcceptedRfc64CatalogAccessSnapshotV1;
  readonly chainId: ChainIdV1;
  readonly contextGraphStorageAddress: EvmAddressV1;
  readonly onChainContextGraphId: DecimalU256V1;
  readonly rpcEndpoints: readonly string[];
}

/**
 * Resolve and snapshot the shared agent/chain boundary used by both finalized
 * policy-only and VM-materializing precommits. Returning null means the
 * accepted policy is not chain-finalized and therefore needs no EVM barrier.
 */
export async function resolveRfc64FinalizedPolicyAgentPrecommitV1(
  options: Rfc64FinalizedPolicyAgentPrecommitResolutionOptionsV1,
  plan: Readonly<Rfc64PublicCatalogNativeBeforeAppliedHeadCommitPlanV1>,
  signal: AbortSignal,
): Promise<Readonly<ResolvedRfc64FinalizedPolicyAgentPrecommitV1> | null> {
  signal.throwIfAborted();
  const untrustedAcceptedPolicy = options.acceptedPolicySnapshotForCatalogScope(
    plan.catalogScope,
  );
  let policy: AcceptedRfc64CatalogAccessSnapshotV1['policy'];
  try {
    assertCanonicalDigest(
      untrustedAcceptedPolicy.policyDigest,
      'RFC-64 finalized precommit policy digest',
    );
    policy = parseCanonicalContextGraphPolicyPayloadV1(
      canonicalizeContextGraphPolicyPayloadV1(untrustedAcceptedPolicy.policy),
    );
  } catch (cause) {
    throw new Error('RFC-64 finalized precommit accepted policy is not canonical', { cause });
  }
  if (policy.source.kind !== 'finalized-chain') return null;
  if (untrustedAcceptedPolicy.roster !== null) {
    throw new Error('RFC-64 finalized precommit public policy forbids a private member roster');
  }
  const acceptedPolicy = Object.freeze({
    policy,
    policyDigest: untrustedAcceptedPolicy.policyDigest,
    roster: null,
  });
  const chainId = policy.governanceChainId;
  const contextGraphStorageAddress = policy.governanceContractAddress;
  if (
    policy.accessPolicy !== 0
    || chainId === null
    || contextGraphStorageAddress === null
  ) {
    throw new Error('RFC-64 finalized precommit requires one public finalized policy');
  }
  if (
    policy.source.chainId !== chainId
    || policy.source.contractAddress !== contextGraphStorageAddress
  ) {
    throw new Error('RFC-64 finalized precommit source differs from its governance binding');
  }
  if (options.rpcEndpoints === null || options.rpcEndpoints.length === 0) {
    throw new Error('RFC-64 finalized precommit requires trusted RPC configuration');
  }
  const rpcEndpoints = Object.freeze([...options.rpcEndpoints]);

  const [untrustedContextGraphId, liveChainId] = await Promise.all([
    options.getOnChainContextGraphId(plan.catalogScope.contextGraphId, signal),
    options.getEvmChainId(),
  ]);
  signal.throwIfAborted();
  if (untrustedContextGraphId === null) {
    throw new Error('RFC-64 finalized precommit could not resolve the numeric context graph id');
  }
  if (liveChainId.toString() !== chainId) {
    throw new Error('RFC-64 finalized precommit policy differs from the configured chain id');
  }
  assertCanonicalDecimalU256(
    untrustedContextGraphId,
    'RFC-64 finalized precommit on-chain context graph id',
  );
  if (untrustedContextGraphId === '0') {
    throw new Error('RFC-64 finalized precommit on-chain context graph id must be nonzero');
  }
  return Object.freeze({
    acceptedPolicy,
    chainId,
    contextGraphStorageAddress,
    onChainContextGraphId: untrustedContextGraphId,
    rpcEndpoints,
  });
}

/**
 * Guard a finalized-chain SWM catalog before its applied-head CAS without
 * treating catalog rows as a second VM inventory. The chain remains the VM
 * catalog; this barrier verifies the accepted public policy, cleartext CG name,
 * governance binding, and finality anchor against live chain state only.
 */
export function createRfc64FinalizedPolicyAgentPrecommitV1(
  options: Rfc64FinalizedPolicyAgentPrecommitOptionsV1,
): Rfc64PublicCatalogNativeBeforeAppliedHeadCommitHandlerV1 {
  return Object.freeze(async (plan, signal): Promise<void> => {
    const resolved = await resolveRfc64FinalizedPolicyAgentPrecommitV1(
      options,
      plan,
      signal,
    );
    if (resolved === null) return;
    const snapshot = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      chainId: resolved.chainId,
      endpoints: resolved.rpcEndpoints,
      // One process-wide per-chain gate protects concurrent policy and VM
      // reads even though each precommit owns its own snapshot scope.
      owner: 'rfc64',
    });
    await snapshot(
      { chainId: resolved.chainId, signal },
      (session) => resolveAndVerifyRfc64FinalizedPolicyInSnapshotV1(
        {
          networkId: plan.catalogScope.networkId,
          chainId: resolved.chainId,
          contextGraphStorageAddress: resolved.contextGraphStorageAddress,
        },
        {
          catalogLane: Object.freeze({
            contextGraphId: plan.catalogScope.contextGraphId,
            subGraphName: plan.catalogScope.subGraphName,
          }),
          onChainContextGraphId: resolved.onChainContextGraphId,
          acceptedPolicy: resolved.acceptedPolicy.policy,
          signal,
        },
        session,
      ),
    );
  });
}
