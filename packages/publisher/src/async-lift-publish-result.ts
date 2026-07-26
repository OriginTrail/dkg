import {
  NO_FUNDED_PUBLISHER_WALLET_CODE,
  PUBLISH_AUTHOR_NOT_CUSTODIAL_CODE,
  PUBLISHER_NOT_AUTHORIZED_FOR_CG_CODE,
  messageIndicatesNoFundedPublisherWallet,
  messageIndicatesPublishAuthorNotCustodial,
  messageIndicatesPublisherNotAuthorizedForCg,
} from '@origintrail-official/dkg-core';
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

/** Throw-safe facts read off an arbitrary thrown publish error. Both the failure-code mapper
 *  and the pre-acceptance classifier read the SAME low-level extraction here (shared
 *  mechanics), while each keeps its OWN classification policy. Inspecting a thrown value can
 *  fail — `String()` on a null-prototype object, or a throwing `.code` accessor / Proxy — so
 *  every read is guarded and falls back to a safe default (`undefined` code, `''` message).
 *  A failure to inspect must never throw out of a failure-recording or recovery-decision path. */
function readPublishErrorFacts(error: unknown): { code: unknown; message: string; lowerMessage: string } {
  let code: unknown;
  try {
    code = (error as { code?: unknown } | null | undefined)?.code;
  } catch {
    code = undefined;
  }
  let message = '';
  try {
    // Prefer a string `.message` even on a NON-Error throw (cross-realm errors, serialized
    // errors from a worker, some RPC clients): `String(error)` on such a value yields
    // '[object Object]', which classifies as nothing. `isKnowledgeAssetPublishPreconditionFailure`
    // read `String(err?.message ?? err)` before it shared this extractor, so keeping the
    // `.message` preference is parity with the caller it absorbed, not new behaviour.
    const own = (error as { message?: unknown } | null | undefined)?.message;
    const raw = error instanceof Error
      ? error.message
      : typeof own === 'string' ? own : String(error);
    if (typeof raw === 'string') message = raw;
  } catch {
    message = '';
  }
  return { code, message, lowerMessage: message.toLowerCase() };
}

/**
 * GH#1786 — is this a PERMANENT author-capability refusal? The node cannot re-sign the
 * selected author's `UpdateAuthorAttestation` (no custodial key on file, and the author is
 * not the publisher EOA).
 *
 * One canonical predicate because THREE independent decisions key off it, and a copy that
 * drifted would silently change the outcome depending on where the error surfaced:
 *   1. the failed-from STATE (`isKnowledgeAssetPublishPreconditionFailure`) — this is raised
 *      before any send, so the job must fail from 'validated', not 'broadcast';
 *   2. the failure CODE on that validated path (`recordExecutionFailure`), whose keyword
 *      chain would otherwise reach `canonicalization_failed`;
 *   3. the failure CODE on the broadcast path ({@link mapPublishExceptionToLiftJobFailure}),
 *      whose default is the RETRYABLE `rpc_unavailable` — the forever-retry trap.
 *
 * Reads through the throw-safe extractor, so a null-prototype throw or a throwing `.code`
 * accessor cannot break a failure-recording path.
 */
export function isPermanentAuthorCapabilityFailure(error: unknown): boolean {
  const { code, lowerMessage } = readPublishErrorFacts(error);
  return code === PUBLISH_AUTHOR_NOT_CUSTODIAL_CODE
    || messageIndicatesPublishAuthorNotCustodial(lowerMessage);
}

