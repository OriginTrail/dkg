import type { QueryResult } from '@origintrail-official/dkg-storage';
import {
  LIFT_AUTHORITY_TYPES,
  LIFT_JOB_FAILURE_CODES,
  LIFT_JOB_FAILURE_MODES,
  LIFT_JOB_FAILURE_PHASES,
  LIFT_JOB_FAILURE_RESOLUTIONS,
  LIFT_JOB_STATES,
  LIFT_JOB_TIMEOUT_HANDLINGS,
  LIFT_TRANSITION_TYPES,
} from './lift-job.js';
import { LIFT_JOB_IMMUTABLE_FIELDS } from './lift-job.js';
import type {
  KnowledgeAssetVmPublishJobRequest,
  KnowledgeAssetVmPublishRequest,
  LiftJob,
  LiftJobAccepted,
  LiftJobHex,
  LiftJobResettableState,
  LiftJobRequest,
  LiftPublishRequestMetadata,
  LiftPublishSnapshotRequest,
  RawLiftJobRequest,
  RawLiftRequest,
} from './lift-job.js';
import { parseLiteral } from './async-lift-control-plane.js';
export {
  CONTROL_CLAIM_TOKEN,
  CONTROL_LOCKED_JOB,
  CONTROL_LOCK_EXPIRES_AT,
  CONTROL_LOCK_STATUS,
  CONTROL_WALLET_ID,
  DEFAULT_WALLET_LOCK_GRAPH_URI,
  DEFAULT_CONTROL_GRAPH_URI as DEFAULT_GRAPH_URI,
  CONTROL_PAYLOAD as PAYLOAD_PREDICATE,
  CONTROL_STATUS as STATUS_PREDICATE,
  CONTROL_LIFECYCLE_KEY,
  DEFAULT_JOURNAL_GRAPH_URI,
  JOURNAL_SEQ,
  JOURNAL_LIFECYCLE_KEY,
  JOURNAL_JOB_ID,
  knowledgeAssetVmPublishLifecycleKey,
  serializeJournalEntry,
  parseJournalEntry,
  serializeVmPublishIntentIndex,
  createJobSlug,
  jobSubject,
  parseIntegerLiteral,
  serializeJob,
  serializeJobRecord,
  serializeWalletLock,
  literal,
  requestSubject,
  walletLockSubject,
} from './async-lift-control-plane.js';
export { parseLiteral };

// STRUCTURAL helpers for a persisted lift job: what it is, what it carries, how it is rebuilt.
// GH#2270 — the POLICY predicates that used to sit here (evidence, the chain-proof hold, retry
// eligibility, lifecycle occupancy, clearability) moved to async-lift-retry-disposition.ts, where
// their one precedence is documented. Each of them reads the same job, and keeping them apart is
// how they drift.

export type PersistedFailedJob = Extract<LiftJob, { status: 'failed' }>;

export function expectBindings(result: QueryResult): Array<Record<string, string>> {
  if (result.type !== 'bindings') {
    throw new Error(`Expected SPARQL bindings result, got ${result.type}`);
  }
  return result.bindings;
}

export type LiftJobPayloadDecodeResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'malformed'; readonly reason: string }
  | { readonly kind: 'job'; readonly job: StructurallyValidLiftJobPayload };

/**
 * The part of a persisted job that is safe before status enum membership has been established.
 * Keeping `status` as `string` prevents an unknown future state from entering lifecycle code as a
 * `LiftJob`; the classified terminal-clear boundary is the sole consumer that needs this view.
 */
export type StructurallyValidLiftJobPayload = Omit<LiftJob, 'status'> & {
  readonly status: string;
};

