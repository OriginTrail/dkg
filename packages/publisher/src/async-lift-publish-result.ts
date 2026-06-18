import type { PublishResult } from './publisher.js';
import {
  createLiftJobFailureMetadata,
  type LiftJobBroadcastMetadata,
  type LiftJobFailureMetadata,
  type LiftJobFinalizationMetadata,
  type LiftJobInclusionMetadata,
  type LiftJobTimeoutMetadata,
} from './lift-job.js';

export type AsyncLiftPublishSuccess =
  | {
      readonly status: 'included';
      readonly broadcast: LiftJobBroadcastMetadata;
      readonly inclusion: LiftJobInclusionMetadata;
      readonly finalization?: undefined;
    }
  | {
      readonly status: 'finalized';
      readonly broadcast: LiftJobBroadcastMetadata;
      readonly inclusion: LiftJobInclusionMetadata;
      readonly finalization: LiftJobFinalizationMetadata & { readonly mode?: 'published' };
    }
  | {
      readonly status: 'finalized';
      readonly broadcast?: undefined;
      readonly inclusion?: undefined;
      readonly finalization: LiftJobFinalizationMetadata & { readonly mode: 'local' };
    };

export interface AsyncLiftPublishFailureInput {
  readonly error: unknown;
  readonly failedFromState: Extract<LiftJobFailureMetadata['failedFromState'], 'broadcast' | 'included'>;
  readonly errorPayloadRef: string;
  readonly stackTraceRef?: string;
  readonly rpcResponseRef?: string;
  readonly revertReasonRef?: string;
  readonly timeout?: LiftJobTimeoutMetadata;
}

export function mapPublishResultToLiftJobSuccess(params: {
  publishResult: PublishResult;
  walletId: string;
  publicByteSize?: number;
}): AsyncLiftPublishSuccess {
  const { publishResult, walletId, publicByteSize } = params;
  const onChain = publishResult.onChainResult;

  const merkleRoot = toHex(publishResult.merkleRoot) as `0x${string}`;

  if (publishResult.status === 'failed') {
    throw new Error('Async lift publish result cannot map failed canonical publish into success state');
  }

  if (!onChain) {
    // GH #1013 — a private publish that failed to reach its chain-registered CG
    // (no collectable ACKs) must NOT be reported as `finalized` with a
    // provisional UAL. Fail honestly so callers can tell "stored locally, not on
    // chain" from a real on-chain finalization. (Reaching chain for private CGs
    // is the #1121 encryption work.) The data is still staged locally under the
    // provisional UAL, surfaced in the error for debugging/recovery.
    if (publishResult.status === 'tentative' && publishResult.localChainSkipReason === 'private-no-acks') {
      throw new Error(
        `Async publish to a chain-registered context graph could not reach Verifiable Memory: ` +
        `private payload had no collectable storage ACKs (peers cannot see private data). ` +
        `Data is staged locally under provisional UAL ${publishResult.ual} but is NOT on chain. ` +
        `See GH #1013 (honesty) and GH #1121 (encrypted private async publish).`,
      );
    }
    if (publishResult.status === 'tentative') {
      // Honest local finalization: there is genuinely no chain to reach
      // (`no-chain` skip reason, or a legacy/no-chain-adapter node).
      return {
        status: 'finalized',
        finalization: {
          mode: 'local',
          ual: publishResult.ual,
        },
      };
    }
    throw new Error(
      `Canonical publish returned ${publishResult.status} without onChainResult. Async lift cannot mark chain inclusion without a real transaction hash.`,
    );
  }

  const txHash = onChain.txHash as `0x${string}`;

  const broadcast: LiftJobBroadcastMetadata = {
    txHash,
    walletId,
    merkleRoot,
    publicByteSize,
  };

  const inclusion: LiftJobInclusionMetadata = {
    txHash,
    blockNumber: onChain.blockNumber,
    blockTimestamp: onChain.blockTimestamp,
  };

  switch (publishResult.status) {
    case 'tentative':
      return {
        status: 'included',
        broadcast,
        inclusion,
      };
    case 'confirmed':
      return {
        status: 'finalized',
        broadcast,
        inclusion,
        finalization: {
          mode: 'published',
          txHash,
          ual: publishResult.ual,
          batchId: onChain.batchId.toString() as `${bigint}`,
          startKAId: onChain.startKAId?.toString() as `${bigint}` | undefined,
          endKAId: onChain.endKAId?.toString() as `${bigint}` | undefined,
          publisherAddress: onChain.publisherAddress as `0x${string}`,
        },
      };
    default:
      throw new Error(`Async lift publish result cannot map unsupported canonical publish status: ${publishResult.status}`);
  }
}

export function mapPublishExceptionToLiftJobFailure(
  input: AsyncLiftPublishFailureInput,
): LiftJobFailureMetadata {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const lower = message.toLowerCase();

  const code = classifyPublishFailureCode(lower, input.failedFromState);

  return createLiftJobFailureMetadata({
    failedFromState: input.failedFromState,
    code,
    message,
    errorPayloadRef: input.errorPayloadRef,
    stackTraceRef: input.stackTraceRef,
    rpcResponseRef: input.rpcResponseRef,
    revertReasonRef: input.revertReasonRef,
    timeout: input.timeout,
  });
}

function classifyPublishFailureCode(
  lowerMessage: string,
  failedFromState: AsyncLiftPublishFailureInput['failedFromState'],
): LiftJobFailureMetadata['code'] {
  // GH #1013/#1121 (Codex #1132 review): a private payload that could not reach
  // Verifiable Memory (no collectable storage ACKs) is a DETERMINISTIC terminal
  // failure — classifying it as the default retryable `rpc_unavailable` made the
  // queue reset/retry forever a job that can never finalize until encrypted
  // private async publish (#1121) lands. The message is emitted verbatim by
  // mapPublishResultToLiftJobSuccess for this exact condition.
  if (lowerMessage.includes('no collectable storage acks')) {
    return 'private_unanchorable';
  }
  if (lowerMessage.includes('timeout') || lowerMessage.includes('timed out')) {
    return failedFromState === 'included' ? 'finality_timeout' : 'tx_submit_timeout';
  }
  if (lowerMessage.includes('insufficient funds')) {
    return 'insufficient_funds';
  }
  if (lowerMessage.includes('nonce')) {
    return 'nonce_conflict';
  }
  if (lowerMessage.includes('revert') || lowerMessage.includes('reverted')) {
    return 'tx_reverted';
  }
  if (lowerMessage.includes('reorg')) {
    return 'chain_reorg';
  }
  if (lowerMessage.includes('mismatch')) {
    return 'confirmation_mismatch';
  }
  if (failedFromState === 'included') {
    // Included-phase failures must still terminate the job safely even when the
    // executor reports an unexpected confirmation-side error shape.
    return 'confirmation_mismatch';
  }
  return 'rpc_unavailable';
}

function toHex(bytes: Uint8Array): string {
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
