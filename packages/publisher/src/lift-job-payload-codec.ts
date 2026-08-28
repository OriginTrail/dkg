import {
  LIFT_JOB_FAILURE_CODES,
  LIFT_JOB_FAILURE_MODES,
  LIFT_JOB_FAILURE_PHASES,
  LIFT_JOB_FAILURE_RESOLUTIONS,
  LIFT_JOB_STATES,
  LIFT_JOB_TIMEOUT_HANDLINGS,
  LIFT_TRANSITION_TYPES,
  type LiftJob,
  type LiftJobAdmissionMetadata,
  type LiftJobBase,
  type LiftJobBroadcastMetadata,
  type LiftJobClaimMetadata,
  type LiftJobCompatibility,
  type LiftJobControlPlaneRefs,
  type LiftJobFailureMetadata,
  type LiftJobFinalizationMetadata,
  type LiftJobHex,
  type LiftJobInclusionMetadata,
  type LiftJobPersistedFailure,
  type LiftJobRecoveryMetadata,
  type LiftJobRecoveryFinalizedFromChain,
  type LiftJobRecoveryResetToAccepted,
  type LiftJobRetryMetadata,
  type LiftJobTimestamps,
  type LiftJobValidationMetadata,
  type PersistedLiftJob,
} from './lift-job.js';
import { parseLiteral } from './async-lift-control-plane.js';
import { normalizePersistedLiftJobRequest } from './async-lift-publisher-utils.js';

/**
 * A fully decoded persisted payload whose status is deliberately still an arbitrary string.
 * Every field exposed here has been parsed into its canonical runtime type; state membership and
 * the exact cross-state field contract are applied before the decoder returns to its caller.
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

type StructurallyValidLiftJobInclusion = Omit<LiftJobInclusionMetadata, 'txHash'> & {
  readonly txHash?: LiftJobHex;
};

export type LiftJobPayloadDecodeResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'malformed'; readonly reason: string }
  | { readonly kind: 'unknown'; readonly job: StructurallyValidLiftJobPayload }
  | { readonly kind: 'canonical'; readonly job: LiftJob }
  | { readonly kind: 'compatibility'; readonly job: LiftJobCompatibility };

type KnownLiftJobPayload = Extract<
  LiftJobPayloadDecodeResult,
  { readonly kind: 'canonical' | 'compatibility' }
>;

/** Classify one persisted job payload without hiding malformed state behind null or an exception. */
export function decodeLiftJobPayload(binding?: string): LiftJobPayloadDecodeResult {
  if (binding === undefined) return { kind: 'absent' };
  try {
    const payload = parseLiteral(binding);
    if (typeof payload !== 'string') return malformed('payload is not an RDF literal');
    const parsed = JSON.parse(payload) as unknown;
    const job = parseStructuralPayload(parsed);
    // Unknown states deliberately stop at the structural representation so targeted clear can
    // distinguish them from corruption. Every recognized payload leaves this boundary already
    // classified and fully typed; consumers never reinterpret the structural bag.
    if (!(LIFT_JOB_STATES as readonly string[]).includes(job.status)) {
      return { kind: 'unknown', job };
    }
    return classifyKnownLiftJobPayload(job);
  } catch (error) {
    return malformed(error instanceof Error ? error.message : String(error));
  }
}

/** Build and classify one recognized persisted union member from the already-parsed structure. */
function classifyKnownLiftJobPayload(job: StructurallyValidLiftJobPayload): KnownLiftJobPayload {
  switch (job.status) {
    case 'broadcast':
      return parsePersistedBroadcast(job);
    case 'finalized':
      return parsePersistedFinalized(job);
    case 'failed':
      return parsePersistedFailed(job);
    default: {
      const canonical = canonicalLiftJobPayload(job);
      if (canonical === null) throw new Error(`Unsupported LiftJob status: ${job.status}`);
      return canonicalPayload(canonical);
    }
  }
}

/**
 * Construct a current writable lifecycle union member. Compatibility projections are deliberately
 * excluded: callers use this at every write boundary before durable state can be changed.
 */
