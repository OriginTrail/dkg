import {
  getChainWriteAheadHookCause,
  isTransientRpcTransportFailureWithoutTransaction,
} from '@origintrail-official/dkg-chain';
import { isRpcPreconditionError } from './ack-errors.js';
import type { ExecutionFailureEvidence } from './async-lift-publisher-types.js';
import { isPermanentAuthorCapabilityFailure, mapPublishExceptionToLiftJobFailure } from './async-lift-publish-result.js';
import {
  createLiftJobFailureMetadata,
  type LiftJobFailureCode,
  type LiftJobFailureMetadata,
  type LiftJobState,
} from './lift-job.js';
import { isStoreOperationProvenNotStarted } from './promote-replay-safety.js';
import { isKnowledgeAssetWorkspaceHeadCorruptError } from './workspace-resolution.js';

/**
 * GH#2940 — is this failure the storage layer's own statement that a store operation never
 * started? Reads the typed contract on the thrown error, or — when the chain adapter re-throws a
 * rejected write-ahead hook — on the hook's own error, which that ONE wrapper
 * (`ChainWriteAheadHookError`) carries as `cause`. Nothing else is unwrapped: an arbitrary cause
 * chain is not walked, so an unrelated error that merely carries a typed cause does not qualify,
 * and prose never does. A wrapper that dropped its cause (an older or third-party adapter) simply
 * does not qualify, which leaves today's classification untouched — it fails conservative.
 */
function isProvenStoreRejection(error: unknown): boolean {
  return isStoreOperationProvenNotStarted(error)
    || isStoreOperationProvenNotStarted(getChainWriteAheadHookCause(error));
}

/**
 * GH#2942 — is this failure a typed TRANSIENT transport failure that names no transaction?
 * Reads the chain's own typed contract on the thrown error or — the ONE wrapper the publisher
 * owns — on the `cause` of an `RpcPreconditionError`, which the agent puts around the cold-start
 * chain reads that precede ACK collection (chain id, lifecycle address, quorum). Nothing else is
 * unwrapped: an arbitrary cause chain is not walked, and prose never qualifies. Throw-safe.
 */
function isTransientRpcFailure(error: unknown): boolean {
  if (isTransientRpcTransportFailureWithoutTransaction(error)) return true;
  if (!isRpcPreconditionError(error)) return false;
  try {
    return isTransientRpcTransportFailureWithoutTransaction(error.cause);
  } catch {
    return false;
  }
}

/**
 * The ONE registration point for STRUCTURED (typed) KA VM-publish
 * precondition failures: a non-null result simultaneously (a) forces the
 * failure to be recorded from the pre-send 'validated' state — from
 * 'broadcast' the publish-side classifier's message sniffing lands e.g.
 * corrupt-head text containing 'mismatch' on terminal `confirmation_mismatch`,
 * and codes like `workspace_unavailable` are not even recordable there — and
 * (b) IS the persisted failure code. Registering a future structured
 * preflight error here cannot desynchronize state and code, which was
 * previously possible because the two decisions lived in independent
 * condition chains. Message-keyed legacy failures still flow through the
 * message chain in `mapExecutionFailure` (their consolidation is #1974's scope).
 */
// GH#2940 — only register causes that are pre-send BY CONSTRUCTION (raised before anything is
// signed). A typed store rejection is position-agnostic: it can equally arise after the send, so
// it must NOT be added here. This function also routes the failure to 'validated' unconditionally
// (`isKnowledgeAssetPublishPreconditionFailure`), with no write-ahead proof; the store-rejection
// case is decided in `mapExecutionFailure`, where that proof and the persisted status are both in
// hand.
function deterministicDraftPreconditionCode(error: unknown): LiftJobFailureCode | null {
  let code: unknown;
  try { code = (error as { code?: unknown } | null)?.code; } catch { return null; }
  switch (code) {
    case 'ROOTLESS_UPDATE_TARGET_NOT_CONFIRMED':
    case 'ROOTLESS_KA_NOT_MATERIALIZED': return 'workspace_slice_not_found';
    case 'ROOTLESS_UPDATE_TARGET_CORRUPT':
    case 'ROOTLESS_UPDATE_INVALID_KA_ID':
    case 'LEGACY_KA_READ_ONLY': return 'canonicalization_failed';
    case 'KA_UPDATE_AUTHOR_NOT_OWNER': return 'authority_forbidden';
    case 'KA_UPDATE_VERSION_MISMATCH': return 'publish_intent_stale';
    default: return null;
  }
}

