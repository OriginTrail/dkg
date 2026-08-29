import {
  LIFT_JOB_IMMUTABLE_FIELDS,
  LIFT_JOB_STATES,
  assertLiftJobTransition,
  type LiftJob,
  type LiftJobAdmissionMetadata,
  type LiftJobBase,
  type LiftJobBroadcastMetadata,
  type LiftJobClaimMetadata,
  type LiftJobControlPlaneRefs,
  type LiftJobFailureMetadata,
  type LiftJobFinalizationInput,
  type LiftJobFinalizationMetadata,
  type LiftJobHex,
  type LiftJobInclusionMetadata,
  type LiftJobRecoveryMetadata,
  type LiftJobRecoveryResetToAccepted,
  type LiftJobRetryMetadata,
  type LiftJobState,
  type LiftJobTimestamps,
  type LiftJobValidationMetadata,
  type PersistedLiftJob,
} from './lift-job.js';

/** Structurally decoded inclusion; old rows may rely on broadcast.txHash as the carrier. */
export type StructurallyValidLiftJobInclusion = Omit<LiftJobInclusionMetadata, 'txHash'> & {
  readonly txHash?: LiftJobHex;
};

/**
 * One parsed lifecycle candidate. State membership and exact field legality are applied only after
 * every value in this structural bag has passed its runtime schema.
 */
export type StructurallyValidLiftJobPayload = Omit<LiftJobBase, 'status'> & {
  readonly status: string;
  readonly claim?: LiftJobClaimMetadata;
  readonly validation?: LiftJobValidationMetadata;
  readonly broadcast?: LiftJobBroadcastMetadata;
  readonly inclusion?: StructurallyValidLiftJobInclusion;
  readonly finalization?: LiftJobFinalizationMetadata;
  readonly failure?: LiftJobFailureMetadata;
};

/**
 * Compatibility mutation surface used by the administrative API. Destination constructors below
 * accept this broad shape at the boundary, then select only fields legal for their exact output.
 */
export interface LiftJobTransitionPatch {
  readonly jobId?: string;
  readonly jobSlug?: string;
  readonly request?: LiftJobBase['request'];
  readonly admission?: LiftJobAdmissionMetadata;
  readonly timestamps?: LiftJobTimestamps;
  readonly retries?: LiftJobRetryMetadata;
  readonly recovery?: LiftJobRecoveryMetadata;
  readonly controlPlane?: LiftJobControlPlaneRefs;
  readonly claim?: LiftJobClaimMetadata;
  readonly validation?: LiftJobValidationMetadata;
  readonly broadcast?: LiftJobBroadcastMetadata;
  readonly inclusion?: LiftJobInclusionMetadata;
  readonly finalization?: LiftJobFinalizationMetadata;
  readonly failure?: LiftJobFailureMetadata;
}

type LiftJobTransitionBasePatch = Pick<
  LiftJobTransitionPatch,
  'timestamps' | 'retries' | 'recovery' | 'controlPlane'
>;

/** Compile-time inputs for ordinary, statically named destination transitions. */
export type LiftJobTransitionPatchByState = {
  readonly accepted: LiftJobTransitionBasePatch;
  readonly claimed: LiftJobTransitionBasePatch & {
    readonly claim: LiftJobClaimMetadata;
  };
  readonly validated: LiftJobTransitionBasePatch & {
    readonly claim?: LiftJobClaimMetadata;
    readonly validation: LiftJobValidationMetadata;
  };
  readonly broadcast: LiftJobTransitionBasePatch & {
    readonly claim?: LiftJobClaimMetadata;
    readonly validation?: LiftJobValidationMetadata;
    readonly broadcast: LiftJobBroadcastMetadata;
  };
  readonly included: LiftJobTransitionBasePatch & {
    readonly claim?: LiftJobClaimMetadata;
    readonly validation?: LiftJobValidationMetadata;
    readonly broadcast?: LiftJobBroadcastMetadata;
    readonly inclusion: LiftJobInclusionMetadata;
  };
  readonly finalized: LiftJobTransitionBasePatch & {
    readonly claim?: LiftJobClaimMetadata;
    readonly validation?: LiftJobValidationMetadata;
    readonly broadcast?: LiftJobBroadcastMetadata;
    readonly inclusion?: LiftJobInclusionMetadata;
    readonly finalization: LiftJobFinalizationMetadata;
  };
  readonly failed: LiftJobTransitionBasePatch & {
    readonly claim?: LiftJobClaimMetadata;
    readonly validation?: LiftJobValidationMetadata;
    readonly broadcast?: LiftJobBroadcastMetadata;
    readonly inclusion?: LiftJobInclusionMetadata;
    readonly failure: LiftJobFailureMetadata;
  };
};

