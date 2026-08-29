import {
  LIFT_JOB_IMMUTABLE_FIELDS,
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

/**
 * Strict, source-independent durable projection. A candidate either already has the exact fields
 * of one writable union member or it is rejected; transition-only shedding is never hidden here.
 */
export function projectCanonicalLiftJob(job: StructurallyValidLiftJobPayload): LiftJob | null {
  const reject = (fields: ReadonlyArray<keyof StructurallyValidLiftJobPayload>): void =>
    rejectDefinedLiftJobFields(job, fields);
  const base = (): Omit<LiftJobBase, 'status'> => canonicalLiftJobBase(job);
  const baseWithoutRecovery = (): Omit<LiftJobBase, 'status' | 'recovery'> =>
    canonicalLiftJobBaseWithoutRecovery(job);

  switch (job.status) {
    case 'accepted':
      reject(['claim', 'validation', 'broadcast', 'inclusion', 'finalization', 'failure']);
      return { ...base(), status: 'accepted' };
    case 'claimed':
      reject(['validation', 'broadcast', 'inclusion', 'finalization', 'failure']);
      return {
        ...base(),
        status: 'claimed',
        claim: requiredLiftJobField(job.claim, 'claim'),
      };
    case 'validated':
      reject(['broadcast', 'inclusion', 'finalization', 'failure']);
      return {
        ...base(),
        status: 'validated',
        claim: requiredLiftJobField(job.claim, 'claim'),
        validation: requiredLiftJobField(job.validation, 'validation'),
      };
    case 'broadcast':
      reject(['inclusion', 'finalization', 'failure']);
      return {
        ...base(),
        status: 'broadcast',
        claim: requiredLiftJobField(job.claim, 'claim'),
        validation: requiredLiftJobField(job.validation, 'validation'),
        broadcast: requiredLiftJobField(job.broadcast, 'broadcast'),
      };
    case 'included': {
      reject(['finalization', 'failure']);
      const broadcast = requiredLiftJobField(job.broadcast, 'broadcast');
      return {
        ...base(),
        status: 'included',
        claim: requiredLiftJobField(job.claim, 'claim'),
        validation: requiredLiftJobField(job.validation, 'validation'),
        broadcast,
        inclusion: canonicalLiftJobInclusion(
          requiredLiftJobField(job.inclusion, 'inclusion'),
          broadcast,
        ),
      };
    }
    case 'finalized': {
      reject(['failure']);
      const claim = requiredLiftJobField(job.claim, 'claim');
      const validation = requiredLiftJobField(job.validation, 'validation');
      const finalization = requiredLiftJobField(job.finalization, 'finalization');
      if (finalization.mode === 'noop') {
        reject(['broadcast', 'inclusion']);
        return {
          ...base(),
          status: 'finalized',
          claim,
          validation,
          finalization: { ...finalization, mode: 'noop' },
        };
      }
      if (finalization.mode === 'local') {
        reject(['broadcast', 'inclusion']);
        return {
          ...base(),
          status: 'finalized',
          claim,
          validation,
          finalization: { ...finalization, mode: 'local' },
        };
      }
      const { mode, ...publishedFields } = finalization;
      const broadcast = requiredLiftJobField(job.broadcast, 'broadcast');
      return {
        ...base(),
        status: 'finalized',
        claim,
        validation,
        broadcast,
        inclusion: canonicalLiftJobInclusion(
          requiredLiftJobField(job.inclusion, 'inclusion'),
          broadcast,
        ),
        finalization: { ...publishedFields, ...(mode === 'published' ? { mode } : {}) },
      };
    }
    case 'failed': {
      reject(['finalization']);
      const failure = requiredLiftJobField(job.failure, 'failure');
      const recovery = canonicalLiftJobFailureRecovery(job.recovery);
      switch (failure.failedFromState) {
        case 'accepted':
          reject(['claim', 'validation', 'broadcast', 'inclusion', 'recovery']);
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
            claim: requiredLiftJobField(job.claim, 'claim'),
            failure: { ...failure, failedFromState: 'claimed' },
          };
        case 'validated':
          reject(['broadcast', 'inclusion']);
          return {
            ...baseWithoutRecovery(),
            ...(recovery ? { recovery } : {}),
            status: 'failed',
            claim: requiredLiftJobField(job.claim, 'claim'),
            validation: requiredLiftJobField(job.validation, 'validation'),
            failure: { ...failure, failedFromState: 'validated' },
          };
        case 'broadcast': {
          reject(['inclusion']);
          const failedBase = {
            ...baseWithoutRecovery(),
            ...(recovery ? { recovery } : {}),
            status: 'failed' as const,
            claim: requiredLiftJobField(job.claim, 'claim'),
            validation: requiredLiftJobField(job.validation, 'validation'),
          };
          return job.broadcast === undefined
            ? { ...failedBase, failure: { ...failure, failedFromState: 'broadcast' } }
            : {
                ...failedBase,
                broadcast: job.broadcast,
                failure: { ...failure, failedFromState: 'broadcast' },
              };
        }
        case 'included': {
          const failedBase = {
            ...baseWithoutRecovery(),
            ...(recovery ? { recovery } : {}),
            status: 'failed' as const,
            claim: requiredLiftJobField(job.claim, 'claim'),
            validation: requiredLiftJobField(job.validation, 'validation'),
          };
          if (job.broadcast === undefined) {
            reject(['inclusion']);
            return { ...failedBase, failure: { ...failure, failedFromState: 'included' } };
          }
          return {
            ...failedBase,
            broadcast: job.broadcast,
            inclusion: canonicalLiftJobInclusion(
              requiredLiftJobField(job.inclusion, 'inclusion'),
              job.broadcast,
            ),
            failure: { ...failure, failedFromState: 'included' },
          };
        }
      }
    }
    default:
      return null;
  }
}

