import type { ChainAdapter, ChainEvent } from '@origintrail-official/dkg-chain';
import {
  WAL_V1_ENUMS,
  type ProtocolTuple,
} from '@origintrail-official/dkg-wal';
import {
  effectiveVmFinalityBlocksV1,
  validateVmChainBindingV1,
  vmBytesEqualV1,
  vmChainConfirmationsV1,
  type CurrentVmFinalityPolicyV1,
} from '@origintrail-official/dkg-wal/vm';
import { ethers } from 'ethers';

const PUBLISH = BigInt(WAL_V1_ENUMS.chainEventType.PUBLISH);

export type DkgVmChainValidationReasonV1 =
  | 'VERIFIED_FINAL'
  | 'CHAIN_UNAVAILABLE'
  | 'INSUFFICIENT_FINALITY'
  | 'CHAIN_ID_MISMATCH'
  | 'CONTRACT_MISMATCH'
  | 'CONTEXT_GRAPH_MISMATCH'
  | 'KA_ID_MISMATCH'
  | 'AUTHOR_MISMATCH'
  | 'ASSERTION_VERSION_MISMATCH'
  | 'MERKLE_ROOT_MISMATCH'
  | 'TRANSACTION_MISMATCH'
  | 'EVENT_LOCATION_MISMATCH'
  | 'BLOCK_REORG';

export type DkgVmChainValidationResultV1 =
  | {
      readonly status: 'FINALIZED';
      readonly reason: 'VERIFIED_FINAL';
      readonly effectiveFinalityBlocks: bigint;
      readonly confirmations: bigint;
      readonly verifiedFrontier: ProtocolTuple<'ChainFrontierV1'>;
    }
  | {
      readonly status: 'PENDING';
      readonly reason: 'CHAIN_UNAVAILABLE' | 'INSUFFICIENT_FINALITY';
      readonly effectiveFinalityBlocks: bigint;
      readonly confirmations: bigint;
    }
  | {
      readonly status: 'REJECTED';
      readonly reason: Exclude<
        DkgVmChainValidationReasonV1,
        'VERIFIED_FINAL' | 'CHAIN_UNAVAILABLE' | 'INSUFFICIENT_FINALITY' | 'BLOCK_REORG'
      >;
      readonly effectiveFinalityBlocks: bigint;
      readonly confirmations: bigint;
    }
  | {
      readonly status: 'REORG';
      readonly reason: 'BLOCK_REORG';
      readonly effectiveFinalityBlocks: bigint;
      readonly confirmations: bigint;
    };

export interface ValidateCurrentDkgVmChainEvidenceInputV1 {
  readonly chain: ChainAdapter;
  readonly binding: ProtocolTuple<'ChainBindingV1'>;
  readonly finalityPolicy: CurrentVmFinalityPolicyV1;
}

function bytes32Bigint(value: Uint8Array): bigint {
  let result = 0n;
  for (const byte of value) result = (result << 8n) | BigInt(byte);
  return result;
}

function bytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (typeof value !== 'string' || !ethers.isHexString(value)) return null;
  try {
    return ethers.getBytes(value);
  } catch {
    return null;
  }
}

function integer(value: unknown): bigint | null {
  if (
    typeof value !== 'bigint'
    && typeof value !== 'number'
    && typeof value !== 'string'
  ) return null;
  try {
    const result = BigInt(value);
    return result >= 0n ? result : null;
  } catch {
    return null;
  }
}

function addressBytes(value: unknown): Uint8Array | null {
  if (typeof value !== 'string') return null;
  try {
    return ethers.getBytes(ethers.getAddress(value));
  } catch {
    return null;
  }
}

function exactAddress(value: unknown, expected: Uint8Array): boolean {
  const actual = addressBytes(value);
  return actual !== null && vmBytesEqualV1(actual, expected);
}

function result(
  status: 'PENDING' | 'REJECTED' | 'REORG',
  reason: DkgVmChainValidationReasonV1,
  effectiveFinalityBlocks: bigint,
  confirmations: bigint,
): DkgVmChainValidationResultV1 {
  return {
    status,
    reason,
    effectiveFinalityBlocks,
    confirmations,
  } as DkgVmChainValidationResultV1;
}

function matchingEvent(
  event: ChainEvent,
  binding: ProtocolTuple<'ChainBindingV1'>,
): DkgVmChainValidationReasonV1 | null {
  if (event.blockNumber !== Number(binding[8])) return 'EVENT_LOCATION_MISMATCH';
  const eventKaId = integer(event.data.kaId ?? event.data.batchId);
  if (eventKaId === null || eventKaId !== bytes32Bigint(binding[3])) {
    return 'KA_ID_MISMATCH';
  }
  const eventRoot = bytes(event.data.merkleRoot ?? event.data.newMerkleRoot);
  if (eventRoot === null || !vmBytesEqualV1(eventRoot, binding[6])) {
    return 'MERKLE_ROOT_MISMATCH';
  }
  const txHash = bytes(event.data.txHash);
  if (txHash === null || !vmBytesEqualV1(txHash, binding[7])) {
    return 'TRANSACTION_MISMATCH';
  }
  if (
    integer(event.data.txIndex) !== binding[10]
    || integer(event.data.logIndex) !== binding[11]
  ) return 'EVENT_LOCATION_MISMATCH';
  if (!exactAddress(event.data.author, binding[4])) return 'AUTHOR_MISMATCH';
  const blockHash = bytes(event.data.blockHash);
  if (blockHash === null || !vmBytesEqualV1(blockHash, binding[9])) {
    return 'BLOCK_REORG';
  }
  return null;
}

