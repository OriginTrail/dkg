import { createHash } from 'node:crypto';
import { ethers } from 'ethers';
import {
  createOperationContext,
  contextGraphMetaUri,
  contextGraphSharedMemoryUri,
  isSafeIri,
  PROTOCOL_GET_ASSERTION_ARTIFACT,
  validateContextGraphId,
  validateSubGraphName,
} from '@origintrail-official/dkg-core';
import type { DKGAgent } from './dkg-agent.js';
import { DKGAgentBase } from './dkg-agent-base.js';
import { buildSyncRequestEnvelope, type SyncRequestEnvelope } from './sync/auth/request-build.js';
import { isSyncRequestEnvelopeBoundToPeer } from './sync/auth/request-authorize.js';
import {
  SYNC_AUTH_MAX_AGE_MS,
  SYNC_PAGE_TIMEOUT_MS,
} from './dkg-agent-constants.js';
import type {
  AssertionArtifactKind,
  ImportedArtifactByteStore,
} from './dkg-agent-types.js';
import { stripLiteral } from './dkg-agent-utils.js';

const DKG_ONTOLOGY = 'http://dkg.io/ontology/';
export const IMPORTED_ARTIFACT_AUTH_PURPOSE = 'imported-artifact:v1';
export const IMPORTED_ARTIFACT_MAX_PAGE_BYTES = 1024 * 1024;
const IMPORTED_ARTIFACT_MAX_CACHE_BYTES = 64 * 1024 * 1024;
export { PROTOCOL_GET_ASSERTION_ARTIFACT };

export interface ImportedArtifactRequest {
  version: 1;
  contextGraphId: string;
  assertionUri: string;
  kind: AssertionArtifactKind;
  hash: string;
  offset: number;
  maxBytes: number;
  subGraphName?: string;
  authB64: string;
}

export interface ImportedArtifactResponse {
  version: 1;
  contextGraphId: string;
  assertionUri: string;
  kind: AssertionArtifactKind;
  hash: string;
  offset: number;
  totalBytes?: number;
  nextOffset?: number;
  truncated?: boolean;
  contentType?: string;
  denied?: string;
  unavailable?: boolean;
  hashMismatch?: boolean;
  bytesB64?: string;
}

export interface ReadAssertionArtifactParams {
  contextGraphId: string;
  assertionUri: string;
  kind: AssertionArtifactKind;
  hash: string;
  offset?: number;
  maxBytes?: number;
  subGraphName?: string;
  sourcePeerId: string;
  cache?: boolean;
}

function validateContentHash(hash: string): boolean {
  return /^(?:sha256:|keccak256:)?[0-9a-f]{64}$/i.test(hash);
}

function normalizeKind(kind: unknown): AssertionArtifactKind | null {
  return kind === 'source' || kind === 'markdown' || kind === 'original' ? kind : null;
}

function normalizeRange(offset: unknown, maxBytes: unknown): { offset: number; maxBytes: number } | null {
  const parsedOffset = Number(offset ?? 0);
  const parsedMax = Number(maxBytes ?? IMPORTED_ARTIFACT_MAX_PAGE_BYTES);
  if (!Number.isSafeInteger(parsedOffset) || parsedOffset < 0) return null;
  if (!Number.isSafeInteger(parsedMax) || parsedMax <= 0) return null;
  return {
    offset: parsedOffset,
    maxBytes: Math.min(parsedMax, IMPORTED_ARTIFACT_MAX_PAGE_BYTES),
  };
}