const PROGRESS_FIELDS = [
  'claim',
  'validation',
  'broadcast',
  'inclusion',
  'finalization',
  'failure',
] as const;

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

function requiredTransitionField<T>(
  current: LiftJob,
  status: LiftJobState,
  value: T | undefined,
  field: string,
): T {
  if (value === undefined) {
    throw new Error(`LiftJob ${current.jobId}: ${field} is required for ${status}`);
  }
  return value;
}

function buildAcceptedTransition(
  _current: LiftJob,
  patch: LiftJobTransitionPatch,
  base: Omit<LiftJobBase, 'status'>,
): Extract<LiftJob, { status: 'accepted' }> {
  rejectTransitionPatchFields(
    patch,
    ['claim', 'validation', 'broadcast', 'inclusion', 'finalization', 'failure'],
    'accepted',
  );
  return { ...base, status: 'accepted' };
}

function buildClaimedTransition(
  current: LiftJob,
  patch: LiftJobTransitionPatch,
  base: Omit<LiftJobBase, 'status'>,
): Extract<LiftJob, { status: 'claimed' }> {
  rejectTransitionPatchFields(
    patch,
    ['validation', 'broadcast', 'inclusion', 'finalization', 'failure'],
    'claimed',
  );
  return {
    ...base,
    status: 'claimed',
    claim: requiredTransitionField(
      current,
      'claimed',
      fieldFromPatch(patch.claim, current.claim),
      'claim',
    ),
  };
}

function buildValidatedTransition(
  current: LiftJob,
  patch: LiftJobTransitionPatch,
  base: Omit<LiftJobBase, 'status'>,
): Extract<LiftJob, { status: 'validated' }> {
  rejectTransitionPatchFields(
    patch,
    ['broadcast', 'inclusion', 'finalization', 'failure'],
    'validated',
  );
  return {
    ...base,
    status: 'validated',
    claim: requiredTransitionField(
      current,
      'validated',
      fieldFromPatch(patch.claim, current.claim),
      'claim',
    ),
    validation: requiredTransitionField(
      current,
      'validated',
      fieldFromPatch(patch.validation, current.validation),
      'validation',
    ),
  };
}