export function canonicalLiftJobPayload(job: StructurallyValidLiftJobPayload): LiftJob | null {
  switch (job.status) {
    case 'accepted':
      rejectDefined(job, ['claim', 'validation', 'broadcast', 'inclusion', 'finalization', 'failure']);
      return { ...base(job), status: 'accepted' };
    case 'claimed':
      rejectDefined(job, ['validation', 'broadcast', 'inclusion', 'finalization', 'failure']);
      return { ...base(job), status: 'claimed', claim: required(job.claim, 'claim') };
    case 'validated':
      rejectDefined(job, ['broadcast', 'inclusion', 'finalization', 'failure']);
      return {
        ...base(job),
        status: 'validated',
        claim: required(job.claim, 'claim'),
        validation: required(job.validation, 'validation'),
      };
    case 'broadcast':
      return parseCanonicalBroadcast(job);
    case 'included': {
      rejectDefined(job, ['finalization', 'failure']);
      const broadcast = required(job.broadcast, 'broadcast');
      return {
        ...base(job),
        status: 'included',
        claim: required(job.claim, 'claim'),
        validation: required(job.validation, 'validation'),
        broadcast,
        inclusion: canonicalInclusion(required(job.inclusion, 'inclusion'), broadcast),
      };
    }
    case 'finalized':
      return parseCanonicalFinalized(job);
    case 'failed':
      return parseCanonicalFailed(job);
    default:
      return null;
  }
}

/** Validate an in-memory write candidate with the same structural and state schemas as restart. */
export function assertCanonicalLiftJobPayload(value: unknown): LiftJob {
  const job = parseStructuralPayload(value);
  const canonical = canonicalLiftJobPayload(job);
  if (canonical === null) throw new Error(`Unsupported LiftJob status: ${job.status}`);
  return canonical;
}

/** Ordinary read policy: absence is nullable, but corrupt or unknown durable state fails closed. */
export function decodedLiftJobOrThrow(decoded: LiftJobPayloadDecodeResult): PersistedLiftJob | null {
  switch (decoded.kind) {
    case 'absent':
      return null;
    case 'malformed':
      throw new Error(`Malformed persisted LiftJob payload: ${decoded.reason}`);
    case 'unknown':
      throw new Error(`Malformed persisted LiftJob payload: Unsupported LiftJob status: ${decoded.job.status}`);
    case 'canonical':
    case 'compatibility':
      return decoded.job;
  }
}

function canonicalPayload(job: LiftJob): KnownLiftJobPayload {
  return { kind: 'canonical', job };
}

function compatibilityPayload(job: LiftJobCompatibility): KnownLiftJobPayload {
  return { kind: 'compatibility', job };
}

function parseStructuralPayload(value: unknown): StructurallyValidLiftJobPayload {
  return structuralPayloadParser(value, 'payload');
}

function base(job: StructurallyValidLiftJobPayload): Omit<LiftJobBase, 'status'> {
  return {
    jobId: job.jobId,
    jobSlug: job.jobSlug,
    request: job.request,
    ...(job.admission ? { admission: job.admission } : {}),
    timestamps: job.timestamps,
    retries: job.retries,
    ...(job.recovery ? { recovery: job.recovery } : {}),
    ...(job.controlPlane ? { controlPlane: job.controlPlane } : {}),
  };
}

function baseWithoutRecovery(
  job: StructurallyValidLiftJobPayload,
): Omit<LiftJobBase, 'status' | 'recovery'> {
  const { recovery: _recovery, ...withoutRecovery } = base(job);
  return withoutRecovery;
}

function parseCanonicalBroadcast(job: StructurallyValidLiftJobPayload): LiftJob {
  rejectDefined(job, ['inclusion', 'finalization', 'failure']);
  return {
    ...base(job),
    status: 'broadcast',
    claim: required(job.claim, 'claim'),
    validation: required(job.validation, 'validation'),
    broadcast: required(job.broadcast, 'broadcast'),
  };
}

