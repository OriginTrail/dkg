// daemon/routes/knowledge-assets-import.ts
//
// Collection-level import-artifact + semantic-enrichment routes for the
// GitHub-shaped Knowledge Asset HTTP surface. These are keyed by
// `assertionUri` in the body (no `:name` path segment) and mirror the
// legacy `/api/assertion/*` routes byte-for-byte:
//
//   POST /api/knowledge-assets/import-artifact/resolve
//        ↔ POST /api/assertion/import-artifact/resolve
//   POST /api/knowledge-assets/import-artifact/read-markdown
//        ↔ POST /api/assertion/import-artifact/read-markdown
//   POST /api/knowledge-assets/semantic-enrichment/write
//        ↔ POST /api/assertion/semantic-enrichment/write
//
// The handlers are ports of the corresponding blocks in
// `daemon/routes/assertion.ts`: identical validation, owner-guard,
// error mapping, response shape, and side-effects. Each reads + parses
// its own body. The shared logic lives in `./shared-assertion-helpers.js`.

import { randomUUID } from "node:crypto";
import {
  contextGraphAssertionUri,
  contextGraphMetaUri,
  assertionLifecycleUri,
  validateAssertionName,
  PayloadTooLargeError,
  assertQuadLiteralsMutf8Safe,
  IMPORTED_ARTIFACT_MAX_PAGE_BYTES,
  isDkgContentHash,
  verifyDkgContentHash,
} from "@origintrail-official/dkg-core";
import { findReservedSubjectPrefix, isSkolemizedUri, listAssertionScopedGraphUris } from "@origintrail-official/dkg-publisher";
import { deleteByPatternWithoutCount } from "@origintrail-official/dkg-storage";
import type { RequestContext } from "./context.js";
import {
  jsonResponse,
  readBody,
  readBodyBuffer,
  safeParseJson,
  safeDecodeURIComponent,
  validateOptionalSubGraphName,
  validateRequiredContextGraphId,
  normalizeContextGraphIdOrUri,
  resolveRequiredWriteContextGraphId,
  oversizedRdfLiteralResponseBody,
  SMALL_BODY_BYTES,
  MAX_UPLOAD_BYTES,
  type ImportFileExtractionPayload,
  buildImportFileResponse,
  unregisteredSubGraphError,
} from "../http-utils.js";
import {
  ImportArtifactRouteError,
  resolveImportedArtifact,
  handleImportArtifactRouteError,
  normalizeSemanticQuads,
  buildSemanticEnrichmentProvenanceQuads,
  normalizeGeneratedAt,
  normalizeGeneratedBy,
  normalizeMarkdownReadLimit,
  parseImportedAssertionUri,
  isSameAgentAddress,
  isContextGraphAuthorizedReadAgent,
  type ImportedArtifactResolution,
} from "./shared-assertion-helpers.js";
import { parseBoundary, parseMultipart, MultipartParseError } from "../../http/multipart.js";
import { normalizeDetectedContentType, inferContentTypeFromFilename } from "../manifest.js";
import { extractFromMarkdown } from "../../extraction/index.js";
import {
  type ExtractionStatusRecord,
  getExtractionStatusRecord,
  setExtractionStatusRecord,
} from "../../extraction-status.js";
import { SignedRequestRejectedError } from "../../auth.js";

type AssertionArtifactKind = 'source' | 'markdown' | 'original';

type AssertionArtifactResolution = ImportedArtifactResolution & {
  kind: AssertionArtifactKind;
  hash: string;
  contentType: string;
};

type AssertionArtifactFetchResult = Awaited<
  ReturnType<NonNullable<RequestContext['agent']['fetchAndVerifyAssertionArtifact']>>
>;

type AssertionArtifactRemoteResult =
  | {
      availability: 'verified';
      remote: AssertionArtifactFetchResult;
      sourcePeerId: string;
    }
  | {
      availability: 'unverified_page';
      remote: AssertionArtifactFetchResult;
      sourcePeerId: string;
    }
  | {
      availability: 'unavailable';
      remote: AssertionArtifactFetchResult;
      sourcePeerId: string;
    };

function normalizeAssertionArtifactKind(raw: unknown): AssertionArtifactKind {
  if (raw === 'source' || raw === 'markdown' || raw === 'original') return raw;
  throw new ImportArtifactRouteError(400, '"kind" must be one of "source", "markdown", or "original"');
}

function normalizeArtifactOffset(raw: unknown): number {
  if (raw == null) return 0;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw new ImportArtifactRouteError(400, '"offset" must be a non-negative integer');
  }
  return raw;
}

function normalizeArtifactReadLimit(raw: unknown): number {
  if (raw == null) return IMPORTED_ARTIFACT_MAX_PAGE_BYTES;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) {
    throw new ImportArtifactRouteError(400, '"maxBytes" must be a positive integer');
  }
  return Math.min(raw, IMPORTED_ARTIFACT_MAX_PAGE_BYTES);
}

function orderedArtifactCandidatePeers(sourcePeerId: string | undefined, discovered: string[]): string[] {
  const candidates: string[] = [];
  if (sourcePeerId) candidates.push(sourcePeerId);
  for (const peerId of discovered) {
    if (peerId && !candidates.includes(peerId)) candidates.push(peerId);
  }
  return candidates;
}

async function discoverArtifactCandidatePeers(
  agent: RequestContext['agent'],
  resolved: AssertionArtifactResolution,
): Promise<string[]> {
  if (typeof agent.discoverAssertionArtifactCandidates !== 'function') return [];
  return agent.discoverAssertionArtifactCandidates({
    contextGraphId: resolved.contextGraphId,
    assertionUri: resolved.assertionUri,
    kind: resolved.kind,
    hash: resolved.hash,
    ...(resolved.subGraphName ? { subGraphName: resolved.subGraphName } : {}),
  });
}

async function fetchFirstAvailableAssertionArtifact(
  agent: RequestContext['agent'],
  resolved: AssertionArtifactResolution,
  opts: {
    sourcePeerIds: string[];
    requesterAgentAddress: string;
    offset: number;
    maxBytes: number;
    cache: boolean;
  },
): Promise<AssertionArtifactRemoteResult | null> {
  if (typeof agent.fetchAndVerifyAssertionArtifact !== 'function') return null;
  let unverifiedFallback: AssertionArtifactRemoteResult | null = null;
  let failureFallback: AssertionArtifactRemoteResult | null = null;
  for (const sourcePeerId of opts.sourcePeerIds) {
    const remote = await agent.fetchAndVerifyAssertionArtifact({
      contextGraphId: resolved.contextGraphId,
      assertionUri: resolved.assertionUri,
      kind: resolved.kind,
      hash: resolved.hash,
      requestingAgentAddress: opts.requesterAgentAddress,
      offset: opts.offset,
      maxBytes: opts.maxBytes,
      ...(resolved.subGraphName ? { subGraphName: resolved.subGraphName } : {}),
      sourcePeerId,
      cache: opts.cache,
    });
    if (remote.verifiedBytes) return { availability: 'verified', remote, sourcePeerId };
    const page = remote.response;
    if (!page.denied && !page.unavailable && !page.hashMismatch && page.bytesB64 != null) {
      unverifiedFallback ??= { availability: 'unverified_page', remote, sourcePeerId };
      continue;
    }
    failureFallback ??= { availability: 'unavailable', remote, sourcePeerId };
  }
  return unverifiedFallback ?? failureFallback;
}

async function resolveAssertionArtifact(
  ctx: RequestContext,
  raw: Record<string, unknown>,
): Promise<AssertionArtifactResolution | 'hash_mismatch'> {
  const kind = normalizeAssertionArtifactKind(raw.kind);
  const requestedHash = typeof raw.hash === 'string' && raw.hash.trim()
    ? raw.hash.trim()
    : undefined;
  if (requestedHash && !isDkgContentHash(requestedHash)) {
    throw new ImportArtifactRouteError(400, 'Invalid hash');
  }

  let artifact: ImportedArtifactResolution;
  try {
    artifact = await resolveImportedArtifactForRead(
      ctx,
      {
        ...raw,
        fileHash: undefined,
      },
      'Import artifact bytes can only be read from imported assertions owned by the requesting agent',
      { allowSharedMemoryFallback: true },
    );
  } catch (err) {
    const directRemote = await resolveExplicitAuthorizedRemoteArtifact(ctx, raw, kind, requestedHash, err);
    if (directRemote) return directRemote;
    throw err;
  }

  const resolvedHash = kind === 'markdown'
    ? artifact.markdownHash
    : artifact.sourceFileHash;
  if (!resolvedHash) {
    throw new ImportArtifactRouteError(404, `No ${kind} artifact is linked to assertionUri`);
  }
  if (requestedHash && requestedHash !== resolvedHash) return 'hash_mismatch';

  return {
    ...artifact,
    kind,
    hash: resolvedHash,
    contentType: kind === 'markdown' ? 'text/markdown' : artifact.sourceContentType,
  };
}

async function resolveExplicitAuthorizedRemoteArtifact(
  ctx: RequestContext,
  raw: Record<string, unknown>,
  kind: AssertionArtifactKind,
  requestedHash: string | undefined,
  cause: unknown,
): Promise<AssertionArtifactResolution | null> {
  if (!isMissingImportMetadataError(cause)) return null;
  if (!requestedHash) return null;
  if (typeof raw.sourcePeerId !== 'string' || !raw.sourcePeerId.trim()) return null;
  if (typeof raw.contextGraphId !== 'string' || !raw.contextGraphId.trim()) return null;
  if (typeof raw.assertionUri !== 'string' || !raw.assertionUri.trim()) return null;

  const contextGraphId = normalizeContextGraphIdOrUri(raw.contextGraphId);
  const parsedAssertion = parseImportedAssertionUri(raw.assertionUri.trim(), contextGraphId, ctx.requestAgentAddress);
  if (!parsedAssertion) return null;
  if (typeof raw.subGraphName === 'string' && raw.subGraphName.trim() !== (parsedAssertion.subGraphName ?? '')) return null;
  const allowed = isSameAgentAddress(parsedAssertion.assertionAgentAddress, ctx.requestAgentAddress)
    || await isContextGraphAuthorizedReadAgent(ctx.agent, contextGraphId, ctx.requestAgentAddress);
  if (!allowed) return null;

  const sourceContentType = kind === 'markdown' ? 'text/markdown' : 'application/octet-stream';
  return {
    contextGraphId,
    assertionUri: contextGraphAssertionUri(
      contextGraphId,
      parsedAssertion.assertionAgentAddress,
      parsedAssertion.assertionName,
      parsedAssertion.subGraphName,
    ),
    assertionName: parsedAssertion.assertionName,
    assertionAgentAddress: parsedAssertion.assertionAgentAddress,
    ...(parsedAssertion.subGraphName ? { subGraphName: parsedAssertion.subGraphName } : {}),
    fileHash: requestedHash,
    sourceFileHash: requestedHash,
    detectedContentType: sourceContentType,
    sourceContentType,
    extractionStatus: 'completed',
    canReadMarkdown: kind === 'markdown',
    ...(kind === 'markdown' ? { markdownHash: requestedHash } : {}),
    kind,
    hash: requestedHash,
    contentType: sourceContentType,
  };
}

