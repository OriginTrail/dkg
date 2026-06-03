// SPDX-License-Identifier: Apache-2.0

/**
 * Imported-artifact byte request subsystem. Kept as a focused mixin so the
 * DKGAgent facade remains aligned with the post-main split architecture.
 */
import { createHash } from 'node:crypto';
import { ethers } from 'ethers';
import {
  PROTOCOL_IMPORTED_ARTIFACT_BYTES,
  IMPORTED_ARTIFACT_BYTE_KIND_SOURCE,
  IMPORTED_ARTIFACT_BYTE_KIND_ORIGINAL,
  IMPORTED_ARTIFACT_BYTE_KIND_MARKDOWN,
  IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS,
  contextGraphSharedMemoryUri,
  contextGraphMetaUri,
  assertSafeIri,
  createOperationContext,
  encodeImportedArtifactBytesRequest,
  decodeImportedArtifactBytesRequest,
  encodeImportedArtifactBytesResponse,
  decodeImportedArtifactBytesResponse,
  type ImportedArtifactBytesRequestMsg,
  type ImportedArtifactBytesResponseMsg,
} from '@origintrail-official/dkg-core';
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';

const IMPORTED_ARTIFACT_BYTES_REQUEST_TIMEOUT_MS = 5_000;
const IMPORTED_ARTIFACT_BYTES_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const IMPORTED_ARTIFACT_BYTE_KINDS = new Set<string>([
  IMPORTED_ARTIFACT_BYTE_KIND_SOURCE,
  IMPORTED_ARTIFACT_BYTE_KIND_ORIGINAL,
  IMPORTED_ARTIFACT_BYTE_KIND_MARKDOWN,
]);
const IMPORTED_ARTIFACT_LEGACY_DKG_NAMESPACES = [
  'http://dkg.io/ontology/',
  'https://dkg.network/ontology#',
];

export interface ImportedArtifactByteStore {
  get(hash: string): Promise<Uint8Array | Buffer | null>;
}

type ImportedArtifactByteState = {
  importedArtifactByteStore?: ImportedArtifactByteStore;
};

function importedArtifactComparableAgentAddress(value: string): string {
  const trimmed = value.trim();
  const unwrapped = trimmed.startsWith('did:dkg:agent:')
    ? trimmed.slice('did:dkg:agent:'.length)
    : trimmed;
  return /^0x[0-9a-fA-F]{40}$/.test(unwrapped) ? unwrapped.toLowerCase() : unwrapped;
}

function sameImportedArtifactAgentAddress(left: string | undefined, right: string): boolean {
  if (!left) return false;
  return left === right || importedArtifactComparableAgentAddress(left) === importedArtifactComparableAgentAddress(right);
}

function normalizeImportedArtifactHash(hash: string): string {
  const lower = hash.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(lower) ? `sha256:${lower}` : lower;
}

function validateImportedArtifactHash(hash: string): boolean {
  return /^(?:sha256:|keccak256:)?[0-9a-f]{64}$/i.test(hash.trim());
}

function hashFromImportedArtifactFileUrn(value: string | undefined): string | undefined {
  const prefix = 'urn:dkg:file:';
  if (!value?.startsWith(prefix)) return undefined;
  const hash = value.slice(prefix.length);
  return validateImportedArtifactHash(hash) ? hash : undefined;
}

function normalizeImportedArtifactBinding(cell: unknown): string {
  if (typeof cell !== 'string') return '';
  const trimmed = cell.replace(/^<|>$/g, '').trim();
  const literal = /^"([^"]*)"/.exec(trimmed);
  return literal ? literal[1] : trimmed;
}

function importedArtifactActualHashes(bytes: Uint8Array): string[] {
  const buffer = Buffer.from(bytes);
  return [
    `sha256:${createHash('sha256').update(buffer).digest('hex')}`,
    `keccak256:${ethers.keccak256(buffer).replace(/^0x/, '')}`,
  ];
}

export class ImportedArtifactByteMethods extends DKGAgentBase {
  setImportedArtifactByteStore(this: DKGAgent, store: ImportedArtifactByteStore | null | undefined): void {
    (this as unknown as ImportedArtifactByteState).importedArtifactByteStore = store ?? undefined;
  }

