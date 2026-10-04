// SPDX-License-Identifier: Apache-2.0
import { ethers } from 'ethers';
import type { ContextGraphAuthoritySnapshot } from './chain-adapter.js';
import type { ContextGraphAuthorityIndexState } from './context-graph-authority-index-checkpoint.js';
import { assertContextGraphAuthorityIndexId, type ContextGraphAuthorityIndexId } from './context-graph-authority-index-id.js';

export function snapshotAuthorityRevisionTargetsV1(
  contextGraphIds: unknown,
): readonly ContextGraphAuthorityIndexId[] {
  if (!Array.isArray(contextGraphIds)) {
    throw new Error('Context Graph authority revision target set is invalid');
  }
  const targets = new Set<ContextGraphAuthorityIndexId>();
  for (const contextGraphId of contextGraphIds as readonly unknown[]) {
    assertContextGraphAuthorityIndexId(
      contextGraphId,
      'Context Graph authority revision target id',
    );
    targets.add(contextGraphId);
  }
  return Object.freeze([...targets]);
}

export function snapshotAuthorityNameHashTargetsV1(
  nameHashes: unknown,
): readonly string[] {
  if (!Array.isArray(nameHashes)) {
    throw new Error('Context Graph authority name-hash target set is invalid');
  }
  const targets = new Set<string>();
  for (const nameHash of nameHashes as readonly unknown[]) {
    if (typeof nameHash !== 'string' || !ethers.isHexString(nameHash, 32)) {
      throw new TypeError('Context Graph authority name-hash target must be bytes32');
    }
    const normalized = nameHash.toLowerCase();
    if (normalized !== ethers.ZeroHash) targets.add(normalized);
  }
  return Object.freeze([...targets]);
}

export function authoritySnapshotV1(
  state: ContextGraphAuthorityIndexState,
  chainId: string,
  contractAddress: string,
): ContextGraphAuthoritySnapshot {
  return Object.freeze({
    chainId,
    governanceContract: contractAddress,
    ...state,
    contextGraphId: state.contextGraphId,
    ownershipEra: state.ownershipEra.toString(10),
    policyVersion: state.policyVersion.toString(10),
    rosterVersion: state.rosterVersion.toString(10),
    sourceBlockNumber: state.sourceBlockNumber.toString(10),
  });
}