function isMissingImportMetadataError(err: unknown): boolean {
  return err instanceof ImportArtifactRouteError
    && err.statusCode === 404
    && /No completed import metadata found for assertionUri/i.test(err.message);
}

function importedArtifactReadOwnerGuard(
  ctx: RequestContext,
  message: string,
) {
  return {
    requestAgentAddress: ctx.requestAgentAddress,
    message,
    relaxOnPublicOpenCg: true,
    relaxOnAuthorizedReadCg: true,
  };
}

function resolveImportedArtifactForRead(
  ctx: RequestContext,
  raw: Record<string, unknown>,
  message: string,
  opts?: { allowSharedMemoryFallback?: boolean },
): Promise<ImportedArtifactResolution> {
  return resolveImportedArtifact(ctx, raw, importedArtifactReadOwnerGuard(ctx, message), opts);
}

// POST /api/knowledge-assets/import-artifact/resolve
// Resolve a completed deterministic import artifact from graph metadata.
export async function handleKaImportArtifactResolve(ctx: RequestContext): Promise<void> {
  const { req, res } = ctx;
  const body = await readBody(req, SMALL_BODY_BYTES);
  const parsed = safeParseJson(body, res);
  if (!parsed) return;
  try {
    const artifact = await resolveImportedArtifactForRead(
      ctx,
      parsed as Record<string, unknown>,
      'Import artifact metadata can only be read from imported assertions owned by the requesting agent',
    );
    return jsonResponse(res, 200, { artifact });
  } catch (err) {
    if (handleImportArtifactRouteError(res, err)) return;
    throw err;
  }
}

// POST /api/knowledge-assets/import-artifact/read
// Generic imported assertion artifact byte reader.
export async function handleKaImportArtifactRead(ctx: RequestContext): Promise<void> {
  const { req, res, agent, fileStore } = ctx;
  const body = await readBody(req, SMALL_BODY_BYTES);
  const parsed = safeParseJson(body, res);
  if (!parsed) return;
  const raw = parsed as Record<string, unknown>;
  try {
    const offset = normalizeArtifactOffset(raw.offset);
    const maxBytes = normalizeArtifactReadLimit(raw.maxBytes);
    const resolved = await resolveAssertionArtifact(ctx, raw);
    if (resolved === 'hash_mismatch') {
      return jsonResponse(res, 200, {
        status: 'hash_mismatch',
        contextGraphId: typeof raw.contextGraphId === 'string' ? normalizeContextGraphIdOrUri(raw.contextGraphId) : undefined,
        assertionUri: raw.assertionUri,
        kind: raw.kind,
        hash: raw.hash,
      });
    }

    const statResult = await fileStore.stat(resolved.hash);
    if (statResult) {
      const bytes = await fileStore.readRange(resolved.hash, offset, maxBytes);
      if (bytes) {
        const nextOffset = offset + bytes.length;
        const truncated = nextOffset < statResult.size;
        return jsonResponse(res, 200, {
          status: 'local',
          contextGraphId: resolved.contextGraphId,
          assertionUri: resolved.assertionUri,
          kind: resolved.kind,
          hash: resolved.hash,
          contentType: resolved.contentType,
          size: statResult.size,
          offset,
          nextOffset: truncated ? nextOffset : undefined,
          truncated,
          bytesB64: bytes.toString('base64'),
          source: { agentAddress: resolved.assertionAgentAddress },
        });
      }
    }

    const sourcePeerId = typeof raw.sourcePeerId === 'string' && raw.sourcePeerId.trim()
      ? raw.sourcePeerId.trim()
      : undefined;
    const discoveredPeerIds = await discoverArtifactCandidatePeers(agent, resolved);
    const sourcePeerIds = orderedArtifactCandidatePeers(sourcePeerId, discoveredPeerIds);
    if (sourcePeerIds.length === 0 || typeof agent.fetchAndVerifyAssertionArtifact !== 'function') {
      return jsonResponse(res, 200, {
        status: sourcePeerId ? 'unavailable' : 'fetchable',
        contextGraphId: resolved.contextGraphId,
        assertionUri: resolved.assertionUri,
        kind: resolved.kind,
        hash: resolved.hash,
        contentType: resolved.contentType,
        offset,
        source: {
          ...(sourcePeerId ? { peerId: sourcePeerId } : {}),
          agentAddress: resolved.assertionAgentAddress,
        },
        reason: sourcePeerId
          ? 'Artifact bytes are not available locally or from the requested peer'
          : 'Artifact bytes are not local and no connected peer candidate is available',
      });
    }

    const cache = raw.cache !== false && offset === 0;
    const fetched = await fetchFirstAvailableAssertionArtifact(agent, resolved, {
      sourcePeerIds,
      requesterAgentAddress: ctx.requestAgentAddress,
      offset,
      maxBytes,
      cache,
    });
    if (!fetched) {
      return jsonResponse(res, 200, {
        status: 'fetchable',
        contextGraphId: resolved.contextGraphId,
        assertionUri: resolved.assertionUri,
        kind: resolved.kind,
        hash: resolved.hash,
        contentType: resolved.contentType,
        offset,
        source: { agentAddress: resolved.assertionAgentAddress },
        reason: 'Artifact bytes are not local and no connected peer candidate is available',
      });
    }
    const { remote, sourcePeerId: fetchedSourcePeerId } = fetched;
    const verified = fetched.availability === 'verified';
    const page = remote.response;
    if (page.denied) {
      return jsonResponse(res, 200, {
        status: 'denied',
        contextGraphId: resolved.contextGraphId,
        assertionUri: resolved.assertionUri,
        kind: resolved.kind,
        hash: resolved.hash,
        source: { peerId: fetchedSourcePeerId, agentAddress: resolved.assertionAgentAddress },
        reason: 'denied',
      });
    }
    if (page.hashMismatch) {
      return jsonResponse(res, 200, {
        status: 'hash_mismatch',
        contextGraphId: resolved.contextGraphId,
        assertionUri: resolved.assertionUri,
        kind: resolved.kind,
        hash: resolved.hash,
        source: { peerId: fetchedSourcePeerId, agentAddress: resolved.assertionAgentAddress },
      });
    }
    if (page.unavailable || page.bytesB64 == null) {
      return jsonResponse(res, 200, {
        status: 'unavailable',
        contextGraphId: resolved.contextGraphId,
        assertionUri: resolved.assertionUri,
        kind: resolved.kind,
        hash: resolved.hash,
        source: { peerId: fetchedSourcePeerId, agentAddress: resolved.assertionAgentAddress },
      });
    }

    if (verified && cache && remote.verifiedBytes) {
      if (!verifyDkgContentHash(resolved.hash, remote.verifiedBytes)) {
        return jsonResponse(res, 200, {
          status: 'hash_mismatch',
          contextGraphId: resolved.contextGraphId,
          assertionUri: resolved.assertionUri,
          kind: resolved.kind,
          hash: resolved.hash,
          source: { peerId: fetchedSourcePeerId, agentAddress: resolved.assertionAgentAddress },
        });
      }
      await fileStore.put(remote.verifiedBytes, resolved.contentType);
    }

    return jsonResponse(res, 200, {
      status: verified ? 'fetched' : 'unverified',
      contextGraphId: resolved.contextGraphId,
      assertionUri: resolved.assertionUri,
      kind: resolved.kind,
      hash: resolved.hash,
      contentType: resolved.contentType,
      size: page.totalBytes,
      offset: page.offset,
      nextOffset: page.nextOffset,
      truncated: page.truncated,
      bytesB64: page.bytesB64,
      source: { peerId: fetchedSourcePeerId, agentAddress: resolved.assertionAgentAddress },
      ...(verified ? {} : { reason: 'Remote page fetched without full-artifact hash verification' }),
    });
  } catch (err) {
    if (handleImportArtifactRouteError(res, err)) return;
    throw err;
  }
}

// POST /api/knowledge-assets/import-artifact/read-markdown
// Read only the Markdown blob tied to a completed imported assertion.
export async function handleKaImportArtifactReadMarkdown(ctx: RequestContext): Promise<void> {
  const { req, res, agent, fileStore } = ctx;
  const body = await readBody(req, SMALL_BODY_BYTES);
  const parsed = safeParseJson(body, res);
  if (!parsed) return;
  try {
    const artifact = await resolveImportedArtifactForRead(
      ctx,
      parsed as Record<string, unknown>,
      'Import artifact Markdown can only be read from imported assertions owned by the requesting agent',
      { allowSharedMemoryFallback: true },
    );
    const maxBytes = normalizeMarkdownReadLimit((parsed as Record<string, unknown>).maxBytes);
    if (!artifact.markdownHash) {
      return jsonResponse(res, 409, {
        error: 'Import artifact does not have a readable Markdown source',
        artifact,
      });
    }
    const bytes = await fileStore.get(artifact.markdownHash);
    if (!bytes) {
      const resolved: AssertionArtifactResolution = {
        ...artifact,
        kind: 'markdown',
        hash: artifact.markdownHash,
        contentType: 'text/markdown',
      };
      const rawSourcePeerId = (parsed as Record<string, unknown>).sourcePeerId;
      const sourcePeerId = typeof rawSourcePeerId === 'string' && rawSourcePeerId.trim()
        ? rawSourcePeerId.trim()
        : undefined;
      const discoveredPeerIds = await discoverArtifactCandidatePeers(agent, resolved);
      const sourcePeerIds = orderedArtifactCandidatePeers(sourcePeerId, discoveredPeerIds);
      const fetched = await fetchFirstAvailableAssertionArtifact(agent, resolved, {
        sourcePeerIds,
        requesterAgentAddress: ctx.requestAgentAddress,
        offset: 0,
        maxBytes,
        cache: true,
      });
      if (fetched?.availability === 'verified' && fetched.remote.verifiedBytes) {
        if (fetched.remote.verifiedBytes.length > maxBytes) {
          return jsonResponse(res, 413, {
            error: `Markdown content exceeds maxBytes (${maxBytes})`,
            artifact,
            bytes: fetched.remote.verifiedBytes.length,
          });
        }
        await fileStore.put(fetched.remote.verifiedBytes, 'text/markdown');
        return jsonResponse(res, 200, {
          artifact,
          markdownHash: artifact.markdownHash,
          contentType: 'text/markdown',
          bytes: fetched.remote.verifiedBytes.length,
          markdown: fetched.remote.verifiedBytes.toString('utf8'),
          source: { peerId: fetched.sourcePeerId, agentAddress: artifact.assertionAgentAddress },
        });
      }
      // Issue #872 — when the owner guard was relaxed (public + open
      // CG, cross-agent request), the missing bytes are the
      // expected outcome: peers replicate the SWM triples for the
      // assertion but the source-artifact bytes are NOT gossipped
      // yet. Surface that explicitly so callers can decide whether
      // to retry against the origin agent instead of treating this
      // as local corruption.
      //
      // DEFERRED FOLLOW-UP: gossip the imported-artifact bytes to
      // peers replicating a public + open CG, so cross-agent reads
      // can complete locally without an out-of-band fetch. Tracked
      // in the PR body for #872.
      const message = artifact.ownerGuardRelaxed
        ? 'Markdown source bytes are not replicated locally on this peer; the assertion graph triples synced but the source artifact bytes were not. Fetch from the origin agent (assertionAgentAddress).'
        : 'Markdown content is not present in the file store';
      return jsonResponse(res, 404, {
        error: message,
        artifact,
      });
    }
    if (bytes.length > maxBytes) {
      return jsonResponse(res, 413, {
        error: `Markdown content exceeds maxBytes (${maxBytes})`,
        artifact,
        bytes: bytes.length,
      });
    }
    return jsonResponse(res, 200, {
      artifact,
      markdownHash: artifact.markdownHash,
      contentType: 'text/markdown',
      bytes: bytes.length,
      markdown: bytes.toString('utf8'),
    });
  } catch (err) {
    if (handleImportArtifactRouteError(res, err)) return;
    throw err;
  }
}

