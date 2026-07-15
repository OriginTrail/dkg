import type { QueryResult } from '@origintrail-official/dkg-storage';
import {
  LIFT_AUTHORITY_TYPES,
  LIFT_TRANSITION_TYPES,
} from './lift-job.js';
import type {
  KnowledgeAssetVmPublishJobRequest,
  KnowledgeAssetVmPublishRequest,
  LiftJob,
  LiftJobHex,
  LiftJobRequest,
  LiftPublishRequestMetadata,
  LiftPublishSnapshotRequest,
  RawLiftJobRequest,
  RawLiftRequest,
} from './lift-job.js';
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
  createJobSlug,
  jobSubject,
  parseIntegerLiteral,
  serializeJob,
  serializeWalletLock,
  literal,
  parseLiteral,
  requestSubject,
  walletLockSubject,
} from './async-lift-control-plane.js';

export type PersistedFailedJob = Extract<LiftJob, { status: 'failed' }>;

export function expectBindings(result: QueryResult): Array<Record<string, string>> {
  if (result.type !== 'bindings') {
    throw new Error(`Expected SPARQL bindings result, got ${result.type}`);
  }
  return result.bindings;
}

export function compareAcceptedJobs(a: LiftJob, b: LiftJob): number {
  const timeDelta = a.timestamps.acceptedAt - b.timestamps.acceptedAt;
  if (timeDelta !== 0) return timeDelta;
  return a.jobId.localeCompare(b.jobId);
}

export function getRecoveryTxHash(job: LiftJob): LiftJobHex | undefined {
  if ('broadcast' in job && job.broadcast) {
    return job.broadcast.txHash;
  }
  return undefined;
}

export function isFailedJob(job: LiftJob): job is PersistedFailedJob {
  return job.status === 'failed' && 'failure' in job;
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
    ...optionalStringField(record, 'subGraphName', path),
    shareOperationId: expectString(record, 'shareOperationId', path),
    roots: expectStringArray(record, 'roots', path),
    ...optionalNumberField(record, 'contentScopeVersion', path),
    ...optionalStringField(record, 'kaUal', path),
    ...optionalStringField(record, 'assertionVersion', path),
    ...optionalNumberField(record, 'publicTripleCount', path),
    ...optionalHexStringField(record, 'privateMerkleRoot', path),
    ...optionalNumberField(record, 'privateTripleCount', path),
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
