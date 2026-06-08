// daemon/routes/shared-assertion-helpers.ts
//
// Shared helper functions / types / classes extracted verbatim from
// `daemon/routes/assertion.ts` so they can be reused by the new
// `/api/knowledge-assets` route ports while `assertion.ts` is wound
// down. Implementations are unchanged; `assertion.ts` re-imports the
// moved symbols from this module.

import type { ServerResponse } from "node:http";
import {
  validateSubGraphName,
  validateAssertionName,
  isSafeIri,
  assertSafeIri,
  assertSafeRdfTerm,
  escapeDkgRdfLiteral,
  contextGraphSharedMemoryUri,
  contextGraphAssertionUri,
  contextGraphMetaUri,
} from '@origintrail-official/dkg-core';
import { type PromoteJob, type PromoteJobState } from '@origintrail-official/dkg-publisher';
import { daemonState } from '../state.js';
import { normalizeDetectedContentType } from '../manifest.js';
import {
  jsonResponse,
  safeDecodeURIComponent,
  normalizeContextGraphIdOrUri,
  isValidContextGraphId,
} from '../http-utils.js';
import {
  stripOpenClawAttachmentLiteral,
  parseOpenClawAttachmentTripleCount,
} from '../openclaw.js';
import { getExtractionStatusRecord } from '../../extraction-status.js';
import type { RequestContext } from './context.js';

const DKG_ONTOLOGY = 'http://dkg.io/ontology/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const PROV = 'http://www.w3.org/ns/prov#';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const XSD_DATE_TIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
const MAX_MARKDOWN_READ_BYTES = 5 * 1024 * 1024;
const DEFAULT_MARKDOWN_READ_BYTES = 1024 * 1024;

export type ImportedArtifactResolution = {
  contextGraphId: string;
  assertionUri: string;
  assertionName: string;
  assertionAgentAddress: string;
  subGraphName?: string;
  fileHash: string;
  sourceFileHash: string;
  detectedContentType: string;
  sourceContentType: string;
  extractionStatus: 'completed';
  extractionMethod?: string;
  rootEntity?: string;
  sourceFileName?: string;
  tripleCount?: number;
  structuralTripleCount?: number;
  semanticTripleCount?: number;
  mdIntermediateHash?: string;
  markdownForm?: string;
  markdownHash?: string;
  canReadMarkdown: boolean;
  /**
   * Issue #872 — set to `true` when the request would have been
   * blocked by the legacy owner guard but the CG's on-chain policy
   * (`accessPolicy === 0` AND `publishPolicy === 1`) made the guard
   * inapplicable. The read-markdown route uses this to distinguish
   * "owner request, missing bytes" (genuine corruption) from
   * "cross-agent request, bytes not replicated locally" (expected
   * until the source-artifact gossip follow-up lands). Omitted when
   * the requester IS the assertion owner.
   */
  ownerGuardRelaxed?: boolean;
};

export class ImportArtifactRouteError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function bindingCellValue(cell: unknown): string {
  if (typeof cell === 'string') return cell;
  if (cell && typeof cell === 'object' && 'value' in cell) {
    const value = (cell as { value?: unknown }).value;
    return typeof value === 'string' ? value : '';
  }
  return '';
}

export function normalizeLiteralBinding(cell: unknown): string {
  return stripOpenClawAttachmentLiteral(bindingCellValue(cell)).trim();
}

export function normalizeIriBinding(cell: unknown): string {
  return bindingCellValue(cell).replace(/^<|>$/g, '').trim();
}

export function singletonMetadataBinding(
  bindings: Array<Record<string, unknown>>,
  key: string,
  normalize: (cell: unknown) => string,
  label: string,
): string {
  const values = [...new Set(bindings.map((binding) => normalize(binding[key])).filter(Boolean))];
  if (values.length > 1) {
    throw new ImportArtifactRouteError(409, `Import metadata contains conflicting ${label} values`);
  }
  return values[0] ?? '';
}

export function optionalPositiveInteger(cell: unknown): number | undefined {
  return parseOpenClawAttachmentTripleCount(bindingCellValue(cell));
}