/**
 * Shared chain-evidence validator. It reads current chain truth only and owns
 * no WAL state or SWM/VM projection. Both synchronization drivers invoke this
 * exact function through DkgSemanticCore.
 */
export async function validateCurrentDkgVmChainEvidenceV1(
  input: ValidateCurrentDkgVmChainEvidenceInputV1,
): Promise<DkgVmChainValidationResultV1> {
  validateVmChainBindingV1(input.binding);
  const effectiveFinalityBlocks = effectiveVmFinalityBlocksV1(
    input.binding,
    input.finalityPolicy,
  );
  const binding = input.binding;
  const chain = input.chain;
  let head = binding[8];
  try {
    if (
      chain.chainType !== 'evm'
      || typeof chain.getDKGKnowledgeAssetsAddress !== 'function'
      || typeof chain.getKAContextGraphId !== 'function'
      || typeof chain.getLatestMerkleRoot !== 'function'
      || typeof chain.getMerkleRootCount !== 'function'
      || typeof chain.getLatestMerkleRootAuthor !== 'function'
      || typeof chain.getBlockNumber !== 'function'
    ) {
      return result('PENDING', 'CHAIN_UNAVAILABLE', effectiveFinalityBlocks, 0n);
    }
    const [
      chainId,
      contract,
      contextGraphId,
      merkleRoot,
      assertionVersion,
      author,
      currentHead,
    ] = await Promise.all([
      chain.getEvmChainId(),
      chain.getDKGKnowledgeAssetsAddress(),
      chain.getKAContextGraphId(bytes32Bigint(binding[3])),
      chain.getLatestMerkleRoot(bytes32Bigint(binding[3])),
      chain.getMerkleRootCount(bytes32Bigint(binding[3])),
      chain.getLatestMerkleRootAuthor(bytes32Bigint(binding[3])),
      chain.getBlockNumber(),
    ]);
    head = BigInt(currentHead);
    const confirmations = vmChainConfirmationsV1(head, binding[8]);
    if (chainId !== binding[0]) {
      return result('REJECTED', 'CHAIN_ID_MISMATCH', effectiveFinalityBlocks, confirmations);
    }
    if (!exactAddress(contract, binding[1])) {
      return result('REJECTED', 'CONTRACT_MISMATCH', effectiveFinalityBlocks, confirmations);
    }
    if (contextGraphId !== bytes32Bigint(binding[2])) {
      return result('REJECTED', 'CONTEXT_GRAPH_MISMATCH', effectiveFinalityBlocks, confirmations);
    }
    if (!vmBytesEqualV1(merkleRoot, binding[6])) {
      return result('REJECTED', 'MERKLE_ROOT_MISMATCH', effectiveFinalityBlocks, confirmations);
    }
    if (assertionVersion !== binding[5]) {
      return result('REJECTED', 'ASSERTION_VERSION_MISMATCH', effectiveFinalityBlocks, confirmations);
    }
    if (!exactAddress(author, binding[4])) {
      return result('REJECTED', 'AUTHOR_MISMATCH', effectiveFinalityBlocks, confirmations);
    }

    const expectedEventType = binding[12] === PUBLISH
      ? 'KCCreated'
      : 'KnowledgeAssetUpdated';
    const events: ChainEvent[] = [];
    for await (const event of chain.listenForEvents({
      eventTypes: [expectedEventType],
      fromBlock: Number(binding[8]),
      toBlock: Number(binding[8]),
    })) events.push(event);
    const exact = events.find(event => {
      const reason = matchingEvent(event, binding);
      return reason === null;
    });
    if (exact === undefined) {
      const reasons = events.map(event => matchingEvent(event, binding));
      if (reasons.includes('BLOCK_REORG') || events.length === 0) {
        return result('REORG', 'BLOCK_REORG', effectiveFinalityBlocks, confirmations);
      }
      return result(
        'REJECTED',
        reasons[0] as Exclude<DkgVmChainValidationReasonV1, 'BLOCK_REORG'>,
        effectiveFinalityBlocks,
        confirmations,
      );
    }
    if (confirmations < effectiveFinalityBlocks) {
      return result(
        'PENDING',
        'INSUFFICIENT_FINALITY',
        effectiveFinalityBlocks,
        confirmations,
      );
    }
    return {
      status: 'FINALIZED',
      reason: 'VERIFIED_FINAL',
      effectiveFinalityBlocks,
      confirmations,
      verifiedFrontier: [binding[0], binding[8], binding[9]],
    };
  } catch {
    return result(
      'PENDING',
      'CHAIN_UNAVAILABLE',
      effectiveFinalityBlocks,
      vmChainConfirmationsV1(head, binding[8]),
    );
  }
}
