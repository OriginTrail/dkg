// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import type { ChainIdV1, ContextGraphIdV1, DecimalU256V1, EvmAddressV1 } from '@origintrail-official/dkg-core';
import type { StrictCurrentFinalizedEvmSnapshotScopeV1 } from '@origintrail-official/dkg-chain';

const storage = new ethers.Interface([
  'function getContextGraph(uint256 contextGraphId) view returns (address owner, address[] participantAgents, uint256 metadataBatchId, bool active, uint256 createdAt, uint8 accessPolicy, uint8 publishPolicy, address publishAuthority, uint256 publishAuthorityAccountId)',
  'function getNameHash(uint256 contextGraphId) view returns (bytes32)',
  'function getContextGraphKaCount(uint256 contextGraphId) view returns (uint256)',
]);
const hub = new ethers.Interface([
  'function getAssetStorageAddress(string assetStorageName) view returns (address)',
]);

/**
 * A fresh registered private graph has no VM catalog genesis to download. A
 * local join, an empty peer response, and an accepted catalog snapshot cannot
 * establish that VM is empty. Instead bind the caller's chain membership,
 * graph name/policy, active Hub storage, and zero KA count at ONE current
 * finalized anchor. This grants no shared-memory or query readiness.
 */
export async function proveRegisteredPrivateEmptyVmV1(input: {
  contextGraphId: ContextGraphIdV1;
  onChainContextGraphId: DecimalU256V1;
  callerAgentAddress: EvmAddressV1;
  chainId: ChainIdV1;
  hubAddress: EvmAddressV1;
  governanceContractAddress: EvmAddressV1;
  snapshot: StrictCurrentFinalizedEvmSnapshotScopeV1;
  signal: AbortSignal;
}): Promise<boolean> {
  const id = BigInt(input.onChainContextGraphId);
  return input.snapshot({ chainId: input.chainId, signal: input.signal }, async (session) => {
    const [tupleData, nameData, countData, storageData] = await session.read([
      { to: input.governanceContractAddress, data: storage.encodeFunctionData('getContextGraph', [id]), maxReturnBytes: 9 * 1024 },
      { to: input.governanceContractAddress, data: storage.encodeFunctionData('getNameHash', [id]), maxReturnBytes: 32 },
      { to: input.governanceContractAddress, data: storage.encodeFunctionData('getContextGraphKaCount', [id]), maxReturnBytes: 32 },
      { to: input.hubAddress, data: hub.encodeFunctionData('getAssetStorageAddress', ['ContextGraphStorage']), maxReturnBytes: 32 },
    ]);
    if (!tupleData || !nameData || !countData || !storageData) return false;
    const tuple = storage.decodeFunctionResult('getContextGraph', tupleData);
    const name = storage.decodeFunctionResult('getNameHash', nameData);
    const count = storage.decodeFunctionResult('getContextGraphKaCount', countData);
    const binding = hub.decodeFunctionResult('getAssetStorageAddress', storageData);
    if (storage.encodeFunctionResult('getContextGraph', [...tuple]).toLowerCase() !== tupleData.toLowerCase()
      || storage.encodeFunctionResult('getNameHash', [...name]).toLowerCase() !== nameData.toLowerCase()
      || storage.encodeFunctionResult('getContextGraphKaCount', [...count]).toLowerCase() !== countData.toLowerCase()
      || hub.encodeFunctionResult('getAssetStorageAddress', [...binding]).toLowerCase() !== storageData.toLowerCase()) return false;
    const members = tuple.participantAgents as readonly string[];
    return tuple.active === true && Number(tuple.accessPolicy) === 1
      && String(name[0]).toLowerCase() === ethers.keccak256(ethers.toUtf8Bytes(input.contextGraphId)).toLowerCase()
      && String(binding[0]).toLowerCase() === input.governanceContractAddress
      && members.some((member) => member.toLowerCase() === input.callerAgentAddress)
      && count[0] === 0n;
  });
}