function classifyKnowledgeAssetVmPublishPreconditionCode(error: unknown): LiftJobFailureCode | null {
  const draftCode = deterministicDraftPreconditionCode(error);
  if (draftCode !== null) return draftCode;
  // GH#1786 — permanent author-capability refusal; no transaction was ever sent.
  if (isPermanentAuthorCapabilityFailure(error)) return 'authority_forbidden';
  let structuredCode: unknown;
  try {
    structuredCode = (error as { code?: unknown } | null | undefined)?.code;
  } catch {
    structuredCode = undefined;
  }
  let structuredReason: unknown;
  try {
    structuredReason = (error as { reason?: unknown } | null | undefined)?.reason;
  } catch {
    structuredReason = undefined;
  }
  // The registered-CG authority gate raises this before signing or
  // broadcasting. Its closed reason registry has the same transient/terminal
  // partition as the agent's promote prerequisite. Keep the package boundary
  // structural (publisher cannot import agent without a cycle), and fail any
  // future/ill-shaped reason closed as terminal until it is classified here.
  // Recording one of these as a tx-submit timeout would invent broadcast
  // uncertainty for a transaction that does not exist.
  if (structuredCode === 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE') {
    switch (structuredReason) {
      case 'finalized-name-absence-unaccepted':
      case 'chain-name-binding-unavailable':
      // An RFC-64 authority read cooldown ends on its own without anything
      // being asked of the pool, so it is transient in exactly the sense
      // this group means. The agent's own promote policy classifies it the
      // same way; left to the terminal default it would turn one unrelated
      // graph's RPC exhaustion into a permanent failure for this publish.
      case 'authority-circuit-open':
      case 'local-chain-binding-unavailable':
      case 'local-existence-unavailable':
      case 'chain-access-policy-unavailable':
      case 'chain-access-policy-timeout':
      case 'chain-participant-authority-unavailable':
      case 'rfc64-private-read-roster-unavailable':
        return 'authority_unavailable';
      case 'chain-access-policy-unknown':
      case 'chain-participant-authority-unsupported':
      case 'chain-participant-authority-invalid':
      default:
        return 'authority_forbidden';
    }
  }
  if (structuredCode === 'PUBLISH_INTENT_STALE') return 'publish_intent_stale';
  // The EVM adapter rejects this before signing or broadcasting. Keep it in
  // the validated retry lane, where an operator can raise the cap or wait for
  // the base fee to fall. It must never create durable transaction evidence.
  if (structuredCode === 'FEE_CAP_BELOW_BASE_FEE') return 'fee_cap_below_base_fee';
  // GH#2273 — multi-valued SWM head: transient local corruption the sync
  // repair heals, NOT a stale intent; the queued request may still be
  // byte-identical to what the head certified at admission.
  if (isKnowledgeAssetWorkspaceHeadCorruptError(error)) return 'workspace_unavailable';
  // Structured admission/registration preconditions. Their persisted code
  // PRESERVES the pre-existing effective mapping: neither message ("is not
  // registered on-chain", "not a complete full share") matches any keyword
  // in the legacy chain, so both always fell through to
  // `canonicalization_failed`. Re-taxonomizing them is #1974's call — what
  // this helper guarantees is only that the code that ROUTES the failure to
  // the pre-send state is also the code that decides what gets persisted.
  if (structuredCode === 'PUBLISH_NOT_FULL_SHARE' || structuredCode === 'CG_NOT_REGISTERED') {
    return 'canonicalization_failed';
  }
  return null;
}

export function isKnowledgeAssetPublishPreconditionFailure(error: unknown): boolean {
  if (classifyKnowledgeAssetVmPublishPreconditionCode(error) !== null) return true;
  const anyError = error as { code?: unknown; message?: unknown };
  const message = String(anyError?.message ?? error);
  return /is not finalized/i.test(message)
    || /No quads in shared memory/i.test(message)
    || /has no private payload/i.test(message)
    || /not a complete full share/i.test(message)
    || /cannot recover .*reservedKaId/i.test(message)
    || /seal binds/i.test(message);
}

export interface ExecutionFailureInput {
  readonly jobId: string;
  /** The job's PERSISTED status, read under the transition lock. */
  readonly currentStatus: LiftJobState;
  /** The origin the caller reports. */
  readonly requestedOrigin: LiftJobState;
  readonly error: unknown;
  readonly evidence?: ExecutionFailureEvidence;
  /** Lazy: read only when a timeout is recorded, so a clock that advances per call is read as often as ever. */
  readonly now: () => number;
}