export function mapPublishExceptionToLiftJobFailure(
  input: AsyncLiftPublishFailureInput,
): LiftJobFailureMetadata {
  const { code: errorCode, message, lowerMessage: lower } = readPublishErrorFacts(input.error);

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
  // GH#1786 — the same trap, one class over. The node cannot re-sign this author's
  // UpdateAuthorAttestation (no custodial key on file, and the author is not the publisher
  // EOA). That is PERMANENT, so without recognising it here it falls through to the
  // retryable `rpc_unavailable` default and the queue keeps resetting a job that can never
  // finalize. Classified as an AUTHORITY failure rather than a transport one; only forced
  // from 'broadcast', which is where the executor raises it — mid-publish, before any
  // transaction is sent. Message fallback mirrors the funded-wallet handling above, for
  // re-wrapped errors that lost `.code` — via the SHARED core matcher, so the agent's
  // message formatter and this classifier cannot drift apart.
  const isAuthorNotCustodial = isPermanentAuthorCapabilityFailure(input.error);
  const isNoFundedWallet = errorCode === NO_FUNDED_PUBLISHER_WALLET_CODE
    || messageIndicatesNoFundedPublisherWallet(lower);
  // #1689 — the context-graph publish-policy rejection (dkg-chain, code
  // `PUBLISHER_NOT_AUTHORIZED_FOR_CG`) is a PERMANENT authorization failure:
  // neither the paying wallet nor the attested author is an authorized
  // publisher for the target CG, and nothing about retrying changes that. Its
  // message deliberately contains none of the substrings
  // `classifyPublishFailureCode` matches, so without code-based recognition it
  // fell through to the retryable `rpc_unavailable` default — which made every
  // curator re-publish silently RE-ACCEPT the same poisoned job (a retryable
  // failed job still "occupies" its lifecycle subject, see
  // `isOccupyingLifecycleJob`) and burn retryCount toward maxRetries while
  // failing identically. Recognized by structured code, with a message-marker
  // fallback for a code-stripped re-wrap, exactly like NO_FUNDED_PUBLISHER_WALLET
  // above. Terminal reclassification is durability-safe: this is thrown at PLAN
  // time, before a signer is picked, so no transaction is ever signed or sent
  // (`broadcastRecorder.outcome === 'not-reached'`). Only forced from
  // 'broadcast' — the state this pre-send rejection is attributed to; any other
  // state falls back to the classifier.
  const isPublisherNotAuthorizedForCg = errorCode === PUBLISHER_NOT_AUTHORIZED_FOR_CG_CODE
    || messageIndicatesPublisherNotAuthorizedForCg(lower);
  // PRECEDENCE (GH#1786 + GH#1689 merge): the two author/authority branches are
  // mutually exclusive in practice — distinct structured codes and disjoint
  // message markers — so their relative order does not change any outcome. Each
  // keeps the position it had in its own PR to keep both diffs minimal. Both
  // resolve to `authority_forbidden`, which is why the allowed-states entry for
  // that code lists 'broadcast' for two independent reasons.
  const code = isAuthorNotCustodial && input.failedFromState === 'broadcast'
    ? 'authority_forbidden'
    : isNoFundedWallet && input.failedFromState === 'broadcast'
      ? 'insufficient_funds'
      : isPublisherNotAuthorizedForCg && input.failedFromState === 'broadcast'
        ? 'authority_forbidden'
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
 * REVERTS ARE NEVER PRE-ACCEPTANCE: a `revert`/`reverted` message means the tx was mined
 * (post-mempool), so it is excluded even when its (caller-controlled) revert string contains
 * "insufficient funds". This keeps ALL reverts uniformly on the recovery track — consistent
 * with the plain-revert handling elsewhere — and confines the whitelist to node-level
 * pre-send rejects. go-ethereum's balance pre-check (`insufficient funds for gas * price +
 * value`) contains no "revert", so the narrowing loses no genuine pre-acceptance case.
 *
 * DECISION vs MECHANICS: the throw-safe extraction of code+message is shared with
 * `mapPublishExceptionToLiftJobFailure` (`readPublishErrorFacts`), but this predicate's
 * classification policy is deliberately SEPARATE and narrower — it must never track the
 * mapper's broader signals, or a future mapper code could silently widen this whitelist and
 * re-open the #1851 double-submit hole. The invariant that every whitelisted error maps to a
 * terminal `insufficient_funds` from 'broadcast' is pinned by test, not by shared code.
 *
 * THROW-SAFE via `readPublishErrorFacts`: this runs on the double-submit safety path — if it
 * threw, the caller would never reach the ambiguous-recovery branch and the error would
 * strand off recovery. An unstringifiable value / throwing `.code` accessor / Proxy yields
 * empty facts → classified non-definitive → stays on recovery.
 */
export function isDefinitivePreAcceptanceSendFailure(error: unknown): boolean {
  const { code, lowerMessage } = readPublishErrorFacts(error);
  if (code === NO_FUNDED_PUBLISHER_WALLET_CODE) return true;
  if (messageIndicatesNoFundedPublisherWallet(lowerMessage)) return true;
  if (lowerMessage.includes('revert')) return false;
  return lowerMessage.includes('insufficient funds');
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