function parsePersistedBroadcast(job: StructurallyValidLiftJobPayload): KnownLiftJobPayload {
  try {
    return canonicalPayload(parseCanonicalBroadcast(job));
  } catch (canonicalError) {
    rejectDefined(job, ['validation', 'broadcast', 'inclusion', 'finalization', 'failure']);
    if (job.request.jobType !== 'lift') throw canonicalError;
    return compatibilityPayload({
      ...base(job),
      status: 'broadcast',
      request: job.request,
      claim: required(job.claim, 'claim'),
    });
  }
}

function parseCanonicalFinalized(job: StructurallyValidLiftJobPayload): LiftJob {
  rejectDefined(job, ['failure']);
  const claim = required(job.claim, 'claim');
  const validation = required(job.validation, 'validation');
  const finalization = required(job.finalization, 'finalization');
  if (finalization.mode === 'noop') {
    rejectDefined(job, ['broadcast', 'inclusion']);
    return {
      ...base(job),
      status: 'finalized',
      claim,
      validation,
      finalization: { ...finalization, mode: 'noop' },
    };
  }
  if (finalization.mode === 'local') {
    rejectDefined(job, ['broadcast', 'inclusion']);
    return {
      ...base(job),
      status: 'finalized',
      claim,
      validation,
      finalization: { ...finalization, mode: 'local' },
    };
  }
  const { mode, ...publishedFields } = finalization;
  const broadcast = required(job.broadcast, 'broadcast');
  return {
    ...base(job),
    status: 'finalized',
    claim,
    validation,
    broadcast,
    inclusion: canonicalInclusion(required(job.inclusion, 'inclusion'), broadcast),
    finalization: { ...publishedFields, ...(mode === 'published' ? { mode } : {}) },
  };
}

function parsePersistedFinalized(job: StructurallyValidLiftJobPayload): KnownLiftJobPayload {
  try {
    return canonicalPayload(parseCanonicalFinalized(job));
  } catch (canonicalError) {
    rejectDefined(job, ['failure']);
    const finalization = required(job.finalization, 'finalization');
    if (finalization.mode !== 'noop' && finalization.mode !== 'local') throw canonicalError;
    const broadcast = job.broadcast;
    return compatibilityPayload({
      ...base(job),
      status: 'finalized',
      claim: required(job.claim, 'claim'),
      validation: required(job.validation, 'validation'),
      ...(broadcast ? { broadcast } : {}),
      ...(job.inclusion && broadcast
        ? { inclusion: canonicalInclusion(job.inclusion, broadcast) }
        : {}),
      finalization: { ...finalization, mode: finalization.mode },
    });
  }
}

function parseCanonicalFailed(job: StructurallyValidLiftJobPayload): LiftJob {
  rejectDefined(job, ['finalization']);
  const failure = required(job.failure, 'failure');
  const recovery = canonicalFailureRecovery(job.recovery);
  switch (failure.failedFromState) {
    case 'accepted':
      rejectDefined(job, ['claim', 'validation', 'broadcast', 'inclusion', 'recovery']);
      return {
        ...baseWithoutRecovery(job),
        status: 'failed',
        failure: { ...failure, failedFromState: 'accepted' },
      };
    case 'claimed': {
      rejectDefined(job, ['validation', 'broadcast', 'inclusion']);
      return {
        ...baseWithoutRecovery(job),
        ...(recovery ? { recovery } : {}),
        status: 'failed',
        claim: required(job.claim, 'claim'),
        failure: { ...failure, failedFromState: 'claimed' },
      };
    }
    case 'validated': {
      rejectDefined(job, ['broadcast', 'inclusion']);
      return {
        ...baseWithoutRecovery(job),
        ...(recovery ? { recovery } : {}),
        status: 'failed',
        claim: required(job.claim, 'claim'),
        validation: required(job.validation, 'validation'),
        failure: { ...failure, failedFromState: 'validated' },
      };
    }
    case 'broadcast': {
      rejectDefined(job, ['inclusion']);
      const claim = required(job.claim, 'claim');
      const validation = required(job.validation, 'validation');
      const failure = required(job.failure, 'failure');
      if (job.broadcast === undefined) {
        return {
          ...baseWithoutRecovery(job),
          ...(recovery ? { recovery } : {}),
          status: 'failed',
          claim,
          validation,
          failure: { ...failure, failedFromState: 'broadcast' },
        };
      }
      return {
        ...baseWithoutRecovery(job),
        ...(recovery ? { recovery } : {}),
        status: 'failed',
        claim,
        validation,
        broadcast: job.broadcast,
        failure: { ...failure, failedFromState: 'broadcast' },
      };
    }
    case 'included': {
      const validation = required(job.validation, 'validation');
      const claim = required(job.claim, 'claim');
      const failure = required(job.failure, 'failure');
      if (job.broadcast === undefined) {
        rejectDefined(job, ['inclusion']);
        return {
          ...baseWithoutRecovery(job),
          ...(recovery ? { recovery } : {}),
          status: 'failed',
          claim,
          validation,
          failure: { ...failure, failedFromState: 'included' },
        };
      }
      const broadcast = job.broadcast;
      return {
        ...baseWithoutRecovery(job),
        ...(recovery ? { recovery } : {}),
        status: 'failed',
        claim,
        validation,
        broadcast,
        inclusion: canonicalInclusion(required(job.inclusion, 'inclusion'), broadcast),
        failure: { ...failure, failedFromState: 'included' },
      };
    }
  }
}

