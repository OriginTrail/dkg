// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import {
  PROTOCOL_GET_IMPORTED_SOURCE_BLOB,
  createOperationContext,
  contextGraphMetaUri,
  isSafeIri,
  validateContextGraphId,
  validateSubGraphName,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { buildSyncRequestEnvelope, type SyncRequestEnvelope } from './sync/auth/request-build.js';
import { authorizePrivateSyncRequest } from './sync/auth/request-authorize.js';
import { DKGAgentBase } from './dkg-agent-base.js';
import { SYNC_AUTH_MAX_AGE_MS } from './dkg-agent-constants.js';
import type { DKGAgent } from './dkg-agent.js';
import type {
  ImportedSourceBlobFetchInput,
  ImportedSourceBlobFetchResult,
  ImportedSourceBlobStore,
} from './dkg-agent-types.js';
import {
  IMPORTED_SOURCE_BLOB_WIRE_VERSION,
  decodeImportedSourceBlobRequest,
  decodeImportedSourceBlobResponse,
  encodeImportedSourceBlobRequest,
  encodeImportedSourceBlobResponse,
  normalizeImportedSourceBlobHash,
  type ImportedSourceBlobRequest,
} from './imported-source-blob-wire.js';

const DKG = 'http://dkg.io/ontology/';
const MAX_IMPORTED_SOURCE_BLOB_PAGE_BYTES = 5 * 1024 * 1024;
const IMPORTED_SOURCE_BLOB_AUTH_PURPOSE = 'imported-source-blob:v1';

function validateContentHash(hash: string): boolean {
  return /^(?:sha256:|keccak256:)?[0-9a-f]{64}$/i.test(hash);
}

function normalizeStoredContentHash(hash: string | undefined): string | undefined {
  if (!hash) return undefined;
  try {
    return normalizeImportedSourceBlobHash(hash);
  } catch {
    return undefined;
  }
}

function contentHashMatchesBytes(hash: string, bytes: Uint8Array): boolean {
  const lower = hash.toLowerCase();
  const buffer = Buffer.from(bytes);
  if (lower.startsWith('keccak256:')) {
    return ethers.keccak256(buffer).replace(/^0x/, '').toLowerCase() === lower.slice('keccak256:'.length);
  }
  const sha = createHash('sha256').update(buffer).digest('hex').toLowerCase();
  return sha === lower.replace(/^sha256:/, '');
}

function bindingCellValue(cell: unknown): string {
  if (typeof cell === 'string') return cell;
  if (cell && typeof cell === 'object' && 'value' in cell) {
    const value = (cell as { value?: unknown }).value;
    return typeof value === 'string' ? value : '';
  }
  return '';
}

function normalizeLiteralBinding(cell: unknown): string {
  return bindingCellValue(cell)
    .replace(/^"/, '')
    .replace(/"(@[a-zA-Z-]+|\^\^<[^>]+>)?$/, '')
    .trim();
}

function normalizeDetectedContentType(raw: string | undefined): string {
  const value = raw?.trim().toLowerCase();
  if (!value) return 'application/octet-stream';
  return value.split(';', 1)[0] || 'application/octet-stream';
}

function normalizeAgentAddressClaim(address: string | undefined): string | undefined {
  const value = address?.trim();
  if (!value) return undefined;
  return value.startsWith('did:dkg:agent:') ? value.slice('did:dkg:agent:'.length) : value;
}

function comparableAgentAddressClaim(address: string | undefined): string | undefined {
  const value = normalizeAgentAddressClaim(address);
  if (!value) return undefined;
  return /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : value;
}

function extractAssertionAgentAddress(contextGraphId: string, assertionUri: string): string | undefined {
  const prefix = `did:dkg:context-graph:${contextGraphId}/`;
  if (!assertionUri.startsWith(prefix)) return undefined;
  const rest = assertionUri.slice(prefix.length);
  const assertionPrefix = 'assertion/';
  const marker = '/assertion/';
  let assertionTail: string | undefined;
  if (rest.startsWith(assertionPrefix)) {
    assertionTail = rest.slice(assertionPrefix.length);
  } else {
    const markerIndex = rest.indexOf(marker);
    if (markerIndex >= 0) assertionTail = rest.slice(markerIndex + marker.length);
  }
  if (!assertionTail) return undefined;
  const slash = assertionTail.indexOf('/');
  if (slash <= 0) return undefined;
  return assertionTail.slice(0, slash);
}

function requesterOwnsAssertion(request: SyncRequestEnvelope, assertionUri: string): boolean {
  try {
    if (BigInt(request.requesterIdentityId ?? '0') !== 0n) return false;
  } catch {
    return false;
  }
  const assertionAgentAddress = extractAssertionAgentAddress(request.contextGraphId, assertionUri);
  const requesterAgentAddress = comparableAgentAddressClaim(request.requesterAgentAddress);
  const ownerAgentAddress = comparableAgentAddressClaim(assertionAgentAddress);
  return !!requesterAgentAddress && !!ownerAgentAddress && requesterAgentAddress === ownerAgentAddress;
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function bytesFromBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'base64'));
}

