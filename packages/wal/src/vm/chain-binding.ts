import { validateProtocolTuple } from '../protocol/codec.js';
import type { ProtocolTuple } from '../protocol/schema.js';
import { walVmError } from './errors.js';
import { vmBytesEqualV1 } from './move-tier.js';
import type { CurrentVmFinalityPolicyV1 } from './types.js';

const U32_MAX = 0xffff_ffffn;

function allZero(value: Uint8Array): boolean {
  return value.every(byte => byte === 0);
}

export function validateVmChainBindingV1(
  binding: ProtocolTuple<'ChainBindingV1'>,
): void {
  validateProtocolTuple('ChainBindingV1', binding);
  if (binding[0] === 0n) walVmError('WAL_VM_INVALID', 'chainId must be nonzero');
  if (allZero(binding[1])) {
    walVmError('WAL_VM_INVALID', 'knowledgeAssetsContract must be nonzero');
  }
  if (allZero(binding[2]) || allZero(binding[3])) {
    walVmError('WAL_VM_INVALID', 'context-graph and KA identities must be nonzero');
  }
  if (binding[5] === 0n) {
    walVmError('WAL_VM_INVALID', 'assertionVersion must start at one');
  }
  for (const [label, value] of [
    ['merkleRoot', binding[6]],
    ['transactionHash', binding[7]],
    ['blockHash', binding[9]],
  ] as const) {
    if (allZero(value)) walVmError('WAL_VM_INVALID', label + ' must be nonzero');
  }
  if (binding[8] === 0n) walVmError('WAL_VM_INVALID', 'blockNumber must be nonzero');
}

export function effectiveVmFinalityBlocksV1(
  binding: ProtocolTuple<'ChainBindingV1'>,
  policy: CurrentVmFinalityPolicyV1,
): bigint {
  validateVmChainBindingV1(binding);
  if (
    !(policy.policyObjectId instanceof Uint8Array)
    || policy.policyObjectId.length !== 32
    || policy.minimumBlocks < 0n
    || policy.maximumBlocks < policy.minimumBlocks
    || policy.maximumBlocks > U32_MAX
  ) {
    walVmError('WAL_VM_FINALITY_POLICY', 'current signed VM finality policy is invalid');
  }
  const requested = binding[13];
  if (requested > policy.maximumBlocks) {
    walVmError(
      'WAL_VM_FINALITY_POLICY',
      'author-requested finality exceeds the signed network maximum',
    );
  }
  return requested > policy.minimumBlocks ? requested : policy.minimumBlocks;
}

export function vmChainConfirmationsV1(
  currentBlockNumber: bigint,
  evidenceBlockNumber: bigint,
): bigint {
  if (currentBlockNumber < 0n || evidenceBlockNumber < 0n) {
    walVmError('WAL_VM_INVALID', 'block numbers cannot be negative');
  }
  if (currentBlockNumber < evidenceBlockNumber) return 0n;
  return currentBlockNumber - evidenceBlockNumber;
}

export function isVmChainBindingFinalV1(
  binding: ProtocolTuple<'ChainBindingV1'>,
  currentBlockNumber: bigint,
  canonicalBlockHash: Uint8Array,
  policy: CurrentVmFinalityPolicyV1,
): boolean {
  if (
    !(canonicalBlockHash instanceof Uint8Array)
    || canonicalBlockHash.length !== 32
  ) walVmError('WAL_VM_INVALID', 'canonical block hash must be exactly 32 bytes');
  if (!vmBytesEqualV1(binding[9], canonicalBlockHash)) return false;
  return vmChainConfirmationsV1(currentBlockNumber, binding[8])
    >= effectiveVmFinalityBlocksV1(binding, policy);
}
