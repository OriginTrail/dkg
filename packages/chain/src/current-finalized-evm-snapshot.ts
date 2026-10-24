import {
  type BlockNumberV1,
  type ChainIdV1,
  type Digest32V1,
} from '@origintrail-official/dkg-core';

import {
  CURRENT_FINALIZED_EVM_READ_MAX_CALLS_V1,
} from './current-finalized-evm-read-profile.js';
import {
  type StrictCurrentFinalizedEvmReadCallV1,
} from './current-finalized-evm-read-model.js';

/** One heavyweight pinned scan per chain; each scan still batches up to four calls. */
export const CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_CONCURRENT_PER_CHAIN_V1 = 1;
export const CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_BATCHES_V1 = 1_024;
export const CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_CALLS_V1 =
  CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_BATCHES_V1 * CURRENT_FINALIZED_EVM_READ_MAX_CALLS_V1;
export const CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_DECLARED_RETURN_BYTES_V1 = 16 * 1024 * 1024;
export const CURRENT_FINALIZED_EVM_SNAPSHOT_TOTAL_DEADLINE_MS_V1 = 60_000;

export interface StrictCurrentFinalizedEvmSnapshotRequestV1 {
  readonly chainId: ChainIdV1;
  readonly signal: AbortSignal;
}

/**
 * Scoped capability for dynamic pages at one transport-owned finalized anchor.
 * The read method becomes unusable as soon as its callback settles.
 */
export interface StrictCurrentFinalizedEvmSnapshotSessionV1 {
  readonly chainId: ChainIdV1;
  readonly blockNumber: BlockNumberV1;
  readonly blockHash: Digest32V1;
  readonly read: (
    calls: readonly StrictCurrentFinalizedEvmReadCallV1[],
  ) => Promise<readonly string[]>;
}

export interface StrictCurrentFinalizedEvmSnapshotScopeV1 {
  <T>(
    request: StrictCurrentFinalizedEvmSnapshotRequestV1,
    consume: (session: StrictCurrentFinalizedEvmSnapshotSessionV1) => Promise<T>,
  ): Promise<T>;
}

export interface CurrentFinalizedEvmSnapshotBudgetV1 {
  readonly consume: (calls: readonly StrictCurrentFinalizedEvmReadCallV1[]) => void;
  readonly snapshot: () => Readonly<{
    batches: number;
    calls: number;
    declaredReturnBytes: number;
  }>;
}

/** Package-internal pure budget used by the scoped transport and cap tests. */
export function createCurrentFinalizedEvmSnapshotBudgetV1(
): CurrentFinalizedEvmSnapshotBudgetV1 {
  let batches = 0;
  let calls = 0;
  let declaredReturnBytes = 0;

  return Object.freeze({
    consume: (batch: readonly StrictCurrentFinalizedEvmReadCallV1[]) => {
      const nextBatches = batches + 1;
      const nextCalls = calls + batch.length;
      const nextDeclaredReturnBytes = batch.reduce(
        (total, call) => total + call.maxReturnBytes,
        declaredReturnBytes,
      );
      if (
        nextBatches > CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_BATCHES_V1
        || nextCalls > CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_CALLS_V1
        || nextDeclaredReturnBytes > CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_DECLARED_RETURN_BYTES_V1
      ) {
        throw new RangeError('Current-finalized snapshot scan exceeded its fixed resource budget');
      }
      batches = nextBatches;
      calls = nextCalls;
      declaredReturnBytes = nextDeclaredReturnBytes;
    },
    snapshot: () => Object.freeze({ batches, calls, declaredReturnBytes }),
  });
}