// POST /api/knowledge-assets/semantic-enrichment/write
// Write model-derived semantic triples into the completed imported assertion with provenance.
export async function handleKaSemanticEnrichmentWrite(ctx: RequestContext): Promise<void> {
  const {
    req,
    res,
    agent,
    requestAgentAddress,
    requestPrincipal,
    emitMemoryGraphChanged,
  } = ctx;
  // Mirror the legacy assertion-route preflight: resolve the caller agent
  // from the bearer token so `resolveRequiredWriteContextGraphId` validates
  // the write CG against the caller's known graphs before any mutation.
  const writePreflightCallerAgentAddress = requestPrincipal.kind === 'agent'
    ? requestPrincipal.agentAddress
    : undefined;
  const writePreflightContextGraphOpts = {
    callerAgentAddress: writePreflightCallerAgentAddress,
    allowLocalExactFallback: !writePreflightCallerAgentAddress,
  };
  const body = await readBody(req);
  const parsed = safeParseJson(body, res);
  if (!parsed) return;
  try {
    const record = { ...(parsed as Record<string, unknown>) };
    if (
      record.name !== undefined ||
      record.semanticAssertionName !== undefined ||
      record.semantic_assertion_name !== undefined
    ) {
      throw new ImportArtifactRouteError(
        400,
        'Semantic enrichment is written into the source import assertion; target assertion names are not supported',
      );
    }
    const resolvedContextGraphId = await resolveRequiredWriteContextGraphId(
      agent,
      record.contextGraphId,
      res,
      writePreflightContextGraphOpts,
    );
    if (!resolvedContextGraphId) return;
    record.contextGraphId = resolvedContextGraphId;
    const artifact = await resolveImportedArtifact(ctx, record, {
      requestAgentAddress,
      message: 'Semantic enrichment can only modify imported assertions owned by the requesting agent',
    });
    const semanticQuads = normalizeSemanticQuads(record.semanticQuads);
    const generatedAt = normalizeGeneratedAt(record.generatedAt);
    const generationMethod = typeof record.generationMethod === 'string' && record.generationMethod.trim()
      ? record.generationMethod.trim()
      : 'agent-semantic-enrichment';
    const generatedBy = normalizeGeneratedBy(record.agentIdentity, requestAgentAddress);
    const enrichmentUri = `urn:dkg:semantic-enrichment:${randomUUID()}`;
    const provenanceQuads = buildSemanticEnrichmentProvenanceQuads({
      enrichmentUri,
      source: artifact,
      generatedBy,
      generatedAt,
      generationMethod,
      semanticQuads,
    });
    const quads = [...semanticQuads, ...provenanceQuads];
    const targetAssertionUri = contextGraphAssertionUri(
      artifact.contextGraphId,
      artifact.assertionAgentAddress,
      artifact.assertionName,
      artifact.subGraphName,
    );
    if (targetAssertionUri !== artifact.assertionUri) {
      throw new ImportArtifactRouteError(409, 'Resolved import artifact target does not match assertionUri');
    }
    await agent.publisher.assertionWrite(
      artifact.contextGraphId,
      artifact.assertionName,
      artifact.assertionAgentAddress,
      quads,
      artifact.subGraphName,
    );
    emitMemoryGraphChanged?.({
      contextGraphId: artifact.contextGraphId,
      layers: ["wm"],
      subGraphName: artifact.subGraphName,
      operation: "semantic_enrichment_written",
      source: "api",
      counts: { triples: quads.length },
    });
    return jsonResponse(res, 200, {
      assertionUri: artifact.assertionUri,
      assertionName: artifact.assertionName,
      contextGraphId: artifact.contextGraphId,
      ...(artifact.subGraphName ? { subGraphName: artifact.subGraphName } : {}),
      sourceAssertionUri: artifact.assertionUri,
      sourceFileHash: artifact.fileHash,
      markdownHash: artifact.markdownHash,
      markdownForm: artifact.markdownForm,
      enrichmentUri,
      written: quads.length,
      semanticTripleCount: semanticQuads.length,
      provenanceTripleCount: provenanceQuads.length,
      promoted: false,
      published: false,
      artifact,
    });
  } catch (err) {
    if (handleImportArtifactRouteError(res, err)) return;
    throw err;
  }
}

