/**
 * Imported-artifact byte request/response codec.
 *
 * The request identifies one imported assertion artifact by context graph,
 * assertion URI, content hash, and byte kind. Responses model expected
 * application outcomes explicitly: missing artifacts, denied access, and
 * hash mismatches are structured payloads instead of transport exceptions.
 *
 * @internal
 */
import protobuf from 'protobufjs';

const { Type, Field } = protobuf;

export const IMPORTED_ARTIFACT_BYTE_KIND_MARKDOWN = 'markdown';

export const IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS = {
  ALLOW: 'allow',
  DENY: 'deny',
  MISS: 'miss',
  HASH_MISMATCH: 'hash_mismatch',
} as const;

export type ImportedArtifactBytesResponseStatus =
  (typeof IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS)[keyof typeof IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS];

export const IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS_VALUES: ReadonlySet<string> = new Set<string>(
  Object.values(IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS),
);

export const ImportedArtifactBytesRequestSchema = new Type('ImportedArtifactBytesRequest')
  .add(new Field('contextGraphId', 1, 'string'))
  .add(new Field('assertionUri', 2, 'string'))
  .add(new Field('hash', 3, 'string'))
  .add(new Field('kind', 4, 'string'))
  .add(new Field('subGraphName', 5, 'string'));

export const ImportedArtifactBytesResponseSchema = new Type('ImportedArtifactBytesResponse')
  .add(new Field('status', 1, 'string'))
  .add(new Field('hash', 2, 'string'))
  .add(new Field('kind', 3, 'string'))
  .add(new Field('bytes', 4, 'bytes'))
  .add(new Field('reason', 5, 'string'))
  .add(new Field('actualHash', 6, 'string'));

export interface ImportedArtifactBytesRequestMsg {
  contextGraphId: string;
  assertionUri: string;
  hash: string;
  kind: string;
  subGraphName?: string;
}

export interface ImportedArtifactBytesResponseMsg {
  status: ImportedArtifactBytesResponseStatus;
  hash: string;
  kind: string;
  bytes: Uint8Array;
  reason?: string;
  actualHash?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateImportedArtifactBytesRequest(msg: ImportedArtifactBytesRequestMsg): void {
  if (!isNonEmptyString(msg.contextGraphId)) {
    throw new Error('Invalid ImportedArtifactBytesRequest payload: contextGraphId is required');
  }
  if (!isNonEmptyString(msg.assertionUri)) {
    throw new Error('Invalid ImportedArtifactBytesRequest payload: assertionUri is required');
  }
  if (!isNonEmptyString(msg.hash)) {
    throw new Error('Invalid ImportedArtifactBytesRequest payload: hash is required');
  }
  if (!isNonEmptyString(msg.kind)) {
    throw new Error('Invalid ImportedArtifactBytesRequest payload: kind is required');
  }
}

function validateImportedArtifactBytesResponse(msg: ImportedArtifactBytesResponseMsg): void {
  if (
    !isNonEmptyString(msg.status) ||
    !IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS_VALUES.has(msg.status)
  ) {
    throw new Error('Invalid ImportedArtifactBytesResponse payload: status is required');
  }
  if (!isNonEmptyString(msg.hash)) {
    throw new Error('Invalid ImportedArtifactBytesResponse payload: hash is required');
  }
  if (!isNonEmptyString(msg.kind)) {
    throw new Error('Invalid ImportedArtifactBytesResponse payload: kind is required');
  }

  const bytes = msg.bytes instanceof Uint8Array ? msg.bytes : new Uint8Array(0);
  if (msg.status !== IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.ALLOW && bytes.length > 0) {
    throw new Error('Invalid ImportedArtifactBytesResponse payload: only allow responses may carry bytes');
  }
  if (
    msg.status === IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.HASH_MISMATCH &&
    !isNonEmptyString(msg.actualHash)
  ) {
    throw new Error('Invalid ImportedArtifactBytesResponse payload: actualHash is required for hash_mismatch');
  }
}

function normalizeImportedArtifactBytesResponse(
  msg: ImportedArtifactBytesResponseMsg,
): ImportedArtifactBytesResponseMsg {
  return {
    ...msg,
    bytes: msg.bytes instanceof Uint8Array ? msg.bytes : new Uint8Array(0),
  };
}

export function encodeImportedArtifactBytesRequest(msg: ImportedArtifactBytesRequestMsg): Uint8Array {
  validateImportedArtifactBytesRequest(msg);
  return ImportedArtifactBytesRequestSchema.encode(
    ImportedArtifactBytesRequestSchema.create(msg),
  ).finish();
}

export function decodeImportedArtifactBytesRequest(buf: Uint8Array): ImportedArtifactBytesRequestMsg {
  const decoded = ImportedArtifactBytesRequestSchema.decode(buf) as unknown as ImportedArtifactBytesRequestMsg;
  validateImportedArtifactBytesRequest(decoded);
  return decoded;
}

export function encodeImportedArtifactBytesResponse(msg: ImportedArtifactBytesResponseMsg): Uint8Array {
  const normalized = normalizeImportedArtifactBytesResponse(msg);
  validateImportedArtifactBytesResponse(normalized);
  return ImportedArtifactBytesResponseSchema.encode(
    ImportedArtifactBytesResponseSchema.create(normalized),
  ).finish();
}

export function decodeImportedArtifactBytesResponse(buf: Uint8Array): ImportedArtifactBytesResponseMsg {
  const decoded = ImportedArtifactBytesResponseSchema.decode(buf) as unknown as ImportedArtifactBytesResponseMsg;
  const normalized = normalizeImportedArtifactBytesResponse(decoded);
  validateImportedArtifactBytesResponse(normalized);
  return normalized;
}