function buildBroadcastTransition(
  current: LiftJob,
  patch: LiftJobTransitionPatch,
  base: Omit<LiftJobBase, 'status'>,
): Extract<LiftJob, { status: 'broadcast' }> {
  rejectTransitionPatchFields(patch, ['inclusion', 'finalization', 'failure'], 'broadcast');
  return {
    ...base,
    status: 'broadcast',
    claim: requiredTransitionField(
      current,
      'broadcast',
      fieldFromPatch(patch.claim, current.claim),
      'claim',
    ),
    validation: requiredTransitionField(
      current,
      'broadcast',
      fieldFromPatch(patch.validation, current.validation),
      'validation',
    ),
    broadcast: requiredTransitionField(
      current,
      'broadcast',
      broadcastFromPatch(current, patch),
      'broadcast',
    ),
  };
}

function buildIncludedTransition(
  current: LiftJob,
  patch: LiftJobTransitionPatch,
  base: Omit<LiftJobBase, 'status'>,
): Extract<LiftJob, { status: 'included' }> {
  rejectTransitionPatchFields(patch, ['finalization', 'failure'], 'included');
  const broadcast = requiredTransitionField(
    current,
    'included',
    broadcastFromPatch(current, patch),
    'broadcast',
  );
  return {
    ...base,
    status: 'included',
    claim: requiredTransitionField(
      current,
      'included',
      fieldFromPatch(patch.claim, current.claim),
      'claim',
    ),
    validation: requiredTransitionField(
      current,
      'included',
      fieldFromPatch(patch.validation, current.validation),
      'validation',
    ),
    broadcast,
    inclusion: canonicalLiftJobInclusion(
      requiredTransitionField(
        current,
        'included',
        inclusionFromPatch(current, patch),
        'inclusion',
      ),
      broadcast,
    ),
  };
}

function buildFinalizedTransition(
  current: LiftJob,
  patch: LiftJobTransitionPatch,
  base: Omit<LiftJobBase, 'status'>,
): Extract<LiftJob, { status: 'finalized' }> {
  rejectTransitionPatchFields(patch, ['failure'], 'finalized');
  const claim = requiredTransitionField(
    current,
    'finalized',
    fieldFromPatch(patch.claim, current.claim),
    'claim',
  );
  const validation = requiredTransitionField(
    current,
    'finalized',
    fieldFromPatch(patch.validation, current.validation),
    'validation',
  );
  const finalization = requiredTransitionField(
    current,
    'finalized',
    fieldFromPatch(patch.finalization, current.finalization),
    'finalization',
  );
  if (finalization.mode === 'noop') {
    rejectTransitionPatchFields(patch, ['broadcast', 'inclusion'], 'finalized');
    return {
      ...base,
      status: 'finalized',
      claim,
      validation,
      finalization: { ...finalization, mode: 'noop' },
    };
  }
  if (finalization.mode === 'local') {
    rejectTransitionPatchFields(patch, ['broadcast', 'inclusion'], 'finalized');
    return {
      ...base,
      status: 'finalized',
      claim,
      validation,
      finalization: { ...finalization, mode: 'local' },
    };
  }
  const broadcast = requiredTransitionField(
    current,
    'finalized',
    broadcastFromPatch(current, patch),
    'broadcast',
  );
  return {
    ...base,
    status: 'finalized',
    claim,
    validation,
    broadcast,
    inclusion: canonicalLiftJobInclusion(
      requiredTransitionField(
        current,
        'finalized',
        inclusionFromPatch(current, patch),
        'inclusion',
      ),
      broadcast,
    ),
    finalization,
  };
}

