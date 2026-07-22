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

/**
 * #1867 — a DEFINITIVE pre-acceptance send failure: an error the chain node returns while
 * REJECTING the transaction before it is admitted to the mempool, so the tx provably never
 * propagated and can never be mined. Only such errors may short-circuit the write-ahead
 * `'broadcast'` recovery early-return into an immediate terminal failure. Every ambiguous
 * error — RPC timeouts, `replacement transaction underpriced`, nonce races, `already known`,
 * and reverts (post-mempool by definition) — MUST stay on the recovery track, or the #1851
 * write-ahead durability guarantee regresses and a double-submit becomes possible.
 *
 * CONSERVATIVE WHITELIST — only `insufficient funds` (plus the no-funded-wallet selection
 * failure, which is thrown pre-signing so no tx exists at all). A node rejects a tx it cannot
 * afford (gas * price + value) at `eth_sendRawTransaction` submission, before the tx enters
 * the mempool; this reject is never emitted after admission. `nonce` and `tx reverted` are
 * deliberately EXCLUDED: a nonce error can follow a competing tx already propagating, and a
 * revert means the tx was mined. Widen only with a per-error pre-mempool proof.
 *
 * Invariant: whatever this whitelists, `mapPublishExceptionToLiftJobFailure({ error,
 * failedFromState: 'broadcast', ... })` classifies as `insufficient_funds` (terminal,
 * `fail_job`, non-retryable), so the job is never chain-recovery-chased.
 *
 * The bare `includes('insufficient funds')` mirrors `classifyPublishFailureCode` exactly; a
 * mined-then-reverted tx whose revert string contains that phrase is an accepted, intentional
 * edge (same code the mapper would assign, and a revert is a failure on either path).
 *
 * THROW-SAFE: this runs on the double-submit safety path — if it threw, the caller would
 * never reach the ambiguous-recovery branch and the error would strand off the recovery
 * track. ALL inspection of the arbitrary thrown value is guarded: not just `String(error)`
 * on a pathological value (e.g. `Object.create(null)`), but also the `.code` read, which a
 * throwing accessor or Proxy can make throw. Any failure to inspect → classified
 * non-definitive → stays on recovery (we cannot PROVE a pre-acceptance reject, so we treat
 * it conservatively as ambiguous).
 */
export function isDefinitivePreAcceptanceSendFailure(error: unknown): boolean {
  try {
    const errorCode = (error as { code?: unknown } | null | undefined)?.code;
    if (errorCode === NO_FUNDED_PUBLISHER_WALLET_CODE) return true;
    const message = error instanceof Error ? error.message : String(error);
    const lower = typeof message === 'string' ? message.toLowerCase() : '';
    return messageIndicatesNoFundedPublisherWallet(lower) || lower.includes('insufficient funds');
  } catch {
    return false;
  }
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
