import type { PublishResult } from './publisher.js';
import {
  createLiftJobFailureMetadata,
  type LiftJobBroadcastMetadata,
  type LiftJobFailureMetadata,
  type LiftJobFinalizationMetadata,
  type LiftJobInclusionMetadata,
  type LiftJobTimeoutMetadata,
} from './lift-job.js';

export interface AsyncLiftPublishSuccess {
  readonly status: 'included' | 'finalized';
  readonly broadcast: LiftJobBroadcastMetadata;
  readonly inclusion: LiftJobInclusionMetadata;
  readonly finalization?: LiftJobFinalizationMetadata & { readonly mode?: 'published' };
}

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

  if (!onChain) {
    throw new Error(
      `Canonical publish returned status ${publishResult.status} without onChainResult. Async lift can only map results that include chain submission/finality details. Check chain configuration, publisher wallet, and canonical publish behavior.`,
    );
  }

  const txHash = onChain.txHash as `0x${string}`;
  const merkleRoot = toHex(publishResult.merkleRoot) as `0x${string}`;

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
    case 'failed':
      throw new Error('Async lift publish result cannot map failed canonical publish into success state');
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
