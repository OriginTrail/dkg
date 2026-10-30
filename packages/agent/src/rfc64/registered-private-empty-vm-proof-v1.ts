// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import type { ChainIdV1, DecimalU256V1, EvmAddressV1 } from '@origintrail-official/dkg-core';
import {
  readFinalizedContextGraphEmptyVmFactsInSnapshotV1,
  type StrictCurrentFinalizedEvmSnapshotScopeV1,
} from '@origintrail-official/dkg-chain';

/**
 * `proven`: every condition holds. `not-empty`: the graph has Knowledge Assets,
 * so this proof can never hold for it. `unproven`: another condition does not
 * hold at this anchor, which a later finalized anchor can change for a graph
 * registered or joined moments ago.
 */
export type RegisteredPrivateEmptyVmProofV1 = 'proven' | 'not-empty' | 'unproven';

/**
 * A fresh registered private graph has no VM catalog genesis to download. A
 * local join, an empty peer response, and an accepted catalog snapshot cannot
 * establish that VM is empty. Instead bind the caller's chain membership,
 * graph name/policy, active Hub storage, and zero KA count at ONE current
 * finalized anchor. This grants no shared-memory or query readiness.
 */
export async function proveRegisteredPrivateEmptyVmV1(input: {
  // Chain registration hashes the exact DKG graph name; the author-lane
  // ContextGraphIdV1 grammar is narrower than the names DKG can register.
  contextGraphId: string;
  onChainContextGraphId: DecimalU256V1;
  callerAgentAddress: EvmAddressV1;
  chainId: ChainIdV1;
  hubAddress: EvmAddressV1;
  governanceContractAddress: EvmAddressV1;
  snapshot: StrictCurrentFinalizedEvmSnapshotScopeV1;
  signal: AbortSignal;
}): Promise<RegisteredPrivateEmptyVmProofV1> {
  return input.snapshot({ chainId: input.chainId, signal: input.signal }, async (session) => {
    const facts = await readFinalizedContextGraphEmptyVmFactsInSnapshotV1({
      contextGraphId: input.onChainContextGraphId,
      contextGraphStorageAddress: input.governanceContractAddress,
      hubAddress: input.hubAddress,
      session,
    });
    if (facts === null
      || facts.nameHash !== ethers.keccak256(ethers.toUtf8Bytes(input.contextGraphId)).toLowerCase()
      || facts.contextGraphStorageAddress !== input.governanceContractAddress) return 'unproven';
    // The count is this graph's only once its name and storage binding hold.
    if (facts.kaCount !== 0n) return 'not-empty';
    return facts.active && facts.accessPolicy === 1 && facts.participantAgents.includes(input.callerAgentAddress)
      ? 'proven' : 'unproven';
  });
}