function canonicalFailureRecovery(
  recovery: LiftJobRecoveryMetadata | undefined,
): LiftJobRecoveryResetToAccepted | undefined {
  if (recovery === undefined) return undefined;
  if (recovery.action !== 'reset_to_accepted') {
    throw new Error('failed jobs may carry only reset_to_accepted recovery provenance');
  }
  return recovery;
}

function parsePersistedFailed(job: StructurallyValidLiftJobPayload): KnownLiftJobPayload {
  try {
    return canonicalPayload(parseCanonicalFailed(job));
  } catch (canonicalError) {
    try {
      return compatibilityPayload(parsePersistedFailureCompatibility(job));
    } catch {
      // Preserve the canonical invariant error. Compatibility is an explicit version predicate,
      // not a more permissive parser whose failure can obscure the violated current-state rule.
      throw canonicalError;
    }
  }
}

function parsePersistedFailureCompatibility(
  job: StructurallyValidLiftJobPayload,
): LiftJobPersistedFailure {
  rejectDefined(job, ['finalization']);
  const failure = required(job.failure, 'failure');

  if (job.recovery?.action === 'finalized_from_chain') {
    if (failure.failedFromState !== 'included') throw new Error('unsupported legacy recovery origin');
    const broadcast = required(job.broadcast, 'broadcast');
    return {
      ...base(job),
      status: 'failed',
      claim: required(job.claim, 'claim'),
      validation: required(job.validation, 'validation'),
      broadcast,
      inclusion: canonicalInclusion(required(job.inclusion, 'inclusion'), broadcast),
      failure: { ...failure, failedFromState: 'included' },
      recovery: job.recovery,
    };
  }

  const recovery = canonicalFailureRecovery(job.recovery);
  if (failure.failedFromState === 'accepted') {
    throw new Error('accepted-origin failures have no compatibility projection');
  }

  if (job.broadcast !== undefined) {
    const broadcast = job.broadcast;
    return {
      ...baseWithoutRecovery(job),
      ...(recovery ? { recovery } : {}),
      status: 'failed',
      ...(job.claim ? { claim: job.claim } : {}),
      ...(job.validation ? { validation: job.validation } : {}),
      broadcast,
      ...(job.inclusion
        ? { inclusion: canonicalInclusion(job.inclusion, broadcast) }
        : {}),
      failure: { ...failure, failedFromState: failure.failedFromState },
    };
  }

  rejectDefined(job, ['inclusion']);
  if (
    job.claim === undefined
    && job.validation === undefined
    && job.broadcast === undefined
  ) {
    return {
      ...baseWithoutRecovery(job),
      ...(recovery ? { recovery } : {}),
      status: 'failed',
      failure: { ...failure, failedFromState: failure.failedFromState },
    };
  }
  if (
    job.claim === undefined
    && recovery?.txHashChecked !== undefined
    && recovery.walletIdChecked === undefined
  ) {
    return {
      ...baseWithoutRecovery(job),
      status: 'failed',
      ...(job.validation ? { validation: job.validation } : {}),
      failure: { ...failure, failedFromState: failure.failedFromState },
      recovery: {
        ...recovery,
        txHashChecked: recovery.txHashChecked,
        walletIdChecked: undefined,
      },
    };
  }
  if (failure.failedFromState === 'claimed' && job.validation !== undefined) {
    return {
      ...baseWithoutRecovery(job),
      ...(recovery ? { recovery } : {}),
      status: 'failed',
      ...(job.claim ? { claim: job.claim } : {}),
      validation: job.validation,
      failure: { ...failure, failedFromState: 'claimed' },
    };
  }
  if (
    failure.failedFromState === 'validated'
    && job.claim === undefined
    && job.validation !== undefined
  ) {
    return {
      ...baseWithoutRecovery(job),
      ...(recovery ? { recovery } : {}),
      status: 'failed',
      validation: job.validation,
      failure: { ...failure, failedFromState: 'validated' },
    };
  }

  throw new Error('failed payload does not match a documented compatibility shape');
}