// POST /api/knowledge-assets/:name/wm/import-file  (multipart/form-data)
//   file (required):           the uploaded document bytes
//   contextGraphId (required): target context graph
//   contentType (optional):    override the file part's Content-Type
//   ontologyRef (optional):    CG _ontology URI for guided Phase 2 extraction
//   subGraphName (optional):   target sub-graph inside the CG
//
// Faithful port of the legacy POST /api/assertion/:name/import-file handler
// (daemon/routes/assertion.ts). The body below is the legacy handler verbatim:
// identical multipart parsing, extraction orchestration, per-assertion lock,
// extractionStatus lifecycle, agent.publisher calls, emitMemoryGraphChanged
// side-effects, 400/409/413/415 error mapping, and response shape. The
// dispatcher passes the already-decoded `name`; the validateAssertionName check
// mirrors the legacy entry exactly.
export async function handleKaImportFile(ctx: RequestContext, name: string): Promise<void> {
  const {
    req,
    res,
    agent,
    extractionRegistry,
    fileStore,
    extractionStatus,
    assertionImportLocks,
    requestAgentAddress,
    requestPrincipal,
    emitMemoryGraphChanged,
  } = ctx;
  // Mirror the legacy assertion-route preflight: resolve the caller agent from
  // the bearer token so `resolveRequiredWriteContextGraphId` validates the write
  // CG against the caller's known graphs before any mutation.
  const writePreflightCallerAgentAddress = requestPrincipal.kind === 'agent'
    ? requestPrincipal.agentAddress
    : undefined;
  const writePreflightContextGraphOpts = {
    callerAgentAddress: writePreflightCallerAgentAddress,
    allowLocalExactFallback: !writePreflightCallerAgentAddress,
  };

  const assertionName = name;
  const nameVal = validateAssertionName(assertionName);
  if (!nameVal.valid)
    return jsonResponse(res, 400, {
      error: `Invalid assertion name: ${nameVal.reason}`,
    });

  const boundary = parseBoundary(req.headers["content-type"]);
  if (!boundary) {
    return jsonResponse(res, 400, {
      error: "Request must be multipart/form-data with a boundary",
    });
  }

  let body: Buffer;
  try {
    body = await readBodyBuffer(req, MAX_UPLOAD_BYTES);
  } catch (err: any) {
    if (err instanceof PayloadTooLargeError) throw err;
    if (err instanceof SignedRequestRejectedError) throw err;
    return jsonResponse(res, 400, {
      error: `Failed to read request body: ${err.message}`,
    });
  }

  let fields;
  try {
    fields = parseMultipart(body, boundary);
  } catch (err: any) {
    if (err instanceof MultipartParseError) {
      return jsonResponse(res, 400, {
        error: `Malformed multipart body: ${err.message}`,
      });
    }
    throw err;
  }

  const filePart = fields.find(
    (f) => f.name === "file" && f.filename !== undefined,
  );
  if (!filePart) {
    return jsonResponse(res, 400, {
      error: 'Missing required "file" field in multipart body',
    });
  }
  const textField = (name: string): string | undefined => {
    const f = fields.find((x) => x.name === name && x.filename === undefined);
    return f ? f.content.toString("utf-8") : undefined;
  };
  let contextGraphId = textField("contextGraphId");
  const contentTypeOverrideRaw = textField("contentType");
  // Treat blank (`contentType=` with empty/whitespace value) as absent so we
  // fall through to the file part's own Content-Type header instead of
  // downgrading a real text/markdown / application/pdf upload to
  // application/octet-stream and silently skipping extraction.
  const contentTypeOverride =
    contentTypeOverrideRaw && contentTypeOverrideRaw.trim().length > 0
      ? contentTypeOverrideRaw
      : undefined;
  const ontologyRef = textField("ontologyRef");
  const subGraphName = textField("subGraphName");

  const resolvedContextGraphId = await resolveRequiredWriteContextGraphId(
    agent,
    contextGraphId,
    res,
    writePreflightContextGraphOpts,
  );
  if (!resolvedContextGraphId) return;
  contextGraphId = resolvedContextGraphId;
  if (!validateOptionalSubGraphName(subGraphName, res)) return;

  // #1101: precedence is explicit `contentType` field > multipart part
  // Content-Type header > filename-extension fallback. The fallback only
  // engages when the first two resolve to application/octet-stream (curl
  // and many HTTP clients send octet-stream for .md files) AND the caller
  // did not say octet-stream EXPLICITLY: an explicit
  // `contentType=application/octet-stream` form field is the documented
  // "store as opaque blob" escape hatch, so inferring `notes.md` back to
  // text/markdown there would override a deliberate choice (Codex review
  // on PR #1107). Only the implicit default (no override, generic or
  // absent part header) is eligible for filename inference.
  let detectedContentType = normalizeDetectedContentType(
    contentTypeOverride ?? filePart.contentType,
  );
  const explicitOctetStream =
    contentTypeOverride !== undefined &&
    normalizeDetectedContentType(contentTypeOverride) === "application/octet-stream";
  if (detectedContentType === "application/octet-stream" && !explicitOctetStream) {
    const inferred = inferContentTypeFromFilename(filePart.filename);
    if (inferred) detectedContentType = inferred;
  }

  if (subGraphName) {
    try {
      const registeredSubGraphs: Array<{ name: string }> =
        await agent.listSubGraphs(contextGraphId!);
      if (
        !registeredSubGraphs.some(
          (subGraph) => subGraph.name === subGraphName,
        )
      ) {
        return jsonResponse(res, 400, {
          error: unregisteredSubGraphError(contextGraphId!, subGraphName),
        });
      }
    } catch (err: any) {
      return jsonResponse(res, 500, {
        error: `Failed to verify sub-graph registration: ${err.message}`,
      });
    }
  }

  // Persist the original upload to the file store.
  let fileStoreEntry;
  try {
    fileStoreEntry = await fileStore.put(
      filePart.content,
      detectedContentType,
    );
  } catch (err: any) {
    return jsonResponse(res, 500, {
      error: `Failed to store uploaded file: ${err.message}`,
    });
  }

  const assertionUri = contextGraphAssertionUri(
    contextGraphId!,
    requestAgentAddress,
    assertionName,
    subGraphName,
  );
  const uploadedFilename = filePart.filename?.trim() || undefined;
  const startedAt = new Date().toISOString();

  // ── Round 14 Bug 42: per-assertion mutex BEFORE extraction ──
  //
  // Round 6 originally acquired this lock just before the
  // snapshot→insert→rollback critical section, AFTER Phase 1 and
  // Phase 2 extraction had already run. Concurrent imports of the
  // same assertion name then raced during extraction, and the one
  // whose extraction finished LAST committed LAST — regardless of
  // which request arrived first. Final stored state depended on
  // extraction duration (bytes-to-parse, converter latency, PDF
  // complexity), not request order.
  //
  // Option 42A fix: move the lock acquisition here, before any
  // extraction work begins. This serializes the entire import-file
  // handler per assertion name so concurrent imports commit in
  // request order, not in extraction-finish order.
  //
  // Tradeoff: a long-running extraction (large PDF through the
  // MarkItDown converter) now holds the lock and blocks other
  // imports of the SAME assertion name for the duration. In
  // practice, same-name re-imports should be rare (name collision
  // is usually a user mistake, not a workflow), so this is an
  // acceptable tradeoff for correctness. Imports of DIFFERENT
  // assertion names are unaffected — the lock is per-URI, not
  // global. Async extraction (if/when it lands) will need a
  // different locking story, but for V10.0's synchronous
  // extraction this is correct by construction.
  //
  // `releaseLock` is invoked in the outer `finally` block at the
  // bottom of the handler so the next waiter unblocks regardless
  // of success, failure, return, or throw.
  const previousLock =
    assertionImportLocks.get(assertionUri) ?? Promise.resolve();
  let releaseLock: () => void = () => {};
  const currentLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const chainedLock = previousLock.then(() => currentLock);
  assertionImportLocks.set(assertionUri, chainedLock);
  await previousLock;

  try {
    // ── Phase 1: converter lookup + MD intermediate resolution ──
    // text/markdown is deliberately NOT a registered converter content type.
    // The raw uploaded bytes ARE the Markdown intermediate, so Phase 1 is skipped.
    // For any other content type, look up a converter; if none is registered,
    // gracefully degrade (store the file, skip extraction, return status=skipped).
    let mdIntermediate: string | null = null;
    let pipelineUsed: string | null = null;
    let mdIntermediateHash: string | undefined;
    let importRootEntity: string | undefined;
    const respondWithImportFileResponse = (
      statusCode: number,
      extraction: ImportFileExtractionPayload,
    ) =>
      jsonResponse(
        res,
        statusCode,
        buildImportFileResponse({
          assertionUri,
          fileHash: fileStoreEntry.keccak256,
          rootEntity: importRootEntity,
          detectedContentType,
          extraction,
        }),
      );
    const recordInProgressExtraction = (): void => {
      setExtractionStatusRecord(extractionStatus, assertionUri, {
        status: "in_progress",
        fileHash: fileStoreEntry.keccak256,
        ...(uploadedFilename ? { fileName: uploadedFilename } : {}),
        detectedContentType,
        pipelineUsed,
        tripleCount: 0,
        ...(mdIntermediateHash ? { mdIntermediateHash } : {}),
        startedAt,
      });
    };
    const recordFailedExtraction = (
      error: string,
      tripleCount: number,
      failedPipelineUsed: string | null = pipelineUsed,
    ): ExtractionStatusRecord => {
      const failedRecord: ExtractionStatusRecord = {
        status: "failed",
        fileHash: fileStoreEntry.keccak256,
        ...(uploadedFilename ? { fileName: uploadedFilename } : {}),
        ...(importRootEntity ? { rootEntity: importRootEntity } : {}),
        detectedContentType,
        pipelineUsed: failedPipelineUsed,
        tripleCount,
        ...(mdIntermediateHash ? { mdIntermediateHash } : {}),
        error,
        startedAt,
        completedAt: new Date().toISOString(),
      };
      setExtractionStatusRecord(extractionStatus, assertionUri, failedRecord);
      return failedRecord;
    };
    const respondWithFailedExtraction = (
      statusCode: number,
      error: string,
      tripleCount: number,
      failedPipelineUsed: string | null = pipelineUsed,
      details: Partial<
        Pick<
          ImportFileExtractionPayload,
          "code" | "limitBytes" | "actualBytes" | "subject" | "predicate" | "graph"
        >
      > = {},
    ) => {
      const failedRecord = recordFailedExtraction(
        error,
        tripleCount,
        failedPipelineUsed,
      );
      return respondWithImportFileResponse(statusCode, {
        status: "failed",
        tripleCount,
        pipelineUsed: failedRecord.pipelineUsed,
        ...(failedRecord.mdIntermediateHash
          ? { mdIntermediateHash: failedRecord.mdIntermediateHash }
          : {}),
        error,
        ...details,
      });
    };
    const previousExtractionStatusRecord = getExtractionStatusRecord(
      extractionStatus,
      assertionUri,
    );
    const importMetaValue = (
      snapshot: Array<{
        subject: string;
        predicate: string;
        object: string;
        graph: string;
      }>,
      predicate: string,
    ): string | undefined => snapshot.find((q) =>
      q.subject === assertionUri &&
      q.predicate === `http://dkg.io/ontology/${predicate}`
    )?.object;
    const parseImportMetaLiteral = (
      value: string | undefined,
    ): string | undefined => {
      const trimmed = value?.trim();
      if (!trimmed) return undefined;
      const literalMatch = /^"((?:[^"\\]|\\.)*)"/.exec(trimmed);
      if (literalMatch) {
        try {
          return JSON.parse(literalMatch[0]);
        } catch {
          return literalMatch[1];
        }
      }
      return trimmed.replace(/^<|>$/g, "");
    };
    const parseImportMetaInteger = (
      value: string | undefined,
    ): number | undefined => {
      const integerMatch = /^"(-?\d+)"/.exec(value?.trim() ?? "");
      if (!integerMatch) return undefined;
      const parsed = Number.parseInt(integerMatch[1], 10);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    const buildPreviousExtractionStatusRecordFromMeta = (
      snapshot: Array<{
        subject: string;
        predicate: string;
        object: string;
        graph: string;
      }>,
    ): ExtractionStatusRecord | undefined => {
      const fileHash = parseImportMetaLiteral(
        importMetaValue(snapshot, "sourceFileHash"),
      );
      const detectedContentType = parseImportMetaLiteral(
        importMetaValue(snapshot, "sourceContentType"),
      );
      const tripleCount = parseImportMetaInteger(
        importMetaValue(snapshot, "structuralTripleCount"),
      );
      if (!fileHash || !detectedContentType || tripleCount == null) {
        return undefined;
      }
      const extractionStatus = parseImportMetaLiteral(
        importMetaValue(snapshot, "extractionStatus"),
      );
      const status = extractionStatus === "skipped" ? "skipped" : "completed";
      const fileName = parseImportMetaLiteral(
        importMetaValue(snapshot, "sourceFileName"),
      );
      const rootEntity = parseImportMetaLiteral(
        importMetaValue(snapshot, "rootEntity"),
      );
      const mdIntermediateHashFromMeta = parseImportMetaLiteral(
        importMetaValue(snapshot, "mdIntermediateHash"),
      );
      const restoredAt = new Date().toISOString();
      return {
        status,
        fileHash,
        ...(fileName ? { fileName } : {}),
        ...(rootEntity ? { rootEntity } : {}),
        detectedContentType,
        pipelineUsed: status === "skipped" ? null : detectedContentType,
        tripleCount,
        ...(mdIntermediateHashFromMeta
          ? { mdIntermediateHash: mdIntermediateHashFromMeta }
          : {}),
        startedAt: restoredAt,
        completedAt: restoredAt,
      };
    };
    const getRestorablePreviousExtractionStatusRecord = (
      metaSnapshot: Array<{
        subject: string;
        predicate: string;
        object: string;
        graph: string;
      }>,
    ): ExtractionStatusRecord | undefined =>
      previousExtractionStatusRecord
        ? { ...previousExtractionStatusRecord }
        : buildPreviousExtractionStatusRecordFromMeta(metaSnapshot);
    const restoreExtractionStatusRecord = (
      record: ExtractionStatusRecord,
    ): void => {
      setExtractionStatusRecord(extractionStatus, assertionUri, record);
    };

    recordInProgressExtraction();

    if (detectedContentType === "text/markdown") {
      mdIntermediate = filePart.content.toString("utf-8");
      pipelineUsed = "text/markdown";
      recordInProgressExtraction();
    } else {
      const converter = extractionRegistry.get(detectedContentType);
      if (converter) {
        try {
          const { mdIntermediate: md } = await converter.extract({
            filePath: fileStoreEntry.path,
            contentType: detectedContentType,
            ontologyRef,
            agentDid: `did:dkg:agent:${requestAgentAddress}`,
          });
          mdIntermediate = md;
          pipelineUsed = detectedContentType;
          const mdEntry = await fileStore.put(
            Buffer.from(md, "utf-8"),
            "text/markdown",
          );
          mdIntermediateHash = mdEntry.keccak256;
          recordInProgressExtraction();
        } catch (err: any) {
          return respondWithFailedExtraction(
            500,
            `Phase 1 converter failed: ${err.message}`,
            0,
            detectedContentType,
          );
        }
      }
    }

    // ── Graceful degrade: no converter registered and not text/markdown ──
    // Store the file blob, return status=skipped, and persist durable
    // provenance metadata without creating assertion data triples.
    if (mdIntermediate === null) {
      const skippedMetaGraph = contextGraphMetaUri(contextGraphId!);
      const lifecycleSubject = assertionLifecycleUri(
        contextGraphId!,
        requestAgentAddress,
        assertionName,
        subGraphName,
      );
      const listCreateMetaSubjects = async (): Promise<string[]> => {
        const lifecycleSubjectLiteral = JSON.stringify(lifecycleSubject);
        const lifecyclePrefixLiteral = JSON.stringify(`${lifecycleSubject}/`);
        const assertionUriLiteral = JSON.stringify(assertionUri);
        const result = await agent.store.query(
          `SELECT DISTINCT ?s WHERE { GRAPH <${skippedMetaGraph}> { ?s ?p ?o . FILTER(STR(?s) = ${lifecycleSubjectLiteral} || STRSTARTS(STR(?s), ${lifecyclePrefixLiteral}) || STR(?s) = ${assertionUriLiteral}) } }`,
        );
        if (result.type !== "bindings") return [];
        return result.bindings
          .map((row) => row["s"])
          .filter((subject): subject is string => typeof subject === "string" && subject.length > 0);
      };
      const snapshotCreateMeta = async (): Promise<
        Array<{
          subject: string;
          predicate: string;
          object: string;
          graph: string;
        }>
      > => {
        const subjects = new Set([
          assertionUri,
          lifecycleSubject,
          ...(await listCreateMetaSubjects()),
        ]);
        const snapshot: Array<{
          subject: string;
          predicate: string;
          object: string;
          graph: string;
        }> = [];
        for (const subject of subjects) {
          const result = await agent.store.query(
            `CONSTRUCT { <${subject}> ?p ?o } WHERE { GRAPH <${skippedMetaGraph}> { <${subject}> ?p ?o } }`,
          );
          if (result.type === "quads") {
            snapshot.push(...result.quads.map((q) => ({
              ...q,
              graph: skippedMetaGraph,
            })));
          }
        }
        return snapshot;
      };
      const restoreCreateMetaSnapshot = async (
        snapshot: Array<{
          subject: string;
          predicate: string;
          object: string;
          graph: string;
        }>,
      ): Promise<void> => {
        const subjects = new Set([
          assertionUri,
          lifecycleSubject,
          ...snapshot.map((q) => q.subject),
          ...(await listCreateMetaSubjects()),
        ]);
        for (const subject of subjects) {
          await deleteByPatternWithoutCount(agent.store, {
            subject,
            graph: skippedMetaGraph,
          });
        }
        if (snapshot.length > 0) {
          await agent.store.insert(snapshot);
        }
      };
      const snapshotCreateDataGraph = async (): Promise<
        Array<{
          subject: string;
          predicate: string;
          object: string;
          graph: string;
        }>
      > => {
        const result = await agent.store.query(
          `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${assertionUri}> { ?s ?p ?o } }`,
        );
        if (result.type !== "quads") return [];
        return result.quads.map((q) => ({
          ...q,
          graph: assertionUri,
        }));
      };
      const restoreCreateSnapshot = async (
        metaSnapshot: Array<{
          subject: string;
          predicate: string;
          object: string;
          graph: string;
        }>,
        dataSnapshot: Array<{
          subject: string;
          predicate: string;
          object: string;
          graph: string;
        }>,
        hadDataGraphBeforeCreate: boolean,
      ): Promise<void> => {
        const restoreErrors: string[] = [];
        try {
          if (dataSnapshot.length > 0) {
            await agent.store.dropGraph(assertionUri);
            await agent.store.insert(dataSnapshot);
          } else if (hadDataGraphBeforeCreate) {
            await agent.store.dropGraph(assertionUri);
            await agent.store.createGraph(assertionUri);
          } else if (!hadDataGraphBeforeCreate) {
            await agent.store.dropGraph(assertionUri);
          }
        } catch (err: any) {
          restoreErrors.push(
            `data graph rollback failed: ${err?.message ?? err}`,
          );
        }
        try {
          await restoreCreateMetaSnapshot(metaSnapshot);
        } catch (err: any) {
          restoreErrors.push(
            `metadata rollback failed: ${err?.message ?? err}`,
          );
        }
        if (restoreErrors.length > 0) {
          throw new Error(restoreErrors.join("; "));
        }
      };

      let preCreateDataGraphExisted = false;
      let preCreateDataSnapshot: Array<{
        subject: string;
        predicate: string;
        object: string;
        graph: string;
      }>;
      let preCreateMetaSnapshot: Array<{
        subject: string;
        predicate: string;
        object: string;
        graph: string;
      }>;
      try {
        preCreateDataGraphExisted = await agent.store.hasGraph(assertionUri);
        preCreateDataSnapshot = await snapshotCreateDataGraph();
        preCreateMetaSnapshot = await snapshotCreateMeta();
      } catch (err: any) {
        return respondWithFailedExtraction(
          500,
          `Failed to snapshot assertion create state for skipped extraction rollback: ${err?.message ?? String(err)}`,
          0,
          null,
        );
      }

      try {
        // Use the allocating create (mints the kaNumber for requestAgentAddress) so the
        // subsequent wmGraphUri resolves the per-KA …/_working_memory/{addr}/{number} graph
        // instead of falling back to the legacy name-keyed graph the WM view can't read.
        await agent.assertion.create(
          contextGraphId!,
          assertionName,
          { subGraphName, agentAddress: requestAgentAddress },
        );
      } catch (err: any) {
        const message = err?.message ?? String(err);
        if (
          message.includes("already exists") ||
          message.includes("duplicate") ||
          message.includes("conflict")
        ) {
          // create() is idempotent when the graph already exists.
        } else if (
          message.includes("has not been registered") ||
          message.includes("Invalid") ||
          message.includes("Unsafe")
        ) {
          const rollbackErrors: string[] = [];
          try {
            await restoreCreateSnapshot(
              preCreateMetaSnapshot,
              preCreateDataSnapshot,
              preCreateDataGraphExisted,
            );
          } catch (rollbackErr: any) {
            rollbackErrors.push(
              `create rollback failed: ${rollbackErr?.message ?? rollbackErr}`,
            );
          }
          const rollbackSuffix = rollbackErrors.length > 0
            ? `; rollback failures: ${rollbackErrors.join("; ")}`
            : "";
          const previousStatusRecord = rollbackErrors.length === 0
            ? getRestorablePreviousExtractionStatusRecord(
                preCreateMetaSnapshot,
              )
            : undefined;
          if (previousStatusRecord) {
            const response = respondWithFailedExtraction(400, `${message}${rollbackSuffix}`, 0, null);
            restoreExtractionStatusRecord(previousStatusRecord);
            return response;
          }
          return respondWithFailedExtraction(400, `${message}${rollbackSuffix}`, 0, null);
        } else {
          const rollbackErrors: string[] = [];
          try {
            await restoreCreateSnapshot(
              preCreateMetaSnapshot,
              preCreateDataSnapshot,
              preCreateDataGraphExisted,
            );
          } catch (rollbackErr: any) {
            rollbackErrors.push(
              `create rollback failed: ${rollbackErr?.message ?? rollbackErr}`,
            );
          }
          const rollbackSuffix = rollbackErrors.length > 0
            ? `; rollback failures: ${rollbackErrors.join("; ")}`
            : "";
          const previousStatusRecord = rollbackErrors.length === 0
            ? getRestorablePreviousExtractionStatusRecord(
                preCreateMetaSnapshot,
              )
            : undefined;
          if (previousStatusRecord) {
            const response = respondWithFailedExtraction(500, `${message}${rollbackSuffix}`, 0, null);
            restoreExtractionStatusRecord(previousStatusRecord);
            return response;
          }
          return respondWithFailedExtraction(500, `${message}${rollbackSuffix}`, 0, null);
        }
      }

      const skippedMetaQuads: Array<{
        subject: string;
        predicate: string;
        object: string;
        graph: string;
      }> = [
        {
          subject: assertionUri,
          predicate: "http://dkg.io/ontology/sourceContentType",
          object: JSON.stringify(detectedContentType),
          graph: skippedMetaGraph,
        },
        {
          subject: assertionUri,
          predicate: "http://dkg.io/ontology/sourceFileHash",
          object: JSON.stringify(fileStoreEntry.keccak256),
          graph: skippedMetaGraph,
        },
        {
          subject: assertionUri,
          predicate: "http://dkg.io/ontology/extractionStatus",
          object: JSON.stringify("skipped"),
          graph: skippedMetaGraph,
        },
        {
          subject: assertionUri,
          predicate: "http://dkg.io/ontology/structuralTripleCount",
          object: '"0"^^<http://www.w3.org/2001/XMLSchema#integer>',
          graph: skippedMetaGraph,
        },
      ];
      if (uploadedFilename) {
        skippedMetaQuads.push({
          subject: assertionUri,
          predicate: "http://dkg.io/ontology/sourceFileName",
          object: JSON.stringify(uploadedFilename),
          graph: skippedMetaGraph,
        });
      }
      try {
        assertQuadLiteralsMutf8Safe(skippedMetaQuads, {
          label: 'import-file.skippedMetaQuads',
        });
      } catch (err: any) {
        if (err?.code === "OVERSIZED_RDF_LITERAL") {
          const oversizedBody = oversizedRdfLiteralResponseBody(err);
          return respondWithFailedExtraction(
            400,
            String(oversizedBody.error ?? err.message),
            0,
            null,
            oversizedBody as Partial<
              Pick<
                ImportFileExtractionPayload,
                "code" | "limitBytes" | "actualBytes" | "subject" | "predicate" | "graph"
              >
            >,
          );
        }
        throw err;
      }

      let skippedMetaCleanupSucceeded = false;
      let skippedDataDropSucceeded = false;
      try {
        await deleteByPatternWithoutCount(agent.store, {
          subject: assertionUri,
          graph: skippedMetaGraph,
        });
        skippedMetaCleanupSucceeded = true;
        await agent.store.dropGraph(assertionUri);
        skippedDataDropSucceeded = true;
        await agent.store.insert(skippedMetaQuads);
      } catch (err: any) {
        const writeMsg = err?.message ?? String(err);
        const rollbackErrors: string[] = [];
        if (skippedMetaCleanupSucceeded) {
          try {
            await deleteByPatternWithoutCount(agent.store, {
              subject: assertionUri,
              graph: skippedMetaGraph,
            });
          } catch (partialMetaCleanupErr: any) {
            rollbackErrors.push(
              `partial _meta cleanup failed: ${partialMetaCleanupErr?.message ?? partialMetaCleanupErr}`,
            );
          }
        }
        try {
          await restoreCreateSnapshot(
            preCreateMetaSnapshot,
            preCreateDataSnapshot,
            preCreateDataGraphExisted,
          );
        } catch (createRollbackErr: any) {
          rollbackErrors.push(
            `create rollback failed: ${createRollbackErr?.message ?? createRollbackErr}`,
          );
        }
        const rollbackSuffix = rollbackErrors.length > 0
          ? `; rollback failures: ${rollbackErrors.join("; ")}`
          : "";
        const previousStatusRecord = rollbackErrors.length === 0
          ? getRestorablePreviousExtractionStatusRecord(
              preCreateMetaSnapshot,
            )
          : undefined;
        if (previousStatusRecord) {
          restoreExtractionStatusRecord(previousStatusRecord);
        } else {
          recordFailedExtraction(
            `Failed to persist skipped extraction metadata: ${writeMsg}${rollbackSuffix}`,
            0,
            null,
          );
          (err as any).__failureAlreadyRecorded = true;
        }
        throw err;
      }

      const skippedRecord: ExtractionStatusRecord = {
        status: "skipped",
        fileHash: fileStoreEntry.keccak256,
        ...(uploadedFilename ? { fileName: uploadedFilename } : {}),
        detectedContentType,
        pipelineUsed: null,
        tripleCount: 0,
        startedAt,
        completedAt: new Date().toISOString(),
      };
      setExtractionStatusRecord(
        extractionStatus,
        assertionUri,
        skippedRecord,
      );
      emitMemoryGraphChanged?.({
        contextGraphId: contextGraphId!,
        layers: ["wm"],
        subGraphName,
        operation: "assertion_imported",
        source: "api",
        counts: { triples: 0 },
      });
      return respondWithImportFileResponse(200, {
        status: "skipped",
        tripleCount: 0,
        pipelineUsed: null,
        skipReason: `no extraction pipeline registered for content type "${detectedContentType}" — the file was stored as a blob; pass an explicit contentType form field (e.g. text/markdown) or upload with a recognized file extension to enable extraction`,
      });
    }

    // ── Source-file linkage inputs for §10.1 / §10.2 triples ──
    // fileUri is the content-addressed URN the extractor stamps on the
    // document subject (row 1) and the daemon uses as both the subject of
    // the file descriptor block (rows 4-8) and the object of the extraction
    // provenance resource (row 10). provUri is a fresh UUID per import for
    // the ExtractionProvenance subject (rows 9-13).
    //
    // Cross-assertion promote contention on `<urn:dkg:file:...>` as a
    // root entity is prevented by a subject-prefix filter in
    // `packages/publisher/src/dkg-publisher.ts` `assertionPromote` that
    // excludes both `urn:dkg:file:` and `urn:dkg:extraction:` subjects
    // from the partition before `skolemizeByEntity` runs. Row 1 (whose
    // subject is the doc entity, not the file URN) is preserved through
    // promote; rows 4-13 are WM-only by design. See Codex Bug 8 Round 4
    // reconciled ruling — Round 3 tried blank-node subjects, but an
    // `skolemizeByEntity` audit showed they silently drop the prov block on
    // promote, which was a correctness smell. See `19_MARKDOWN_CONTENT_TYPE.md
    // §10.2` for the normative rule.
    const fileUri = `urn:dkg:file:${fileStoreEntry.keccak256}`;
    const provUri = `urn:dkg:extraction:${randomUUID()}`;
    const agentDid = `did:dkg:agent:${agent.peerId}`;

    // ── Phase 2: markdown → triples + linkage ──
    let triples;
    let sourceFileLinkage;
    let documentSubjectIri: string;
    let resolvedRootEntity: string;
    try {
      // The extractor owns rows 1 and 3. Row 2 (dkg:sourceContentType) is
      // daemon-owned — it must describe the ORIGINAL upload blob (row 1's
      // target), not the markdown intermediate the extractor processes.
      // Only the daemon has `detectedContentType` here, so it emits row 2
      // itself below alongside the file descriptor block.
      let result = extractFromMarkdown({
        markdown: mdIntermediate,
        agentDid,
        ontologyRef,
        documentIri: assertionUri,
        sourceFileIri: fileUri,
      });
      // Issue #122 interim rule: the import-file path still pins the
      // document subject to the assertion URI. A divergent frontmatter
      // `rootEntity` would require distinct document-vs-root identity
      // plumbing through promote/update paths; until that lands, reject
      // the override explicitly rather than silently rewriting content
      // triples onto a different subject during import.
      if (result.resolvedRootEntity !== assertionUri) {
        importRootEntity = result.resolvedRootEntity;
        const reservedPrefix = findReservedSubjectPrefix(
          result.resolvedRootEntity,
        );
        if (reservedPrefix) {
          return respondWithFailedExtraction(
            400,
            `Frontmatter 'rootEntity' resolves to the reserved namespace '${reservedPrefix}*', which is protocol-reserved for daemon-generated import bookkeeping subjects.`,
            0,
          );
        }
        if (isSkolemizedUri(result.resolvedRootEntity)) {
          return respondWithFailedExtraction(
            400,
            `Frontmatter 'rootEntity' resolves to the skolemized URI '${result.resolvedRootEntity}', but import-file rootEntity must identify a root subject rather than a skolemized child (/.well-known/genid/...).`,
            0,
          );
        }
        return respondWithFailedExtraction(
          400,
          `Frontmatter 'rootEntity' override is not yet supported on the import-file path when it diverges from the imported document subject. Remove the 'rootEntity' key from frontmatter or make it match the document subject; tracking issue #122.`,
          0,
        );
      }
      triples = result.triples;
      // Round 13 Bug 39: `provenance` renamed to `sourceFileLinkage`.
      // The old name conflicted with its original extraction-run
      // metadata semantic, which was moved to daemon-owned rows 9-13
      // (on the `<urn:dkg:extraction:uuid>` subject) in Round 9 Bug 27.
      // The extractor now only emits rows 1 and 3 of the source-file
      // linkage block, so the field's name reflects that directly.
      sourceFileLinkage = result.sourceFileLinkage;
      documentSubjectIri = result.subjectIri;
      // §19.10.1:508 precedence: frontmatter `rootEntity` > explicit input >
      // reflexive subject. The extractor has already applied it to row 3;
      // reuse the resolved value for `_meta` row 14 below so row 3 and row
      // 14 are guaranteed to agree on the same root entity.
      resolvedRootEntity = result.resolvedRootEntity;
      importRootEntity = resolvedRootEntity;
    } catch (err: any) {
      // Bug 13 + Round 7 Bug 20: invalid frontmatter IRIs AND invalid
      // programmatic `rootEntityIri` / `sourceFileIri` inputs both
      // throw from the extractor with a clear message. Surface as a
      // 400 so the user sees it immediately rather than a generic 500.
      const message = err?.message ?? String(err);
      if (
        message.includes("Invalid frontmatter") ||
        message.includes("Invalid 'rootEntityIri'") ||
        message.includes("Invalid 'sourceFileIri'")
      ) {
        return respondWithFailedExtraction(400, message, 0);
      }
      return respondWithFailedExtraction(
        500,
        `Phase 2 extraction failed: ${message}`,
        0,
      );
    }

    // ── Build the full quad set for both graphs (atomic single insert) ──
    // We assemble rows 1-13 as data-graph quads + rows 14-20 as CG root
    // `_meta` quads, each with its own explicit `graph` field, and commit
    // them all in ONE `agent.store.insert(...)` call. Every supported
    // triple-store adapter (oxigraph, blazegraph, sparql-http) implements
    // `insert` as a single N-Quads load / `INSERT DATA` operation, so the
    // call is naturally atomic across graphs: either every row lands or
    // none does. This replaces the earlier two-call flow
    // (`assertion.write` + `store.insert`) which had a window where rows
    // 1-13 could commit and rows 14-20 fail, leaving dangling data.
    //
    // `assertion.create` still runs first to register the assertion graph
    // container (idempotent on "already exists"). The write itself
    // bypasses `assertion.write` so the daemon can atomically insert both
    // data-graph and `_meta` rows in one store operation. Generic assertion
    // writes preserve user named-graph metadata inside KA-scoped storage, but
    // they are still content writes; this import path also owns daemon-stamped
    // provenance rows and must commit those graphs together. Sub-graph
    // registration is already validated by
    // `assertion.create`, so bypassing `assertion.write` doesn't skip any
    // safety checks.
    let assertionGraph = contextGraphAssertionUri(
      contextGraphId!,
      requestAgentAddress,
      assertionName,
      subGraphName,
    );
    const metaGraph = contextGraphMetaUri(contextGraphId!);
    const startedAtLiteral = `"${startedAt}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`;
    const markdownFormUri = mdIntermediateHash
      ? `urn:dkg:file:${mdIntermediateHash}`
      : fileUri;

    // Data-graph quads: content (triples) + extractor linkage (provenance)
    // + daemon-owned rows 2, markdownForm, 4, 5, 8, 9-13. Every quad is pinned to the
    // assertion graph URI. `triples` and `provenance` come from the
    // extractor without a `graph` field, so we stamp each one here.
    //
    // Round 9 Bug 27: rows 6 (`dkg:fileName`) and 7 (`dkg:contentType`)
    // are REMOVED from the file descriptor block. `<fileUri>` is
    // content-addressed — two imports of identical bytes under different
    // filenames / upload content types would have written contradictory
    // facts to the same subject. Per-upload metadata now lives on the
    // assertion UAL in `_meta` (new row 15a: `dkg:sourceFileName`,
    // existing row 15: `dkg:sourceContentType` already there) where
    // per-assertion facts belong. Only intrinsic-to-content properties
    // (rdf:type, dkg:contentHash, dkg:size) remain on `<fileUri>` —
    // those are safe because they're derived purely from the blob bytes.
    // See `19_MARKDOWN_CONTENT_TYPE.md §10.2`.
    let dataGraphQuads = [
      ...triples.map((t) => ({ ...t, graph: assertionGraph })),
      ...sourceFileLinkage.map((t) => ({ ...t, graph: assertionGraph })),
      // Row 2 — daemon-owned. Describes the ORIGINAL upload blob (row 1's
      // target), so for a PDF upload this is "application/pdf" — NOT the
      // markdown intermediate the extractor processes. Extractor never
      // emits this row; the daemon is the single source of truth. Its
      // subject matches rows 1 and 3 on the resolved document entity.
      {
        subject: documentSubjectIri,
        predicate: "http://dkg.io/ontology/sourceContentType",
        object: JSON.stringify(detectedContentType),
        graph: assertionGraph,
      },
      // Graph-level link to the markdown bytes structural extraction ran
      // against. For markdown-native uploads this equals row 1's object;
      // for converter-backed uploads it points at the stored intermediate.
      {
        subject: documentSubjectIri,
        predicate: "http://dkg.io/ontology/markdownForm",
        object: markdownFormUri,
        graph: assertionGraph,
      },
      // Row 4 — file descriptor block subject is the content-addressed URN
      {
        subject: fileUri,
        predicate: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
        object: "http://dkg.io/ontology/File",
        graph: assertionGraph,
      },
      // Row 5 — on-chain canonical hash format is keccak256:<hex>
      {
        subject: fileUri,
        predicate: "http://dkg.io/ontology/contentHash",
        object: JSON.stringify(fileStoreEntry.keccak256),
        graph: assertionGraph,
      },
      // Row 8 — xsd:integer for size (byte count)
      {
        subject: fileUri,
        predicate: "http://dkg.io/ontology/size",
        object: `"${fileStoreEntry.size}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
        graph: assertionGraph,
      },
      // Row 9 — ExtractionProvenance subject is a fresh UUID URN per import
      {
        subject: provUri,
        predicate: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
        object: "http://dkg.io/ontology/ExtractionProvenance",
        graph: assertionGraph,
      },
      // Row 10 — back-references the ORIGINAL upload file URN (same value
      // as rows 4-5, 8 subject). The new `dkg:markdownForm` entity link
      // above separately exposes the markdown bytes Phase 2 actually read.
      {
        subject: provUri,
        predicate: "http://dkg.io/ontology/extractedFrom",
        object: fileUri,
        graph: assertionGraph,
      },
      // Row 11
      {
        subject: provUri,
        predicate: "http://dkg.io/ontology/extractedBy",
        object: agentDid,
        graph: assertionGraph,
      },
      // Row 12
      {
        subject: provUri,
        predicate: "http://dkg.io/ontology/extractedAt",
        object: startedAtLiteral,
        graph: assertionGraph,
      },
      // Row 13
      {
        subject: provUri,
        predicate: "http://dkg.io/ontology/extractionMethod",
        object: JSON.stringify("structural"),
        graph: assertionGraph,
      },
    ];

    // `_meta` quads (rows 14-20): always land in the CG ROOT `_meta`, never
    // a sub-graph `_meta`, keyed by the assertion UAL so daemon restarts
    // can recover the file ↔ assertion linkage from the graph alone.
    const metaQuads: Array<{
      subject: string;
      predicate: string;
      object: string;
      graph: string;
    }> = [
      // Row 14 — rootEntity comes from the extractor's resolved value so
      // the data-graph row 3 and `_meta` row 14 point at the same IRI.
      {
        subject: assertionUri,
        predicate: "http://dkg.io/ontology/rootEntity",
        object: resolvedRootEntity,
        graph: metaGraph,
      },
      // Row 15 — original content type from the upload (matches row 2
      // now that both rows are sourced from `detectedContentType`).
      {
        subject: assertionUri,
        predicate: "http://dkg.io/ontology/sourceContentType",
        object: JSON.stringify(detectedContentType),
        graph: metaGraph,
      },
      // Row 16 — load-bearing: lets a caller look up the source blob by UAL alone.
      {
        subject: assertionUri,
        predicate: "http://dkg.io/ontology/sourceFileHash",
        object: JSON.stringify(fileStoreEntry.keccak256),
        graph: metaGraph,
      },
      // Row 17
      {
        subject: assertionUri,
        predicate: "http://dkg.io/ontology/extractionMethod",
        object: JSON.stringify("structural"),
        graph: metaGraph,
      },
      // Row 18 - durable terminal import state used by artifact readers after restart.
      {
        subject: assertionUri,
        predicate: "http://dkg.io/ontology/extractionStatus",
        object: JSON.stringify("completed"),
        graph: metaGraph,
      },
      // Row 19
      {
        subject: assertionUri,
        predicate: "http://dkg.io/ontology/structuralTripleCount",
        object: `"${triples.length}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
        graph: metaGraph,
      },
      // Row 20 - V10.0 has no semantic (Layer 2) extraction, so always zero.
      {
        subject: assertionUri,
        predicate: "http://dkg.io/ontology/semanticTripleCount",
        object: `"0"^^<http://www.w3.org/2001/XMLSchema#integer>`,
        graph: metaGraph,
      },
    ];
    // Row 20 — only emitted when Phase 1 actually ran (PDF/DOCX path).
    if (mdIntermediateHash) {
      metaQuads.push({
        subject: assertionUri,
        predicate: "http://dkg.io/ontology/mdIntermediateHash",
        object: JSON.stringify(mdIntermediateHash),
        graph: metaGraph,
      });
    }
    // Round 9 Bug 27: `dkg:sourceFileName` — per-upload metadata that
    // used to live on `<fileUri>` (row 6 in the old file descriptor
    // block) moves to `_meta` keyed by `<assertionUri>` so two imports
    // of identical bytes under different filenames don't collide on
    // the same content-addressed subject. Symmetric to row 15
    // (`dkg:sourceContentType`). Skipped entirely when the upload
    // didn't carry a filename (matches the row 20 optional pattern).
    if (uploadedFilename) {
      metaQuads.push({
        subject: assertionUri,
        predicate: "http://dkg.io/ontology/sourceFileName",
        object: JSON.stringify(uploadedFilename),
        graph: metaGraph,
      });
    }
    try {
      assertQuadLiteralsMutf8Safe([...dataGraphQuads, ...metaQuads], {
        label: 'import-file.quads',
      });
    } catch (err: any) {
      if (err?.code === "OVERSIZED_RDF_LITERAL") {
        const oversizedBody = oversizedRdfLiteralResponseBody(err);
        return respondWithFailedExtraction(
          400,
          String(oversizedBody.error ?? err.message),
          triples.length,
          pipelineUsed,
          oversizedBody as Partial<
            Pick<
              ImportFileExtractionPayload,
              "code" | "limitBytes" | "actualBytes" | "subject" | "predicate" | "graph"
            >
          >,
        );
      }
      throw err;
    }

    // Round 14 Bug 42: lock acquisition moved to the top of the
    // handler, before Phase 1/2 extraction. This inner `try` now
    // wraps only the assertion.create + snapshot + cleanup + insert
    // + rollback sequence. See the lock-acquisition site above for
    // the full rationale.
    try {
      // Ensure the assertion graph exists even when Phase 2 yields zero
      // content triples, so a completed import always materializes the
      // reported assertion URI. `assertion.create` also runs the sub-graph
      // registration check, so bypassing `assertion.write` below doesn't
      // skip that safety gate.
      try {
        // Use the allocating create (mints the kaNumber for requestAgentAddress) so the
        // subsequent wmGraphUri resolves the per-KA …/_working_memory/{addr}/{number} graph
        // instead of falling back to the legacy name-keyed graph the WM view can't read.
        await agent.assertion.create(
          contextGraphId!,
          assertionName,
          { subGraphName, agentAddress: requestAgentAddress },
        );
      } catch (err: any) {
        const message = err?.message ?? String(err);
        if (
          message.includes("already exists") ||
          message.includes("duplicate") ||
          message.includes("conflict")
        ) {
          // create() is idempotent when the graph already exists.
        } else if (
          message.includes("has not been registered") ||
          message.includes("Invalid") ||
          message.includes("Unsafe")
        ) {
          return respondWithFailedExtraction(400, message, triples.length);
        } else {
          return respondWithFailedExtraction(500, message, triples.length);
        }
      }

      // rc.17 uniform per-KA WM: `assertionCreate` above minted the KA number and
      // registered the canonical `…/_working_memory/{addr}/{number}` graph (plus the
      // `_meta` `dkg:assertionGraph` pointer at it). The import data + provenance were
      // built BEFORE the number existed, pinned to the legacy name-keyed
      // `…/assertion/{addr}/{name}` graph — which the working-memory view (it reads ONLY
      // the `_working_memory/{addr}/` prefix) can never surface, so imports showed nothing
      // in WM. Re-pin them to the resolved WM graph so they're visible + match the registry.
      assertionGraph = await agent.publisher.wmGraphUri(
        contextGraphId!,
        requestAgentAddress,
        assertionName,
        subGraphName,
      );
      dataGraphQuads = dataGraphQuads.map((q) => ({ ...q, graph: assertionGraph }));

      // ── Snapshot BOTH graphs for Bugs 11 + 15 rollback ──
      //
      // Before the destructive cleanup (dropGraph + deleteByPattern),
      // CONSTRUCT the current contents of BOTH the assertion data graph
      // AND the assertion's `_meta` rows so the rollback path can
      // restore either or both if the subsequent atomic `store.insert`
      // fails.
      //
      // Round 4 (Bug 11) added the data-graph snapshot but NOT the
      // `_meta` snapshot, which left an edge case: a transient insert
      // failure would restore the prior data graph but leave `_meta`
      // empty for this assertion. Codex Bug 15 called that out — the
      // old `sourceFileHash` / `rootEntity` rows need to come back too.
      //
      // The data-graph CONSTRUCT pulls every quad where the assertion
      // graph is the context. The `_meta` CONSTRUCT is scoped to the
      // `<assertionUal> ?p ?o` subject pattern inside the CG root
      // `_meta` graph — we only rollback rows keyed by THIS assertion,
      // not every row in the shared `_meta` graph.
      //
      // First-import case: both CONSTRUCTs return zero quads (nothing
      // to preserve), and the rollback path is a no-op on both sides.
      let dataSnapshot: Array<{
        subject: string;
        predicate: string;
        object: string;
        graph: string;
      }> = [];
      let dataGraphs = [assertionGraph];
      let metaSnapshot: Array<{
        subject: string;
        predicate: string;
        object: string;
        graph: string;
      }> = [];
      try {
        const dataResult = await agent.store.query(
          `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${assertionGraph}> { ?s ?p ?o } }`,
        );
        if (dataResult.type === "quads") {
          // Pin the graph field to the assertion graph URI — CONSTRUCT
          // result quads have graph="" by adapter convention, but the
          // rollback re-insert needs to target the original graph.
          dataSnapshot = dataResult.quads.map((q) => ({
            ...q,
            graph: assertionGraph,
          }));
        }
        dataGraphs = await listAssertionScopedGraphUris(agent.store, assertionGraph, 'always');
        for (const graph of dataGraphs.filter((candidate) => candidate !== assertionGraph)) {
          const childResult = await agent.store.query(
            `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`,
          );
          if (childResult.type === "quads") {
            dataSnapshot.push(...childResult.quads.map((q) => ({
              ...q,
              graph,
            })));
          }
        }
      } catch (err: any) {
        const message = err?.message ?? String(err);
        // Round 13 Bug 38: mark the error so the outer catch doesn't
        // overwrite this stage-specific failure record with the raw
        // store error. Callers reading `/extraction-status` see
        // "Failed to snapshot assertion data graph for rollback: ..."
        // which tells them WHICH stage of the import pipeline broke,
        // not just the underlying store error in isolation.
        recordFailedExtraction(
          `Failed to snapshot assertion data graph for rollback: ${message}`,
          0,
        );
        (err as any).__failureAlreadyRecorded = true;
        throw err;
      }
      try {
        const metaResult = await agent.store.query(
          `CONSTRUCT { <${assertionUri}> ?p ?o } WHERE { GRAPH <${metaGraph}> { <${assertionUri}> ?p ?o } }`,
        );
        if (metaResult.type === "quads") {
          // Same graph-field pinning as above — preserve `metaGraph`
          // on every snapshotted quad so the rollback re-insert targets
          // the CG root `_meta` graph, not the empty default graph.
          metaSnapshot = metaResult.quads.map((q) => ({
            ...q,
            graph: metaGraph,
          }));
        }
      } catch (err: any) {
        const message = err?.message ?? String(err);
        // Round 13 Bug 38: same stage-context preservation as the
        // dataSnapshot failure branch above.
        recordFailedExtraction(
          `Failed to snapshot _meta for rollback: ${message}`,
          0,
        );
        (err as any).__failureAlreadyRecorded = true;
        throw err;
      }

      // ── Clear stale content from BOTH graphs before the fresh insert ──
      //
      // import-file has REPLACE semantics on same-name re-import: the
      // assertion ends up with exactly the content of the latest upload,
      // not a merge of every prior upload. Without this cleanup:
      //
      // 1. `_meta` rows 14-20 keyed by `<assertionUal>` would stack a
      //    second block next to the old one, so
      //    `<assertionUal> dkg:sourceFileHash ?h` would return two
      //    different hashes with no way to tell which is canonical.
      //
      // 2. Data-graph rows 1 and 4-13 would leave the old blob's
      //    descriptor next to the new blob's — a consumer walking the
      //    assertion graph would see two source files for one assertion.
      //
      // Order (Bug 14 reorder): `_meta` cleanup runs FIRST, then
      // `dropGraph`. This matches the Bug 12 pattern in
      // `assertionDiscard`. Both primitives are idempotent:
      // `deleteByPattern` returns 0 on a fresh assertion, `dropGraph`
      // uses `DROP SILENT GRAPH` so it's a no-op on a missing graph.
      //
      // Round 7 Bug 22: the Round 5/6 rollback path only fired when
      // the atomic `store.insert` failed. If `dropGraph` failed AFTER
      // `deleteByPattern` succeeded, the old `_meta` rows were gone
      // and the old data graph was still intact — a self-inconsistent
      // state with no rollback. Track which cleanup steps succeeded
      // and, on ANY subsequent failure, restore whichever snapshots
      // correspond to state we actually corrupted:
      //
      //  - `metaCleanupSucceeded` → restore `metaSnapshot`
      //  - a graph added to `droppedDataGraphs` → restore its `dataSnapshot`
      //  - insert succeeded → no rollback
      //  - `deleteByPattern` itself failed → no rollback (nothing
      //    changed, retry converges cleanly)
      //
      // The rollback is best-effort: compound failures record a rich
      // error with every failure message, then rethrow the ORIGINAL
      // error so the 500 envelope matches what the caller experienced.
      let metaCleanupSucceeded = false;
      let dataDropSucceeded = false;
      const droppedDataGraphs = new Set<string>();
      try {
        await deleteByPatternWithoutCount(agent.store, {
          subject: assertionUri,
          graph: metaGraph,
        });
        metaCleanupSucceeded = true;
        const dataGraphsToDrop = [...dataGraphs].sort((a, b) => {
          if (a === assertionGraph) return 1;
          if (b === assertionGraph) return -1;
          return a.localeCompare(b);
        });
        for (const graph of dataGraphsToDrop) {
          await agent.store.dropGraph(graph);
          droppedDataGraphs.add(graph);
          dataDropSucceeded = true;
        }
        // ── Atomic multi-graph insert: rows 1-13 + rows 14-20 in one call ──
        // A single `store.insert` across two graphs — either both
        // land or neither does, per the adapter contracts.
        await agent.store.insert([...dataGraphQuads, ...metaQuads]);
      } catch (writeErr: any) {
        const writeMsg = writeErr?.message ?? String(writeErr);
        const rollbackErrors: string[] = [];
        // Restore each side we corrupted, in reverse order of the
        // forward sequence (insert → dropGraph → deleteByPattern).
        // `dataSnapshot` is restored only for graphs whose `dropGraph`
        // succeeded (before then the old data is still in the store); likewise
        // `metaSnapshot` is restored only if `deleteByPattern`
        // succeeded. On a `deleteByPattern`-only failure both flags
        // are false and no rollback fires — the state is unchanged.
        const droppedDataSnapshot = dataSnapshot.filter((q) => droppedDataGraphs.has(q.graph));
        if (dataDropSucceeded && droppedDataSnapshot.length > 0) {
          try {
            await agent.store.insert(droppedDataSnapshot);
          } catch (dataRollbackErr: any) {
            rollbackErrors.push(
              `data rollback failed: ${dataRollbackErr?.message ?? dataRollbackErr}`,
            );
          }
        }
        if (metaCleanupSucceeded && metaSnapshot.length > 0) {
          try {
            await agent.store.insert(metaSnapshot);
          } catch (metaRollbackErr: any) {
            rollbackErrors.push(
              `_meta rollback failed: ${metaRollbackErr?.message ?? metaRollbackErr}`,
            );
          }
        }
        if (rollbackErrors.length > 0) {
          // One or both rollback re-inserts failed. Log the compound
          // failure with every error message so a human can diagnose
          // the state, then rethrow the original error so the
          // top-level 500 handler responds with the envelope that
          // matches what the caller actually experienced.
          recordFailedExtraction(
            `write stage failed AND rollback failures: ${writeMsg}; ${rollbackErrors.join("; ")}`,
            triples.length,
          );
          (writeErr as any).__failureAlreadyRecorded = true;
        } else {
          const previousStatusRecord =
            getRestorablePreviousExtractionStatusRecord(metaSnapshot);
          if (previousStatusRecord) {
            (writeErr as any).__previousExtractionStatusRecord =
              previousStatusRecord;
          }
        }
        throw writeErr;
      }
    } catch (err: any) {
      const message = err?.message ?? String(err);
      // Round 10 Bug 29: the previous `message.includes('Invalid' |
      // 'Unsafe' | 'has not been registered')` branches were moved
      // OUT of this outer catch. They now live only in the inner
      // `assertion.create` catch above (lines 2815-2828), which is
      // the only step in this block where a user-input validation
      // error can legitimately originate.
      //
      // The outer catch is only reachable for post-`assertion.create`
      // steps — snapshot queries, `_meta` cleanup, `dropGraph`, atomic
      // insert, and rollback re-inserts. Those all operate on
      // daemon-constructed quads and storage-layer primitives; an
      // `Invalid` or `Unsafe` substring in a thrown message from
      // those steps signals an INTERNAL storage error (e.g., an
      // Oxigraph `Invalid query plan` or a replication layer
      // `Unsafe write`), not a user-input failure. Misclassifying
      // them as HTTP 400 would mislead the caller into retrying
      // with a "fixed" payload when the problem was server-side.
      // Let them bubble up as 500 via the top-level handler.
      //
      // Bug 15: compound rollback failure already wrote a rich error
      // record — don't overwrite it with the bare insert error.
      if ((err as any)?.__failureAlreadyRecorded) {
        throw err;
      }
      // Unexpected write-stage failure: record the failure on the extraction
      // status map before rethrowing so /extraction-status doesn't stay stuck
      // at in_progress when the top-level 500 handler takes over. Because
      // the insert is atomic across both graphs, nothing landed and a retry
      // sees a clean slate.
      recordFailedExtraction(message, triples.length);
      const previousStatusRecord = (err as any)?.__previousExtractionStatusRecord as
        | ExtractionStatusRecord
        | undefined;
      if (previousStatusRecord) {
        restoreExtractionStatusRecord(previousStatusRecord);
      }
      throw err;
    }

    const completedRecord: ExtractionStatusRecord = {
      status: "completed",
      fileHash: fileStoreEntry.keccak256,
      ...(uploadedFilename ? { fileName: uploadedFilename } : {}),
      ...(importRootEntity ? { rootEntity: importRootEntity } : {}),
      detectedContentType,
      pipelineUsed,
      tripleCount: triples.length,
      mdIntermediateHash,
      startedAt,
      completedAt: new Date().toISOString(),
    };
    setExtractionStatusRecord(
      extractionStatus,
      assertionUri,
      completedRecord,
    );
    emitMemoryGraphChanged?.({
      contextGraphId: contextGraphId!,
      layers: ["wm"],
      subGraphName,
      operation: "assertion_imported",
      source: "api",
      counts: { triples: triples.length },
    });

    return respondWithImportFileResponse(200, {
      status: "completed",
      tripleCount: triples.length,
      pipelineUsed,
      ...(mdIntermediateHash ? { mdIntermediateHash } : {}),
    });
  } finally {
    // Round 14 Bug 42 outer finally: release the per-assertion
    // lock so the next waiter can start. Runs regardless of
    // early returns (graceful-degrade skipped path, failed-
    // extraction paths, successful completion) AND regardless
    // of whether the inner write-stage try/catch threw. The map
    // entry is cleaned up iff this call is still the head of
    // the queue — if another waiter has chained on after us, its
    // chained promise has already replaced our slot in the map
    // and we leave it alone.
    releaseLock();
    if (assertionImportLocks.get(assertionUri) === chainedLock) {
      assertionImportLocks.delete(assertionUri);
    }
  }
}