export function computeImportedArtifactSelector(args: {
  version: 1;
  contextGraphId: string;
  assertionUri: string;
  kind: AssertionArtifactKind;
  hash: string;
  offset: number;
  maxBytes: number;
  subGraphName?: string;
}): string {
  const payload: {
    version: 1;
    contextGraphId: string;
    assertionUri: string;
    kind: AssertionArtifactKind;
    hash: string;
    offset: number;
    maxBytes: number;
    subGraphName?: string;
  } = {
    version: args.version,
    contextGraphId: args.contextGraphId,
    assertionUri: args.assertionUri,
    kind: args.kind,
    hash: args.hash,
    offset: args.offset,
    maxBytes: args.maxBytes,
  };
  if (args.subGraphName) payload.subGraphName = args.subGraphName;
  const canonical = JSON.stringify(payload);
  return `imported-artifact:v1:${ethers.keccak256(ethers.toUtf8Bytes(canonical))}`;
}

function encodeResponse(response: ImportedArtifactResponse): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(response));
}

function decodeResponse(data: Uint8Array): ImportedArtifactResponse {
  return JSON.parse(new TextDecoder().decode(data)) as ImportedArtifactResponse;
}

function decodeRequest(data: Uint8Array): ImportedArtifactRequest | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const kind = normalizeKind(parsed.kind);
  const range = normalizeRange(parsed.offset, parsed.maxBytes);
  const contextGraphId = typeof parsed.contextGraphId === 'string' ? parsed.contextGraphId.trim() : '';
  const assertionUri = typeof parsed.assertionUri === 'string' ? parsed.assertionUri.trim() : '';
  const hash = typeof parsed.hash === 'string' ? parsed.hash.trim() : '';
  const authB64 = typeof parsed.authB64 === 'string' ? parsed.authB64.trim() : '';
  if (parsed.version !== 1 || !kind || !range || !contextGraphId || !assertionUri || !hash || !authB64) return null;
  if (!validateContextGraphId(contextGraphId).valid || !isSafeIri(assertionUri) || !validateContentHash(hash)) return null;
  const subGraphName = typeof parsed.subGraphName === 'string' && parsed.subGraphName.trim()
    ? parsed.subGraphName.trim()
    : undefined;
  if (subGraphName && !validateSubGraphName(subGraphName).valid) return null;
  return {
    version: 1,
    contextGraphId,
    assertionUri,
    kind,
    hash,
    offset: range.offset,
    maxBytes: range.maxBytes,
    ...(subGraphName ? { subGraphName } : {}),
    authB64,
  };
}

function responseBase(req: ImportedArtifactRequest): ImportedArtifactResponse {
  return {
    version: 1,
    contextGraphId: req.contextGraphId,
    assertionUri: req.assertionUri,
    kind: req.kind,
    hash: req.hash,
    offset: req.offset,
  };
}

function parseHashUrn(value: string | undefined): string | undefined {
  const prefix = 'urn:dkg:file:';
  if (!value?.startsWith(prefix)) return undefined;
  const hash = value.slice(prefix.length);
  return validateContentHash(hash) ? hash : undefined;
}

function binding(cell: unknown): string {
  if (typeof cell === 'string') return cell.replace(/^<|>$/g, '');
  if (cell && typeof cell === 'object' && 'value' in cell) {
    const value = (cell as { value?: unknown }).value;
    return typeof value === 'string' ? value : '';
  }
  return '';
}

function literal(cell: unknown): string {
  return stripLiteral(binding(cell)).trim();
}

function normalizeContentType(raw: string | undefined): string {
  return raw?.trim().toLowerCase() || 'application/octet-stream';
}

function comparableAgentAddress(value: string): string {
  const trimmed = value.trim();
  const unwrapped = trimmed.startsWith('did:dkg:agent:')
    ? trimmed.slice('did:dkg:agent:'.length)
    : trimmed;
  return /^0x[0-9a-fA-F]{40}$/.test(unwrapped) ? unwrapped.toLowerCase() : unwrapped;
}

function isSameAgentAddress(left: string, right: string): boolean {
  return left === right || comparableAgentAddress(left) === comparableAgentAddress(right);
}