type RuntimeParser<T> = (value: unknown, path: string) => T;
type OptionalRuntimeParser<T> = { readonly optional: true; readonly parser: RuntimeParser<T> };
type OptionalKeys<T extends object> = {
  [K in keyof T]-?: undefined extends T[K] ? K : never
}[keyof T];
type RequiredKeys<T extends object> = Exclude<keyof T, OptionalKeys<T>>;
type ObjectRuntimeSchema<T extends object> =
  & { readonly [K in RequiredKeys<T>]: RuntimeParser<T[K]> }
  & { readonly [K in OptionalKeys<T>]: OptionalRuntimeParser<Exclude<T[K], undefined>> };

function optional<T>(parser: RuntimeParser<T>): OptionalRuntimeParser<T> {
  return { optional: true, parser };
}

/**
 * The schema map is exhaustive over T, including optional fields. Adding a metadata field now
 * breaks this declaration at compile time instead of silently making newly written rows unreadable.
 */
function objectParser<T extends object>(schema: ObjectRuntimeSchema<T>): RuntimeParser<T> {
  return (value, path) => {
    const record = expectRecord(value, path);
    const parsed: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(schema)) {
      if (typeof field === 'object' && field !== null && 'optional' in field) {
        const descriptor = field as OptionalRuntimeParser<unknown>;
        if (record[key] !== undefined) parsed[key] = descriptor.parser(record[key], `${path}.${key}`);
      } else {
        parsed[key] = (field as RuntimeParser<unknown>)(record[key], `${path}.${key}`);
      }
    }
    return parsed as T;
  };
}

const stringParser: RuntimeParser<string> = expectString;
const nonEmptyStringParser: RuntimeParser<string> = expectNonEmptyString;
const numberParser: RuntimeParser<number> = expectFiniteNumber;
const booleanParser: RuntimeParser<boolean> = expectBoolean;
const hexParser: RuntimeParser<LiftJobHex> = expectHexString;
const stringArrayParser: RuntimeParser<readonly string[]> = expectStringArray;
const operationKindParser: RuntimeParser<'create' | 'update'> = (value, path) =>
  expectEnum(value, ['create', 'update'] as const, path);

function enumParser<const T extends readonly string[]>(allowed: T): RuntimeParser<T[number]> {
  return (value, path) => expectEnum(value, allowed, path);
}

function literalParser<const T extends string>(literal: T): RuntimeParser<T> {
  return (value, path) => {
    if (value !== literal) throw new Error(`${path} must be ${literal}`);
    return literal;
  };
}

const stringRecordParser: RuntimeParser<Readonly<Record<string, string>>> = (value, path) => {
  const record = expectRecord(value, path);
  if (!Object.values(record).every((item) => typeof item === 'string')) {
    throw new Error(`${path} must map strings to strings`);
  }
  return record as Record<string, string>;
};

