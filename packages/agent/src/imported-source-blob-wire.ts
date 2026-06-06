export const IMPORTED_SOURCE_BLOB_WIRE_VERSION = 1;

export interface ImportedSourceBlobRequest {
  version: number;
  contextGraphId: string;
  assertionUri: string;
  blobHash: string;
  offset: number;
  maxBytes: number;
  subGraphName?: string;
  /** Base64-encoded sync auth envelope built for the target peer. */
  authB64: string;
}

export interface ImportedSourceBlobResponse {
  version: number;
  contextGraphId: string;
  assertionUri: string;
  blobHash: string;
  offset: number;
  totalBytes?: number;
  nextOffset?: number;
  truncated?: boolean;
  denied?: string;
  bytesB64?: string;
}

type RequestJson = Partial<Omit<ImportedSourceBlobRequest, 'authB64'> & { authB64: string }>;
type ResponseJson = Partial<ImportedSourceBlobResponse>;

const HASH_RE = /^(?:sha256:|keccak256:)?[0-9a-f]{64}$/i;

export function normalizeImportedSourceBlobHash(value: string): string {
  if (!HASH_RE.test(value)) {
    throw new Error('blobHash must be a supported content hash');
  }
  return value.toLowerCase();
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

export function encodeImportedSourceBlobRequest(req: ImportedSourceBlobRequest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(req));
}

export function decodeImportedSourceBlobRequest(bytes: Uint8Array): ImportedSourceBlobRequest {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as RequestJson;
  if (parsed.version !== IMPORTED_SOURCE_BLOB_WIRE_VERSION) {
    throw new Error(`Unsupported imported-source-blob request version: ${parsed.version}`);
  }
  const contextGraphId = requireString(parsed.contextGraphId, 'contextGraphId');
  const assertionUri = requireString(parsed.assertionUri, 'assertionUri');
  const blobHash = normalizeImportedSourceBlobHash(requireString(parsed.blobHash, 'blobHash'));
  const offset = requireNonNegativeInteger(parsed.offset, 'offset');
  const maxBytes = requirePositiveInteger(parsed.maxBytes, 'maxBytes');
  const authB64 = requireString(parsed.authB64, 'authB64');
  return {
    version: IMPORTED_SOURCE_BLOB_WIRE_VERSION,
    contextGraphId,
    assertionUri,
    blobHash,
    offset,
    maxBytes,
    ...(typeof parsed.subGraphName === 'string' && parsed.subGraphName ? { subGraphName: parsed.subGraphName } : {}),
    authB64,
  };
}

export function encodeImportedSourceBlobResponse(resp: ImportedSourceBlobResponse): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(resp));
}

export function decodeImportedSourceBlobResponse(bytes: Uint8Array): ImportedSourceBlobResponse {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as ResponseJson;
  if (parsed.version !== IMPORTED_SOURCE_BLOB_WIRE_VERSION) {
    throw new Error(`Unsupported imported-source-blob response version: ${parsed.version}`);
  }
  const denied = typeof parsed.denied === 'string' ? parsed.denied : undefined;
  const contextGraphId = denied !== undefined && parsed.contextGraphId === ''
    ? ''
    : requireString(parsed.contextGraphId, 'contextGraphId');
  const assertionUri = denied !== undefined && parsed.assertionUri === ''
    ? ''
    : requireString(parsed.assertionUri, 'assertionUri');
  const blobHash = normalizeImportedSourceBlobHash(requireString(parsed.blobHash, 'blobHash'));
  const offset = requireNonNegativeInteger(parsed.offset, 'offset');
  if (parsed.denied !== undefined && parsed.bytesB64 !== undefined) {
    throw new Error('imported-source-blob response sets both denied and bytesB64');
  }
  return {
    version: IMPORTED_SOURCE_BLOB_WIRE_VERSION,
    contextGraphId,
    assertionUri,
    blobHash,
    offset,
    ...(parsed.totalBytes !== undefined ? { totalBytes: requireNonNegativeInteger(parsed.totalBytes, 'totalBytes') } : {}),
    ...(parsed.nextOffset !== undefined ? { nextOffset: requireNonNegativeInteger(parsed.nextOffset, 'nextOffset') } : {}),
    ...(typeof parsed.truncated === 'boolean' ? { truncated: parsed.truncated } : {}),
    ...(denied !== undefined ? { denied } : {}),
    ...(typeof parsed.bytesB64 === 'string' ? { bytesB64: parsed.bytesB64 } : {}),
  };
}