function parseImportedAssertionUri(
  assertionUri: string,
  contextGraphId: string,
  legacyAssertionAgentAddress?: string,
): { assertionAgentAddress: string; assertionName: string; subGraphName?: string; legacy?: boolean } | null {
  const prefix = `did:dkg:context-graph:${contextGraphId}/`;
  if (!assertionUri.startsWith(prefix)) return null;
  const tail = assertionUri.slice(prefix.length);
  let subGraphName: string | undefined;
  let assertionTail = tail;
  if (tail.startsWith('assertion/')) {
    assertionTail = tail.slice('assertion/'.length);
  } else {
    const marker = tail.indexOf('/assertion/');
    if (marker <= 0) return null;
    subGraphName = tail.slice(0, marker);
    if (!validateSubGraphName(subGraphName).valid) return null;
    assertionTail = tail.slice(marker + '/assertion/'.length);
  }

  const slash = assertionTail.indexOf('/');
  if (slash === -1 && legacyAssertionAgentAddress && assertionTail) {
    return {
      assertionAgentAddress: legacyAssertionAgentAddress,
      assertionName: assertionTail,
      ...(subGraphName ? { subGraphName } : {}),
      legacy: true,
    };
  }
  if (slash <= 0 || slash === assertionTail.length - 1) return null;
  const assertionAgentAddress = assertionTail.slice(0, slash);
  const assertionName = assertionTail.slice(slash + 1);
  if (!assertionAgentAddress || !assertionName) return null;
  return { assertionAgentAddress, assertionName, subGraphName };
}

async function isPublicOpenContextGraph(
  agent: DKGAgent,
  contextGraphId: string,
): Promise<boolean> {
  if (typeof agent.getContextGraphOnChainPolicy !== 'function') return false;
  try {
    const policy = await agent.getContextGraphOnChainPolicy(contextGraphId);
    return policy.accessPolicy === 0 && policy.publishPolicy === 1;
  } catch {
    return false;
  }
}

async function canReadImportedArtifactByOwnerPolicy(
  agent: DKGAgent,
  req: ImportedArtifactRequest,
  syncReq: SyncRequestEnvelope,
): Promise<boolean> {
  const parsedAssertion = parseImportedAssertionUri(
    req.assertionUri,
    req.contextGraphId,
    syncReq.requesterAgentAddress,
  );
  if (!parsedAssertion) return false;

  if (!parsedAssertion.legacy && await isPublicOpenContextGraph(agent, req.contextGraphId)) {
    return true;
  }

  return Boolean(
    syncReq.requesterAgentAddress &&
    isSameAgentAddress(parsedAssertion.assertionAgentAddress, syncReq.requesterAgentAddress),
  );
}