function buildFailedTransition(
  current: LiftJob,
  patch: LiftJobTransitionPatch,
  base: Omit<LiftJobBase, 'status'>,
): Extract<LiftJob, { status: 'failed' }> {
  rejectTransitionPatchFields(patch, ['finalization'], 'failed');
  const failure = requiredTransitionField(
    current,
    'failed',
    fieldFromPatch(patch.failure, current.failure),
    'failure',
  );
  if (
    (current.status === 'broadcast' || current.status === 'included')
    && failure.failedFromState !== current.status
  ) {
    throw new Error(
      `LiftJob ${current.jobId}: failure origin ${failure.failedFromState} cannot discard `
      + `${current.status} transaction evidence`,
    );
  }

  const recovery = canonicalLiftJobFailureRecovery(base.recovery);
  const { recovery: _recovery, ...baseWithoutRecovery } = base;
  if (failure.failedFromState === 'accepted') {
    rejectTransitionPatchFields(
      patch,
      ['claim', 'validation', 'broadcast', 'inclusion', 'recovery'],
      'failed',
    );
    if (base.recovery !== undefined) throw new Error('recovery is forbidden for status failed');
    return {
      ...baseWithoutRecovery,
      status: 'failed',
      failure: { ...failure, failedFromState: 'accepted' },
    };
  }

  const failedBase = {
    ...baseWithoutRecovery,
    ...(recovery ? { recovery } : {}),
    status: 'failed' as const,
  };
  if (failure.failedFromState === 'claimed') {
    rejectTransitionPatchFields(patch, ['validation', 'broadcast', 'inclusion'], 'failed');
    return {
      ...failedBase,
      claim: requiredTransitionField(
        current,
        'failed',
        fieldFromPatch(patch.claim, current.claim),
        'claim',
      ),
      failure: { ...failure, failedFromState: 'claimed' },
    };
  }
  if (failure.failedFromState === 'validated') {
    rejectTransitionPatchFields(patch, ['broadcast', 'inclusion'], 'failed');
    return {
      ...failedBase,
      claim: requiredTransitionField(
        current,
        'failed',
        fieldFromPatch(patch.claim, current.claim),
        'claim',
      ),
      validation: requiredTransitionField(
        current,
        'failed',
        fieldFromPatch(patch.validation, current.validation),
        'validation',
      ),
      failure: { ...failure, failedFromState: 'validated' },
    };
  }

  const claim = requiredTransitionField(
    current,
    'failed',
    fieldFromPatch(patch.claim, current.claim),
    'claim',
  );
  const validation = requiredTransitionField(
    current,
    'failed',
    fieldFromPatch(patch.validation, current.validation),
    'validation',
  );
  const broadcast = broadcastFromPatch(current, patch);
  if (failure.failedFromState === 'broadcast') {
    rejectTransitionPatchFields(patch, ['inclusion'], 'failed');
    return broadcast === undefined
      ? {
          ...failedBase,
          claim,
          validation,
          failure: { ...failure, failedFromState: 'broadcast' },
        }
      : {
          ...failedBase,
          claim,
          validation,
          broadcast,
          failure: { ...failure, failedFromState: 'broadcast' },
        };
  }
  if (broadcast === undefined) {
    rejectTransitionPatchFields(patch, ['inclusion'], 'failed');
    return {
      ...failedBase,
      claim,
      validation,
      failure: { ...failure, failedFromState: 'included' },
    };
  }
  return {
    ...failedBase,
    claim,
    validation,
    broadcast,
    inclusion: canonicalLiftJobInclusion(
      requiredTransitionField(
        current,
        'failed',
        inclusionFromPatch(current, patch),
        'inclusion',
      ),
      broadcast,
    ),
    failure: { ...failure, failedFromState: 'included' },
  };
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
  let next: LiftJob;
  switch (status) {
    case 'accepted': next = buildAcceptedTransition(current, patch, base); break;
    case 'claimed': next = buildClaimedTransition(current, patch, base); break;
    case 'validated': next = buildValidatedTransition(current, patch, base); break;
    case 'broadcast': next = buildBroadcastTransition(current, patch, base); break;
    case 'included': next = buildIncludedTransition(current, patch, base); break;
    case 'finalized': next = buildFinalizedTransition(current, patch, base); break;
    case 'failed': next = buildFailedTransition(current, patch, base); break;
  }
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
