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
  type LiftJobControlPlaneRefs,
  type LiftJobFailureMetadata,
  type LiftJobFinalizationMetadata,
  type LiftJobHex,
  type LiftJobInclusionMetadata,
  type LiftJobRecoveryMetadata,
  type LiftJobRequest,
  type LiftJobRetryMetadata,
  type LiftJobTimestamps,
  type LiftJobValidationMetadata,
} from './lift-job.js';
import { parseLiteral } from './async-lift-control-plane.js';
import { normalizePersistedLiftJobRequest } from './async-lift-publisher-utils.js';

/**
 * A fully decoded persisted payload whose status is deliberately still an arbitrary string.
 * Every field exposed here has been parsed into its canonical runtime type; state membership and
 * the exact cross-state field contract are applied separately by {@link knownLiftJobPayload}.
 */
export interface StructurallyValidLiftJobPayload {
  readonly jobId: string;
  readonly jobSlug: string;
  readonly request: LiftJobRequest;
  readonly admission?: LiftJobAdmissionMetadata;
  readonly status: string;
  readonly timestamps: LiftJobTimestamps;
  readonly retries: LiftJobRetryMetadata;
  readonly recovery?: LiftJobRecoveryMetadata;
  readonly controlPlane?: LiftJobControlPlaneRefs;
  readonly claim?: LiftJobClaimMetadata;
  readonly validation?: LiftJobValidationMetadata;
  readonly broadcast?: LiftJobBroadcastMetadata;
  readonly inclusion?: StructurallyValidLiftJobInclusion;
  readonly finalization?: LiftJobFinalizationMetadata;
  readonly failure?: LiftJobFailureMetadata;
}

type StructurallyValidLiftJobInclusion = Omit<LiftJobInclusionMetadata, 'txHash'> & {
  readonly txHash?: LiftJobHex;
};

export type LiftJobPayloadDecodeResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'malformed'; readonly reason: string }
  | { readonly kind: 'job'; readonly job: StructurallyValidLiftJobPayload };

/** Classify one persisted job payload without hiding malformed state behind null or an exception. */
export function decodeLiftJobPayload(binding?: string): LiftJobPayloadDecodeResult {
  if (binding === undefined) return { kind: 'absent' };
  try {
    const payload = parseLiteral(binding);
    if (typeof payload !== 'string') return malformed('payload is not an RDF literal');
    const parsed = JSON.parse(payload) as unknown;
    const job = parseStructuralPayload(parsed);
    // Recognized states must satisfy an exact union member now. Unknown states deliberately stop
    // at the structural representation so targeted clear can distinguish them from corruption.
    if ((LIFT_JOB_STATES as readonly string[]).includes(job.status)) knownLiftJobPayload(job);
    return { kind: 'job', job };
  } catch (error) {
    return malformed(error instanceof Error ? error.message : String(error));
  }
}

/** Build the exact canonical union member, or null when only the status enum is unrecognized. */
export function knownLiftJobPayload(job: StructurallyValidLiftJobPayload): LiftJob | null {
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
      return parseBroadcast(job);
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
      return parseFinalized(job);
    case 'failed':
      return parseFailed(job);
    default:
      return null;
  }
}

/** Ordinary read policy: absence is nullable, but corrupt or unknown durable state fails closed. */
export function decodedLiftJobOrThrow(decoded: LiftJobPayloadDecodeResult): LiftJob | null {
  switch (decoded.kind) {
    case 'absent':
      return null;
    case 'malformed':
      throw new Error(`Malformed persisted LiftJob payload: ${decoded.reason}`);
    case 'job': {
      const known = knownLiftJobPayload(decoded.job);
      if (known === null) {
        throw new Error(`Malformed persisted LiftJob payload: Unsupported LiftJob status: ${decoded.job.status}`);
      }
      return known;
    }
  }
}