async function resolveLinkedArtifact(agent: DKGAgent, args: {
  contextGraphId: string;
  assertionUri: string;
  kind: AssertionArtifactKind;
  hash?: string;
  subGraphName?: string;
}): Promise<{ hash: string; contentType?: string } | null | 'hash_mismatch'> {
  const durable = await agent.store.query(`
    SELECT ?fileHash ?contentType ?extractionStatus ?structuralTripleCount ?mdIntermediateHash WHERE {
      GRAPH <${contextGraphMetaUri(args.contextGraphId)}> {
        <${args.assertionUri}> <${DKG_ONTOLOGY}sourceFileHash> ?fileHash .
        OPTIONAL { <${args.assertionUri}> <${DKG_ONTOLOGY}sourceContentType> ?contentType }
        OPTIONAL { <${args.assertionUri}> <${DKG_ONTOLOGY}extractionStatus> ?extractionStatus }
        OPTIONAL { <${args.assertionUri}> <${DKG_ONTOLOGY}structuralTripleCount> ?structuralTripleCount }
        OPTIONAL { <${args.assertionUri}> <${DKG_ONTOLOGY}mdIntermediateHash> ?mdIntermediateHash }
      }
    }
    LIMIT 1
  `) as { type?: string; bindings?: Array<Record<string, unknown>> };
  let fileHash: string | undefined;
  let contentType = 'application/octet-stream';
  let mdIntermediateHash: string | undefined;
  const durableBinding = durable.bindings?.[0];
  if (durableBinding) {
    const status = literal(durableBinding.extractionStatus);
    const legacyCount = Number(literal(durableBinding.structuralTripleCount));
    if (status && status !== 'completed') return null;
    if (!status && (!Number.isSafeInteger(legacyCount) || legacyCount <= 0)) return null;
    fileHash = literal(durableBinding.fileHash);
    contentType = normalizeContentType(literal(durableBinding.contentType));
    mdIntermediateHash = literal(durableBinding.mdIntermediateHash) || undefined;
  } else {
    const swm = await agent.store.query(`
      SELECT ?sourceFile ?contentType ?markdownForm WHERE {
        GRAPH <${contextGraphSharedMemoryUri(args.contextGraphId, args.subGraphName)}> {
          <${args.assertionUri}> <${DKG_ONTOLOGY}sourceFile> ?sourceFile .
          OPTIONAL { <${args.assertionUri}> <${DKG_ONTOLOGY}sourceContentType> ?contentType }
          OPTIONAL { <${args.assertionUri}> <${DKG_ONTOLOGY}markdownForm> ?markdownForm }
        }
      }
      LIMIT 1
    `) as { type?: string; bindings?: Array<Record<string, unknown>> };
    const row = swm.bindings?.[0];
    if (!row) return null;
    fileHash = parseHashUrn(binding(row.sourceFile));
    contentType = normalizeContentType(literal(row.contentType));
    mdIntermediateHash = parseHashUrn(binding(row.markdownForm));
  }
  if (!fileHash || !validateContentHash(fileHash)) return null;
  if (mdIntermediateHash && !validateContentHash(mdIntermediateHash)) return null;

  const linkedHash = args.kind === 'markdown'
    ? mdIntermediateHash ?? (contentType === 'text/markdown' ? fileHash : undefined)
    : fileHash;
  if (!linkedHash) return null;
  if (args.hash && args.hash !== linkedHash) return 'hash_mismatch';
  return {
    hash: linkedHash,
    contentType: args.kind === 'markdown' ? 'text/markdown' : contentType,
  };
}

function verifyBytesHash(hash: string, bytes: Uint8Array): boolean {
  const buffer = Buffer.from(bytes);
  if (hash.startsWith('keccak256:')) {
    return `keccak256:${ethers.keccak256(buffer).replace(/^0x/, '')}` === hash;
  }
  const sha = createHash('sha256').update(buffer).digest('hex');
  return hash === sha || hash === `sha256:${sha}`;
}

export class ImportedArtifactMethods extends DKGAgentBase {
  registerImportedArtifactByteStore(this: DKGAgent, store: ImportedArtifactByteStore): void {
    this.config.importedArtifactByteStore = store;
    this.router.register(
      PROTOCOL_GET_ASSERTION_ARTIFACT,
      (data, peerIdObj) => this.handleGetImportedArtifact(data, peerIdObj.toString()),
    );
  }

