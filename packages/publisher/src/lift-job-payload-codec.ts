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
  type LiftJobBigInt,
  type LiftJobBroadcastMetadata,
  type LiftJobClaimMetadata,
  type LiftJobCompatibility,
  type LiftJobControlPlaneRefs,
  type LiftJobFailureMetadata,
  type LiftJobFinalizationMetadata,
  type LiftJobHex,
  type LiftJobOpaqueFinalizationIdentifiers,
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
import {
  canonicalLiftJobBase,
  canonicalLiftJobBaseWithoutRecovery,
  canonicalLiftJobFailureRecovery,
  canonicalLiftJobInclusion,
  projectCanonicalLiftJob,
  rejectDefinedLiftJobFields,
  requiredLiftJobField,
  type StructurallyValidLiftJobInclusion,
  type StructurallyValidLiftJobPayload,
} from './lift-job-state-model.js';

export {
  projectCanonicalLiftJob as canonicalLiftJobPayload,
  type StructurallyValidLiftJobPayload,
} from './lift-job-state-model.js';

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
      const canonical = projectCanonicalLiftJob(job);
      if (canonical === null) throw new Error(`Unsupported LiftJob status: ${job.status}`);
      return canonicalPayload(canonical);
    }
  }
}

/** Validate an in-memory write candidate with the same structural and state schemas as restart. */
export function assertCanonicalLiftJobPayload(value: unknown): LiftJob {
  const job = parseStructuralPayload(value);
  const canonical = projectCanonicalLiftJob(job);
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

function requiredCanonicalProjection(job: StructurallyValidLiftJobPayload): LiftJob {
  const canonical = projectCanonicalLiftJob(job);
  if (canonical === null) throw new Error(`Unsupported LiftJob status: ${job.status}`);
  return canonical;
}

function parseStructuralPayload(value: unknown): StructurallyValidLiftJobPayload {
  return structuralPayloadParser(value, 'payload');
}

function parsePersistedBroadcast(job: StructurallyValidLiftJobPayload): KnownLiftJobPayload {
  try {
    return canonicalPayload(requiredCanonicalProjection(job));
  } catch (canonicalError) {
    rejectDefinedLiftJobFields(job, ['validation', 'broadcast', 'inclusion', 'finalization', 'failure']);
    if (job.request.jobType !== 'lift') throw canonicalError;
    return compatibilityPayload({
      ...canonicalLiftJobBase(job),
      status: 'broadcast',
      request: job.request,
      claim: requiredLiftJobField(job.claim, 'claim'),
    });
  }
}

function parsePersistedFinalized(job: StructurallyValidLiftJobPayload): KnownLiftJobPayload {
  try {
    return canonicalPayload(requiredCanonicalProjection(job));
  } catch (canonicalError) {
    rejectDefinedLiftJobFields(job, ['failure']);
    const finalization = requiredLiftJobField(job.finalization, 'finalization');
    if (finalization.mode !== 'noop' && finalization.mode !== 'local') throw canonicalError;
    const broadcast = job.broadcast;
    return compatibilityPayload({
      ...canonicalLiftJobBase(job),
      status: 'finalized',
      claim: requiredLiftJobField(job.claim, 'claim'),
      validation: requiredLiftJobField(job.validation, 'validation'),
      ...(broadcast ? { broadcast } : {}),
      ...(job.inclusion && broadcast
        ? { inclusion: canonicalLiftJobInclusion(job.inclusion, broadcast) }
        : {}),
      finalization: { ...finalization, mode: finalization.mode },
    });
  }
}

function parsePersistedFailed(job: StructurallyValidLiftJobPayload): KnownLiftJobPayload {
  try {
    return canonicalPayload(requiredCanonicalProjection(job));
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
  rejectDefinedLiftJobFields(job, ['finalization']);
  const failure = requiredLiftJobField(job.failure, 'failure');

  if (job.recovery?.action === 'finalized_from_chain') {
    if (failure.failedFromState !== 'included') throw new Error('unsupported legacy recovery origin');
    const broadcast = requiredLiftJobField(job.broadcast, 'broadcast');
    return {
      ...canonicalLiftJobBase(job),
      status: 'failed',
      claim: requiredLiftJobField(job.claim, 'claim'),
      validation: requiredLiftJobField(job.validation, 'validation'),
      broadcast,
      inclusion: canonicalLiftJobInclusion(
        requiredLiftJobField(job.inclusion, 'inclusion'),
        broadcast,
      ),
      failure: { ...failure, failedFromState: 'included' },
      recovery: job.recovery,
    };
  }

  const recovery = canonicalLiftJobFailureRecovery(job.recovery);
  if (failure.failedFromState === 'accepted') {
    throw new Error('accepted-origin failures have no compatibility projection');
  }

  if (job.broadcast !== undefined) {
    const broadcast = job.broadcast;
    return {
      ...canonicalLiftJobBaseWithoutRecovery(job),
      ...(recovery ? { recovery } : {}),
      status: 'failed',
      ...(job.claim ? { claim: job.claim } : {}),
      ...(job.validation ? { validation: job.validation } : {}),
      broadcast,
      ...(job.inclusion
        ? { inclusion: canonicalLiftJobInclusion(job.inclusion, broadcast) }
        : {}),
      failure: { ...failure, failedFromState: failure.failedFromState },
    };
  }

  rejectDefinedLiftJobFields(job, ['inclusion']);
  if (
    job.claim === undefined
    && job.validation === undefined
    && job.broadcast === undefined
  ) {
    return {
      ...canonicalLiftJobBaseWithoutRecovery(job),
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
      ...canonicalLiftJobBaseWithoutRecovery(job),
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
      ...canonicalLiftJobBaseWithoutRecovery(job),
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
      ...canonicalLiftJobBaseWithoutRecovery(job),
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
const bigintStringParser: RuntimeParser<LiftJobBigInt> = (value, path) => {
  const parsed = expectString(value, path);
  if (!/^-?(?:0|[1-9]\d*)$/.test(parsed)) {
    throw new Error(`${path} must be serialized integer text`);
  }
  return parsed as LiftJobBigInt;
};
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

const opaqueFinalizationIdentifiersParser = objectParser<LiftJobOpaqueFinalizationIdentifiers>({
  batchId: optional(stringParser),
  startKAId: optional(stringParser),
  endKAId: optional(stringParser),
});

const finalizationParser = objectParser<LiftJobFinalizationMetadata>({
  mode: optional(enumParser(['published', 'noop', 'local'] as const)),
  txHash: optional(hexParser),
  ual: optional(stringParser),
  batchId: optional(bigintStringParser),
  startKAId: optional(bigintStringParser),
  endKAId: optional(bigintStringParser),
  opaqueIdentifiers: optional(opaqueFinalizationIdentifiersParser),
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
