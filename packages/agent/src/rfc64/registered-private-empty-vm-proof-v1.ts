// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import type { ChainIdV1, DecimalU256V1, EvmAddressV1 } from '@origintrail-official/dkg-core';
import {
  readFinalizedContextGraphEmptyVmFactsInSnapshotV1,
  type StrictCurrentFinalizedEvmSnapshotScopeV1,
} from '@origintrail-official/dkg-chain';

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
}): Promise<boolean> {
  return input.snapshot({ chainId: input.chainId, signal: input.signal }, async (session) => {
    const facts = await readFinalizedContextGraphEmptyVmFactsInSnapshotV1({
      contextGraphId: input.onChainContextGraphId,
      contextGraphStorageAddress: input.governanceContractAddress,
      hubAddress: input.hubAddress,
      session,
    });
    return facts !== null && facts.active && facts.accessPolicy === 1
      && facts.nameHash === ethers.keccak256(ethers.toUtf8Bytes(input.contextGraphId)).toLowerCase()
      && facts.contextGraphStorageAddress === input.governanceContractAddress
      && facts.participantAgents.includes(input.callerAgentAddress)
      && facts.kaCount === 0n;
  });
}
