// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import type { ContextGraphIdV1, DecimalU256V1, EvmAddressV1 } from '@origintrail-official/dkg-core';
import type { StrictCurrentFinalizedEvmSnapshotScopeV1 } from '@origintrail-official/dkg-chain';
import { assertAcceptedRfc64CatalogPolicyRosterV1, type AcceptedRfc64CatalogAccessSnapshotV1 } from './catalog-access-policy-v1.js';
import { resolveAndVerifyRfc64FinalizedPolicyInSnapshotV1 } from './finalized-policy-verifier-v1.js';

const storage = new ethers.Interface([
  'function getContextGraphKaCount(uint256 contextGraphId) view returns (uint256)',
]);

/**
 * Prove only the durable plane of a newly joined, empty registered private CG.
 * A private peer's empty payload is ambiguous (it may be filtered); the chain's
 * finalized VM inventory is not. Policy/name and zero count are read at the
 * SAME pinned anchor. This says nothing about shared memory.
 */
export async function proveRegisteredPrivateEmptyVmV1(input: {
  contextGraphId: ContextGraphIdV1;
  onChainContextGraphId: DecimalU256V1;
  callerAgentAddress: EvmAddressV1;
  accepted: AcceptedRfc64CatalogAccessSnapshotV1;
  snapshot: StrictCurrentFinalizedEvmSnapshotScopeV1;
  signal: AbortSignal;
}): Promise<boolean> {
  const { accepted } = input;
  const policy = accepted.policy;
  if (policy.accessPolicy !== 1 || policy.source.kind !== 'finalized-chain'
    || policy.governanceChainId === null || policy.governanceContractAddress === null
    || policy.contextGraphId !== input.contextGraphId) return false;
  assertAcceptedRfc64CatalogPolicyRosterV1(policy, accepted.policyDigest, accepted.roster);
  if (!accepted.roster?.members.some((member) =>
    member.agentAddress === input.callerAgentAddress)) return false;

  return input.snapshot({ chainId: policy.governanceChainId, signal: input.signal }, async (session) => {
    await resolveAndVerifyRfc64FinalizedPolicyInSnapshotV1({
      networkId: policy.networkId,
      chainId: policy.governanceChainId!,
      contextGraphStorageAddress: policy.governanceContractAddress!,
    }, {
      catalogLane: { contextGraphId: input.contextGraphId, subGraphName: null },
      onChainContextGraphId: input.onChainContextGraphId,
      acceptedPolicy: policy,
      signal: input.signal,
    }, session);
    const returned = await session.read([{
      to: policy.governanceContractAddress!,
      data: storage.encodeFunctionData('getContextGraphKaCount', [
        BigInt(input.onChainContextGraphId),
      ]),
      maxReturnBytes: 32,
    }]);
    if (returned.length !== 1 || returned[0] === undefined) return false;
    const count = storage.decodeFunctionResult('getContextGraphKaCount', returned[0])[0];
    return typeof count === 'bigint' && count === 0n;
  });
}