  async handleGetImportedArtifact(this: DKGAgent, data: Uint8Array, fromPeerId: string): Promise<Uint8Array> {
    const ctx = createOperationContext('sync');
    const req = decodeRequest(data);
    const denied = (request?: ImportedArtifactRequest) => encodeResponse({
      version: 1,
      contextGraphId: request?.contextGraphId ?? '',
      assertionUri: request?.assertionUri ?? '',
      kind: request?.kind ?? 'source',
      hash: request?.hash ?? '',
      offset: request?.offset ?? 0,
      denied: 'denied',
    });
    if (!req) return denied();

    let syncReq: SyncRequestEnvelope;
    try {
      syncReq = this.parseSyncRequest(Buffer.from(req.authB64, 'base64'));
    } catch {
      return denied(req);
    }
    const expectedSelector = computeImportedArtifactSelector(req);
    if (
      syncReq.contextGraphId !== req.contextGraphId ||
      !isSyncRequestEnvelopeBoundToPeer(syncReq, fromPeerId, this.peerId) ||
      syncReq.authPurpose !== IMPORTED_ARTIFACT_AUTH_PURPOSE ||
      syncReq.authSelector !== expectedSelector
    ) {
      this.log.warn(ctx, `Denied imported artifact request for "${req.contextGraphId}" from ${fromPeerId}: sync envelope not bound to artifact request`);
      return denied(req);
    }

    const authorized = await this.authorizeSyncRequest(syncReq, fromPeerId);
    if (!authorized) return denied(req);
    if (!await canReadImportedArtifactByOwnerPolicy(this, req, syncReq)) return denied(req);

    const linked = await resolveLinkedArtifact(this, req);
    if (linked === 'hash_mismatch') {
      return encodeResponse({ ...responseBase(req), hashMismatch: true });
    }
    if (!linked) {
      return encodeResponse({ ...responseBase(req), unavailable: true });
    }

    const store = this.config.importedArtifactByteStore;
    if (!store) return encodeResponse({ ...responseBase(req), unavailable: true });
    const stat = await store.stat(linked.hash);
    if (!stat) return encodeResponse({ ...responseBase(req), unavailable: true });
    const bytes = await store.readRange(linked.hash, req.offset, req.maxBytes);
    if (!bytes) return encodeResponse({ ...responseBase(req), unavailable: true });
    const nextOffset = req.offset + bytes.byteLength;
    const truncated = nextOffset < stat.size;
    return encodeResponse({
      version: 1,
      contextGraphId: req.contextGraphId,
      assertionUri: req.assertionUri,
      kind: req.kind,
      hash: linked.hash,
      offset: req.offset,
      totalBytes: stat.size,
      nextOffset: truncated ? nextOffset : undefined,
      truncated,
      contentType: linked.contentType,
      bytesB64: Buffer.from(bytes).toString('base64'),
    });
  }

  async readAssertionArtifact(this: DKGAgent, params: ReadAssertionArtifactParams): Promise<ImportedArtifactResponse> {
    const range = normalizeRange(params.offset, params.maxBytes);
    if (!range) throw new Error('Invalid artifact byte range');
    const selector = computeImportedArtifactSelector({
      version: 1,
      contextGraphId: params.contextGraphId,
      assertionUri: params.assertionUri,
      kind: params.kind,
      hash: params.hash,
      offset: range.offset,
      maxBytes: range.maxBytes,
      subGraphName: params.subGraphName,
    });
    const needsAuth = !await isPublicOpenContextGraph(this, params.contextGraphId);
    const claimedAgentAddress = needsAuth
      ? await this.findLocalAgentForContextGraph(params.contextGraphId)
      : undefined;
    const claimedAgent = claimedAgentAddress ? this.localAgents.get(claimedAgentAddress) : undefined;
    const auth = needsAuth
      ? await buildSyncRequestEnvelope({
          contextGraphId: params.contextGraphId,
          offset: 0,
          limit: 1,
          includeSharedMemory: false,
          targetPeerId: params.sourcePeerId,
          requesterPeerId: this.peerId,
          needsAuth,
          authPurpose: IMPORTED_ARTIFACT_AUTH_PURPOSE,
          authSelector: selector,
          computeSyncDigest: this.computeSyncDigest.bind(this),
          getIdentityId: () => this.chain.getIdentityId(),
          signMessage: typeof this.chain.signMessage === 'function' ? this.chain.signMessage.bind(this.chain) : undefined,
          claimedAgentAddress,
          claimedAgentPrivateKey: claimedAgent?.privateKey,
        })
      : new TextEncoder().encode(JSON.stringify({
          contextGraphId: params.contextGraphId,
          offset: 0,
          limit: 1,
          includeSharedMemory: false,
          targetPeerId: params.sourcePeerId,
          requesterPeerId: this.peerId,
          authPurpose: IMPORTED_ARTIFACT_AUTH_PURPOSE,
          authSelector: selector,
        } satisfies SyncRequestEnvelope));
    const req: ImportedArtifactRequest = {
      version: 1,
      contextGraphId: params.contextGraphId,
      assertionUri: params.assertionUri,
      kind: params.kind,
      hash: params.hash,
      offset: range.offset,
      maxBytes: range.maxBytes,
      ...(params.subGraphName ? { subGraphName: params.subGraphName } : {}),
      authB64: Buffer.from(auth).toString('base64'),
    };
    const responseBytes = await this.sendToPeer(
      params.sourcePeerId,
      PROTOCOL_GET_ASSERTION_ARTIFACT,
      new TextEncoder().encode(JSON.stringify(req)),
      { timeoutMs: Math.max(SYNC_PAGE_TIMEOUT_MS, SYNC_AUTH_MAX_AGE_MS) },
    );
    return decodeResponse(responseBytes);
  }

