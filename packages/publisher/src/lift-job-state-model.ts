import {
  LIFT_JOB_IMMUTABLE_FIELDS,
  assertLiftJobTransition,
  type LiftJob,
  type LiftJobAccepted,
  type LiftJobBase,
  type LiftJobBroadcast,
  type LiftJobBroadcastMetadata,
  type LiftJobClaimMetadata,
  type LiftJobClaimed,
  type LiftJobFailureMetadata,
  type LiftJobFinalizationMetadata,
  type LiftJobHex,
  type LiftJobIncluded,
  type LiftJobInclusionMetadata,
  type LiftJobRecoveryMetadata,
  type LiftJobRecoveryResetToAccepted,
  type LiftJobState,
  type LiftJobValidationMetadata,
} from './lift-job.js';

/** Structurally decoded inclusion; old rows may rely on broadcast.txHash as the carrier. */
export type StructurallyValidLiftJobInclusion = Omit<LiftJobInclusionMetadata, 'txHash'> & {
  readonly txHash?: LiftJobHex;
};

/**
 * One parsed lifecycle candidate. The projector below is the sole owner of state-specific field
 * legality and exact canonical union construction for both durable reads and transition writes.
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

type ProjectionOptions = {
  /**
   * Cross-state transitions may shed progress already present on the source. A field absent from
   * the source remains an injection and is rejected rather than silently discarded.
   */
  readonly transitionSource?: LiftJob;
};

export function requiredLiftJobField<T>(value: T | undefined, path: string): T {
  if (value === undefined) throw new Error(`${path} is required`);
  return value;
}

export function rejectDefinedLiftJobFields(
  job: StructurallyValidLiftJobPayload,
  fields: ReadonlyArray<keyof StructurallyValidLiftJobPayload>,
  transitionSource?: LiftJob,
): void {
  for (const field of fields) {
    if (job[field] === undefined) continue;
    const source: StructurallyValidLiftJobPayload | undefined = transitionSource;
    if (source?.[field] !== undefined) continue;
    throw new Error(`${String(field)} is forbidden for status ${job.status}`);
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

function immutableLiftJobFieldValue(
  job: LiftJob,
  field: (typeof LIFT_JOB_IMMUTABLE_FIELDS)[number],
): unknown {
  switch (field) {
    case 'jobId': return job.jobId;
    case 'jobSlug': return job.jobSlug;
    case 'request': return job.request;
    case 'admission': return job.admission;
    case 'timestamps.acceptedAt': return job.timestamps?.acceptedAt;
    case 'retries.maxRetries': return job.retries?.maxRetries;
  }
}

function assertNoImmutableLiftJobFieldChange(current: LiftJob, next: LiftJob): void {
  for (const field of LIFT_JOB_IMMUTABLE_FIELDS) {
    const before = immutableLiftJobFieldValue(current, field);
    const after = immutableLiftJobFieldValue(next, field);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    throw new Error(
      `LiftJob ${current.jobId}: ${field} is immutable and cannot be changed by a transition`,
    );
  }
}

/** Project a parsed candidate into exactly one current writable lifecycle union member. */
export function projectCanonicalLiftJob(
  job: StructurallyValidLiftJobPayload,
  options: ProjectionOptions = {},
): LiftJob | null {
  const source = options.transitionSource;
  const reject = (fields: ReadonlyArray<keyof StructurallyValidLiftJobPayload>): void =>
    rejectDefinedLiftJobFields(job, fields, source);
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
          rejectDefinedLiftJobFields(
            job,
            ['claim', 'validation', 'broadcast', 'inclusion', 'recovery'],
          );
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
          const claim = requiredLiftJobField(job.claim, 'claim');
          const validation = requiredLiftJobField(job.validation, 'validation');
          return {
            ...baseWithoutRecovery(),
            ...(recovery ? { recovery } : {}),
            status: 'failed',
            claim,
            validation,
            ...(job.broadcast !== undefined ? { broadcast: job.broadcast } : {}),
            failure: { ...failure, failedFromState: 'broadcast' },
          };
        }
        case 'included': {
          const claim = requiredLiftJobField(job.claim, 'claim');
          const validation = requiredLiftJobField(job.validation, 'validation');
          if (job.broadcast === undefined) {
            reject(['inclusion']);
            return {
              ...baseWithoutRecovery(),
              ...(recovery ? { recovery } : {}),
              status: 'failed',
              claim,
              validation,
              failure: { ...failure, failedFromState: 'included' },
            };
          }
          return {
            ...baseWithoutRecovery(),
            ...(recovery ? { recovery } : {}),
            status: 'failed',
            claim,
            validation,
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

export function buildCanonicalLiftJobTransition(
  current: LiftJobAccepted,
  status: 'claimed',
  data: { claim: { walletId: string } },
  now: number,
): LiftJobClaimed;
export function buildCanonicalLiftJobTransition(
  current: LiftJobBroadcast,
  status: 'included',
  data: { inclusion: LiftJobInclusionMetadata },
  now: number,
): LiftJobIncluded;
export function buildCanonicalLiftJobTransition(
  current: LiftJob,
  status: LiftJobState,
  data: Partial<LiftJob>,
  now: number,
): LiftJob;
export function buildCanonicalLiftJobTransition(
  current: LiftJob,
  status: LiftJobState,
  data: Partial<LiftJob> & { inclusion?: LiftJobInclusionMetadata },
  now: number,
): LiftJob {
  if (current.status !== status) assertLiftJobTransition(current.status, status);
  const patchedTimestamps = { ...current.timestamps, ...data.timestamps };
  const candidate: StructurallyValidLiftJobPayload = {
    ...current,
    ...data,
    status,
    timestamps: {
      ...patchedTimestamps,
      claimedAt: status === 'claimed' ? (patchedTimestamps.claimedAt ?? now) : patchedTimestamps.claimedAt,
      validatedAt: status === 'validated' ? (patchedTimestamps.validatedAt ?? now) : patchedTimestamps.validatedAt,
      broadcastAt: status === 'broadcast' ? (patchedTimestamps.broadcastAt ?? now) : patchedTimestamps.broadcastAt,
      includedAt: status === 'included' ? (patchedTimestamps.includedAt ?? now) : patchedTimestamps.includedAt,
      finalizedAt: status === 'finalized' ? (patchedTimestamps.finalizedAt ?? now) : patchedTimestamps.finalizedAt,
      failedAt: status === 'failed' ? (patchedTimestamps.failedAt ?? now) : patchedTimestamps.failedAt,
      updatedAt: now,
    },
  };
  const next = projectCanonicalLiftJob(candidate, { transitionSource: current });
  if (next === null) throw new Error(`Unsupported LiftJob status: ${status}`);
  assertNoImmutableLiftJobFieldChange(current, next);
  return next;
}