const timestampsParser = objectParser<LiftJobTimestamps>({
  acceptedAt: numberParser,
  claimedAt: optional(numberParser),
  validatedAt: optional(numberParser),
  broadcastAt: optional(numberParser),
  rpcAcceptedAt: optional(numberParser),
  includedAt: optional(numberParser),
  finalizedAt: optional(numberParser),
  failedAt: optional(numberParser),
  lastRetriedAt: optional(numberParser),
  nextRetryAt: optional(numberParser),
  lastRecoveredAt: optional(numberParser),
  updatedAt: numberParser,
});

const retriesParser = objectParser<LiftJobRetryMetadata>({
  retryCount: numberParser,
  maxRetries: numberParser,
  lastRetryReason: optional(stringParser),
});

const admissionParser = objectParser<LiftJobAdmissionMetadata>({
  byAgentAddress: nonEmptyStringParser,
});

const controlPlaneParser = objectParser<LiftJobControlPlaneRefs>({
  jobRef: optional(stringParser),
  walletLockRef: optional(stringParser),
});

function parseTimestamps(value: unknown): LiftJobTimestamps {
  return timestampsParser(value, 'timestamps');
}

function parseRetries(value: unknown): LiftJobRetryMetadata {
  return retriesParser(value, 'retries');
}

function parseAdmission(value: unknown): LiftJobAdmissionMetadata {
  return admissionParser(value, 'admission');
}

function parseControlPlane(value: unknown): LiftJobControlPlaneRefs {
  return controlPlaneParser(value, 'controlPlane');
}

const recoveryResetParser = objectParser<LiftJobRecoveryResetToAccepted>({
  action: literalParser('reset_to_accepted'),
  recoveredFromStatus: enumParser(['claimed', 'validated', 'broadcast', 'included'] as const),
  txHashChecked: optional(hexParser),
  txHashAccounted: optional(booleanParser),
  operationKind: optional(operationKindParser),
  walletIdChecked: optional(stringParser),
  nonceChecked: optional(numberParser),
  note: optional(stringParser),
});

const recoveryFinalizedParser = objectParser<LiftJobRecoveryFinalizedFromChain>({
  action: literalParser('finalized_from_chain'),
  recoveredFromStatus: enumParser(['broadcast', 'included'] as const),
  txHashChecked: hexParser,
  note: optional(stringParser),
});

const claimParser = objectParser<LiftJobClaimMetadata>({
  walletId: nonEmptyStringParser,
  claimedBy: optional(stringParser),
  claimToken: optional(stringParser),
  claimLeaseExpiresAt: optional(numberParser),
});

const validationParser = objectParser<LiftJobValidationMetadata>({
  canonicalRoots: stringArrayParser,
  canonicalRootMap: stringRecordParser,
  swmQuadCount: numberParser,
  authorityProofRef: nonEmptyStringParser,
  transitionType: enumParser(LIFT_TRANSITION_TYPES),
  priorVersion: optional(stringParser),
});

const broadcastMetadataParser = objectParser<LiftJobBroadcastMetadata>({
  txHash: hexParser,
  walletId: nonEmptyStringParser,
  merkleRoot: optional(hexParser),
  publicByteSize: optional(numberParser),
  nonce: optional(numberParser),
  operationKind: optional(operationKindParser),
});

const inclusionParser = objectParser<StructurallyValidLiftJobInclusion>({
  txHash: optional(hexParser),
  blockNumber: numberParser,
  blockHash: optional(hexParser),
  blockTimestamp: optional(numberParser),
});

function parseRecovery(value: unknown): LiftJobRecoveryMetadata {
  const action = expectRecord(value, 'recovery')['action'];
  if (action === 'reset_to_accepted') return recoveryResetParser(value, 'recovery');
  if (action === 'finalized_from_chain') return recoveryFinalizedParser(value, 'recovery');
  throw new Error('recovery.action is unsupported');
}

function parseClaim(value: unknown): LiftJobClaimMetadata {
  return claimParser(value, 'claim');
}

function parseValidation(value: unknown): LiftJobValidationMetadata {
  return validationParser(value, 'validation');
}

function parseBroadcastMetadata(value: unknown): LiftJobBroadcastMetadata {
  return broadcastMetadataParser(value, 'broadcast');
}

function parseInclusion(value: unknown): StructurallyValidLiftJobInclusion {
  return inclusionParser(value, 'inclusion');
}