  async fetchAndVerifyAssertionArtifact(this: DKGAgent, params: ReadAssertionArtifactParams): Promise<{
    response: ImportedArtifactResponse;
    verifiedBytes?: Buffer;
  }> {
    const requestedRange = normalizeRange(params.offset, params.maxBytes);
    if (!requestedRange) throw new Error('Invalid artifact byte range');

    const first = await this.readAssertionArtifact({
      ...params,
      offset: 0,
      maxBytes: IMPORTED_ARTIFACT_MAX_PAGE_BYTES,
    });
    if (first.denied || first.unavailable || first.hashMismatch || first.bytesB64 == null) {
      return { response: first };
    }
    const total = first.totalBytes;
    if (!params.cache || total == null || total > IMPORTED_ARTIFACT_MAX_CACHE_BYTES) {
      if (total == null || total > IMPORTED_ARTIFACT_MAX_CACHE_BYTES) {
        return { response: { ...first, bytesB64: undefined, unavailable: true } };
      }
    }
    if (first.offset !== 0 || first.hash !== params.hash) {
      return { response: { ...first, bytesB64: undefined, hashMismatch: true } };
    }
    const chunks = [Buffer.from(first.bytesB64, 'base64')];
    let nextOffset = first.nextOffset;
    while (first.truncated && nextOffset != null && nextOffset < total) {
      const requestedOffset = nextOffset;
      const page = await this.readAssertionArtifact({
        ...params,
        offset: requestedOffset,
        maxBytes: IMPORTED_ARTIFACT_MAX_PAGE_BYTES,
      });
      if (page.denied || page.unavailable || page.hashMismatch || page.bytesB64 == null) {
        return { response: page };
      }
      if (
        page.offset !== requestedOffset ||
        page.hash !== params.hash ||
        (page.totalBytes != null && page.totalBytes !== total) ||
        (page.truncated && (page.nextOffset == null || page.nextOffset <= requestedOffset || page.nextOffset > total))
      ) {
        return { response: { ...page, bytesB64: undefined, hashMismatch: true } };
      }
      chunks.push(Buffer.from(page.bytesB64, 'base64'));
      nextOffset = page.nextOffset;
      if (!page.truncated) break;
    }
    const assembled = Buffer.concat(chunks);
    if (assembled.length !== total || !verifyBytesHash(params.hash, assembled)) {
      return { response: { ...first, bytesB64: undefined, hashMismatch: true } };
    }
    const pageBytes = assembled.subarray(
      Math.min(requestedRange.offset, assembled.length),
      Math.min(requestedRange.offset + requestedRange.maxBytes, assembled.length),
    );
    const pageNextOffset = requestedRange.offset + pageBytes.length;
    const pageTruncated = pageNextOffset < assembled.length;
    return {
      response: {
        ...first,
        offset: requestedRange.offset,
        totalBytes: total,
        nextOffset: pageTruncated ? pageNextOffset : undefined,
        truncated: pageTruncated,
        bytesB64: pageBytes.toString('base64'),
      },
      verifiedBytes: assembled,
    };
  }
}
