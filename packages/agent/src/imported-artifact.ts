import { ethers } from 'ethers';
import {
  createOperationContext,
  IMPORTED_ARTIFACT_MAX_PAGE_BYTES,
  ImportedArtifactMetadataError,
  isSafeIri,
  isDkgContentHash,
  PROTOCOL_GET_ASSERTION_ARTIFACT,
  resolveImportedArtifactMetadata,
  validateContextGraphId,
  validateSubGraphName,
  verifyDkgContentHash,
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

export const IMPORTED_ARTIFACT_AUTH_PURPOSE = 'imported-artifact:v1';
const IMPORTED_ARTIFACT_MAX_CACHE_BYTES = 64 * 1024 * 1024;
export { IMPORTED_ARTIFACT_MAX_PAGE_BYTES, PROTOCOL_GET_ASSERTION_ARTIFACT };

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
  /**
   * Local agent that owns the imported assertion being read. Private artifact
   * reads must be signed by this assertion owner, not by the generic CG sync
   * signer, because the responder authorizes the recovered signer against the
   * assertion owner embedded in the assertion URI.
   */
  requestingAgentAddress?: string;
}

export interface AssertionArtifactAvailabilityParams {
  contextGraphId: string;
  assertionUri: string;
  kind: AssertionArtifactKind;
  hash: string;
  subGraphName?: string;
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

function unavailableResponse(fallback: Omit<ImportedArtifactResponse, 'version'>): ImportedArtifactResponse {
  return {
    version: 1,
    contextGraphId: fallback.contextGraphId,
    assertionUri: fallback.assertionUri,
    kind: fallback.kind,
    hash: fallback.hash,
    offset: fallback.offset,
    unavailable: true,
  };
}

function isSafeIntegerField(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isValidBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

function decodeResponse(
  data: Uint8Array,
  fallback: Omit<ImportedArtifactResponse, 'version'>,
): ImportedArtifactResponse {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
  } catch {
    return unavailableResponse(fallback);
  }
  const kind = normalizeKind(parsed.kind);
  const contextGraphId = typeof parsed.contextGraphId === 'string' ? parsed.contextGraphId.trim() : '';
  const assertionUri = typeof parsed.assertionUri === 'string' ? parsed.assertionUri.trim() : '';
  const hash = typeof parsed.hash === 'string' ? parsed.hash.trim() : '';
  if (
    parsed.version !== 1 ||
    !kind ||
    !contextGraphId ||
    !assertionUri ||
    !hash ||
    !isDkgContentHash(hash) ||
    !isSafeIntegerField(parsed.offset)
  ) {
    return unavailableResponse(fallback);
  }
  const response: ImportedArtifactResponse = {
    version: 1,
    contextGraphId,
    assertionUri,
    kind,
    hash,
    offset: parsed.offset,
  };
  if (parsed.totalBytes !== undefined) {
    if (!isSafeIntegerField(parsed.totalBytes)) return unavailableResponse(fallback);
    response.totalBytes = parsed.totalBytes;
  }
  if (parsed.nextOffset !== undefined) {
    if (!isSafeIntegerField(parsed.nextOffset)) return unavailableResponse(fallback);
    response.nextOffset = parsed.nextOffset;
  }
  if (parsed.truncated !== undefined) {
    if (typeof parsed.truncated !== 'boolean') return unavailableResponse(fallback);
    response.truncated = parsed.truncated;
  }
  if (parsed.contentType !== undefined) {
    if (typeof parsed.contentType !== 'string') return unavailableResponse(fallback);
    response.contentType = parsed.contentType;
  }
  if (parsed.denied !== undefined) {
    if (typeof parsed.denied !== 'string') return unavailableResponse(fallback);
    response.denied = parsed.denied;
  }
  if (parsed.unavailable !== undefined) {
    if (typeof parsed.unavailable !== 'boolean') return unavailableResponse(fallback);
    response.unavailable = parsed.unavailable;
  }
  if (parsed.hashMismatch !== undefined) {
    if (typeof parsed.hashMismatch !== 'boolean') return unavailableResponse(fallback);
    response.hashMismatch = parsed.hashMismatch;
  }
  if (parsed.bytesB64 !== undefined) {
    if (typeof parsed.bytesB64 !== 'string' || !isValidBase64(parsed.bytesB64)) {
      return unavailableResponse(fallback);
    }
    response.bytesB64 = parsed.bytesB64;
  }
  return response;
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
  if (!validateContextGraphId(contextGraphId).valid || !isSafeIri(assertionUri) || !isDkgContentHash(hash)) return null;
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

function findLocalAgentSigningAddress(
  localAgents: ReadonlyMap<string, unknown>,
  requestedAddress: string | undefined,
): string | undefined {
  if (!requestedAddress) return undefined;
  const requested = comparableAgentAddress(requestedAddress);
  for (const [localAddress] of localAgents) {
    if (comparableAgentAddress(localAddress) === requested) return localAddress;
  }
  return undefined;
}

type ParsedImportedAssertionUri = {
  assertionAgentAddress: string;
  assertionName: string;
  subGraphName?: string;
  legacy?: boolean;
};

function parseImportedAssertionUri(
  assertionUri: string,
  contextGraphId: string,
  legacyAssertionAgentAddress?: string,
): ParsedImportedAssertionUri | null {
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

function canonicalImportedAssertionUri(
  contextGraphId: string,
  parsed: ParsedImportedAssertionUri,
): string {
  const base = `did:dkg:context-graph:${contextGraphId}`;
  const scoped = parsed.subGraphName ? `${base}/${parsed.subGraphName}` : base;
  return `${scoped}/assertion/${parsed.assertionAgentAddress}/${parsed.assertionName}`;
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

function hasSelectorBoundRequesterProof(
  agent: DKGAgent,
  syncReq: SyncRequestEnvelope,
): boolean {
  if (
    !syncReq.requesterAgentAddress ||
    !syncReq.targetPeerId ||
    !syncReq.requesterPeerId ||
    !syncReq.requestId ||
    syncReq.issuedAtMs == null ||
    !syncReq.requesterSignatureR ||
    !syncReq.requesterSignatureVS
  ) {
    return false;
  }

  try {
    const digest = agent.computeSyncDigest(
      syncReq.contextGraphId,
      syncReq.offset,
      syncReq.limit,
      syncReq.includeSharedMemory,
      syncReq.targetPeerId,
      syncReq.requesterPeerId,
      syncReq.requestId,
      syncReq.issuedAtMs,
      syncReq.requesterAgentAddress,
      syncReq.authPurpose,
      syncReq.authSelector,
    );
    const recoveredAddress = ethers.recoverAddress(ethers.hashMessage(digest), {
      r: syncReq.requesterSignatureR,
      yParityAndS: syncReq.requesterSignatureVS,
    });
    return isSameAgentAddress(recoveredAddress, syncReq.requesterAgentAddress);
  } catch {
    return false;
  }
}

async function resolveImportedArtifactReadSubject(
  agent: DKGAgent,
  req: ImportedArtifactRequest,
  syncReq: SyncRequestEnvelope,
): Promise<{ assertionUri: string; subGraphName?: string } | null> {
  const parsedAssertion = parseImportedAssertionUri(
    req.assertionUri,
    req.contextGraphId,
    syncReq.requesterAgentAddress,
  );
  if (!parsedAssertion) return null;
  if (req.subGraphName && req.subGraphName !== parsedAssertion.subGraphName) return null;

  if (!parsedAssertion.legacy && await isPublicOpenContextGraph(agent, req.contextGraphId)) {
    return {
      assertionUri: canonicalImportedAssertionUri(req.contextGraphId, parsedAssertion),
      ...(parsedAssertion.subGraphName ? { subGraphName: parsedAssertion.subGraphName } : {}),
    };
  }

  const ownerAllowed = Boolean(
    syncReq.requesterAgentAddress &&
    isSameAgentAddress(parsedAssertion.assertionAgentAddress, syncReq.requesterAgentAddress) &&
    hasSelectorBoundRequesterProof(agent, syncReq),
  );
  if (!ownerAllowed) return null;
  return {
    assertionUri: canonicalImportedAssertionUri(req.contextGraphId, parsedAssertion),
    ...(parsedAssertion.subGraphName ? { subGraphName: parsedAssertion.subGraphName } : {}),
  };
}

async function resolveLinkedArtifact(agent: DKGAgent, args: {
  contextGraphId: string;
  assertionUri: string;
  kind: AssertionArtifactKind;
  hash?: string;
  subGraphName?: string;
}): Promise<{ hash: string; contentType?: string } | null | 'hash_mismatch'> {
  let metadata: Awaited<ReturnType<typeof resolveImportedArtifactMetadata>>;
  try {
    metadata = await resolveImportedArtifactMetadata({
      contextGraphId: args.contextGraphId,
      assertionUri: args.assertionUri,
      ...(args.subGraphName ? { subGraphName: args.subGraphName } : {}),
      allowSharedMemoryFallback: true,
      query: (sparql: string) => agent.store.query(sparql) as Promise<{ type?: string; bindings?: Array<Record<string, unknown>> }>,
    });
  } catch (err) {
    if (err instanceof ImportedArtifactMetadataError) return null;
    throw err;
  }

  const linkedHash = args.kind === 'markdown'
    ? metadata.markdownHash
    : metadata.sourceFileHash;
  if (!linkedHash) return null;
  if (args.hash && args.hash !== linkedHash) return 'hash_mismatch';
  return {
    hash: linkedHash,
    contentType: args.kind === 'markdown' ? 'text/markdown' : metadata.sourceContentType,
  };
}

export class ImportedArtifactMethods extends DKGAgentBase {
  registerImportedArtifactByteStore(this: DKGAgent, store: ImportedArtifactByteStore): void {
    this.config.importedArtifactByteStore = store;
    this.router.register(
      PROTOCOL_GET_ASSERTION_ARTIFACT,
      (data, peerIdObj) => this.handleGetImportedArtifact(data, peerIdObj.toString()),
    );
  }

  async hasLocalAssertionArtifact(this: DKGAgent, params: AssertionArtifactAvailabilityParams): Promise<boolean> {
    const linked = await resolveLinkedArtifact(this, params);
    if (linked === 'hash_mismatch' || !linked) return false;
    const store = this.config.importedArtifactByteStore;
    if (!store) return false;
    const stat = await store.stat(linked.hash);
    return Boolean(stat);
  }

  async discoverAssertionArtifactCandidates(this: DKGAgent, _params: AssertionArtifactAvailabilityParams): Promise<string[]> {
    const rawPeers = this.node?.libp2p?.getPeers?.() ?? [];
    const peers = rawPeers
      .map((peer: unknown) => peer?.toString?.() ?? String(peer))
      .filter((peerId: string) => peerId && peerId !== this.peerId);
    const uniquePeers = [...new Set(peers)];
    if (typeof this.getPeerProtocols !== 'function') return uniquePeers;
    const candidates = await Promise.all(uniquePeers.map(async (peerId) => {
      const protocols = await this.getPeerProtocols(peerId).catch((): string[] => []);
      return protocols.includes(PROTOCOL_GET_ASSERTION_ARTIFACT) ? peerId : null;
    }));
    return candidates.filter((peerId): peerId is string => Boolean(peerId));
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
    const readSubject = await resolveImportedArtifactReadSubject(this, req, syncReq);
    if (!readSubject) return denied(req);

    const linked = await resolveLinkedArtifact(this, {
      contextGraphId: req.contextGraphId,
      assertionUri: readSubject.assertionUri,
      kind: req.kind,
      hash: req.hash,
      subGraphName: readSubject.subGraphName,
    });
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
    const rawBytes = await store.readRange(linked.hash, req.offset, req.maxBytes);
    if (!rawBytes) return encodeResponse({ ...responseBase(req), unavailable: true });
    const expectedLength = Math.min(req.maxBytes, Math.max(0, stat.size - req.offset));
    const bytes = rawBytes.byteLength > expectedLength
      ? rawBytes.subarray(0, expectedLength)
      : rawBytes;
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
    const parsedAssertion = parseImportedAssertionUri(
      params.assertionUri,
      params.contextGraphId,
      params.requestingAgentAddress,
    );
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
    const assertionOwnerAddress = params.requestingAgentAddress ?? parsedAssertion?.assertionAgentAddress;
    const claimedAgentAddress = needsAuth
      ? findLocalAgentSigningAddress(this.localAgents, assertionOwnerAddress)
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
          forceClaimedAgentSignature: true,
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
    return decodeResponse(responseBytes, {
      contextGraphId: params.contextGraphId,
      assertionUri: params.assertionUri,
      kind: params.kind,
      hash: params.hash,
      offset: range.offset,
    });
  }

  async fetchAndVerifyAssertionArtifact(this: DKGAgent, params: ReadAssertionArtifactParams): Promise<{
    response: ImportedArtifactResponse;
    verifiedBytes?: Buffer;
  }> {
    const requestedRange = normalizeRange(params.offset, params.maxBytes);
    if (!requestedRange) throw new Error('Invalid artifact byte range');

    const readRequestedPage = async (): Promise<{ response: ImportedArtifactResponse }> => {
      const page = await this.readAssertionArtifact({
        ...params,
        offset: requestedRange.offset,
        maxBytes: requestedRange.maxBytes,
      });
      if (page.denied || page.unavailable || page.hashMismatch || page.bytesB64 == null) {
        return { response: page };
      }
      if (
        page.offset !== requestedRange.offset ||
        page.hash !== params.hash ||
        (page.totalBytes != null && page.offset + Buffer.byteLength(page.bytesB64, 'base64') > page.totalBytes) ||
        (page.truncated && (page.nextOffset == null || page.nextOffset <= page.offset))
      ) {
        return { response: { ...page, bytesB64: undefined, hashMismatch: true } };
      }
      return { response: page };
    };

    if (!params.cache) {
      return readRequestedPage();
    }

    const first = await this.readAssertionArtifact({
      ...params,
      offset: 0,
      maxBytes: IMPORTED_ARTIFACT_MAX_PAGE_BYTES,
    });
    if (first.denied || first.unavailable || first.hashMismatch || first.bytesB64 == null) {
      return { response: first };
    }
    const total = first.totalBytes;
    if (total == null || total > IMPORTED_ARTIFACT_MAX_CACHE_BYTES) {
      return readRequestedPage();
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
    if (assembled.length !== total || !verifyDkgContentHash(params.hash, assembled)) {
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