/** Classify one persisted job payload without hiding malformed state behind null or an exception. */
export function decodeLiftJobPayload(binding?: string): LiftJobPayloadDecodeResult {
  if (binding === undefined) return { kind: 'absent' };
  try {
    const payload = parseLiteral(binding);
    if (typeof payload !== 'string') {
      return { kind: 'malformed', reason: 'payload is not an RDF literal' };
    }
    const parsed = JSON.parse(payload) as unknown;
    if (!isRecord(parsed)) return malformedLiftJobPayload('payload is not an object');
    if (!isNonEmptyString(parsed['jobId'])) return malformedLiftJobPayload('jobId must be a non-empty string');
    if (!isNonEmptyString(parsed['jobSlug'])) return malformedLiftJobPayload('jobSlug must be a non-empty string');
    if (!isNonEmptyString(parsed['status'])) return malformedLiftJobPayload('status must be a non-empty string');

    const timestampsError = validateLiftJobTimestamps(parsed['timestamps']);
    if (timestampsError) return malformedLiftJobPayload(timestampsError);
    const retriesError = validateLiftJobRetries(parsed['retries']);
    if (retriesError) return malformedLiftJobPayload(retriesError);
    const admissionError = validateOptionalLiftJobAdmission(parsed['admission']);
    if (admissionError) return malformedLiftJobPayload(admissionError);
    const controlPlaneError = validateOptionalLiftJobControlPlane(parsed['controlPlane']);
    if (controlPlaneError) return malformedLiftJobPayload(controlPlaneError);
    const recoveryError = validateOptionalLiftJobRecovery(parsed['recovery']);
    if (recoveryError) return malformedLiftJobPayload(recoveryError);

    const status = parsed['status'];
    const normalized: Record<string, unknown> = {
      ...parsed,
      request: normalizePersistedLiftJobRequest(parsed['request']),
    };
    if ((LIFT_JOB_STATES as readonly string[]).includes(status)) {
      const stateShapeError = validateKnownLiftJobStateShape(normalized);
      if (stateShapeError) return malformedLiftJobPayload(stateShapeError);
    }
    return {
      kind: 'job',
      job: normalized as unknown as StructurallyValidLiftJobPayload,
    };
  } catch (error) {
    return {
      kind: 'malformed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Narrow a structurally decoded payload only after its state enum and state shape are valid. */
export function isKnownLiftJobPayload(
  job: StructurallyValidLiftJobPayload,
): job is LiftJob {
  return (LIFT_JOB_STATES as readonly string[]).includes(job.status)
    && validateKnownLiftJobStateShape(job as unknown as Record<string, unknown>) === null;
}

/** Ordinary read policy: absence is nullable, but corrupt durable state always fails closed. */
export function decodedLiftJobOrThrow(decoded: LiftJobPayloadDecodeResult): LiftJob | null {
  switch (decoded.kind) {
    case 'absent':
      return null;
    case 'job': {
      if (!isKnownLiftJobPayload(decoded.job)) {
        throw new Error(`Malformed persisted LiftJob payload: Unsupported LiftJob status: ${decoded.job.status}`);
      }
      return decoded.job;
    }
    case 'malformed':
      throw new Error(`Malformed persisted LiftJob payload: ${decoded.reason}`);
  }
}

function malformedLiftJobPayload(reason: string): LiftJobPayloadDecodeResult {
  return { kind: 'malformed', reason };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function optionalStringError(record: Record<string, unknown>, key: string, path: string): string | null {
  return record[key] === undefined || typeof record[key] === 'string'
    ? null
    : `${path}.${key} must be a string`;
}

function optionalFiniteNumberError(record: Record<string, unknown>, key: string, path: string): string | null {
  return record[key] === undefined || isFiniteNumber(record[key])
    ? null
    : `${path}.${key} must be a finite number`;
}

function validateLiftJobTimestamps(value: unknown): string | null {
  if (!isRecord(value)) return 'timestamps must be an object';
  if (!isFiniteNumber(value['acceptedAt'])) return 'timestamps.acceptedAt must be a finite number';
  if (!isFiniteNumber(value['updatedAt'])) return 'timestamps.updatedAt must be a finite number';
  for (const key of [
    'claimedAt', 'validatedAt', 'broadcastAt', 'rpcAcceptedAt', 'includedAt', 'finalizedAt',
    'failedAt', 'lastRetriedAt', 'nextRetryAt', 'lastRecoveredAt',
  ]) {
    const error = optionalFiniteNumberError(value, key, 'timestamps');
    if (error) return error;
  }
  return null;
}

function validateLiftJobRetries(value: unknown): string | null {
  if (!isRecord(value)) return 'retries must be an object';
  if (!isFiniteNumber(value['retryCount'])) return 'retries.retryCount must be a finite number';
  if (!isFiniteNumber(value['maxRetries'])) return 'retries.maxRetries must be a finite number';
  return optionalStringError(value, 'lastRetryReason', 'retries');
}

function validateOptionalLiftJobAdmission(value: unknown): string | null {
  if (value === undefined) return null;
  if (!isRecord(value) || !isNonEmptyString(value['byAgentAddress'])) {
    return 'admission.byAgentAddress must be a non-empty string';
  }
  return null;
}

function validateOptionalLiftJobControlPlane(value: unknown): string | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return 'controlPlane must be an object';
  return optionalStringError(value, 'jobRef', 'controlPlane')
    ?? optionalStringError(value, 'walletLockRef', 'controlPlane');
}

function validateOptionalLiftJobRecovery(value: unknown): string | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return 'recovery must be an object';
  if (value['action'] !== 'reset_to_accepted' && value['action'] !== 'finalized_from_chain') {
    return 'recovery.action is unsupported';
  }
  if (!['claimed', 'validated', 'broadcast', 'included'].includes(String(value['recoveredFromStatus']))) {
    return 'recovery.recoveredFromStatus is unsupported';
  }
  if (
    value['action'] === 'finalized_from_chain'
    && value['recoveredFromStatus'] !== 'broadcast'
    && value['recoveredFromStatus'] !== 'included'
  ) {
    return 'recovery.finalized_from_chain requires a broadcast or included origin';
  }
  for (const key of ['txHashChecked', 'walletIdChecked', 'note']) {
    const error = optionalStringError(value, key, 'recovery');
    if (error) return error;
  }
  const nonceError = optionalFiniteNumberError(value, 'nonceChecked', 'recovery');
  if (nonceError) return nonceError;
  if (value['txHashAccounted'] !== undefined && typeof value['txHashAccounted'] !== 'boolean') {
    return 'recovery.txHashAccounted must be a boolean';
  }
  if (value['operationKind'] !== undefined && value['operationKind'] !== 'create' && value['operationKind'] !== 'update') {
    return 'recovery.operationKind is unsupported';
  }
  if (value['action'] === 'finalized_from_chain' && !isNonEmptyString(value['txHashChecked'])) {
    return 'recovery.txHashChecked must be a non-empty string';
  }
  return null;
}

function validateKnownLiftJobStateShape(job: Record<string, unknown>): string | null {
  const claim = validateLiftJobClaim(job['claim']);
  const validation = validateLiftJobValidation(job['validation']);
  const broadcast = validateLiftJobBroadcast(job['broadcast']);
  const inclusion = validateLiftJobInclusion(job['inclusion']);
  const finalization = validateLiftJobFinalization(job['finalization']);
  const failure = validateLiftJobFailure(job['failure']);
  const required = (error: string | null, key: string): string | null =>
    job[key] === undefined ? `${key} is required` : error;

  switch (job['status']) {
    case 'accepted':
      return null;
    case 'claimed':
      return required(claim, 'claim');
    case 'validated':
      return required(claim, 'claim') ?? required(validation, 'validation');
    case 'broadcast': {
      const request = job['request'];
      const isLegacyEvidenceFreeRawCrash = isRecord(request)
        && request['jobType'] === 'lift'
        && job['validation'] === undefined
        && job['broadcast'] === undefined;
      return required(claim, 'claim') ?? (isLegacyEvidenceFreeRawCrash
        ? null
        : required(validation, 'validation') ?? required(broadcast, 'broadcast'));
    }
    case 'included':
      return required(claim, 'claim') ?? required(validation, 'validation')
        ?? required(broadcast, 'broadcast') ?? required(inclusion, 'inclusion');
    case 'finalized': {
      const base = required(claim, 'claim') ?? required(validation, 'validation')
        ?? required(finalization, 'finalization');
      if (base) return base;
      const mode = (job['finalization'] as Record<string, unknown>)['mode'];
      return mode === 'noop' || mode === 'local'
        ? null
        : required(broadcast, 'broadcast') ?? required(inclusion, 'inclusion');
    }
    // A failed record's progress metadata is intentionally historical rather than a strict copy
    // of `failedFromState`: legacy/pre-WAL failures can name broadcast without carrying a signed
    // transaction, while the recovery carrier may retain the only available evidence. Validate
    // the failure discriminator itself, but do not invent stricter persistence semantics here.
    case 'failed':
      return required(failure, 'failure');
    default:
      return null;
  }
}

function validateLiftJobClaim(value: unknown): string | null {
  if (!isRecord(value)) return 'claim must be an object';
  if (!isNonEmptyString(value['walletId'])) return 'claim.walletId must be a non-empty string';
  return optionalStringError(value, 'claimedBy', 'claim')
    ?? optionalStringError(value, 'claimToken', 'claim')
    ?? optionalFiniteNumberError(value, 'claimLeaseExpiresAt', 'claim');
}

function validateLiftJobValidation(value: unknown): string | null {
  if (!isRecord(value)) return 'validation must be an object';
  if (!Array.isArray(value['canonicalRoots']) || !value['canonicalRoots'].every((item) => typeof item === 'string')) {
    return 'validation.canonicalRoots must be a string array';
  }
  if (!isRecord(value['canonicalRootMap']) || !Object.values(value['canonicalRootMap']).every((item) => typeof item === 'string')) {
    return 'validation.canonicalRootMap must map strings to strings';
  }
  if (!isFiniteNumber(value['swmQuadCount'])) return 'validation.swmQuadCount must be a finite number';
  if (!isNonEmptyString(value['authorityProofRef'])) return 'validation.authorityProofRef must be a non-empty string';
  if (!(LIFT_TRANSITION_TYPES as readonly unknown[]).includes(value['transitionType'])) {
    return 'validation.transitionType is unsupported';
  }
  return optionalStringError(value, 'priorVersion', 'validation');
}

function validateLiftJobBroadcast(value: unknown): string | null {
  if (!isRecord(value)) return 'broadcast must be an object';
  if (!isNonEmptyString(value['txHash'])) return 'broadcast.txHash must be a non-empty string';
  if (!isNonEmptyString(value['walletId'])) return 'broadcast.walletId must be a non-empty string';
  const optionalString = optionalStringError(value, 'merkleRoot', 'broadcast');
  if (optionalString) return optionalString;
  const numberError = optionalFiniteNumberError(value, 'publicByteSize', 'broadcast')
    ?? optionalFiniteNumberError(value, 'nonce', 'broadcast');
  if (numberError) return numberError;
  if (value['operationKind'] !== undefined && value['operationKind'] !== 'create' && value['operationKind'] !== 'update') {
    return 'broadcast.operationKind is unsupported';
  }
  return null;
}

function validateLiftJobInclusion(value: unknown): string | null {
  if (!isRecord(value)) return 'inclusion must be an object';
  if (value['txHash'] !== undefined && !isNonEmptyString(value['txHash'])) {
    return 'inclusion.txHash must be a non-empty string';
  }
  if (!isFiniteNumber(value['blockNumber'])) return 'inclusion.blockNumber must be a finite number';
  return optionalStringError(value, 'blockHash', 'inclusion')
    ?? optionalFiniteNumberError(value, 'blockTimestamp', 'inclusion');
}

function validateLiftJobFinalization(value: unknown): string | null {
  if (!isRecord(value)) return 'finalization must be an object';
  if (value['mode'] !== undefined && !['published', 'noop', 'local'].includes(String(value['mode']))) {
    return 'finalization.mode is unsupported';
  }
  for (const key of ['txHash', 'ual', 'batchId', 'startKAId', 'endKAId', 'publisherAddress']) {
    const error = optionalStringError(value, key, 'finalization');
    if (error) return error;
  }
  return null;
}

function validateLiftJobFailure(value: unknown): string | null {
  if (!isRecord(value)) return 'failure must be an object';
  if (!['accepted', 'claimed', 'validated', 'broadcast', 'included'].includes(String(value['failedFromState']))) {
    return 'failure.failedFromState is unsupported';
  }
  if (!(LIFT_JOB_FAILURE_PHASES as readonly unknown[]).includes(value['phase'])) {
    return 'failure.phase is unsupported';
  }
  if (!(LIFT_JOB_FAILURE_MODES as readonly unknown[]).includes(value['mode'])) {
    return 'failure.mode is unsupported';
  }
  if (!(LIFT_JOB_FAILURE_RESOLUTIONS as readonly unknown[]).includes(value['resolution'])) {
    return 'failure.resolution is unsupported';
  }
  if (!(LIFT_JOB_FAILURE_CODES as readonly unknown[]).includes(value['code'])) {
    return 'failure.code is unsupported';
  }
  for (const key of ['message', 'errorPayloadRef']) {
    if (!isNonEmptyString(value[key])) return `failure.${key} must be a non-empty string`;
  }
  if (typeof value['retryable'] !== 'boolean') return 'failure.retryable must be a boolean';
  for (const key of ['stackTraceRef', 'rpcResponseRef', 'revertReasonRef']) {
    const error = optionalStringError(value, key, 'failure');
    if (error) return error;
  }
  if (value['timeout'] !== undefined) {
    if (!isRecord(value['timeout'])) return 'failure.timeout must be an object';
    if (!isFiniteNumber(value['timeout']['timeoutMs']) || !isFiniteNumber(value['timeout']['timeoutAt'])) {
      return 'failure.timeout values must be finite numbers';
    }
    if (!(LIFT_JOB_TIMEOUT_HANDLINGS as readonly unknown[]).includes(value['timeout']['handling'])) {
      return 'failure.timeout.handling is unsupported';
    }
  }
  return null;
}

export function compareAcceptedJobs(a: LiftJob, b: LiftJob): number {
  const timeDelta = a.timestamps.acceptedAt - b.timestamps.acceptedAt;
  if (timeDelta !== 0) return timeDelta;
  return a.jobId.localeCompare(b.jobId);
}

/**
 * GH#2270 — the ONE reader of a job's transaction hash, over BOTH carriers it can live in:
 *  - `broadcast.txHash`, while the job still holds its broadcast metadata;
 *  - `recovery.txHashChecked`, which is where a reset put it — that reset rebuilds the job without
 *    broadcast metadata, so after one the recovery record is the ONLY carrier.
 *
 * Every consumer reads it here: the evidence predicate that decides whether a job is held, and the
 * resets that must carry the hash into the job they rebuild. Reading only the first carrier is how
 * a second reset silently dropped a hash the first one had preserved.
 *
 * Structural, not policy: this answers "what hash does this job carry", never "what does carrying
 * it mean" — that is `hasBroadcastEvidence` in the disposition module.
 */
export function getLiftJobTransactionEvidence(job: LiftJob): LiftJobHex | undefined {
  if ('broadcast' in job && job.broadcast) {
    return job.broadcast.txHash;
  }
  return job.recovery?.txHashChecked;
}

export function isFailedJob(job: LiftJob): job is PersistedFailedJob {
  return job.status === 'failed' && 'failure' in job;
}

/**
 * GH#2270 PR-3 r2 — the knowledge asset id a re-run of this job would mint, if its request pins
 * one. (PR #2300 r1: moved here from the impl so the disposition module's retryability policy
 * reads the SAME derivation as the lookup builder.)
 *
 * Only a job whose request carries a seal with `reservedKaId` has a FIXED identity: that id is
 * threaded verbatim back into the mint, so a re-run either mints exactly it or reverts against a
 * mint that already happened. A job without one allocates a fresh id on every attempt, which is
 * precisely why it cannot be released by absence — a replacement transaction could have published
 * it already and the re-run would mint a SECOND asset over the same content, with nothing on
 * chain to object.
 *
 * `undefined` on anything malformed or absent: this feeds a guard, so it fails closed.
 */
export function pinnedPublishIdentityKaId(job: LiftJob): string | undefined {
  const request = job.request as { knowledgeAssetVmPublish?: { seal?: { reservedKaId?: unknown } } };
  const raw = request?.knowledgeAssetVmPublish?.seal?.reservedKaId
    ?? (job.request as { lift?: { seal?: { reservedKaId?: unknown } } })?.lift?.seal?.reservedKaId;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    const kaId = BigInt(raw);
    return kaId > 0n ? kaId.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * GH#2270 PR-3 r4 — what this job's queued transaction was TRYING to do, derived from the
 * persisted request alone. Structural, not policy: the disposition module and the lookup builder
 * both read it, and what a kind PERMITS (which recognitions, which releases) is decided there.
 *
 * The derivation errs toward 'update', because the two misclassifications are not symmetric.
 * A create read as an update merely narrows what can settle it: update recognition will not match
 * a mint receipt and the create-only absence release is withheld — the job stays held for the
 * operator, which is safe. An update read as a create is the dangerous direction, so 'create'
 * requires proof:
 *  - a named-KA VM job is a create only when its request records NO prior VM assertion
 *    (`vmCurrentAssertion` is what the queued executor branches on) AND its assertion version
 *    does not advance past 1 (the executor may still take the update branch off the LIVE
 *    lifecycle pointer when the request field is absent — but then the identity check answers
 *    "minted" and the absence release holds anyway; see the resolver);
 *  - a raw lift is a create only when its transition type says CREATE (MUTATE/REVOKE rewrite
 *    existing state and carry the same ABA hazard).
 */
/**
 * GH#2270 PR #2300 r3 — the branch a persisted job actually signed, read from the durable marker
 * written at the write-ahead (`broadcast.operationKind`) or carried across a reset in the recovery
 * record. Either carrier is the transaction's own testimony; nothing else is.
 */
export function liftJobOperationKindMarker(job: LiftJob): 'create' | 'update' | undefined {
  const broadcast = (job as { broadcast?: { operationKind?: 'create' | 'update' } }).broadcast;
  const recovery = (job as { recovery?: { operationKind?: 'create' | 'update' } }).recovery;
  return broadcast?.operationKind ?? recovery?.operationKind;
}

/**
 * GH#2270 PR #2300 r21 (🔴 3812632539) — the wallet that signed the evidence hash, read from the
 * SAME carrier the hash came from. `broadcast` is this attempt's; `recovery.walletIdChecked` is
 * one an earlier reset preserved. `claim.walletId` is deliberately NOT a fallback: it names the
 * wallet for the next attempt, and pairing it with an inherited hash builds a
 * transaction/account combination that never existed on chain.
 */
export function liftJobCheckedSigner(job: LiftJob): string | undefined {
  const broadcast = (job as { broadcast?: { txHash?: string; walletId?: string } }).broadcast;
  if (broadcast?.txHash && broadcast.walletId) return broadcast.walletId;
  return (job as { recovery?: { walletIdChecked?: string } }).recovery?.walletIdChecked;
}

/** The nonce that accompanies {@link liftJobCheckedSigner}'s hash, from the same carrier. */
export function liftJobCheckedNonce(job: LiftJob): number | undefined {
  const broadcast = (job as { broadcast?: { txHash?: string; nonce?: number } }).broadcast;
  if (broadcast?.txHash && broadcast.nonce !== undefined) return broadcast.nonce;
  return (job as { recovery?: { nonceChecked?: number } }).recovery?.nonceChecked;
}

export function queuedLiftOperationKind(job: LiftJob): 'create' | 'update' {
  if (isKnowledgeAssetVmPublishJobRequest(job.request)) {
    // The DURABLE marker first: it records what actually signed. Everything else is inference, and
    // for a named KA the request cannot carry the answer — `publishQueuedKnowledgeAssetVmPublish`
    // resolves its update branch from `request.vmCurrentAssertion ?? the live lifecycle pointer`,
    // so a request with no pointer of its own can still sign an update.
    const signed = liftJobOperationKindMarker(job);
    if (signed !== undefined) return signed;
    // No marker: the record predates it. `assertionVersion` was used here and was WRONG — it counts
    // assertion revisions, not VM publications, so a KA finalized twice before its FIRST publish
    // reads as version 2 and would be misclassified as an update forever (PR #2300 r3, 3811569441).
    // With nothing authoritative left, the answer is the SAFE one rather than the likely one:
    // 'update' only forfeits absence-release (the job holds, with the operator's by-id clear as its
    // exit), while a wrong 'create' would authorise a resend of an update that may already be on
    // chain. Every job this build writes carries the marker, so this is a pre-upgrade residual.
    return 'update';
  }
  const rawTransition = (job.request as { lift?: { transitionType?: string } }).lift?.transitionType;
  return rawTransition === 'CREATE' ? 'create' : 'update';
}

/**
 * GH#2270 — the ONE reset-to-accepted builder for a FAILED job, shared by every reaccept path
 * (claim-time sweep, `retry()`, admission re-submit).
 *
 * The recorded origin state is what carries the transaction hash forward
 * (`recovery.txHashChecked`), so which origins are recorded IS the evidence-preservation rule.
 * Every origin is recorded except 'accepted', which has no prior state to recover from — stated
 * as that one exclusion rather than a list of the rest, so a new active state cannot silently go
 * unrecorded (the compiler rejects one that is not a `LiftJobResettableState`). `included` used to
 * be excluded, which dropped the recovery record and the hash with it. The origin is recorded even
 * though every manual path refuses evidence-bearing jobs today: the reset must not be the step
 * that loses the evidence when the proof-first dispatcher lands.
 *
 * The hash itself comes from {@link getLiftJobTransactionEvidence}, i.e. from EITHER carrier: a job
 * being reset a second time carries its hash in the recovery record left by the first reset, and
 * reading only `broadcast` dropped it exactly there.
 *
 * Timestamps are rebuilt from scratch rather than merged, so `nextRetryAt` is dropped BY
 * CONSTRUCTION — a reaccepted job carries no stale schedule for the sweep to re-fire on.
 */
export function resetFailedLiftJobToAccepted(
  job: PersistedFailedJob,
  now: number,
  options: { readonly txHashAccounted?: boolean } = {},
): LiftJobAccepted {
  return buildLiftJobAcceptedReset(job, {
    now,
    ...(options.txHashAccounted ? { txHashAccounted: true } : {}),
    // The marker rides along with the hash: a released job must not degrade to the pre-marker
    // default on its next attempt (see LiftJobRecoveryMetadata.operationKind).
    ...(liftJobOperationKindMarker(job) ? { operationKind: liftJobOperationKindMarker(job) } : {}),
    // r23 (🔴 3817474299) — and so do the SIGNER and the nonce, for the same reason. This is
    // the SECOND reset path (admission re-submit, `retry()`, the claim-time sweep); the recovery
    // dispatcher has its own. Preserving the envelope in only one of them meant a job reset
    // through this one lost its signer and could never form a chain-proof lookup again.
    ...(liftJobCheckedSigner(job) ? { walletIdChecked: liftJobCheckedSigner(job) } : {}),
    ...(liftJobCheckedNonce(job) !== undefined ? { nonceChecked: liftJobCheckedNonce(job) } : {}),
    // 'accepted' is the one origin with no prior state to recover from. Stated as that exclusion
    // rather than a list of the rest, so a new active state cannot silently go unrecorded — the
    // compiler rejects one that is not a `LiftJobResettableState`.
    recoveredFrom: job.failure.failedFromState === 'accepted' ? undefined : job.failure.failedFromState,
    txHashChecked: getLiftJobTransactionEvidence(job),
    // This is a RETRY of the job (sweep, `retry()`, re-submit), so the attempt is stamped.
    stampRetriedAt: true,
  });
}

/**
 * GH#2270 — the ONE shape of a job reset back to 'accepted', for every path that rebuilds one: the
 * failed-job reaccept above and the interrupted-recovery reset in the publisher. The two used to be
 * separate literals that had already drifted once (the evidence carrier), which is the whole reason
 * this exists; their remaining differences are the OPTIONS below rather than two copies to keep in
 * step by eye.
 *
 * The job is rebuilt, never merged, so `nextRetryAt` is dropped BY CONSTRUCTION — a reaccepted job
 * carries no stale schedule for the sweep to re-fire on — and so are the claim, validation and
 * broadcast facts of the attempt that failed.
 *
 * `recoveredFrom` is the origin state the recovery record names; passing `undefined` records no
 * recovery at all. It is what carries the transaction hash forward (`txHashChecked`), so which
 * origins a caller records IS its evidence-preservation rule. `stampRetriedAt` separates a RETRY
 * (an attempt was spent) from a recovery reset (the job was interrupted, not re-attempted).
 */
export function buildLiftJobAcceptedReset(
  job: LiftJob,
  options: {
    readonly now: number;
    readonly recoveredFrom: LiftJobResettableState | undefined;
    readonly txHashChecked: LiftJobHex | undefined;
    readonly stampRetriedAt: boolean;
    /**
     * GH#2270 PR-3 r3 — the chain has ACCOUNTED for `txHashChecked` and this reset is the decision.
     * Defaults to absent, so every caller that has not asked the chain keeps carrying an open
     * question forward, which is the safe direction. Only the proof-first dispatcher passes true.
     */
    readonly txHashAccounted?: boolean;
    /** The branch the checked transaction signed; carried forward like the hash itself. */
    readonly operationKind?: 'create' | 'update';
    /**
     * r21 (🔴 3812632539) — the signer envelope of `txHashChecked`, preserved with it. A reset
     * drops `broadcast`, so without this the inherited hash would later be paired with whatever
     * wallet claims the job next.
     */
    readonly walletIdChecked?: string;
    readonly nonceChecked?: number;
  },
): LiftJobAccepted {
  return {
    jobId: job.jobId,
    jobSlug: job.jobSlug,
    request: job.request,
    // Admission is immutable job identity: a recovery reset must not launder away WHO admitted the
    // job, or the enqueuer would lose the by-id clear on exactly the recovered jobs that need it.
    ...(job.admission ? { admission: job.admission } : {}),
    status: 'accepted',
    timestamps: {
      acceptedAt: job.timestamps.acceptedAt,
      lastRecoveredAt: options.now,
      updatedAt: options.now,
      ...(options.stampRetriedAt ? { lastRetriedAt: options.now } : {}),
    },
    retries: job.retries,
    recovery: options.recoveredFrom
      ? {
          action: 'reset_to_accepted',
          recoveredFromStatus: options.recoveredFrom,
          txHashChecked: options.txHashChecked,
          ...(options.txHashAccounted ? { txHashAccounted: true } : {}),
          ...(options.operationKind ? { operationKind: options.operationKind } : {}),
          ...(options.walletIdChecked ? { walletIdChecked: options.walletIdChecked } : {}),
          ...(options.nonceChecked !== undefined ? { nonceChecked: options.nonceChecked } : {}),
        }
      : undefined,
    controlPlane: job.controlPlane,
  };
}

export function createKnowledgeAssetVmPublishSnapshotRequest(
  request: KnowledgeAssetVmPublishRequest,
): LiftPublishSnapshotRequest {
  return {
    shareOperationId: request.shareOperationId,
    roots: request.roots,
    contextGraphId: request.contextGraphId,
    ...(request.contentScopeVersion !== undefined
      ? { contentScopeVersion: request.contentScopeVersion }
      : {}),
    ...(request.kaUal !== undefined ? { kaUal: request.kaUal } : {}),
    ...(request.assertionVersion !== undefined
      ? { assertionVersion: request.assertionVersion }
      : {}),
    ...(request.publicTripleCount !== undefined
      ? { publicTripleCount: request.publicTripleCount }
      : {}),
    ...(request.privateMerkleRoot !== undefined
      ? { privateMerkleRoot: request.privateMerkleRoot }
      : {}),
    ...(request.privateTripleCount !== undefined
      ? { privateTripleCount: request.privateTripleCount }
      : {}),
    ...(request.accessPolicy !== undefined
      ? { accessPolicy: request.accessPolicy }
      : {}),
    ...(request.allowedPeers !== undefined
      ? { allowedPeers: [...request.allowedPeers] }
      : {}),
    ...(request.entityProofs !== undefined
      ? { entityProofs: request.entityProofs }
      : {}),
    ...(request.subGraphName ? { subGraphName: request.subGraphName } : {}),
    ...(request.publishEpochs !== undefined ? { publishEpochs: request.publishEpochs } : {}),
    ...(request.publisherNodeIdentityIdOverride !== undefined
      ? { publisherNodeIdentityIdOverride: request.publisherNodeIdentityIdOverride }
      : {}),
    seal: request.seal,
  };
}

export function createKnowledgeAssetVmPublishSnapshotMetadata(
  request: KnowledgeAssetVmPublishRequest,
): LiftPublishRequestMetadata {
  const subGraphPart = request.subGraphName ? `:${request.subGraphName}` : '';
  const operationKey = `${request.contextGraphId}:${request.name}${subGraphPart}:${request.shareOperationId}`;
  return {
    scope: 'vm-publish',
    // Named-KA VM publish chooses mint/update from lifecycle state in the agent.
    // This metadata only validates the immutable share snapshot shape: no
    // priorVersion is expected for the sealed snapshot payload itself.
    transitionType: 'CREATE',
    authority: {
      type: 'owner',
      proofRef: `urn:dkg:knowledge-assets:${operationKey}:vm-publish`,
    },
  };
}

export function createRawLiftJobRequest(request: RawLiftRequest): RawLiftJobRequest {
  return {
    jobType: 'lift',
    lift: {
      ...request,
      jobType: request.jobType ?? 'lift',
    },
  };
}

export function createKnowledgeAssetVmPublishJobRequest(
  request: KnowledgeAssetVmPublishRequest,
): KnowledgeAssetVmPublishJobRequest {
  return {
    jobType: 'knowledge-asset-vm-publish',
    knowledgeAssetVmPublish: request,
  };
}

/**
 * Enforce {@link LIFT_JOB_IMMUTABLE_FIELDS} at the WRITE boundary.
 *
 * That list said these fields never change; nothing checked it, and the transition merge spread a
 * caller's patch straight over the record. Harmless-looking while the set was identity and budget,
 * it became an AUTHORIZATION hole when `admission` joined: whoever can pass an `admission` through
 * a transition can move the right to run the destructive pending-transaction clear onto themselves.
 *
 * Compares the EFFECTIVE post-merge value against the current one, never the shape of the patch.
 * Reasoning about the patch is what made the first two versions of this guard wrong: an explicit
 * `undefined` is spread rather than skipped, and an omitted nested key only survives where the
 * merge deep-merges that object -- true for `timestamps`, false for `retries`, which is replaced
 * wholesale. Reading the merge's own output cannot drift from the merge.
 */
export function assertNoImmutableLiftJobFieldChange(current: LiftJob, next: LiftJob): void {
  for (const field of LIFT_JOB_IMMUTABLE_FIELDS) {
    const [head, nested] = field.split('.') as [keyof LiftJob, string | undefined];
    const read = (job: LiftJob): unknown => {
      const value = (job as unknown as Record<string, unknown>)[head as string];
      return nested ? (value as Record<string, unknown> | undefined)?.[nested] : value;
    };
    const before = read(current);
    const after = read(next);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    throw new Error(
      `LiftJob ${current.jobId}: ${field} is immutable and cannot be changed by a transition`,
    );
  }
}

export function isKnowledgeAssetVmPublishJobRequest(
  request: unknown,
): request is KnowledgeAssetVmPublishJobRequest {
  if (!isRecord(request) || request.jobType !== 'knowledge-asset-vm-publish') {
    return false;
  }
  try {
    parseKnowledgeAssetVmPublishRequest(request.knowledgeAssetVmPublish, 'request.knowledgeAssetVmPublish');
    return true;
  } catch {
    return false;
  }
}

export function isRawLiftJobRequest(request: unknown): request is RawLiftJobRequest {
  if (!isRecord(request) || request.jobType !== 'lift' || !isRecord(request.lift)) {
    return false;
  }
  try {
    parseRawLiftRequest(request.lift, 'request.lift');
    return true;
  } catch {
    return false;
  }
}

export function rawLiftRequestFromJobRequest(request: LiftJobRequest): RawLiftRequest | null {
  return isRawLiftJobRequest(request) ? request.lift : null;
}

export function isRawLiftRequest(request: unknown): request is RawLiftRequest {
  if (!isRecord(request) || (request.jobType !== undefined && request.jobType !== 'lift')) {
    return false;
  }
  if (request.lift !== undefined || request.knowledgeAssetVmPublish !== undefined) {
    return false;
  }
  try {
    parseRawLiftRequest(request, 'request');
    return true;
  } catch {
    return false;
  }
}

export function normalizePersistedLiftJobRequest(request: unknown): LiftJobRequest {
  if (!isRecord(request)) {
    throw new Error('Unrecognized persisted async lift job request payload');
  }
  if (request.jobType === 'knowledge-asset-vm-publish') {
    return {
      jobType: 'knowledge-asset-vm-publish',
      knowledgeAssetVmPublish: parseKnowledgeAssetVmPublishRequest(
        request.knowledgeAssetVmPublish,
        'request.knowledgeAssetVmPublish',
      ),
    };
  }
  if (request.jobType === 'lift' && request.lift !== undefined) {
    return createRawLiftJobRequest(parseRawLiftRequest(request.lift, 'request.lift'));
  }
  if (request.jobType === undefined || request.jobType === 'lift') {
    return createRawLiftJobRequest(parseRawLiftRequest(request, 'request'));
  }
  throw new Error('Unrecognized persisted async lift job request payload');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseRawLiftRequest(value: unknown, path: string): RawLiftRequest {
  const record = expectRecord(value, path);
  return {
    ...(record.jobType === 'lift' ? { jobType: 'lift' as const } : {}),
    swmId: expectString(record, 'swmId', path),
    shareOperationId: expectString(record, 'shareOperationId', path),
    roots: expectStringArray(record, 'roots', path),
    contextGraphId: expectString(record, 'contextGraphId', path),
    ...optionalNumberField(record, 'contentScopeVersion', path),
    ...optionalStringField(record, 'kaUal', path),
    ...optionalStringField(record, 'assertionVersion', path),
    ...optionalNumberField(record, 'publicTripleCount', path),
    ...optionalHexStringField(record, 'privateMerkleRoot', path),
    ...optionalNumberField(record, 'privateTripleCount', path),
    namespace: expectString(record, 'namespace', path),
    scope: expectString(record, 'scope', path),
    transitionType: expectEnum(record, 'transitionType', LIFT_TRANSITION_TYPES, path),
    authority: parseAuthority(record.authority, `${path}.authority`),
    ...optionalStringField(record, 'priorVersion', path),
    ...optionalStringField(record, 'subGraphName', path),
    ...optionalAccessPolicyField(record, 'accessPolicy', path),
    ...optionalStringArrayField(record, 'allowedPeers', path),
    ...optionalBooleanField(record, 'entityProofs', path),
    ...optionalNumberField(record, 'publishEpochs', path),
    ...optionalBigIntStringField(record, 'publisherNodeIdentityIdOverride', path),
    ...optionalSealField(record, 'seal', path),
  };
}

function parseKnowledgeAssetVmPublishRequest(value: unknown, path: string): KnowledgeAssetVmPublishRequest {
  const record = expectRecord(value, path);
  return {
    contextGraphId: expectString(record, 'contextGraphId', path),
    name: expectString(record, 'name', path),
    ...optionalStringField(record, 'agentAddress', path),
    // GH#1778 — the enqueuing caller must survive the persisted-job round-trip so
    // the async worker stamps the CG curator with the operator who requested the
    // publish (consistent with the sync lane), not the resolved KA author.
    ...optionalStringField(record, 'callerAgentAddress', path),
    ...optionalStringField(record, 'subGraphName', path),
    shareOperationId: expectString(record, 'shareOperationId', path),
    roots: expectStringArray(record, 'roots', path),
    ...optionalNumberField(record, 'contentScopeVersion', path),
    ...optionalStringField(record, 'kaUal', path),
    ...optionalStringField(record, 'assertionVersion', path),
    ...optionalNumberField(record, 'publicTripleCount', path),
    ...optionalHexStringField(record, 'privateMerkleRoot', path),
    ...optionalNumberField(record, 'privateTripleCount', path),
    ...optionalAccessPolicyField(record, 'accessPolicy', path),
    ...optionalStringArrayField(record, 'allowedPeers', path),
    ...optionalBooleanField(record, 'entityProofs', path),
    seal: parseSeal(record.seal, `${path}.seal`),
    sealChainId: expectBigIntString(record, 'sealChainId', path),
    sealKav10Address: expectHexString(record, 'sealKav10Address', path),
    sealFinalizedAtIso: expectString(record, 'sealFinalizedAtIso', path),
    sealMerkleRoot: expectHexString(record, 'sealMerkleRoot', path),
    intentKey: expectString(record, 'intentKey', path),
    ...optionalStringField(record, 'wmCurrentAssertion', path),
    ...optionalStringField(record, 'swmCurrentAssertion', path),
    ...optionalStringField(record, 'vmCurrentAssertion', path),
    ...optionalStringField(record, 'kaNumber', path),
    ...optionalStringField(record, 'reservedUal', path),
    ...optionalNumberField(record, 'publishEpochs', path),
    ...optionalBooleanField(record, 'clearSharedMemoryAfter', path),
    ...optionalBigIntStringField(record, 'publisherNodeIdentityIdOverride', path),
  };
}

function parseAuthority(value: unknown, path: string): RawLiftRequest['authority'] {
  const record = expectRecord(value, path);
  return {
    type: expectEnum(record, 'type', LIFT_AUTHORITY_TYPES, path),
    proofRef: expectString(record, 'proofRef', path),
  };
}

function parseSeal(value: unknown, path: string): KnowledgeAssetVmPublishRequest['seal'] {
  const record = expectRecord(value, path);
  const signature = expectRecord(record.signature, `${path}.signature`);
  return {
    merkleRoot: expectHexString(record, 'merkleRoot', path),
    authorAddress: expectHexString(record, 'authorAddress', path),
    signature: {
      r: expectHexString(signature, 'r', `${path}.signature`),
      vs: expectHexString(signature, 'vs', `${path}.signature`),
    },
    schemeVersion: expectInteger(record, 'schemeVersion', path),
    ...optionalBigIntStringField(record, 'reservedKaId', path),
  };
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function expectString(record: Record<string, unknown>, field: string, path: string): string {
  const value = record[field];
  if (typeof value !== 'string') {
    throw new Error(`${path}.${field} must be a string`);
  }
  return value;
}

function expectHexString(record: Record<string, unknown>, field: string, path: string): `0x${string}` {
  const value = expectString(record, field, path);
  if (!/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${path}.${field} must be a 0x-prefixed hex string`);
  }
  return value as `0x${string}`;
}

function expectBigIntString(record: Record<string, unknown>, field: string, path: string): `${bigint}` {
  const value = expectString(record, field, path);
  try {
    BigInt(value);
  } catch {
    throw new Error(`${path}.${field} must be a bigint string`);
  }
  return value as `${bigint}`;
}

function expectInteger(record: Record<string, unknown>, field: string, path: string): number {
  const value = record[field];
  if (!Number.isInteger(value)) {
    throw new Error(`${path}.${field} must be an integer`);
  }
  return value as number;
}

function expectStringArray(record: Record<string, unknown>, field: string, path: string): readonly string[] {
  const value = record[field];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${path}.${field} must be an array of strings`);
  }
  return value;
}

function expectEnum<T extends readonly string[]>(
  record: Record<string, unknown>,
  field: string,
  allowed: T,
  path: string,
): T[number] {
  const value = expectString(record, field, path);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${path}.${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T[number];
}

function optionalStringField<T extends string>(
  record: Record<string, unknown>,
  field: T,
  path: string,
): Partial<Record<T, string>> {
  const value = record[field];
  if (value === undefined) return {};
  if (typeof value !== 'string') {
    throw new Error(`${path}.${field} must be a string when supplied`);
  }
  return { [field]: value } as Partial<Record<T, string>>;
}

function optionalNumberField<T extends string>(
  record: Record<string, unknown>,
  field: T,
  path: string,
): Partial<Record<T, number>> {
  const value = record[field];
  if (value === undefined) return {};
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path}.${field} must be a finite number when supplied`);
  }
  return { [field]: value } as Partial<Record<T, number>>;
}

function optionalBooleanField<T extends string>(
  record: Record<string, unknown>,
  field: T,
  path: string,
): Partial<Record<T, boolean>> {
  const value = record[field];
  if (value === undefined) return {};
  if (typeof value !== 'boolean') {
    throw new Error(`${path}.${field} must be a boolean when supplied`);
  }
  return { [field]: value } as Partial<Record<T, boolean>>;
}

function optionalStringArrayField<T extends string>(
  record: Record<string, unknown>,
  field: T,
  path: string,
): Partial<Record<T, readonly string[]>> {
  const value = record[field];
  if (value === undefined) return {};
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${path}.${field} must be an array of strings when supplied`);
  }
  return { [field]: value } as unknown as Partial<Record<T, readonly string[]>>;
}

function optionalBigIntStringField<T extends string>(
  record: Record<string, unknown>,
  field: T,
  path: string,
): Partial<Record<T, `${bigint}`>> {
  if (record[field] === undefined) return {};
  return { [field]: expectBigIntString(record, field, path) } as Partial<Record<T, `${bigint}`>>;
}

function optionalHexStringField<T extends string>(
  record: Record<string, unknown>,
  field: T,
  path: string,
): Partial<Record<T, `0x${string}`>> {
  if (record[field] === undefined) return {};
  return {
    [field]: expectHexString(record, field, path),
  } as Partial<Record<T, `0x${string}`>>;
}

function optionalAccessPolicyField(
  record: Record<string, unknown>,
  field: 'accessPolicy',
  path: string,
): Pick<RawLiftRequest, 'accessPolicy'> | Record<string, never> {
  const value = record[field];
  if (value === undefined) return {};
  if (value !== 'public' && value !== 'ownerOnly' && value !== 'allowList') {
    throw new Error(`${path}.${field} must be one of: public, ownerOnly, allowList`);
  }
  return { accessPolicy: value };
}

function optionalSealField(
  record: Record<string, unknown>,
  field: 'seal',
  path: string,
): Pick<RawLiftRequest, 'seal'> | Record<string, never> {
  if (record[field] === undefined) return {};
  return { seal: parseSeal(record[field], `${path}.${field}`) };
}
