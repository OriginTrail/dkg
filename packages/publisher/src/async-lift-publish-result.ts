import { NO_FUNDED_PUBLISHER_WALLET_CODE, messageIndicatesNoFundedPublisherWallet } from '@origintrail-official/dkg-core';
import type { PublishResult } from './publisher.js';
import { isQuorumUnmetError } from './ack-errors.js';
import {
  createLiftJobFailureMetadata,
  isTimeoutLiftJobFailure,
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
    if ((publishResult as { localChainSkipReason?: unknown }).localChainSkipReason === 'private-no-acks') {
      throw new Error(
        'Async lift publish result cannot finalize legacy private-no-acks result as local success. ' +
        'The publish targeted chain finalization but did not collect ACKs; keep the job terminal-failed or rerun publish.',
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

  // The funded-wallet-selection error (dkg-chain `InsufficientPublisherFundsError`,
  // code `NO_FUNDED_PUBLISHER_WALLET`) carries a friendly "no operational wallet
  // has enough funds" message that does NOT contain the literal "insufficient
  // funds" substring `classifyPublishFailureCode` matches — so recognize it by
  // its structured code (with a message-marker fallback, mirroring the daemon +
  // node-ui, in case an intermediate re-wrap drops `.code`). Otherwise an
  // unfundable publish would fall through to the retryable `rpc_unavailable`
  // default and the queue would reset/retry a job that can never finalize (the
  // same forever-retry trap #1013/#1121 fixed). `insufficient_funds` is only
  // valid from the 'broadcast' state, so only force it there — funded selection
  // is a broadcast-phase concern; any other state falls back to the classifier.
  const errorCode = (input.error as { code?: unknown } | null | undefined)?.code;
  const isNoFundedWallet = errorCode === NO_FUNDED_PUBLISHER_WALLET_CODE
    || messageIndicatesNoFundedPublisherWallet(lower);
  const code = isNoFundedWallet && input.failedFromState === 'broadcast'
    ? 'insufficient_funds'
    : input.failedFromState === 'broadcast' && (
      isQuorumUnmetError(input.error) || lower.includes('quorumunmeterror')
    )
      ? 'quorum_unmet'
      : classifyPublishFailureCode(lower, input.failedFromState);

  return createLiftJobFailureMetadata({
    failedFromState: input.failedFromState,
    code,
    message,
    errorPayloadRef: input.errorPayloadRef,
    stackTraceRef: input.stackTraceRef,
    rpcResponseRef: input.rpcResponseRef,
    revertReasonRef: input.revertReasonRef,
    timeout: isTimeoutLiftJobFailure(code) ? input.timeout : undefined,
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