export type LiftJobTransitionPatchFor<State extends LiftJobState> =
  LiftJobTransitionPatchByState[State];

export function requiredLiftJobField<T>(value: T | undefined, path: string): T {
  if (value === undefined) throw new Error(`${path} is required`);
  return value;
}

export function rejectDefinedLiftJobFields(
  job: StructurallyValidLiftJobPayload,
  fields: ReadonlyArray<keyof StructurallyValidLiftJobPayload>,
): void {
  for (const field of fields) {
    if (job[field] !== undefined) {
      throw new Error(`${String(field)} is forbidden for status ${job.status}`);
    }
  }
}

export function canonicalLiftJobInclusion(
  inclusion: StructurallyValidLiftJobInclusion,
  broadcast: LiftJobBroadcastMetadata,
): LiftJobInclusionMetadata {
  return { ...inclusion, txHash: inclusion.txHash ?? broadcast.txHash };
}

export function canonicalLiftJobBase(
  job: StructurallyValidLiftJobPayload,
): Omit<LiftJobBase, 'status'> {
  return {
    jobId: job.jobId,
    jobSlug: job.jobSlug,
    request: job.request,
    ...(job.admission !== undefined ? { admission: job.admission } : {}),
    timestamps: job.timestamps,
    retries: job.retries,
    ...(job.recovery !== undefined ? { recovery: job.recovery } : {}),
    ...(job.controlPlane !== undefined ? { controlPlane: job.controlPlane } : {}),
  };
}

export function canonicalLiftJobBaseWithoutRecovery(
  job: StructurallyValidLiftJobPayload,
): Omit<LiftJobBase, 'status' | 'recovery'> {
  const { recovery: _recovery, ...withoutRecovery } = canonicalLiftJobBase(job);
  return withoutRecovery;
}

export function canonicalLiftJobFailureRecovery(
  recovery: LiftJobRecoveryMetadata | undefined,
): LiftJobRecoveryResetToAccepted | undefined {
  if (recovery === undefined) return undefined;
  if (recovery.action !== 'reset_to_accepted') {
    throw new Error('failed jobs may carry only reset_to_accepted recovery provenance');
  }
  return recovery;
}

function isLiftJobBigInt(value: string): value is `${bigint}` {
  return /^-?(?:0|[1-9]\d*)$/.test(value);
}

/** Preserve numeric public IDs while giving opaque backend IDs an explicit, non-breaking home. */
export function canonicalLiftJobFinalizationMetadata(
  input: LiftJobFinalizationInput,
): LiftJobFinalizationMetadata {
  const opaqueIdentifiers = { ...input.opaqueIdentifiers };
  const numericIdentifiers: {
    batchId?: `${bigint}`;
    startKAId?: `${bigint}`;
    endKAId?: `${bigint}`;
  } = {};
  for (const field of ['batchId', 'startKAId', 'endKAId'] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (isLiftJobBigInt(value)) numericIdentifiers[field] = value;
    else opaqueIdentifiers[field] = value;
  }
  return {
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    ...(input.txHash !== undefined ? { txHash: input.txHash } : {}),
    ...(input.ual !== undefined ? { ual: input.ual } : {}),
    ...numericIdentifiers,
    ...(Object.keys(opaqueIdentifiers).length > 0 ? { opaqueIdentifiers } : {}),
    ...(input.publisherAddress !== undefined ? { publisherAddress: input.publisherAddress } : {}),
  };
}