// GET /api/knowledge-assets/:name/wm/extraction-status?contextGraphId=...&subGraphName=...
// Returns the current extraction job state for the given assertion.
// Synchronous extractions (V10.0 default) return status="completed" immediately
// on the import-file response; this endpoint lets agents re-query the status
// later without having to hold the import-file response, and provides the hook
// for async extraction workflows in V10.x.
//
// Faithful port of the legacy GET /api/assertion/:name/extraction-status handler
// (daemon/routes/assertion.ts): identical name + contextGraphId + subGraphName
// validation, extractionStatus map lookup, 404 mapping, and response shape. The
// dispatcher passes the already-decoded `name`.
export async function handleKaExtractionStatus(ctx: RequestContext, name: string): Promise<void> {
  const { res, url, extractionStatus, requestAgentAddress } = ctx;
  const assertionName = name;
  const nameVal = validateAssertionName(assertionName);
  if (!nameVal.valid)
    return jsonResponse(res, 400, {
      error: `Invalid assertion name: ${nameVal.reason}`,
    });
  const contextGraphId =
    url.searchParams.get("contextGraphId") ??
    url.searchParams.get("contextGraphId");
  if (!validateRequiredContextGraphId(contextGraphId, res)) return;
  const normalizedContextGraphId = normalizeContextGraphIdOrUri(contextGraphId!);
  const subGraphName = url.searchParams.get("subGraphName") ?? undefined;
  if (!validateOptionalSubGraphName(subGraphName, res)) return;

  const assertionUri = contextGraphAssertionUri(
    normalizedContextGraphId,
    requestAgentAddress,
    assertionName,
    subGraphName,
  );
  const record = getExtractionStatusRecord(extractionStatus, assertionUri);
  if (!record) {
    return jsonResponse(res, 404, {
      error: `No extraction record found for assertion "${assertionName}" in context graph "${normalizedContextGraphId}"`,
    });
  }
  return jsonResponse(res, 200, {
    assertionUri,
    status: record.status,
    fileHash: record.fileHash,
    ...(record.rootEntity ? { rootEntity: record.rootEntity } : {}),
    detectedContentType: record.detectedContentType,
    pipelineUsed: record.pipelineUsed,
    tripleCount: record.tripleCount,
    ...(record.mdIntermediateHash
      ? { mdIntermediateHash: record.mdIntermediateHash }
      : {}),
    ...(record.error ? { error: record.error } : {}),
    startedAt: record.startedAt,
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
  });
}