export function optionalStrictPositiveInteger(cell: unknown): number | undefined {
  const value = normalizeLiteralBinding(cell);
  if (!/^\+?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function hashFromFileUrn(value: string | undefined): string | undefined {
  const prefix = 'urn:dkg:file:';
  if (!value?.startsWith(prefix)) return undefined;
  const hash = value.slice(prefix.length);
  return /^[a-z0-9]+:[0-9a-f]{64}$/i.test(hash) ? hash : undefined;
}

export function validateContentHash(hash: string): boolean {
  return /^(?:sha256:|keccak256:)?[0-9a-f]{64}$/i.test(hash);
}

export function validatePromoteJobId(jobId: string): { valid: true } | { valid: false; reason: string } {
  if (!jobId) return { valid: false, reason: "jobId is required" };
  if (jobId.length > 256) return { valid: false, reason: "jobId is too long" };
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(jobId)) {
    return {
      valid: false,
      reason: "jobId may only contain letters, numbers, '.', '_', ':', and '-'",
    };
  }
  return { valid: true };
}

export function decodePromoteJobId(encoded: string, res: ServerResponse): string | null {
  const jobId = safeDecodeURIComponent(encoded, res);
  if (jobId === null) return null;
  const validation = validatePromoteJobId(jobId);
  if (!validation.valid) {
    jsonResponse(res, 400, { error: `Invalid promote jobId: ${validation.reason}` });
    return null;
  }
  return jobId;
}

// ── Async-promote wire schema (RFC §3.2 + §3.3) ──────────────────────────────
//
// The internal `PromoteJob` shape persisted by the queue carries
// implementation details the HTTP contract is not allowed to leak:
//   - `lease.claimToken` (opaque worker-side capability),
//   - `lease.workerId` / heartbeat metadata,
//   - numeric epoch timestamps,
//   - `commitMarker` (internal idempotency bookkeeping).
//
// `PromoteJobView` is the documented public shape per RFC §3.2; ISO-8601
// timestamps, a flat top level for assertion identity, and a stable
// `lastError.code` enum mapped from the queue's failure classification.
// The list (§3.3) and status (§3.2) endpoints share `promoteJobToView()`
// so both surfaces stay in lockstep.

export interface PromoteJobErrorView {
  code: string;
  message: string;
  retryable: boolean;
}

export interface PromoteJobView {
  jobId: string;
  state: PromoteJobState;
  contextGraphId: string;
  assertionName: string;
  subGraphName?: string;
  entities: readonly string[] | 'all';
  enqueuedAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  entitiesPromoted?: number;
  attempts: number;
  maxAttempts: number;
  nextRetryAt?: string;
  lastError?: PromoteJobErrorView;
  reason?: string;
}

export function isoFromEpochMs(ms: number | undefined): string | undefined {
  if (ms === undefined || ms === null) return undefined;
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

export function promoteJobToView(job: PromoteJob): PromoteJobView {
  // `startedAt` reflects the current attempt's lease acquisition; while
  // running the lease is present, after success/failure the queue clears
  // it so the field naturally goes away. `finishedAt` is sourced from
  // the terminal-state evidence the queue already records:
  // `result.succeededAt` for success and `attempt.lastError.recordedAt`
  // for failed / failed_retrying. Cancelled jobs (no lastError, no
  // result) fall back to `updatedAt` because that's the only durable
  // timestamp for that transition.
  const startedAt = isoFromEpochMs(job.lease?.acquiredAt);
  let finishedAt: string | undefined;
  if (job.state === 'succeeded') {
    finishedAt = isoFromEpochMs(job.result?.succeededAt) ?? isoFromEpochMs(job.updatedAt);
  } else if (job.state === 'failed' || job.state === 'failed_retrying') {
    finishedAt =
      isoFromEpochMs(job.attempt.lastError?.recordedAt) ?? isoFromEpochMs(job.updatedAt);
  }

  const lastError: PromoteJobErrorView | undefined = job.attempt.lastError
    ? {
        code: job.attempt.lastError.classification,
        message: job.attempt.lastError.message,
        retryable: job.attempt.lastError.retryable,
      }
    : undefined;

  const view: PromoteJobView = {
    jobId: job.jobId,
    state: job.state,
    contextGraphId: job.request.contextGraphId,
    assertionName: job.request.assertionName,
    entities: job.request.entities,
    enqueuedAt: new Date(job.enqueuedAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
    attempts: job.attempt.count,
    maxAttempts: job.attempt.maxRetries,
  };
  if (job.request.subGraphName !== undefined) view.subGraphName = job.request.subGraphName;
  if (startedAt !== undefined) view.startedAt = startedAt;
  if (finishedAt !== undefined) view.finishedAt = finishedAt;
  if (job.result?.promotedCount !== undefined) view.entitiesPromoted = job.result.promotedCount;
  const nextRetryAt = isoFromEpochMs(job.attempt.nextRetryAt);
  if (nextRetryAt !== undefined) view.nextRetryAt = nextRetryAt;
  if (lastError !== undefined) view.lastError = lastError;
  if (job.reason !== undefined) view.reason = job.reason;
  return view;
}

// Helper used by the five `/promote-async` routes below to refuse work
// when no worker is actually draining the queue (RFC §3.1 — the
// implementation plan parks the supervisor in a follow-up PR; until then
// `daemonState.promoteWorkerAvailable` stays `false` and we return 503
// rather than silently accept jobs that would sit in `queued` forever).
export function asyncPromoteUnavailable(res: ServerResponse): boolean {
  if (daemonState.promoteWorkerAvailable) return false;
  const reason = daemonState.promoteWorkerUnavailableReason;
  jsonResponse(res, 503, {
    error:
      `async-promote worker is not available` +
      (reason ? `: ${reason}` : ''),
  });
  return true;
}

export function parseImportedAssertionUri(
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
    const subGraphValidation = validateSubGraphName(subGraphName);
    if (!subGraphValidation.valid) return null;
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

export function normalizeSemanticQuads(raw: unknown): Array<{ subject: string; predicate: string; object: string }> {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ImportArtifactRouteError(400, '"semanticQuads" must be a non-empty array');
  }
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ImportArtifactRouteError(400, `semanticQuads[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const subject = typeof record.subject === 'string' ? record.subject.trim() : '';
    const predicate = typeof record.predicate === 'string' ? record.predicate.trim() : '';
    const object = typeof record.object === 'string' ? record.object.trim() : '';
    if (record.graph != null) {
      throw new ImportArtifactRouteError(
        400,
        `semanticQuads[${index}].graph is not supported; semantic triples are written to the source imported assertion graph`,
      );
    }
    if (!subject || !predicate || !object) {
      throw new ImportArtifactRouteError(
        400,
        `semanticQuads[${index}] must include non-empty subject, predicate, and object strings`,
      );
    }
    assertSafeIri(subject);
    assertSafeIri(predicate);
    let normalizedObject = object;
    if (object.startsWith('"')) {
      assertSafeRdfTerm(object);
    } else if (isSafeIri(object)) {
      assertSafeIri(object);
    } else {
      normalizedObject = rdfLiteral(object);
    }
    return { subject, predicate, object: normalizedObject };
  });
}

export function rdfLiteral(value: string): string {
  return `"${escapeRdfLiteralBody(value)}"`;
}

export function typedLiteral(value: string | number, typeIri: string): string {
  return `"${escapeRdfLiteralBody(String(value))}"^^<${typeIri}>`;
}

export function escapeRdfLiteralBody(value: string): string {
  return escapeDkgRdfLiteral(value).replace(
    /[\x00-\x07\x0B\x0E-\x1F\x7F]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
  );
}

export function buildSemanticEnrichmentProvenanceQuads(args: {
  enrichmentUri: string;
  source: ImportedArtifactResolution;
  generatedBy: string;
  generatedAt: string;
  generationMethod: string;
  semanticQuads: Array<{ subject: string; predicate: string; object: string }>;
}): Array<{ subject: string; predicate: string; object: string }> {
  const markdownHash = args.source.markdownHash ?? args.source.mdIntermediateHash;
  const markdownForm = args.source.markdownForm
    ?? (markdownHash ? `urn:dkg:file:${markdownHash}` : undefined);
  const provenanceQuads: Array<{ subject: string; predicate: string; object: string }> = [
    {
      subject: args.enrichmentUri,
      predicate: RDF_TYPE,
      object: `${DKG_ONTOLOGY}SemanticEnrichment`,
    },
    {
      subject: args.enrichmentUri,
      predicate: `${DKG_ONTOLOGY}sourceAssertion`,
      object: args.source.assertionUri,
    },
    {
      subject: args.enrichmentUri,
      predicate: `${PROV}wasDerivedFrom`,
      object: args.source.assertionUri,
    },
    {
      subject: args.enrichmentUri,
      predicate: `${DKG_ONTOLOGY}sourceFileHash`,
      object: rdfLiteral(args.source.fileHash),
    },
    {
      subject: args.enrichmentUri,
      predicate: `${DKG_ONTOLOGY}generationMethod`,
      object: rdfLiteral(args.generationMethod),
    },
    {
      subject: args.enrichmentUri,
      predicate: `${DKG_ONTOLOGY}generatedBy`,
      object: args.generatedBy,
    },
    {
      subject: args.enrichmentUri,
      predicate: `${DKG_ONTOLOGY}generatedAt`,
      object: typedLiteral(args.generatedAt, XSD_DATE_TIME),
    },
    {
      subject: args.enrichmentUri,
      predicate: `${DKG_ONTOLOGY}semanticTripleCount`,
      object: typedLiteral(args.semanticQuads.length, XSD_INTEGER),
    },
  ];

  if (markdownHash) {
    provenanceQuads.push({
      subject: args.enrichmentUri,
      predicate: `${DKG_ONTOLOGY}markdownHash`,
      object: rdfLiteral(markdownHash),
    });
  }
  if (markdownForm) {
    provenanceQuads.push({
      subject: args.enrichmentUri,
      predicate: `${DKG_ONTOLOGY}markdownForm`,
      object: markdownForm,
    });
  }
  if (isSafeIri(args.generatedBy)) {
    provenanceQuads.push({
      subject: args.enrichmentUri,
      predicate: `${PROV}wasAttributedTo`,
      object: args.generatedBy,
    });
  }

  for (const subject of new Set(args.semanticQuads.map((quad) => quad.subject))) {
    provenanceQuads.push(
      {
        subject,
        predicate: `${PROV}wasGeneratedBy`,
        object: args.enrichmentUri,
      },
      {
        subject,
        predicate: `${PROV}wasDerivedFrom`,
        object: args.source.assertionUri,
      },
    );
  }

  return provenanceQuads;
}

export function sortAssertionQuads<T>(quads: T[]): T[] {
  return [...quads].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export function normalizeMarkdownReadLimit(raw: unknown): number {
  if (raw == null) return DEFAULT_MARKDOWN_READ_BYTES;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new ImportArtifactRouteError(400, '"maxBytes" must be a positive integer');
  }
  return Math.min(raw, MAX_MARKDOWN_READ_BYTES);
}

export function normalizeGeneratedAt(raw: unknown): string {
  if (raw == null) return new Date().toISOString();
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ImportArtifactRouteError(400, '"generatedAt" must be an ISO date-time string');
  }
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ImportArtifactRouteError(400, '"generatedAt" must be an ISO date-time string');
  }
  return parsed.toISOString();
}

export function normalizeGeneratedBy(raw: unknown, requestAgentAddress: string): string {
  const requestAgent = requestAgentAddress.trim();
  const fallback = isSafeIri(requestAgent) ? requestAgent : `did:dkg:agent:${requestAgent}`;
  if (raw == null) return fallback;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ImportArtifactRouteError(400, '"agentIdentity" must be a non-empty string');
  }
  const value = raw.trim();
  if (isSafeIri(value)) return value;
  return rdfLiteral(value);
}

export function comparableAgentAddress(value: string): string {
  const trimmed = value.trim();
  const unwrapped = trimmed.startsWith('did:dkg:agent:')
    ? trimmed.slice('did:dkg:agent:'.length)
    : trimmed;
  return /^0x[0-9a-fA-F]{40}$/.test(unwrapped) ? unwrapped.toLowerCase() : unwrapped;
}

export function isSameAgentAddress(left: string, right: string): boolean {
  return left === right || comparableAgentAddress(left) === comparableAgentAddress(right);
}

export function assertImportedArtifactOwnerAddress(
  assertionAgentAddress: string,
  requestAgentAddress: string,
  message: string,
): void {
  if (!isSameAgentAddress(assertionAgentAddress, requestAgentAddress)) {
    throw new ImportArtifactRouteError(403, message);
  }
}

/**
 * Issue #872 — public + open context graphs ship their SWM triples to
 * every subscribed peer, so the owner-scoped artifact-read guard is
 * the wrong policy for them: peers that legitimately replicated the
 * triples can't even resolve metadata about the source markdown
 * artifact, let alone fetch its bytes. This helper consults the
 * agent's local on-chain policy cache (populated eagerly by the
 * chain-event poller) to decide whether the guard should be relaxed.
 *
 * Returns `true` only when both policies are confirmed
 * (`accessPolicy === 0` AND `publishPolicy === 1`). Any other state
 * — including missing cache entries — yields `false`, which keeps
 * the existing owner guard in effect (fail-closed).
 *
 * DEFERRED FOLLOW-UP: peers replicate SWM triples but NOT the source
 * artifact bytes; with the guard relaxed, the read-markdown route
 * will return 404 on every cross-agent read until byte-replication is
 * added. Tracked in the PR body for #872.
 */
export async function isPublicOpenContextGraph(
  agent: { getContextGraphOnChainPolicy?: (id: string) => Promise<{ accessPolicy?: number; publishPolicy?: number }> },
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

export function handleImportArtifactRouteError(res: ServerResponse, err: unknown): boolean {
  if (err instanceof ImportArtifactRouteError) {
    jsonResponse(res, err.statusCode, { error: err.message });
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (
    message.includes('Invalid') ||
    message.includes('Unsafe') ||
    message.includes('reserved namespace') ||
    message.includes('not found') ||
    (err as { name?: string })?.name === 'ReservedNamespaceError'
  ) {
    jsonResponse(res, 400, { error: message });
    return true;
  }
  return false;
}

export async function resolveImportedArtifactFromSharedMemory(
  ctx: RequestContext,
  args: {
    contextGraphId: string;
    assertionUri: string;
    assertionName: string;
    assertionAgentAddress: string;
    subGraphName?: string;
    requestedFileHash?: string;
    ownerGuardRelaxed: boolean;
  },
): Promise<ImportedArtifactResolution | undefined> {
  const swmGraph = contextGraphSharedMemoryUri(args.contextGraphId, args.subGraphName);
  const result = await ctx.agent.store.query(`
    SELECT ?sourceFile ?contentType ?rootEntity ?markdownForm WHERE {
      GRAPH <${swmGraph}> {
        <${args.assertionUri}> <${DKG_ONTOLOGY}sourceFile> ?sourceFile .
        OPTIONAL { <${args.assertionUri}> <${DKG_ONTOLOGY}sourceContentType> ?contentType }
        OPTIONAL { <${args.assertionUri}> <${DKG_ONTOLOGY}rootEntity> ?rootEntity }
        OPTIONAL { <${args.assertionUri}> <${DKG_ONTOLOGY}markdownForm> ?markdownForm }
      }
    }
  `) as { type?: string; bindings?: Array<Record<string, unknown>> };
  const bindings = result.bindings ?? [];
  if (bindings.length === 0) return undefined;

  const sourceFile = singletonMetadataBinding(bindings, 'sourceFile', normalizeIriBinding, 'source file');
  const sourceFileHash = hashFromFileUrn(sourceFile);
  if (!sourceFileHash || !validateContentHash(sourceFileHash)) {
    throw new ImportArtifactRouteError(409, 'Shared-memory import metadata is missing a valid source file hash');
  }
  if (args.requestedFileHash && args.requestedFileHash !== sourceFileHash) {
    throw new ImportArtifactRouteError(400, 'fileHash does not match import metadata');
  }

  const durableSourceContentType = singletonMetadataBinding(
    bindings,
    'contentType',
    normalizeLiteralBinding,
    'source content type',
  ) || undefined;
  const sourceContentType = normalizeDetectedContentType(durableSourceContentType);
  const rootEntity = singletonMetadataBinding(bindings, 'rootEntity', normalizeIriBinding, 'root entity') || undefined;
  const markdownFormValue = singletonMetadataBinding(bindings, 'markdownForm', normalizeIriBinding, 'Markdown form') || undefined;
  const markdownFormHash = hashFromFileUrn(markdownFormValue);
  if (markdownFormValue && (!markdownFormHash || !validateContentHash(markdownFormHash))) {
    throw new ImportArtifactRouteError(409, 'Import metadata is missing a valid Markdown intermediate hash');
  }
  const markdownHash = markdownFormHash
    ?? (sourceContentType === 'text/markdown' ? sourceFileHash : undefined);
  const markdownForm = markdownHash ? `urn:dkg:file:${markdownHash}` : undefined;
  const markdownAvailableLocally = markdownHash
    ? await ctx.fileStore.has(markdownHash).catch(() => false)
    : false;

  return {
    contextGraphId: args.contextGraphId,
    assertionUri: args.assertionUri,
    assertionName: args.assertionName,
    assertionAgentAddress: args.assertionAgentAddress,
    ...(args.subGraphName ? { subGraphName: args.subGraphName } : {}),
    fileHash: sourceFileHash,
    sourceFileHash,
    detectedContentType: sourceContentType,
    sourceContentType,
    extractionStatus: 'completed',
    extractionMethod: 'structural',
    ...(rootEntity ? { rootEntity } : {}),
    ...(markdownHash && markdownHash !== sourceFileHash ? { mdIntermediateHash: markdownHash } : {}),
    ...(markdownForm ? { markdownForm } : {}),
    ...(markdownHash ? { markdownHash } : {}),
    canReadMarkdown: markdownAvailableLocally,
    ...(args.ownerGuardRelaxed ? { ownerGuardRelaxed: true } : {}),
  };
}

export async function resolveImportedArtifact(
  ctx: RequestContext,
  raw: Record<string, unknown>,
  ownerGuard?: {
    requestAgentAddress: string;
    message: string;
    /**
     * Issue #872 / Codex review finding 1: opt-in for the public + open
     * CG owner-guard relaxation. Only the two READ routes
     * (`/import-artifact/resolve`, `/import-artifact/read-markdown`)
     * set this to `true`. The semantic-enrichment WRITE route
     * intentionally leaves it `false` (default) so the strict owner
     * guard remains in effect regardless of the CG's on-chain policy
     * — a non-owner peer on a public + open CG must not be allowed
     * to mutate someone else's imported assertion.
     */
    relaxOnPublicOpenCg?: boolean;
  },
  opts?: {
    allowSharedMemoryFallback?: boolean;
  },
): Promise<ImportedArtifactResolution> {
  const rawContextGraphId = typeof raw.contextGraphId === 'string' ? raw.contextGraphId.trim() : '';
  const contextGraphId = rawContextGraphId ? normalizeContextGraphIdOrUri(rawContextGraphId) : '';
  if (!contextGraphId) {
    throw new ImportArtifactRouteError(400, '"contextGraphId" is required');
  }
  if (!isValidContextGraphId(contextGraphId)) {
    throw new ImportArtifactRouteError(400, 'Invalid contextGraphId');
  }

  const subGraphName = typeof raw.subGraphName === 'string' && raw.subGraphName.trim()
    ? raw.subGraphName.trim()
    : undefined;
  if (subGraphName) {
    const subGraphValidation = validateSubGraphName(subGraphName);
    if (!subGraphValidation.valid) {
      throw new ImportArtifactRouteError(400, `Invalid subGraphName: ${subGraphValidation.reason}`);
    }
  }

  const assertionName = typeof raw.assertionName === 'string' && raw.assertionName.trim()
    ? raw.assertionName.trim()
    : undefined;
  if (assertionName) {
    const nameValidation = validateAssertionName(assertionName);
    if (!nameValidation.valid) {
      throw new ImportArtifactRouteError(400, `Invalid assertionName: ${nameValidation.reason}`);
    }
  }

  const rawAssertionUri = typeof raw.assertionUri === 'string' && raw.assertionUri.trim()
    ? raw.assertionUri.trim()
    : undefined;
  if (!rawAssertionUri) {
    throw new ImportArtifactRouteError(400, '"assertionUri" is required');
  }
  if (rawAssertionUri && !isSafeIri(rawAssertionUri)) {
    throw new ImportArtifactRouteError(400, 'Invalid assertionUri');
  }

  const inputAssertionUri = rawAssertionUri;
  // Issue #872 Codex finding 1: only the READ routes opt into the
  // public + open relaxation. The write callers (e.g.
  // `/semantic-enrichment/write`) leave `relaxOnPublicOpenCg`
  // unset/false so the strict owner guard stays in effect — a
  // non-owner peer on a public + open CG must NOT be able to mutate
  // someone else's imported assertion just because cross-agent READS
  // are allowed.
  const canRelaxGuard = Boolean(ownerGuard?.relaxOnPublicOpenCg);
  // Probing the on-chain policy is a no-op for the write path (which
  // never relaxes). Skip it there to keep the diff scoped and avoid
  // adding chain-cache reads to a code path that doesn't need them.
  const isPublicOpen = canRelaxGuard
    ? await isPublicOpenContextGraph(ctx.agent, contextGraphId)
    : false;
  const parsedAssertion = parseImportedAssertionUri(
    inputAssertionUri,
    contextGraphId,
    ownerGuard?.requestAgentAddress,
  );
  if (!parsedAssertion) {
    throw new ImportArtifactRouteError(400, 'assertionUri is not an assertion in the supplied contextGraphId');
  }
  const parsedNameValidation = validateAssertionName(parsedAssertion.assertionName);
  if (!parsedNameValidation.valid) {
    throw new ImportArtifactRouteError(400, `Invalid assertionUri assertion name: ${parsedNameValidation.reason}`);
  }
  const reconstructedAssertionUri = contextGraphAssertionUri(
    contextGraphId,
    parsedAssertion.assertionAgentAddress,
    parsedAssertion.assertionName,
    parsedAssertion.subGraphName,
  );
  if (reconstructedAssertionUri !== inputAssertionUri && !parsedAssertion.legacy) {
    throw new ImportArtifactRouteError(400, 'assertionUri is not in canonical assertion URI form');
  }
  const assertionUri = reconstructedAssertionUri;
  let ownerGuardRelaxed = false;
  if (ownerGuard) {
    // Issue #872 — drop the owner guard for public + open CGs. Their
    // SWM triples are gossipped to every subscribed peer, so blocking
    // cross-agent reads of the imported source artifact contradicts
    // the very access policy the curator chose on-chain. For every
    // other policy combo (curated, curators-only publish, or any
    // write path), the guard stays in force regardless of the
    // on-chain policy.
    //
    // Codex review (round 2, finding A): the relaxation is skipped
    // for legacy ownerless URIs (`parsedAssertion.legacy === true`).
    // `parseImportedAssertionUri` already canonicalizes those by
    // defaulting the missing owner segment to `requestAgentAddress`
    // — which is the right answer ONLY for owner self-reads. For
    // cross-agent reads the canonical URI silently points at the
    // wrong owner, so the meta SPARQL below misses and returns 404.
    // Letting the strict guard run for legacy URIs preserves the
    // owner-self-read back-compat path (the legacy default makes
    // `assertionAgentAddress === requestAgentAddress` so the guard
    // passes) while non-owner cross-agent reads get the same 404
    // they got pre-PR rather than a misleading 200.
    if (canRelaxGuard && isPublicOpen && !parsedAssertion.legacy) {
      ownerGuardRelaxed = !isSameAgentAddress(
        parsedAssertion.assertionAgentAddress,
        ownerGuard.requestAgentAddress,
      );
    } else {
      assertImportedArtifactOwnerAddress(
        parsedAssertion.assertionAgentAddress,
        ownerGuard.requestAgentAddress,
        ownerGuard.message,
      );
    }
  }
  if (assertionName && assertionName !== parsedAssertion.assertionName) {
    throw new ImportArtifactRouteError(400, '"assertionName" does not match assertionUri');
  }
  if (subGraphName && subGraphName !== parsedAssertion.subGraphName) {
    throw new ImportArtifactRouteError(400, '"subGraphName" does not match assertionUri');
  }

  const requestedFileHash = typeof raw.fileHash === 'string' && raw.fileHash.trim()
    ? raw.fileHash.trim()
    : undefined;
  if (requestedFileHash && !validateContentHash(requestedFileHash)) {
    throw new ImportArtifactRouteError(400, 'Invalid fileHash');
  }

  const extractionRecord = getExtractionStatusRecord(ctx.extractionStatus, assertionUri);
  if (extractionRecord && extractionRecord.status !== 'completed') {
    throw new ImportArtifactRouteError(
      409,
      `Import artifact is not a completed extraction (status: ${extractionRecord.status})`,
    );
  }

  const metaGraph = contextGraphMetaUri(contextGraphId);
  const metaResult = await ctx.agent.store.query(`
    SELECT ?fileHash ?contentType ?rootEntity ?structuralTripleCount ?semanticTripleCount ?extractionMethod ?extractionStatus ?mdIntermediateHash ?sourceFileName WHERE {
      GRAPH <${metaGraph}> {
        <${assertionUri}> <${DKG_ONTOLOGY}sourceFileHash> ?fileHash .
        OPTIONAL { <${assertionUri}> <${DKG_ONTOLOGY}sourceContentType> ?contentType }
        OPTIONAL { <${assertionUri}> <${DKG_ONTOLOGY}rootEntity> ?rootEntity }
        OPTIONAL { <${assertionUri}> <${DKG_ONTOLOGY}structuralTripleCount> ?structuralTripleCount }
        OPTIONAL { <${assertionUri}> <${DKG_ONTOLOGY}semanticTripleCount> ?semanticTripleCount }
        OPTIONAL { <${assertionUri}> <${DKG_ONTOLOGY}extractionMethod> ?extractionMethod }
        OPTIONAL { <${assertionUri}> <${DKG_ONTOLOGY}extractionStatus> ?extractionStatus }
        OPTIONAL { <${assertionUri}> <${DKG_ONTOLOGY}mdIntermediateHash> ?mdIntermediateHash }
        OPTIONAL { <${assertionUri}> <${DKG_ONTOLOGY}sourceFileName> ?sourceFileName }
      }
    }
    LIMIT 1
  `) as { type?: string; bindings?: Array<Record<string, unknown>> };
  const metaBinding = metaResult.bindings?.[0];
  if (!metaBinding) {
    if (ownerGuardRelaxed || opts?.allowSharedMemoryFallback) {
      const swmArtifact = await resolveImportedArtifactFromSharedMemory(ctx, {
        contextGraphId,
        assertionUri,
        assertionName: parsedAssertion.assertionName,
        assertionAgentAddress: parsedAssertion.assertionAgentAddress,
        ...(parsedAssertion.subGraphName ? { subGraphName: parsedAssertion.subGraphName } : {}),
        ...(requestedFileHash ? { requestedFileHash } : {}),
        ownerGuardRelaxed,
      });
      if (swmArtifact) return swmArtifact;
    }
    throw new ImportArtifactRouteError(404, 'No completed import metadata found for assertionUri');
  }

  const durableExtractionStatus = normalizeLiteralBinding(metaBinding.extractionStatus) || undefined;
  const structuralTripleCount = optionalPositiveInteger(metaBinding.structuralTripleCount);
  const legacyCompletedStructuralTripleCount = optionalStrictPositiveInteger(metaBinding.structuralTripleCount);
  if (durableExtractionStatus && durableExtractionStatus !== 'completed') {
    throw new ImportArtifactRouteError(
      409,
      `Import artifact is not a completed extraction (status: ${durableExtractionStatus})`,
    );
  }
  if (!durableExtractionStatus && (legacyCompletedStructuralTripleCount ?? 0) <= 0) {
    throw new ImportArtifactRouteError(409, 'Import metadata is missing completed extraction status');
  }

  const sourceFileHash = normalizeLiteralBinding(metaBinding.fileHash);
  if (!sourceFileHash || !validateContentHash(sourceFileHash)) {
    throw new ImportArtifactRouteError(409, 'Import metadata is missing a valid source file hash');
  }
  if (requestedFileHash && requestedFileHash !== sourceFileHash) {
    throw new ImportArtifactRouteError(400, 'fileHash does not match import metadata');
  }

  const durableSourceContentType = normalizeLiteralBinding(metaBinding.contentType) || undefined;
  const sourceContentType = normalizeDetectedContentType(
    durableSourceContentType || extractionRecord?.detectedContentType,
  );
  const mdIntermediateHash = normalizeLiteralBinding(metaBinding.mdIntermediateHash) || undefined;
  if (mdIntermediateHash && !validateContentHash(mdIntermediateHash)) {
    throw new ImportArtifactRouteError(409, 'Import metadata is missing a valid Markdown intermediate hash');
  }
  const markdownFormResult = await ctx.agent.store.query(`
    SELECT DISTINCT ?markdownForm WHERE {
      GRAPH <${assertionUri}> {
        ?document <${DKG_ONTOLOGY}markdownForm> ?markdownForm .
      }
    }
  `) as { type?: string; bindings?: Array<Record<string, unknown>> };
  const authoritativeMarkdownHash = mdIntermediateHash
    ?? (durableSourceContentType && normalizeDetectedContentType(durableSourceContentType) === 'text/markdown'
      ? sourceFileHash
      : undefined);
  const graphMarkdownForms = (markdownFormResult.bindings ?? [])
    .map((binding) => normalizeIriBinding(binding.markdownForm))
    .filter(Boolean);
  for (const graphMarkdownForm of graphMarkdownForms) {
    const markdownFormHash = hashFromFileUrn(graphMarkdownForm);
    if (!markdownFormHash || !authoritativeMarkdownHash || markdownFormHash !== authoritativeMarkdownHash) {
      throw new ImportArtifactRouteError(409, 'Import metadata markdown hash does not match assertion markdownForm');
    }
  }
  const markdownHash = authoritativeMarkdownHash;
  const markdownForm = markdownHash ? `urn:dkg:file:${markdownHash}` : undefined;

  // Codex review on #872 — when the owner guard is relaxed for a
  // public + open CG, replicated `_meta` may have a `markdownHash`
  // even though the bytes were never replicated to this node's
  // file-store (only the SWM/_meta triples gossip across peers; the
  // raw file bytes don't auto-replicate). The previous
  // `Boolean(markdownHash)` would have returned `canReadMarkdown:
  // true` and then `/import-artifact/read-markdown` would
  // deterministically 404. Derive presence from the local file-store
  // when the relaxation is in effect so the flag is honest. Owner
  // self-reads (no relaxation) keep the existing fast-path —
  // `_meta` and bytes land together at import time on the importing
  // node, so a `markdownHash` there really does mean readable.
  const markdownAvailableLocally = markdownHash
    ? ownerGuardRelaxed
      ? await ctx.fileStore.has(markdownHash).catch(() => false)
      : true
    : false;

  return {
    contextGraphId,
    assertionUri,
    assertionName: parsedAssertion.assertionName,
    assertionAgentAddress: parsedAssertion.assertionAgentAddress,
    ...(parsedAssertion.subGraphName ? { subGraphName: parsedAssertion.subGraphName } : {}),
    fileHash: sourceFileHash,
    sourceFileHash,
    detectedContentType: sourceContentType,
    sourceContentType,
    extractionStatus: 'completed',
    extractionMethod: normalizeLiteralBinding(metaBinding.extractionMethod) || extractionRecord?.pipelineUsed || undefined,
    rootEntity: normalizeIriBinding(metaBinding.rootEntity) || extractionRecord?.rootEntity || undefined,
    sourceFileName: normalizeLiteralBinding(metaBinding.sourceFileName) || extractionRecord?.fileName || undefined,
    tripleCount: structuralTripleCount ?? extractionRecord?.tripleCount,
    structuralTripleCount: structuralTripleCount ?? extractionRecord?.tripleCount,
    semanticTripleCount: optionalPositiveInteger(metaBinding.semanticTripleCount),
    ...(mdIntermediateHash ? { mdIntermediateHash } : {}),
    ...(markdownForm ? { markdownForm } : {}),
    ...(markdownHash ? { markdownHash } : {}),
    canReadMarkdown: markdownAvailableLocally,
    ...(ownerGuardRelaxed ? { ownerGuardRelaxed: true } : {}),
  };
}