const PROGRESS_FIELDS = [
  'claim',
  'validation',
  'broadcast',
  'inclusion',
  'finalization',
  'failure',
] as const;

type LiftJobProgressField = (typeof PROGRESS_FIELDS)[number];
type LiftJobConstructionField = LiftJobProgressField | 'recovery';
type LiftJobProgressValues = Pick<StructurallyValidLiftJobPayload, LiftJobProgressField>;

interface LiftJobConstructionSource {
  value<Field extends LiftJobProgressField>(
    field: Field,
  ): LiftJobProgressValues[Field];
  reject(fields: readonly LiftJobConstructionField[], status: LiftJobState): void;
}

function isLiftJobState(status: string): status is LiftJobState {
  return LIFT_JOB_STATES.some((candidate) => candidate === status);
}

/**
 * The one per-state construction table. Durable decoding supplies fields directly and rejects
 * every forbidden persisted field. Transitions supply inherited/patched values and reject only
 * forbidden patch fields, so deliberate lifecycle shedding is visible at that boundary.
 */
function constructCanonicalLiftJob(
  status: LiftJobState,
  base: Omit<LiftJobBase, 'status'>,
  source: LiftJobConstructionSource,
): LiftJob {
  const reject = (fields: readonly LiftJobConstructionField[]): void =>
    source.reject(fields, status);
  const required = <Field extends LiftJobProgressField>(
    field: Field,
  ): Exclude<LiftJobProgressValues[Field], undefined> =>
    requiredLiftJobField(source.value(field), field) as Exclude<
      LiftJobProgressValues[Field],
      undefined
    >;
  const baseWithoutRecovery = (): Omit<LiftJobBase, 'status' | 'recovery'> => {
    const { recovery: _recovery, ...withoutRecovery } = base;
    return withoutRecovery;
  };

  switch (status) {
    case 'accepted':
      reject(['claim', 'validation', 'broadcast', 'inclusion', 'finalization', 'failure']);
      return { ...base, status: 'accepted' };
    case 'claimed':
      reject(['validation', 'broadcast', 'inclusion', 'finalization', 'failure']);
      return {
        ...base,
        status: 'claimed',
        claim: required('claim'),
      };
    case 'validated':
      reject(['broadcast', 'inclusion', 'finalization', 'failure']);
      return {
        ...base,
        status: 'validated',
        claim: required('claim'),
        validation: required('validation'),
      };
    case 'broadcast':
      reject(['inclusion', 'finalization', 'failure']);
      return {
        ...base,
        status: 'broadcast',
        claim: required('claim'),
        validation: required('validation'),
        broadcast: required('broadcast'),
      };
    case 'included': {
      reject(['finalization', 'failure']);
      const broadcast = required('broadcast');
      return {
        ...base,
        status: 'included',
        claim: required('claim'),
        validation: required('validation'),
        broadcast,
        inclusion: canonicalLiftJobInclusion(required('inclusion'), broadcast),
      };
    }
    case 'finalized': {
      reject(['failure']);
      const claim = required('claim');
      const validation = required('validation');
      const finalization = required('finalization');
      if (finalization.mode === 'noop') {
        reject(['broadcast', 'inclusion']);
        return {
          ...base,
          status: 'finalized',
          claim,
          validation,
          finalization: { ...finalization, mode: 'noop' },
        };
      }
      if (finalization.mode === 'local') {
        reject(['broadcast', 'inclusion']);
        return {
          ...base,
          status: 'finalized',
          claim,
          validation,
          finalization: { ...finalization, mode: 'local' },
        };
      }
      const { mode, ...publishedFields } = finalization;
      const broadcast = required('broadcast');
      return {
        ...base,
        status: 'finalized',
        claim,
        validation,
        broadcast,
        inclusion: canonicalLiftJobInclusion(required('inclusion'), broadcast),
        finalization: { ...publishedFields, ...(mode === 'published' ? { mode } : {}) },
      };
    }
    case 'failed': {
      reject(['finalization']);
      const failure = required('failure');
      const recovery = canonicalLiftJobFailureRecovery(base.recovery);
      switch (failure.failedFromState) {
        case 'accepted':
          reject(['claim', 'validation', 'broadcast', 'inclusion', 'recovery']);
          if (base.recovery !== undefined) {
            throw new Error('recovery is forbidden for status failed');
          }
          return {
            ...baseWithoutRecovery(),
            status: 'failed',
            failure: { ...failure, failedFromState: 'accepted' },
          };
        case 'claimed':
          reject(['validation', 'broadcast', 'inclusion']);
          return {
            ...baseWithoutRecovery(),
            ...(recovery ? { recovery } : {}),
            status: 'failed',
            claim: required('claim'),
            failure: { ...failure, failedFromState: 'claimed' },
          };
        case 'validated':
          reject(['broadcast', 'inclusion']);
          return {
            ...baseWithoutRecovery(),
            ...(recovery ? { recovery } : {}),
            status: 'failed',
            claim: required('claim'),
            validation: required('validation'),
            failure: { ...failure, failedFromState: 'validated' },
          };
        case 'broadcast': {
          reject(['inclusion']);
          const failedBase = {
            ...baseWithoutRecovery(),
            ...(recovery ? { recovery } : {}),
            status: 'failed' as const,
            claim: required('claim'),
            validation: required('validation'),
          };
          const broadcast = source.value('broadcast');
          return broadcast === undefined
            ? { ...failedBase, failure: { ...failure, failedFromState: 'broadcast' } }
            : {
                ...failedBase,
                broadcast,
                failure: { ...failure, failedFromState: 'broadcast' },
              };
        }
        case 'included': {
          const failedBase = {
            ...baseWithoutRecovery(),
            ...(recovery ? { recovery } : {}),
            status: 'failed' as const,
            claim: required('claim'),
            validation: required('validation'),
          };
          const broadcast = source.value('broadcast');
          if (broadcast === undefined) {
            reject(['inclusion']);
            return { ...failedBase, failure: { ...failure, failedFromState: 'included' } };
          }
          return {
            ...failedBase,
            broadcast,
            inclusion: canonicalLiftJobInclusion(required('inclusion'), broadcast),
            failure: { ...failure, failedFromState: 'included' },
          };
        }
      }
    }
  }
}

