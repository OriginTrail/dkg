import {
  assertCanonicalDecimalU256,
  assertCanonicalDigest,
  canonicalizeContextGraphPolicyPayloadV1,
  canonicalizeMemberRosterPayloadV1,
  parseCanonicalContextGraphPolicyPayloadV1,
  parseCanonicalMemberRosterPayloadV1,
  type AuthorCatalogScopeV1,
  type ChainIdV1,
  type ContextGraphIdV1,
  type DecimalU256V1,
  type EvmAddressV1,
  type MemberRosterV1,
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
  let roster: Readonly<MemberRosterV1> | null;
  try {
    assertCanonicalDigest(plan.policyDigest, 'RFC-64 finalized precommit plan policy digest');
    assertCanonicalDigest(
      untrustedAcceptedPolicy.policyDigest,
      'RFC-64 finalized precommit policy digest',
    );
    if (untrustedAcceptedPolicy.policyDigest !== plan.policyDigest) {
      throw new Error('accepted-current policy generation differs from the transfer plan');
    }
    policy = parseCanonicalContextGraphPolicyPayloadV1(
      canonicalizeContextGraphPolicyPayloadV1(untrustedAcceptedPolicy.policy),
    );
    roster = untrustedAcceptedPolicy.roster === null
      ? null
      : parseCanonicalMemberRosterPayloadV1(
        canonicalizeMemberRosterPayloadV1(untrustedAcceptedPolicy.roster),
      );
    assertAcceptedPolicyMatchesPlanV1(policy, plan.catalogScope);
    assertRosterMatchesAcceptedPolicyV1(
      roster,
      policy,
      untrustedAcceptedPolicy.policyDigest,
      plan.catalogScope.authorAddress,
    );
  } catch (cause) {
    const detail = cause instanceof Error ? `: ${cause.message}` : '';
    throw new Error(
      `RFC-64 finalized precommit accepted policy is not canonical${detail}`,
      { cause },
    );
  }
  if (policy.source.kind !== 'finalized-chain') return null;
  const acceptedPolicy = Object.freeze({
    policy,
    policyDigest: untrustedAcceptedPolicy.policyDigest,
    roster,
  });
  const chainId = policy.governanceChainId;
  const contextGraphStorageAddress = policy.governanceContractAddress;
  if (
    chainId === null
    || contextGraphStorageAddress === null
  ) {
    throw new Error('RFC-64 finalized precommit requires one finalized policy');
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
 * catalog; this barrier verifies the accepted policy, cleartext CG name,
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
    if (resolved === null) {
      assertPlanPolicyAndRosterCurrentV1(options, plan);
      return;
    }
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
    assertRfc64FinalizedPolicyAgentPrecommitSnapshotCurrentV1(
      options,
      plan,
      resolved.acceptedPolicy,
    );
  });
}

function assertPlanPolicyAndRosterCurrentV1(
  options: Rfc64FinalizedPolicyAgentPrecommitResolutionOptionsV1,
  plan: Readonly<Rfc64PublicCatalogNativeBeforeAppliedHeadCommitPlanV1>,
): void {
  const current = options.acceptedPolicySnapshotForCatalogScope(plan.catalogScope);
  assertCanonicalDigest(current.policyDigest, 'RFC-64 current precommit policy digest');
  if (current.policyDigest !== plan.policyDigest) {
    throw new Error('RFC-64 accepted policy changed during catalog precommit');
  }
  const policy = parseCanonicalContextGraphPolicyPayloadV1(
    canonicalizeContextGraphPolicyPayloadV1(current.policy),
  );
  const roster = current.roster === null
    ? null
    : parseCanonicalMemberRosterPayloadV1(
      canonicalizeMemberRosterPayloadV1(current.roster),
    );
  assertAcceptedPolicyMatchesPlanV1(policy, plan.catalogScope);
  assertRosterMatchesAcceptedPolicyV1(
    roster,
    policy,
    current.policyDigest,
    plan.catalogScope.authorAddress,
  );
}

function assertAcceptedPolicyMatchesPlanV1(
  policy: AcceptedRfc64CatalogAccessSnapshotV1['policy'],
  scope: Readonly<AuthorCatalogScopeV1>,
): void {
  if (
    policy.networkId !== scope.networkId
    || policy.contextGraphId !== scope.contextGraphId
    || policy.governanceChainId !== scope.governanceChainId
    || policy.governanceContractAddress !== scope.governanceContractAddress
    || policy.ownershipTransitionDigest !== scope.ownershipTransitionDigest
    || policy.era !== scope.era
  ) {
    throw new Error('accepted policy differs from the exact catalog scope');
  }
}

function assertRosterMatchesAcceptedPolicyV1(
  roster: Readonly<MemberRosterV1> | null,
  policy: AcceptedRfc64CatalogAccessSnapshotV1['policy'],
  policyDigest: AcceptedRfc64CatalogAccessSnapshotV1['policyDigest'],
  authorAddress: EvmAddressV1,
): void {
  if (policy.accessPolicy === 0) {
    if (roster !== null) {
      throw new Error('public RFC-64 policy forbids a private member roster');
    }
    return;
  }
  if (
    roster === null
    || roster.networkId !== policy.networkId
    || roster.contextGraphId !== policy.contextGraphId
    || roster.ownershipTransitionDigest !== policy.ownershipTransitionDigest
    || roster.era !== policy.era
    || roster.policyDigest !== policyDigest
    || roster.administrativeDelegationDigest !== policy.administrativeDelegationDigest
    || !roster.members.some((member) => member.agentAddress === authorAddress)
  ) {
    throw new Error(
      'private RFC-64 precommit requires the exact current policy-bound roster and author membership',
    );
  }
}

export function assertRfc64FinalizedPolicyAgentPrecommitSnapshotCurrentV1(
  options: Rfc64FinalizedPolicyAgentPrecommitResolutionOptionsV1,
  plan: Readonly<Rfc64PublicCatalogNativeBeforeAppliedHeadCommitPlanV1>,
  expected: Readonly<AcceptedRfc64CatalogAccessSnapshotV1>,
): void {
  const current = options.acceptedPolicySnapshotForCatalogScope(plan.catalogScope);
  if (
    current.policyDigest !== plan.policyDigest
    || current.policyDigest !== expected.policyDigest
    || canonicalizeContextGraphPolicyPayloadV1(current.policy)
      !== canonicalizeContextGraphPolicyPayloadV1(expected.policy)
    || (current.roster === null) !== (expected.roster === null)
    || (
      current.roster !== null
      && expected.roster !== null
      && canonicalizeMemberRosterPayloadV1(current.roster)
        !== canonicalizeMemberRosterPayloadV1(expected.roster)
    )
  ) {
    throw new Error('RFC-64 accepted policy or roster changed during catalog precommit');
  }
}