  async resolveImportedArtifactBytePeerId(this: DKGAgent, agentAddress: string): Promise<string | null> {
    const agents = await this.discovery.findAgents();
    const match = agents.find((agent) => sameImportedArtifactAgentAddress(agent.agentAddress, agentAddress));
    return match?.peerId ?? null;
  }

  async requestImportedArtifactBytesFromPeer(
    this: DKGAgent,
    peerId: string,
    request: ImportedArtifactBytesRequestMsg,
    opts: { timeoutMs?: number } = {},
  ): Promise<ImportedArtifactBytesResponseMsg> {
    const payload = encodeImportedArtifactBytesRequest(request);
    const sendResult = await this.messenger.sendReliable(
      peerId,
      PROTOCOL_IMPORTED_ARTIFACT_BYTES,
      payload,
      {
        timeoutMs: opts.timeoutMs ?? IMPORTED_ARTIFACT_BYTES_REQUEST_TIMEOUT_MS,
        maxAgeMs: opts.timeoutMs ?? IMPORTED_ARTIFACT_BYTES_REQUEST_TIMEOUT_MS,
      },
    );
    if (!sendResult.delivered) {
      throw new Error(`imported-artifact byte request was queued: ${sendResult.error}`);
    }
    return decodeImportedArtifactBytesResponse(sendResult.response);
  }

  importedArtifactBytesResponse(
    this: DKGAgent,
    request: ImportedArtifactBytesRequestMsg,
    status: ImportedArtifactBytesResponseMsg['status'],
    extra: Partial<ImportedArtifactBytesResponseMsg> = {},
  ): Uint8Array {
    return encodeImportedArtifactBytesResponse({
      status,
      hash: request.hash,
      kind: request.kind,
      bytes: new Uint8Array(0),
      ...extra,
    });
  }