/** Strict source-independent durable projection through the shared per-state constructor. */
export function projectCanonicalLiftJob(job: StructurallyValidLiftJobPayload): LiftJob | null {
  if (!isLiftJobState(job.status)) return null;
  const source: LiftJobConstructionSource = {
    value: (field) => job[field],
    reject: (fields) => rejectDefinedLiftJobFields(job, fields),
  };
  return constructCanonicalLiftJob(
    job.status,
    canonicalLiftJobBase(job),
    source,
  );
}

function hasOwn(value: object, field: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function fieldFromPatch<T>(patch: T | undefined, current: T | undefined): T | undefined {
  return patch ?? current;
}

function broadcastFromPatch(
  current: LiftJob,
  patch: LiftJobTransitionPatch,
): LiftJobBroadcastMetadata | undefined {
  const candidate = fieldFromPatch(patch.broadcast, current.broadcast);
  if (
    candidate === undefined
    || current.broadcast === undefined
    || candidate.txHash !== current.broadcast.txHash
  ) return candidate;
  return { ...current.broadcast, ...candidate };
}

function inclusionFromPatch(
  current: LiftJob,
  patch: LiftJobTransitionPatch,
): LiftJobInclusionMetadata | undefined {
  const candidate = fieldFromPatch(patch.inclusion, current.inclusion);
  if (
    candidate === undefined
    || current.inclusion === undefined
    || candidate.txHash !== current.inclusion.txHash
    || candidate.blockNumber !== current.inclusion.blockNumber
  ) return candidate;
  return { ...current.inclusion, ...candidate };
}

function rejectTransitionPatchFields(
  patch: LiftJobTransitionPatch,
  fields: ReadonlyArray<(typeof PROGRESS_FIELDS)[number] | 'recovery'>,
  status: LiftJobState,
): void {
  for (const field of fields) {
    if (patch[field] !== undefined) {
      throw new Error(`${String(field)} is forbidden for status ${status}`);
    }
  }
}

function immutableLiftJobFieldValue(
  job: LiftJob,
  field: (typeof LIFT_JOB_IMMUTABLE_FIELDS)[number],
): unknown {
  switch (field) {
    case 'jobId': return job.jobId;
    case 'jobSlug': return job.jobSlug;
    case 'request': return job.request;
    case 'admission': return job.admission;
    case 'timestamps.acceptedAt': return job.timestamps.acceptedAt;
    case 'retries.maxRetries': return job.retries.maxRetries;
  }
}

function patchedImmutableLiftJobFieldValue(
  current: LiftJob,
  patch: LiftJobTransitionPatch,
  field: (typeof LIFT_JOB_IMMUTABLE_FIELDS)[number],
): unknown {
  switch (field) {
    case 'jobId': return hasOwn(patch, 'jobId') ? patch.jobId : current.jobId;
    case 'jobSlug': return hasOwn(patch, 'jobSlug') ? patch.jobSlug : current.jobSlug;
    case 'request': return hasOwn(patch, 'request') ? patch.request : current.request;
    case 'admission': return hasOwn(patch, 'admission') ? patch.admission : current.admission;
    case 'timestamps.acceptedAt':
      return patch.timestamps === undefined || !hasOwn(patch.timestamps, 'acceptedAt')
        ? current.timestamps.acceptedAt
        : patch.timestamps.acceptedAt;
    case 'retries.maxRetries':
      return !hasOwn(patch, 'retries') ? current.retries.maxRetries : patch.retries?.maxRetries;
  }
}

function assertNoImmutableLiftJobPatch(current: LiftJob, patch: LiftJobTransitionPatch): void {
  for (const field of LIFT_JOB_IMMUTABLE_FIELDS) {
    const before = immutableLiftJobFieldValue(current, field);
    const after = patchedImmutableLiftJobFieldValue(current, patch, field);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    throw new Error(
      `LiftJob ${current.jobId}: ${field} is immutable and cannot be changed by a transition`,
    );
  }
}

function transitionTimestamps(
  current: LiftJob,
  status: LiftJobState,
  patch: LiftJobTransitionPatch,
  now: number,
): LiftJobTimestamps {
  const timestamps = { ...current.timestamps, ...patch.timestamps };
  return {
    ...timestamps,
    claimedAt: status === 'claimed' ? (timestamps.claimedAt ?? now) : timestamps.claimedAt,
    validatedAt: status === 'validated' ? (timestamps.validatedAt ?? now) : timestamps.validatedAt,
    broadcastAt: status === 'broadcast' ? (timestamps.broadcastAt ?? now) : timestamps.broadcastAt,
    includedAt: status === 'included' ? (timestamps.includedAt ?? now) : timestamps.includedAt,
    finalizedAt: status === 'finalized' ? (timestamps.finalizedAt ?? now) : timestamps.finalizedAt,
    failedAt: status === 'failed' ? (timestamps.failedAt ?? now) : timestamps.failedAt,
    updatedAt: now,
  };
}

function transitionBase(
  current: LiftJob,
  status: LiftJobState,
  patch: LiftJobTransitionPatch,
  now: number,
): Omit<LiftJobBase, 'status'> {
  const retries = hasOwn(patch, 'retries')
    ? requiredLiftJobField(patch.retries, 'retries')
    : current.retries;
  const recovery = hasOwn(patch, 'recovery') ? patch.recovery : current.recovery;
  const controlPlane = hasOwn(patch, 'controlPlane') ? patch.controlPlane : current.controlPlane;
  return {
    jobId: current.jobId,
    jobSlug: current.jobSlug,
    request: current.request,
    ...(current.admission !== undefined ? { admission: current.admission } : {}),
    timestamps: transitionTimestamps(current, status, patch, now),
    retries,
    ...(recovery !== undefined ? { recovery } : {}),
    ...(controlPlane !== undefined ? { controlPlane } : {}),
  };
}

function transitionConstructionSource(
  current: LiftJob,
  patch: LiftJobTransitionPatch,
): LiftJobConstructionSource {
  const claim = fieldFromPatch(patch.claim, current.claim);
  const validation = fieldFromPatch(patch.validation, current.validation);
  const broadcast = broadcastFromPatch(current, patch);
  const inclusion = inclusionFromPatch(current, patch);
  const finalization = fieldFromPatch(patch.finalization, current.finalization);
  const failure = fieldFromPatch(patch.failure, current.failure);
  const values: LiftJobProgressValues = {
    ...(claim !== undefined ? { claim } : {}),
    ...(validation !== undefined ? { validation } : {}),
    ...(broadcast !== undefined ? { broadcast } : {}),
    ...(inclusion !== undefined ? { inclusion } : {}),
    ...(finalization !== undefined ? { finalization } : {}),
    ...(failure !== undefined ? { failure } : {}),
  };
  return {
    value: (field) => values[field],
    reject: (fields, status) => rejectTransitionPatchFields(patch, fields, status),
  };
}

function assertFailureOriginRetainsTransactionEvidence(
  current: LiftJob,
  source: LiftJobConstructionSource,
): void {
  const failure = source.value('failure');
  if (failure === undefined) return;
  if (
    (current.status === 'broadcast' || current.status === 'included')
    && failure.failedFromState !== current.status
  ) {
    throw new Error(
      `LiftJob ${current.jobId}: failure origin ${failure.failedFromState} cannot discard `
      + `${current.status} transaction evidence`,
    );
  }
}

function checkedRecoveryTxHash(job: LiftJob): LiftJobHex | undefined {
  return job.recovery?.txHashChecked;
}

const RECOVERY_EVIDENCE_FIELDS = [
  'action',
  'recoveredFromStatus',
  'txHashChecked',
  'txHashAccounted',
  'operationKind',
  'walletIdChecked',
  'nonceChecked',
] as const;

function recoveryEvidenceField(
  recovery: LiftJobRecoveryMetadata | undefined,
  field: (typeof RECOVERY_EVIDENCE_FIELDS)[number],
): unknown {
  if (recovery === undefined) return undefined;
  if (field === 'action' || field === 'recoveredFromStatus' || field === 'txHashChecked') {
    return recovery[field];
  }
  return recovery.action === 'reset_to_accepted' ? recovery[field] : undefined;
}

/** No ordinary transition may erase or retarget transaction evidence already persisted. */
function assertTransactionEvidenceRetained(current: LiftJob, next: LiftJob): void {
  if (current.broadcast !== undefined) {
    if (next.broadcast === undefined) {
      throw new Error(
        `LiftJob ${current.jobId}: transition cannot discard broadcast transaction evidence`,
      );
    }
    for (const field of ['txHash', 'walletId', 'nonce', 'operationKind'] as const) {
      const before = current.broadcast[field];
      if (before === undefined || before === next.broadcast[field]) continue;
      throw new Error(`LiftJob ${current.jobId}: transition cannot change broadcast.${field}`);
    }
  }
  if (current.inclusion !== undefined) {
    if (next.inclusion === undefined) {
      throw new Error(
        `LiftJob ${current.jobId}: transition cannot discard inclusion transaction evidence`,
      );
    }
    for (const field of ['txHash', 'blockNumber', 'blockHash', 'blockTimestamp'] as const) {
      const before = current.inclusion[field];
      if (before === undefined || before === next.inclusion[field]) continue;
      throw new Error(`LiftJob ${current.jobId}: transition cannot change inclusion.${field}`);
    }
  }
  const checkedTxHash = checkedRecoveryTxHash(current);
  if (checkedTxHash !== undefined) {
    for (const field of RECOVERY_EVIDENCE_FIELDS) {
      if (recoveryEvidenceField(current.recovery, field)
        === recoveryEvidenceField(next.recovery, field)) continue;
      throw new Error(
        `LiftJob ${current.jobId}: transition cannot change checked recovery.${field}`,
      );
    }
  }
}

export function buildCanonicalLiftJobTransition(
  current: LiftJob,
  status: 'accepted',
  patch: LiftJobTransitionPatchFor<'accepted'>,
  now: number,
): Extract<LiftJob, { status: 'accepted' }>;
export function buildCanonicalLiftJobTransition(
  current: LiftJob,
  status: 'claimed',
  patch: LiftJobTransitionPatchFor<'claimed'>,
  now: number,
): Extract<LiftJob, { status: 'claimed' }>;
export function buildCanonicalLiftJobTransition(
  current: LiftJob,
  status: 'validated',
  patch: LiftJobTransitionPatchFor<'validated'>,
  now: number,
): Extract<LiftJob, { status: 'validated' }>;
export function buildCanonicalLiftJobTransition(
  current: LiftJob,
  status: 'broadcast',
  patch: LiftJobTransitionPatchFor<'broadcast'>,
  now: number,
): Extract<LiftJob, { status: 'broadcast' }>;
export function buildCanonicalLiftJobTransition(
  current: LiftJob,
  status: 'included',
  patch: LiftJobTransitionPatchFor<'included'>,
  now: number,
): Extract<LiftJob, { status: 'included' }>;
export function buildCanonicalLiftJobTransition(
  current: LiftJob,
  status: 'finalized',
  patch: LiftJobTransitionPatchFor<'finalized'>,
  now: number,
): Extract<LiftJob, { status: 'finalized' }>;
export function buildCanonicalLiftJobTransition(
  current: LiftJob,
  status: 'failed',
  patch: LiftJobTransitionPatchFor<'failed'>,
  now: number,
): Extract<LiftJob, { status: 'failed' }>;
export function buildCanonicalLiftJobTransition(
  current: LiftJob,
  status: LiftJobState,
  patch: LiftJobTransitionPatch,
  now: number,
): LiftJob {
  return buildCanonicalLiftJobAdministrativeTransition(current, status, patch, now);
}

/** Runtime-validated compatibility boundary for the public administrative mutation surface. */
export function buildCanonicalLiftJobAdministrativeTransition(
  current: LiftJob,
  status: LiftJobState,
  patch: LiftJobTransitionPatch,
  now: number,
): LiftJob {
  if (current.status !== status) assertLiftJobTransition(current.status, status);
  assertNoImmutableLiftJobPatch(current, patch);
  const base = transitionBase(current, status, patch, now);
  const source = transitionConstructionSource(current, patch);
  if (status === 'failed') assertFailureOriginRetainsTransactionEvidence(current, source);
  const next = constructCanonicalLiftJob(status, base, source);
  assertTransactionEvidenceRetained(current, next);
  return next;
}

type PersistedFailedLiftJob = Extract<PersistedLiftJob, { status: 'failed' }>;

/**
 * Convert a proof-resolved historical failure into one current canonical failed union member.
 * This is the only compatibility-to-canonical re-failure path; it retains every available chain
 * evidence field and deliberately leaves unformable historical records held.
 */
export function buildCanonicalRevertedLiftJobFailure(
  job: PersistedFailedLiftJob,
  failure: LiftJobFailureMetadata,
  now: number,
): Extract<LiftJob, { status: 'failed' }> | null {
  if (failure.code !== 'tx_reverted') {
    throw new Error('proof-resolved failure must use tx_reverted');
  }
  const origin = job.claim !== undefined
    && job.validation !== undefined
    && job.broadcast !== undefined
    && job.inclusion !== undefined
    ? 'included'
    : job.claim !== undefined && job.validation !== undefined && job.broadcast !== undefined
      ? 'broadcast'
      : null;
  if (origin === null) return null;
  const claim = job.claim;
  const validation = job.validation;
  const broadcast = job.broadcast;
  if (claim === undefined || validation === undefined || broadcast === undefined) return null;
  const base = {
    ...canonicalLiftJobBaseWithoutRecovery(job),
    timestamps: {
      ...job.timestamps,
      failedAt: now,
      updatedAt: now,
    },
  };
  if (origin === 'included') {
    return {
      ...base,
      status: 'failed',
      claim,
      validation,
      broadcast,
      inclusion: requiredLiftJobField(job.inclusion, 'inclusion'),
      failure: { ...failure, failedFromState: 'included' },
    };
  }
  return {
    ...base,
    status: 'failed',
    claim,
    validation,
    broadcast,
    failure: { ...failure, failedFromState: 'broadcast' },
  };
}