function canonicalInclusion(
  inclusion: StructurallyValidLiftJobInclusion,
  broadcast: LiftJobBroadcastMetadata,
): LiftJobInclusionMetadata {
  return { ...inclusion, txHash: inclusion.txHash ?? broadcast.txHash };
}

const finalizationParser = objectParser<LiftJobFinalizationMetadata>({
  mode: optional(enumParser(['published', 'noop', 'local'] as const)),
  txHash: optional(hexParser),
  ual: optional(stringParser),
  batchId: optional(stringParser),
  startKAId: optional(stringParser),
  endKAId: optional(stringParser),
  publisherAddress: optional(hexParser),
});

const timeoutParser = objectParser<NonNullable<LiftJobFailureMetadata['timeout']>>({
  timeoutMs: numberParser,
  timeoutAt: numberParser,
  handling: enumParser(LIFT_JOB_TIMEOUT_HANDLINGS),
});

const failureParser = objectParser<LiftJobFailureMetadata>({
  failedFromState: enumParser(['accepted', 'claimed', 'validated', 'broadcast', 'included'] as const),
  phase: enumParser(LIFT_JOB_FAILURE_PHASES),
  mode: enumParser(LIFT_JOB_FAILURE_MODES),
  retryable: booleanParser,
  resolution: enumParser(LIFT_JOB_FAILURE_RESOLUTIONS),
  code: enumParser(LIFT_JOB_FAILURE_CODES),
  // Diagnostics are strings, not identifiers. Empty values are legitimate writer output.
  message: stringParser,
  errorPayloadRef: stringParser,
  stackTraceRef: optional(stringParser),
  rpcResponseRef: optional(stringParser),
  revertReasonRef: optional(stringParser),
  timeout: optional(timeoutParser),
});

const structuralPayloadParser = objectParser<StructurallyValidLiftJobPayload>({
  jobId: nonEmptyStringParser,
  jobSlug: nonEmptyStringParser,
  request: (value) => normalizePersistedLiftJobRequest(value),
  admission: optional((value) => parseAdmission(value)),
  status: nonEmptyStringParser,
  timestamps: (value) => parseTimestamps(value),
  retries: (value) => parseRetries(value),
  recovery: optional((value) => parseRecovery(value)),
  controlPlane: optional((value) => parseControlPlane(value)),
  claim: optional((value) => parseClaim(value)),
  validation: optional((value) => parseValidation(value)),
  broadcast: optional((value) => parseBroadcastMetadata(value)),
  inclusion: optional((value) => parseInclusion(value)),
  finalization: optional((value) => parseFinalization(value)),
  failure: optional((value) => parseFailure(value)),
});

function parseFinalization(value: unknown): LiftJobFinalizationMetadata {
  return finalizationParser(value, 'finalization');
}

function parseFailure(value: unknown): LiftJobFailureMetadata {
  return failureParser(value, 'failure');
}

function malformed(reason: string): LiftJobPayloadDecodeResult {
  return { kind: 'malformed', reason };
}

function required<T>(value: T | undefined, path: string): T {
  if (value === undefined) throw new Error(`${path} is required`);
  return value;
}

function rejectDefined(
  job: StructurallyValidLiftJobPayload,
  fields: ReadonlyArray<keyof StructurallyValidLiftJobPayload>,
): void {
  for (const field of fields) {
    if (job[field] !== undefined) throw new Error(`${String(field)} is forbidden for status ${job.status}`);
  }
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`);
  return value;
}

function expectNonEmptyString(value: unknown, path: string): string {
  const parsed = expectString(value, path);
  if (parsed.length === 0) throw new Error(`${path} must be a non-empty string`);
  return parsed;
}

function expectHexString(value: unknown, path: string): LiftJobHex {
  const parsed = expectNonEmptyString(value, path);
  if (!parsed.startsWith('0x')) throw new Error(`${path} must be a 0x-prefixed string`);
  return parsed as LiftJobHex;
}

function expectFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
  return value;
}

function expectStringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${path} must be a string array`);
  }
  return value;
}

function expectEnum<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${path} is unsupported`);
  }
  return value as T[number];
}