  async resolveImportedArtifactHashLink(
    this: DKGAgent,
    request: ImportedArtifactBytesRequestMsg,
  ): Promise<{ linked: boolean; contentType?: string }> {
    const swmGraph = assertSafeIri(contextGraphSharedMemoryUri(
      request.contextGraphId,
      request.subGraphName?.trim() ? request.subGraphName.trim() : undefined,
    ));
    const metaGraph = assertSafeIri(contextGraphMetaUri(request.contextGraphId));
    const assertionUri = assertSafeIri(request.assertionUri);
    const patterns = IMPORTED_ARTIFACT_LEGACY_DKG_NAMESPACES.flatMap((ns) => [
      `GRAPH <${swmGraph}> {
        <${assertionUri}> <${ns}sourceFile> ?sourceFile .
        OPTIONAL { <${assertionUri}> <${ns}sourceContentType> ?sourceContentType }
        OPTIONAL { <${assertionUri}> <${ns}markdownForm> ?markdownForm }
      }`,
      `GRAPH <${metaGraph}> {
        <${assertionUri}> <${ns}sourceFileHash> ?sourceFileHash .
        OPTIONAL { <${assertionUri}> <${ns}sourceContentType> ?sourceContentType }
        OPTIONAL { <${assertionUri}> <${ns}mdIntermediateHash> ?mdIntermediateHash }
      }`,
    ]);
    const result = await this.store.query(
      `SELECT ?sourceFile ?sourceContentType ?markdownForm ?sourceFileHash ?mdIntermediateHash WHERE {
        ${patterns.map((pattern) => `{ ${pattern} }`).join(' UNION ')}
      } LIMIT 20`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return { linked: false };
    const requested = normalizeImportedArtifactHash(request.hash);
    for (const row of result.bindings as Array<Record<string, unknown>>) {
      const sourceContentType = normalizeImportedArtifactBinding(row.sourceContentType);
      const sourceHashes = [
        hashFromImportedArtifactFileUrn(normalizeImportedArtifactBinding(row.sourceFile)),
        normalizeImportedArtifactBinding(row.sourceFileHash),
      ].filter((hash): hash is string => Boolean(hash));
      if (sourceHashes.some((hash) => normalizeImportedArtifactHash(hash) === requested)) {
        return {
          linked: true,
          contentType: sourceContentType || (
            request.kind === IMPORTED_ARTIFACT_BYTE_KIND_MARKDOWN ? 'text/markdown' : 'application/octet-stream'
          ),
        };
      }
      const markdownHashes = [
        hashFromImportedArtifactFileUrn(normalizeImportedArtifactBinding(row.markdownForm)),
        normalizeImportedArtifactBinding(row.mdIntermediateHash),
      ].filter((hash): hash is string => Boolean(hash));
      if (markdownHashes.some((hash) => normalizeImportedArtifactHash(hash) === requested)) {
        return { linked: true, contentType: 'text/markdown' };
      }
    }
    return { linked: false };
  }

  async handleImportedArtifactBytesRequest(
    this: DKGAgent,
    data: Uint8Array,
    fromPeerId: string,
  ): Promise<Uint8Array> {
    const ctx = createOperationContext('query');
    const request = decodeImportedArtifactBytesRequest(data);
    if (!IMPORTED_ARTIFACT_BYTE_KINDS.has(request.kind)) {
      return this.importedArtifactBytesResponse(
        request,
        IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.DENY,
        { reason: `unsupported imported-artifact byte kind: ${request.kind}` },
      );
    }
    if (!validateImportedArtifactHash(request.hash)) {
      return this.importedArtifactBytesResponse(
        request,
        IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.DENY,
        { reason: 'requested hash is malformed' },
      );
    }

    const policy: { accessPolicy?: number; publishPolicy?: number } = await this
      .getContextGraphOnChainPolicy(request.contextGraphId)
      .catch(() => ({}));
    if (policy.accessPolicy !== 0 || policy.publishPolicy !== 1) {
      return this.importedArtifactBytesResponse(
        request,
        IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.DENY,
        { reason: 'context graph is not public + open' },
      );
    }

    const hashLink: { linked: boolean; contentType?: string } = await this
      .resolveImportedArtifactHashLink(request)
      .catch((err): { linked: boolean; contentType?: string } => {
        this.log.warn(
          ctx,
          `Imported-artifact byte request from ${fromPeerId.slice(-8)} failed metadata linkage check: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { linked: false };
      });
    if (!hashLink.linked) {
      return this.importedArtifactBytesResponse(
        request,
        IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.DENY,
        { reason: 'requested hash is not linked to the imported assertion' },
      );
    }

    const store = (this as unknown as ImportedArtifactByteState).importedArtifactByteStore;
    if (!store) {
      return this.importedArtifactBytesResponse(
        request,
        IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.MISS,
        { reason: 'imported-artifact byte store is not configured' },
      );
    }
    const bytes = await store.get(request.hash);
    if (!bytes) {
      return this.importedArtifactBytesResponse(
        request,
        IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.MISS,
        { reason: 'artifact bytes are not present on the origin peer' },
      );
    }
    if (bytes.length > IMPORTED_ARTIFACT_BYTES_MAX_RESPONSE_BYTES) {
      return this.importedArtifactBytesResponse(
        request,
        IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.DENY,
        { reason: `artifact bytes exceed ${IMPORTED_ARTIFACT_BYTES_MAX_RESPONSE_BYTES} bytes` },
      );
    }

    const actualHashes = importedArtifactActualHashes(bytes);
    const requested = normalizeImportedArtifactHash(request.hash);
    if (!actualHashes.includes(requested)) {
      return this.importedArtifactBytesResponse(
        request,
        IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.HASH_MISMATCH,
        {
          actualHash: actualHashes[1],
          reason: 'stored bytes do not match requested hash',
        },
      );
    }

    return this.importedArtifactBytesResponse(
      request,
      IMPORTED_ARTIFACT_BYTES_RESPONSE_STATUS.ALLOW,
      {
        bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
        contentType: hashLink.contentType ?? (
          request.kind === IMPORTED_ARTIFACT_BYTE_KIND_MARKDOWN ? 'text/markdown' : 'application/octet-stream'
        ),
        size: bytes.length,
      },
    );
  }
}