function parseStructuralPayload(value: unknown): StructurallyValidLiftJobPayload {
  const record = expectRecord(value, 'payload');
  return {
    jobId: expectNonEmptyString(record['jobId'], 'jobId'),
    jobSlug: expectNonEmptyString(record['jobSlug'], 'jobSlug'),
    request: normalizePersistedLiftJobRequest(record['request']),
    ...(record['admission'] === undefined ? {} : { admission: parseAdmission(record['admission']) }),
    status: expectNonEmptyString(record['status'], 'status'),
    timestamps: parseTimestamps(record['timestamps']),
    retries: parseRetries(record['retries']),
    ...(record['recovery'] === undefined ? {} : { recovery: parseRecovery(record['recovery']) }),
    ...(record['controlPlane'] === undefined
      ? {}
      : { controlPlane: parseControlPlane(record['controlPlane']) }),
    ...(record['claim'] === undefined ? {} : { claim: parseClaim(record['claim']) }),
    ...(record['validation'] === undefined
      ? {}
      : { validation: parseValidation(record['validation']) }),
    ...(record['broadcast'] === undefined
      ? {}
      : { broadcast: parseBroadcastMetadata(record['broadcast']) }),
    ...(record['inclusion'] === undefined
      ? {}
      : { inclusion: parseInclusion(record['inclusion']) }),
    ...(record['finalization'] === undefined
      ? {}
      : { finalization: parseFinalization(record['finalization']) }),
    ...(record['failure'] === undefined ? {} : { failure: parseFailure(record['failure']) }),
  };
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

function parseBroadcast(job: StructurallyValidLiftJobPayload): LiftJob {
  rejectDefined(job, ['inclusion', 'finalization', 'failure']);
  const claim = required(job.claim, 'claim');
  if (job.validation === undefined && job.broadcast === undefined && job.request.jobType === 'lift') {
    return { ...base(job), status: 'broadcast', request: job.request, claim };
  }
  return {
    ...base(job),
    status: 'broadcast',
    claim,
    validation: required(job.validation, 'validation'),
    broadcast: required(job.broadcast, 'broadcast'),
  };
}

function parseFinalized(job: StructurallyValidLiftJobPayload): LiftJob {
  rejectDefined(job, ['failure']);
  const claim = required(job.claim, 'claim');
  const validation = required(job.validation, 'validation');
  const finalization = required(job.finalization, 'finalization');
  // Older/current transition callers can retain transaction fields while stamping a local/noop
  // result. Those fields are not part of either canonical terminal variant, so the constructive
  // projection deliberately omits them instead of lying about the returned union member.
  if (finalization.mode === 'noop') {
    return {
      ...base(job),
      status: 'finalized',
      claim,
      validation,
      finalization: { ...finalization, mode: 'noop' },
    };
  }
  if (finalization.mode === 'local') {
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

function parseFailed(job: StructurallyValidLiftJobPayload): LiftJob {
  rejectDefined(job, ['finalization']);
  const failure = required(job.failure, 'failure');
  // Failure progress is historical: it may describe an earlier attempt than failedFromState and
  // can be deliberately incomplete. LiftJobPersistedFailure is the exact read-model member for
  // that durable contract; policy consumers already inspect its optional evidence defensively.
  return {
    ...base(job),
    status: 'failed',
    ...(job.claim ? { claim: job.claim } : {}),
    ...(job.validation ? { validation: job.validation } : {}),
    ...(job.broadcast ? { broadcast: job.broadcast } : {}),
    ...(job.inclusion && job.broadcast
      ? { inclusion: canonicalInclusion(job.inclusion, job.broadcast) }
      : {}),
    failure,
  };
}

function parseTimestamps(value: unknown): LiftJobTimestamps {
  const record = expectRecord(value, 'timestamps');
  return {
    acceptedAt: expectFiniteNumber(record['acceptedAt'], 'timestamps.acceptedAt'),
    ...optionalNumber(record, 'claimedAt', 'timestamps'),
    ...optionalNumber(record, 'validatedAt', 'timestamps'),
    ...optionalNumber(record, 'broadcastAt', 'timestamps'),
    ...optionalNumber(record, 'rpcAcceptedAt', 'timestamps'),
    ...optionalNumber(record, 'includedAt', 'timestamps'),
    ...optionalNumber(record, 'finalizedAt', 'timestamps'),
    ...optionalNumber(record, 'failedAt', 'timestamps'),
    ...optionalNumber(record, 'lastRetriedAt', 'timestamps'),
    ...optionalNumber(record, 'nextRetryAt', 'timestamps'),
    ...optionalNumber(record, 'lastRecoveredAt', 'timestamps'),
    updatedAt: expectFiniteNumber(record['updatedAt'], 'timestamps.updatedAt'),
  };
}

function parseRetries(value: unknown): LiftJobRetryMetadata {
  const record = expectRecord(value, 'retries');
  return {
    retryCount: expectFiniteNumber(record['retryCount'], 'retries.retryCount'),
    maxRetries: expectFiniteNumber(record['maxRetries'], 'retries.maxRetries'),
    ...optionalString(record, 'lastRetryReason', 'retries'),
  };
}

function parseAdmission(value: unknown): LiftJobAdmissionMetadata {
  const record = expectRecord(value, 'admission');
  return {
    byAgentAddress: expectNonEmptyString(record['byAgentAddress'], 'admission.byAgentAddress'),
  };
}

function parseControlPlane(value: unknown): LiftJobControlPlaneRefs {
  const record = expectRecord(value, 'controlPlane');
  return {
    ...optionalString(record, 'jobRef', 'controlPlane'),
    ...optionalString(record, 'walletLockRef', 'controlPlane'),
  };
}

function parseRecovery(value: unknown): LiftJobRecoveryMetadata {
  const record = expectRecord(value, 'recovery');
  const action = record['action'];
  const recoveredFromStatus = record['recoveredFromStatus'];
  if (action === 'finalized_from_chain') {
    if (recoveredFromStatus !== 'broadcast' && recoveredFromStatus !== 'included') {
      throw new Error('recovery.finalized_from_chain requires a broadcast or included origin');
    }
    return {
      action,
      recoveredFromStatus,
      txHashChecked: expectHexString(record['txHashChecked'], 'recovery.txHashChecked'),
      ...optionalString(record, 'note', 'recovery'),
    };
  }
  if (action !== 'reset_to_accepted') throw new Error('recovery.action is unsupported');
  if (!['claimed', 'validated', 'broadcast', 'included'].includes(String(recoveredFromStatus))) {
    throw new Error('recovery.recoveredFromStatus is unsupported');
  }
  return {
    action,
    recoveredFromStatus: recoveredFromStatus as 'claimed' | 'validated' | 'broadcast' | 'included',
    ...(record['txHashChecked'] === undefined
      ? {}
      : { txHashChecked: expectHexString(record['txHashChecked'], 'recovery.txHashChecked') }),
    ...optionalBoolean(record, 'txHashAccounted', 'recovery'),
    ...optionalOperationKind(record, 'operationKind', 'recovery'),
    ...optionalString(record, 'walletIdChecked', 'recovery'),
    ...optionalNumber(record, 'nonceChecked', 'recovery'),
    ...optionalString(record, 'note', 'recovery'),
  };
}

function parseClaim(value: unknown): LiftJobClaimMetadata {
  const record = expectRecord(value, 'claim');
  return {
    walletId: expectNonEmptyString(record['walletId'], 'claim.walletId'),
    ...optionalString(record, 'claimedBy', 'claim'),
    ...optionalString(record, 'claimToken', 'claim'),
    ...optionalNumber(record, 'claimLeaseExpiresAt', 'claim'),
  };
}

function parseValidation(value: unknown): LiftJobValidationMetadata {
  const record = expectRecord(value, 'validation');
  const rootMap = expectRecord(record['canonicalRootMap'], 'validation.canonicalRootMap');
  if (!Object.values(rootMap).every((item) => typeof item === 'string')) {
    throw new Error('validation.canonicalRootMap must map strings to strings');
  }
  return {
    canonicalRoots: expectStringArray(record['canonicalRoots'], 'validation.canonicalRoots'),
    canonicalRootMap: rootMap as Record<string, string>,
    swmQuadCount: expectFiniteNumber(record['swmQuadCount'], 'validation.swmQuadCount'),
    authorityProofRef: expectNonEmptyString(record['authorityProofRef'], 'validation.authorityProofRef'),
    transitionType: expectEnum(record['transitionType'], LIFT_TRANSITION_TYPES, 'validation.transitionType'),
    ...optionalString(record, 'priorVersion', 'validation'),
  };
}

function parseBroadcastMetadata(value: unknown): LiftJobBroadcastMetadata {
  const record = expectRecord(value, 'broadcast');
  return {
    txHash: expectHexString(record['txHash'], 'broadcast.txHash'),
    walletId: expectNonEmptyString(record['walletId'], 'broadcast.walletId'),
    ...(record['merkleRoot'] === undefined
      ? {}
      : { merkleRoot: expectHexString(record['merkleRoot'], 'broadcast.merkleRoot') }),
    ...optionalNumber(record, 'publicByteSize', 'broadcast'),
    ...optionalNumber(record, 'nonce', 'broadcast'),
    ...optionalOperationKind(record, 'operationKind', 'broadcast'),
  };
}

function parseInclusion(value: unknown): StructurallyValidLiftJobInclusion {
  const record = expectRecord(value, 'inclusion');
  return {
    ...(record['txHash'] === undefined
      ? {}
      : { txHash: expectHexString(record['txHash'], 'inclusion.txHash') }),
    blockNumber: expectFiniteNumber(record['blockNumber'], 'inclusion.blockNumber'),
    ...(record['blockHash'] === undefined
      ? {}
      : { blockHash: expectHexString(record['blockHash'], 'inclusion.blockHash') }),
    ...optionalNumber(record, 'blockTimestamp', 'inclusion'),
  };
}

function canonicalInclusion(
  inclusion: StructurallyValidLiftJobInclusion,
  broadcast: LiftJobBroadcastMetadata,
): LiftJobInclusionMetadata {
  return { ...inclusion, txHash: inclusion.txHash ?? broadcast.txHash };
}

function parseFinalization(value: unknown): LiftJobFinalizationMetadata {
  const record = expectRecord(value, 'finalization');
  const mode = record['mode'];
  if (mode !== undefined && mode !== 'published' && mode !== 'noop' && mode !== 'local') {
    throw new Error('finalization.mode is unsupported');
  }
  return {
    ...(mode === undefined ? {} : { mode }),
    ...(record['txHash'] === undefined
      ? {}
      : { txHash: expectHexString(record['txHash'], 'finalization.txHash') }),
    ...optionalString(record, 'ual', 'finalization'),
    ...optionalString(record, 'batchId', 'finalization'),
    ...optionalString(record, 'startKAId', 'finalization'),
    ...optionalString(record, 'endKAId', 'finalization'),
    ...(record['publisherAddress'] === undefined
      ? {}
      : { publisherAddress: expectHexString(record['publisherAddress'], 'finalization.publisherAddress') }),
  };
}

function parseFailure(value: unknown): LiftJobFailureMetadata {
  const record = expectRecord(value, 'failure');
  return {
    failedFromState: expectEnum(
      record['failedFromState'],
      ['accepted', 'claimed', 'validated', 'broadcast', 'included'] as const,
      'failure.failedFromState',
    ),
    phase: expectEnum(record['phase'], LIFT_JOB_FAILURE_PHASES, 'failure.phase'),
    mode: expectEnum(record['mode'], LIFT_JOB_FAILURE_MODES, 'failure.mode'),
    retryable: expectBoolean(record['retryable'], 'failure.retryable'),
    resolution: expectEnum(record['resolution'], LIFT_JOB_FAILURE_RESOLUTIONS, 'failure.resolution'),
    code: expectEnum(record['code'], LIFT_JOB_FAILURE_CODES, 'failure.code'),
    // Diagnostics are strings, not identifiers. Empty values are legitimate output from Error('')
    // and from legacy callers, so the codec must accept what the public writer can persist.
    message: expectString(record['message'], 'failure.message'),
    errorPayloadRef: expectString(record['errorPayloadRef'], 'failure.errorPayloadRef'),
    ...optionalString(record, 'stackTraceRef', 'failure'),
    ...optionalString(record, 'rpcResponseRef', 'failure'),
    ...optionalString(record, 'revertReasonRef', 'failure'),
    ...(record['timeout'] === undefined ? {} : { timeout: parseTimeout(record['timeout']) }),
  };
}

function parseTimeout(value: unknown): NonNullable<LiftJobFailureMetadata['timeout']> {
  const record = expectRecord(value, 'failure.timeout');
  return {
    timeoutMs: expectFiniteNumber(record['timeoutMs'], 'failure.timeout.timeoutMs'),
    timeoutAt: expectFiniteNumber(record['timeoutAt'], 'failure.timeout.timeoutAt'),
    handling: expectEnum(record['handling'], LIFT_JOB_TIMEOUT_HANDLINGS, 'failure.timeout.handling'),
  };
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

function optionalString<K extends string>(
  record: Record<string, unknown>,
  key: K,
  path: string,
): { readonly [P in K]?: string } {
  return record[key] === undefined
    ? {}
    : { [key]: expectString(record[key], `${path}.${key}`) } as { [P in K]: string };
}

function optionalNumber<K extends string>(
  record: Record<string, unknown>,
  key: K,
  path: string,
): { readonly [P in K]?: number } {
  return record[key] === undefined
    ? {}
    : { [key]: expectFiniteNumber(record[key], `${path}.${key}`) } as { [P in K]: number };
}

function optionalBoolean<K extends string>(
  record: Record<string, unknown>,
  key: K,
  path: string,
): { readonly [P in K]?: boolean } {
  return record[key] === undefined
    ? {}
    : { [key]: expectBoolean(record[key], `${path}.${key}`) } as { [P in K]: boolean };
}

function optionalOperationKind<K extends string>(
  record: Record<string, unknown>,
  key: K,
  path: string,
): { readonly [P in K]?: 'create' | 'update' } {
  if (record[key] === undefined) return {};
  const value = record[key];
  if (value !== 'create' && value !== 'update') throw new Error(`${path}.${key} is unsupported`);
  return { [key]: value } as { [P in K]: 'create' | 'update' };
}