function computeImportedSourceBlobSelector(input: {
  assertionUri: string;
  blobHash: string;
  offset: number;
  maxBytes: number;
}): string {
  return ethers.solidityPackedKeccak256(
    ['uint256', 'string', 'string', 'uint256', 'uint256'],
    [
      BigInt(IMPORTED_SOURCE_BLOB_WIRE_VERSION),
      input.assertionUri,
      input.blobHash.toLowerCase(),
      BigInt(input.offset),
      BigInt(input.maxBytes),
    ],
  );
}

export class SourceBlobMethods extends DKGAgentBase {
  setImportedSourceBlobStore(this: DKGAgent, store: ImportedSourceBlobStore | undefined): void {
    this.importedSourceBlobStore = store;
  }

  async fetchImportedSourceBlobFromPeer(this: DKGAgent,
    remotePeerId: string,
    input: ImportedSourceBlobFetchInput,
  ): Promise<ImportedSourceBlobFetchResult> {
    const offset = input.offset ?? 0;
    const maxBytes = Math.min(input.maxBytes, MAX_IMPORTED_SOURCE_BLOB_PAGE_BYTES);
    if (!remotePeerId) throw new Error('fetchImportedSourceBlobFromPeer requires remotePeerId');
    if (!validateContentHash(input.blobHash)) throw new Error('fetchImportedSourceBlobFromPeer requires a valid blobHash');
    const blobHash = normalizeImportedSourceBlobHash(input.blobHash);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('fetchImportedSourceBlobFromPeer requires a non-negative offset');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('fetchImportedSourceBlobFromPeer requires a positive maxBytes');
    }
    const auth = await this.buildImportedSourceBlobAuthEnvelope(
      input.contextGraphId,
      remotePeerId,
      offset,
      maxBytes,
      input.assertionUri,
      blobHash,
      input.requestAgentAddress,
    );
    const req = encodeImportedSourceBlobRequest({
      version: IMPORTED_SOURCE_BLOB_WIRE_VERSION,
      contextGraphId: input.contextGraphId,
      assertionUri: input.assertionUri,
      blobHash,
      offset,
      maxBytes,
      ...(input.subGraphName ? { subGraphName: input.subGraphName } : {}),
      authB64: bytesToBase64(auth),
    });
    const responseBytes = await this.messenger.sendToPeer(
      remotePeerId,
      PROTOCOL_GET_IMPORTED_SOURCE_BLOB,
      req,
      { timeoutMs: input.timeoutMs ?? 15_000 },
    );
    const response = decodeImportedSourceBlobResponse(responseBytes);
    if (response.denied) {
      return { denied: response.denied };
    }
    if (
      response.contextGraphId !== input.contextGraphId ||
      response.assertionUri !== input.assertionUri ||
      response.blobHash !== blobHash ||
      response.offset !== offset
    ) {
      throw new Error('Imported source blob response does not match request');
    }
    let bytes = response.bytesB64 !== undefined ? bytesFromBase64(response.bytesB64) : undefined;
    if (bytes && bytes.length > maxBytes) {
      throw new Error(`Imported source blob response exceeds requested maxBytes (${maxBytes})`);
    }
    if (bytes !== undefined) {
      const responseEnd = offset + bytes.length;
      if (typeof response.totalBytes === 'number') {
        if (response.totalBytes < responseEnd) {
          throw new Error('Imported source blob response has inconsistent pagination metadata');
        }
        if (response.truncated === true && response.totalBytes <= responseEnd) {
          throw new Error('Imported source blob response has inconsistent pagination metadata');
        }
        if (response.truncated !== true && response.totalBytes !== responseEnd) {
          throw new Error('Imported source blob response has inconsistent pagination metadata');
        }
      }
      if (typeof response.nextOffset === 'number' && response.nextOffset !== responseEnd) {
        throw new Error('Imported source blob response has inconsistent pagination metadata');
      }
      const isCompleteOffsetZeroResponse = offset === 0 && response.truncated !== true;
      if (isCompleteOffsetZeroResponse && !contentHashMatchesBytes(blobHash, bytes)) {
        throw new Error('Imported source blob response hash mismatch');
      }
    }
    return {
      ...(typeof response.totalBytes === 'number' ? { totalBytes: response.totalBytes } : {}),
      ...(typeof response.nextOffset === 'number' ? { nextOffset: response.nextOffset } : {}),
      ...(response.truncated !== undefined ? { truncated: response.truncated } : {}),
      ...(bytes !== undefined ? { bytes } : {}),
    };
  }

  async buildImportedSourceBlobAuthEnvelope(this: DKGAgent,
    contextGraphId: string,
    responderPeerId: string,
    offset: number,
    limit: number,
    assertionUri: string,
    blobHash: string,
    requestAgentAddress?: string,
  ): Promise<Uint8Array> {
    const needsAuth = true;
    const requestedClaim = normalizeAgentAddressClaim(requestAgentAddress);
    const fallbackClaim = await this.findLocalAgentForContextGraph(contextGraphId);
    const claimedAgentAddress = requestedClaim ?? fallbackClaim;
    const localClaim = claimedAgentAddress
      ? this.resolveLocalAgentAddress(claimedAgentAddress)
      : undefined;
    const claimedAgent = localClaim ? this.localAgents.get(localClaim) : undefined;
    const canonicalBlobHash = normalizeImportedSourceBlobHash(blobHash);
    const useAgentKeySigner = !!claimedAgent?.privateKey;
    return buildSyncRequestEnvelope({
      contextGraphId,
      offset,
      limit,
      includeSharedMemory: true,
      targetPeerId: responderPeerId,
      requesterPeerId: this.peerId,
      phase: 'data',
      needsAuth,
      computeSyncDigest: this.computeSyncDigest.bind(this),
      getIdentityId: () => this.chain.getIdentityId(),
      signMessage: !useAgentKeySigner && typeof this.chain.signMessage === 'function'
        ? this.chain.signMessage.bind(this.chain)
        : undefined,
      claimedAgentAddress: localClaim ?? claimedAgentAddress,
      claimedAgentPrivateKey: claimedAgent?.privateKey,
      authPurpose: IMPORTED_SOURCE_BLOB_AUTH_PURPOSE,
      authSelector: computeImportedSourceBlobSelector({
        assertionUri,
        blobHash: canonicalBlobHash,
        offset,
        maxBytes: limit,
      }),
    });
  }

  validateImportedSourceBlobSignature(this: DKGAgent,
    request: SyncRequestEnvelope,
    remotePeerId: string,
  ): boolean {
    const now = Date.now();
    for (const [requestId, seenAt] of this.seenPrivateSyncRequestIds) {
      if (now - seenAt > SYNC_AUTH_MAX_AGE_MS) {
        this.seenPrivateSyncRequestIds.delete(requestId);
      }
    }

    let requesterIdentityId = 0n;
    try {
      requesterIdentityId = request.requesterIdentityId ? BigInt(request.requesterIdentityId) : 0n;
    } catch {
      return false;
    }

    if (
      request.targetPeerId !== this.peerId ||
      request.requesterPeerId !== remotePeerId ||
      !request.requestId ||
      request.issuedAtMs == null ||
      now - request.issuedAtMs > SYNC_AUTH_MAX_AGE_MS ||
      now < request.issuedAtMs - 5000 ||
      !request.requesterSignatureR ||
      !request.requesterSignatureVS ||
      this.seenPrivateSyncRequestIds.has(request.requestId)
    ) {
      return false;
    }
    if (requesterIdentityId === 0n && !request.requesterAgentAddress) {
      return false;
    }

    const digest = this.computeSyncDigest(
      request.contextGraphId,
      request.offset,
      request.limit,
      request.includeSharedMemory,
      request.targetPeerId,
      request.requesterPeerId,
      request.requestId,
      request.issuedAtMs,
      request.requesterAgentAddress,
      request.authPurpose,
      request.authSelector,
    );

    let recoveredAddress: string;
    try {
      recoveredAddress = ethers.recoverAddress(ethers.hashMessage(digest), {
        r: request.requesterSignatureR,
        yParityAndS: request.requesterSignatureVS,
      });
    } catch {
      return false;
    }

    if (requesterIdentityId === 0n) {
      return recoveredAddress.toLowerCase() === request.requesterAgentAddress!.toLowerCase();
    }

    const verifyIdentity = this.chain.verifySyncIdentity ?? this.chain.verifyACKIdentity;
    if (typeof verifyIdentity !== 'function') {
      return false;
    }
    return true;
  }

  async importedSourceBlobSignatureIdentityIsValid(this: DKGAgent,
    request: SyncRequestEnvelope,
  ): Promise<boolean> {
    let requesterIdentityId = 0n;
    try {
      requesterIdentityId = request.requesterIdentityId ? BigInt(request.requesterIdentityId) : 0n;
    } catch {
      return false;
    }
    if (requesterIdentityId === 0n) return true;
    const digest = this.computeSyncDigest(
      request.contextGraphId,
      request.offset,
      request.limit,
      request.includeSharedMemory,
      request.targetPeerId!,
      request.requesterPeerId!,
      request.requestId!,
      request.issuedAtMs!,
      request.requesterAgentAddress,
      request.authPurpose,
      request.authSelector,
    );
    let recoveredAddress: string;
    try {
      recoveredAddress = ethers.recoverAddress(ethers.hashMessage(digest), {
        r: request.requesterSignatureR!,
        yParityAndS: request.requesterSignatureVS!,
      });
    } catch {
      return false;
    }
    const verifyIdentity = this.chain.verifySyncIdentity ?? this.chain.verifyACKIdentity;
    return typeof verifyIdentity === 'function'
      ? verifyIdentity.call(this.chain, recoveredAddress, requesterIdentityId)
      : false;
  }

  async authorizeImportedSourceBlobRequest(this: DKGAgent,
    request: SyncRequestEnvelope,
    remotePeerId: string,
    assertionUri: string,
  ): Promise<boolean> {
    if (!this.validateImportedSourceBlobSignature(request, remotePeerId)) {
      return false;
    }
    if (!(await this.importedSourceBlobSignatureIdentityIsValid(request))) {
      return false;
    }

    const policy: { accessPolicy?: number; publishPolicy?: number } =
      await this.getContextGraphOnChainPolicy(request.contextGraphId).catch(() => ({}));
    if (requesterOwnsAssertion(request, assertionUri)) {
      this.seenPrivateSyncRequestIds.set(request.requestId!, Date.now());
      return true;
    }
    // Cross-agent source blob reads mirror the HTTP route relaxation: public + open only.
    if (policy.accessPolicy === 0 && policy.publishPolicy === 1) {
      this.seenPrivateSyncRequestIds.set(request.requestId!, Date.now());
      return true;
    }
    if (policy.accessPolicy === 0) return false;
    const verifyIdentity = this.chain.verifySyncIdentity ?? this.chain.verifyACKIdentity;
    return authorizePrivateSyncRequest({
      ctx: createOperationContext('sync'),
      request,
      remotePeerId,
      localPeerId: this.peerId,
      syncAuthMaxAgeMs: SYNC_AUTH_MAX_AGE_MS,
      seenRequestIds: this.seenPrivateSyncRequestIds,
      computeSyncDigest: this.computeSyncDigest.bind(this),
      verifyIdentity: typeof verifyIdentity === 'function' ? verifyIdentity.bind(this.chain) : undefined,
      getParticipants: (contextGraphId) => this.getPrivateContextGraphParticipants(contextGraphId),
      getAllowedPeers: (contextGraphId) => this.getContextGraphAllowedPeers(contextGraphId),
      getAgentGateAddresses: (contextGraphId) => this.getContextGraphAgentGateAddresses(contextGraphId),
      getAllowedDelegateePeers: (contextGraphId) => this.getContextGraphAllowedDelegateePeers(contextGraphId),
      getAllowedDelegateeKeys: (contextGraphId) => this.getContextGraphAllowedDelegateeKeys(contextGraphId),
      refreshMetaFromCurator: (contextGraphId) => this.refreshMetaFromCurator(contextGraphId),
      logWarn: (ctx, message) => this.log.warn(ctx, message),
      logInfo: (ctx, message) => this.log.info(ctx, message),
    }).catch(() => false);
  }

  async handleGetImportedSourceBlob(this: DKGAgent, data: Uint8Array, fromPeerId: string): Promise<Uint8Array> {
    let req: ImportedSourceBlobRequest;
    try {
      req = decodeImportedSourceBlobRequest(data);
    } catch (err) {
      return encodeImportedSourceBlobResponse({
        version: IMPORTED_SOURCE_BLOB_WIRE_VERSION,
        contextGraphId: '',
        assertionUri: '',
        blobHash: `keccak256:${'0'.repeat(64)}`,
        offset: 0,
        denied: `malformed request: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const deny = (reason: string) => encodeImportedSourceBlobResponse({
      version: IMPORTED_SOURCE_BLOB_WIRE_VERSION,
      contextGraphId: req.contextGraphId,
      assertionUri: req.assertionUri,
      blobHash: req.blobHash,
      offset: req.offset,
      denied: reason,
    });

    if (!validateContextGraphId(req.contextGraphId).valid) return deny('invalid contextGraphId');
    if (req.subGraphName && !validateSubGraphName(req.subGraphName).valid) return deny('invalid subGraphName');
    if (!isSafeIri(req.assertionUri)) return deny('invalid assertionUri');
    if (!this.importedSourceBlobStore) return deny('source blob store unavailable');

    let authEnvelope;
    try {
      authEnvelope = this.parseSyncRequest(bytesFromBase64(req.authB64));
    } catch {
      return deny('malformed auth envelope');
    }
    if (
      authEnvelope.contextGraphId !== req.contextGraphId ||
      authEnvelope.offset !== req.offset ||
      authEnvelope.limit !== req.maxBytes ||
      authEnvelope.includeSharedMemory !== true
    ) {
      return deny('auth envelope does not match source blob request');
    }
    const expectedSelector = computeImportedSourceBlobSelector({
      assertionUri: req.assertionUri,
      blobHash: req.blobHash,
      offset: req.offset,
      maxBytes: req.maxBytes,
    });
    if (
      authEnvelope.authPurpose !== IMPORTED_SOURCE_BLOB_AUTH_PURPOSE ||
      authEnvelope.authSelector !== expectedSelector
    ) {
      return deny('auth envelope does not bind source blob selector');
    }
    const authorized = await this.authorizeImportedSourceBlobRequest(authEnvelope, fromPeerId, req.assertionUri)
      .catch(() => false);
    if (!authorized) return deny('source blob request unauthorized');

    const referenced = await this.importedSourceBlobHashIsReferenced(req).catch(() => false);
    if (!referenced) return deny('source blob is not referenced by assertion metadata');

    if (!this.importedSourceBlobStore.stat || !this.importedSourceBlobStore.readRange) {
      return deny('source blob range store unavailable');
    }

    const info = await this.importedSourceBlobStore.stat(req.blobHash).catch(() => undefined);
    if (!info) return deny('source blob not found');
    const totalBytes = info.size;
    if (req.offset > totalBytes) return deny('offset exceeds blob length');
    const maxBytes = Math.min(req.maxBytes, MAX_IMPORTED_SOURCE_BLOB_PAGE_BYTES);
    const end = Math.min(totalBytes, req.offset + maxBytes);
    const stored = await this.importedSourceBlobStore.readRange(req.blobHash, req.offset, end - req.offset)
      .catch(() => undefined);
    if (!stored) return deny('source blob not found');
    const slice = Buffer.from(stored);
    return encodeImportedSourceBlobResponse({
      version: IMPORTED_SOURCE_BLOB_WIRE_VERSION,
      contextGraphId: req.contextGraphId,
      assertionUri: req.assertionUri,
      blobHash: req.blobHash,
      offset: req.offset,
      totalBytes,
      nextOffset: end,
      truncated: end < totalBytes,
      bytesB64: slice.toString('base64'),
    });
  }

  async importedSourceBlobHashIsReferenced(this: DKGAgent, req: ImportedSourceBlobRequest): Promise<boolean> {
    const hash = normalizeImportedSourceBlobHash(req.blobHash);
    const metaGraph = contextGraphMetaUri(req.contextGraphId);
    const metaResult = await this.store.query(`
      SELECT ?sourceFileHash ?sourceContentType ?mdIntermediateHash WHERE {
        GRAPH <${metaGraph}> {
          <${req.assertionUri}> <${DKG}sourceFileHash> ?sourceFileHash .
          OPTIONAL { <${req.assertionUri}> <${DKG}sourceContentType> ?sourceContentType }
          OPTIONAL { <${req.assertionUri}> <${DKG}mdIntermediateHash> ?mdIntermediateHash }
        }
      }
      LIMIT 1
    `);
    if (metaResult.type === 'bindings' && metaResult.bindings.length > 0) {
      const row = metaResult.bindings[0];
      const sourceFileHash = normalizeStoredContentHash(normalizeLiteralBinding(row.sourceFileHash));
      const sourceContentType = normalizeDetectedContentType(normalizeLiteralBinding(row.sourceContentType) || undefined);
      const mdIntermediateHash = normalizeStoredContentHash(normalizeLiteralBinding(row.mdIntermediateHash));
      if (mdIntermediateHash) return hash === mdIntermediateHash;
      if (sourceContentType === 'text/markdown' && hash === sourceFileHash) return true;
    }

    return false;
  }
}