/**
 * The failure a job records when its publish fails while being executed: the failed-from state, the
 * code, the message and the timeout metadata. Pure — persistence, the retry schedule and the state
 * transition stay with the caller.
 *
 * GH#2940 — a typed store rejection that PROVABLY preceded dispatch is a pre-send failure, not a
 * transaction-submission timeout. Its message reads "Store scheduler queue wait timeout (...)",
 * which the broadcast-origin classifiers match on the bare word `timeout`: it used to be recorded as
 * `tx_submit_timeout` — "check the chain" — for a job with no transaction to check, which no
 * automatic lane can ever resolve.
 * GH#2942 — the same holds for a typed TRANSIENT RPC transport failure that names no transaction
 * (`isTransientRpcTransportFailureWithoutTransaction`): estimate / populate / sign exhausted every
 * endpoint, the request governor was full, a bounded request ran out of time. Those are raised while
 * the publish transaction is still being prepared, strictly before the write-ahead hook, so they
 * follow the same rule. An approval or a context-graph registration may already have been sent by
 * this attempt; neither is the publication, and nothing here says otherwise.
 * All three conjuncts are required, and each is an independent barrier (the first two overlap in
 * practice — a recorded write-ahead leaves the record at 'broadcast' — which is exactly why neither
 * may stand in for the other):
 *   - the write-ahead never durably recorded a hash (the recorder's positional proof — the hook is
 *     awaited strictly before the send and fails closed);
 *   - the PERSISTED status is still 'validated' — if the write-ahead rollback itself failed the
 *     record is `broadcast` + hash, and recording it "from validated" would discard that evidence
 *     (the state model throws), so it falls back to the held failure it has always been;
 *   - the cause is typed: the storage layer's `not_started` contract, on the thrown error or on the
 *     hook error that the chain adapter's write-ahead wrapper carries as `cause`
 *     (`isProvenStoreRejection`), or the chain's transient transport failure. Prose never
 *     qualifies, and an absent `txHash` is never a proof — it is only one more exclusion.
 */
export function mapExecutionFailure(input: ExecutionFailureInput): LiftJobFailureMetadata {
  const { jobId, currentStatus, requestedOrigin, error, evidence, now } = input;
  const transientRpc = isTransientRpcFailure(error);
  const preDispatchRecoverable = evidence?.neverDispatched === true
    && currentStatus === 'validated'
    && (isProvenStoreRejection(error) || transientRpc);
  // A failure raised while the job is still 'claimed' (the initial preflight) precedes validation,
  // and so precedes everything that could dispatch anything: the typed cause alone is enough. The
  // keyword chain below would otherwise record a multi-endpoint exhaustion message that carries
  // none of its words as the TERMINAL `canonicalization_failed` - a transient outage ending a job.
  // No in-repo preflight raises a typed transport failure today (the agent's is store-only); this
  // keeps a chain read added to one later, or a third-party handler's, from ending the job.
  const claimedTransientRpc = requestedOrigin === 'claimed'
    && currentStatus === 'claimed'
    && transientRpc;
  const retainedTransactionOrigin = deterministicDraftPreconditionCode(error) !== null
    && (currentStatus === 'broadcast' || currentStatus === 'included');
  const origin: LiftJobState = retainedTransactionOrigin ? currentStatus
    : preDispatchRecoverable ? 'validated' : requestedOrigin;
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const errorPayloadRef = `urn:dkg:publisher:error:${jobId}`;

  if (origin === 'claimed' || origin === 'validated') {
    const code =
      // Structured precondition failures (author capability / stale intent /
      // corrupt head) come from the SAME classifier that routed the failure
      // to this pre-send branch, so their state and code cannot drift apart.
      // Everything message-keyed stays in the legacy chain below (#1974).
      classifyKnowledgeAssetVmPublishPreconditionCode(error)
        ?? (preDispatchRecoverable || claimedTransientRpc
        ? 'workspace_unavailable'
        : lower.includes('timeout') || lower.includes('timed out') || lower.includes('unavailable') || lower.includes('query') || lower.includes('store')
        ? 'workspace_unavailable'
        : lower.includes('authority')
        ? 'authority_forbidden'
        : lower.includes('workspace') || lower.includes('root')
          ? 'workspace_slice_not_found'
          : 'canonicalization_failed');
    return createLiftJobFailureMetadata({ failedFromState: origin, code, message, errorPayloadRef });
  }

  return mapPublishExceptionToLiftJobFailure({
    error,
    failedFromState: requestedOrigin === 'included' ? 'included' : 'broadcast',
    errorPayloadRef,
    timeout:
      lower.includes('timeout') || lower.includes('timed out')
        ? {
            // A PLACEHOLDER, not a measurement: the executor reports no configured or elapsed
            // deadline, so 0 means "unknown" — never "the configured timeout was zero" nor
            // "it took zero time". `timeoutAt` is when this failure was recorded. GH#2940: a
            // typed pre-dispatch store rejection never reaches here (it is recorded above as a
            // non-timeout failure, which cannot carry timeout metadata at all).
            timeoutMs: 0,
            timeoutAt: now(),
            // Both carriers a timeout can land on here (`tx_submit_timeout` from 'broadcast',
            // `finality_timeout` from 'included') declare this same `timeoutHandling` in the
            // registry, which validates the value — so the state cannot change it.
            handling: 'check_chain_then_finalize_or_reset',
          }
        : undefined,
  });
}
