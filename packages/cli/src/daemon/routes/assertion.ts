// daemon/routes/assertion.ts
//
// Route handlers for assertion CRUD + import + file download.
//
// Extracted verbatim from the legacy monolithic `handleRequest` —
// every block is a contiguous slice of the original source with zero
// edits to route bodies. Dispatch is driven by the surviving
// `handle-request.ts` shell, which awaits each group handler in
// sequence and uses `res.writableEnded` to short-circuit once a
// route claims the request.
//
// See `packages/cli/scripts/split-handle-request.mjs` for the
// extraction driver.

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { execSync, exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname, resolve } from 'node:path';
import { existsSync, readdirSync, readFileSync, openSync, closeSync, writeFileSync as fsWriteFileSync, unlinkSync } from 'node:fs';
// Namespace import: our Phase-8 install-context builder (~line 290) calls
// `osModule.homedir()`, and the later agent-identity probe (~line 6851)
// uses `osModule.hostname()` + `osModule.userInfo()`. v10-rc's new
// OpenClaw config helper (~line 2535) uses a bare `homedir()` — aliased
// below so both sites coexist without a duplicate-module import.
import * as osModule from 'node:os';
const { homedir } = osModule;
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';

// Lazy resolver used by the manifest-install flow: find the
// @origintrail-official/dkg-mcp package via Node's own resolution
// algorithm, so the daemon can write workspace-level configs that
// point at a valid MCP server install regardless of whether it's
// running from a monorepo checkout, an npm-global `dkg`, or a
// `pnpm dlx` tarball.
const daemonRequire = createRequire(import.meta.url);

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
import { enrichEvmError, MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent, loadOpWallets } from '@origintrail-official/dkg-agent';
import { computeNetworkId, createOperationContext, DKGEvent, Logger, PayloadTooLargeError, GET_VIEWS, TrustLevel, validateSubGraphName, validateAssertionName, validateContextGraphId, isSafeIri, assertSafeIri, assertSafeRdfTerm, escapeDkgRdfLiteral, sparqlIri, contextGraphSharedMemoryUri, contextGraphSharedMemoryMetaUri, contextGraphAssertionUri, contextGraphMetaUri, assertionLifecycleUri } from '@origintrail-official/dkg-core';
import { findReservedSubjectPrefix, isSkolemizedUri, PROMOTE_JOB_STATES, PromoteJobConflictError, type PromoteJob, type PromoteJobState, type PublishOptions } from '@origintrail-official/dkg-publisher';
import { validatePreSignedAuthorAttestation } from './memory.js';
import { recordAssertionActivity } from '../activity-notification.js';
import {
  DashboardDB,
  MetricsCollector,
  OperationTracker,
  handleNodeUIRequest,
  ChatMemoryManager,
  LogPushWorker,
  LlmClient,
  type MetricsSource,
} from "@origintrail-official/dkg-node-ui";
import {
  loadConfig,
  saveConfig,
  loadNetworkConfig,
  dkgDir,
  writePid,
  removePid,
  writeApiPort,
  removeApiPort,
  logPath,
  ensureDkgDir,
  TELEMETRY_ENDPOINTS,
  type DkgConfig,
  type AutoUpdateConfig,
  type LocalAgentIntegrationCapabilities,
  type LocalAgentIntegrationConfig,
  type LocalAgentIntegrationManifest,
  type LocalAgentIntegrationRuntime,
  type LocalAgentIntegrationStatus,
  type LocalAgentIntegrationTransport,
  resolveContextGraphs,
  resolveNetworkDefaultContextGraphs,
  resolveSharedMemoryTtlMs,
  repoDir,
  releasesDir,
  activeSlot,
  inactiveSlot,
  swapSlot,
  gitCommandEnv,
  gitCommandArgs,
  isStandaloneInstall,
  slotEntryPoint,
  CLI_NPM_PACKAGE,
} from '../../config.js';
import { createPublisherControlFromStore, startPublisherRuntimeIfEnabled, type PublisherRuntime } from '../../publisher-runner.js';
import { createCatchupRunner, type CatchupJobResult, type CatchupRunner } from '../../catchup-runner.js';
import { loadTokens, httpAuthGuard, extractBearerToken, SignedRequestRejectedError } from '../../auth.js';
import { ExtractionPipelineRegistry } from '@origintrail-official/dkg-core';
import { MarkItDownConverter, isMarkItDownAvailable, extractFromMarkdown, extractWithLlm } from '../../extraction/index.js';
import {
  expectedBundledMarkItDownBuildMetadata,
  readCliPackageVersion,
  type BundledMarkItDownMetadata,
} from "../../extraction/markitdown-bundle-metadata.js";
import {
  checksumPathFor as markItDownChecksumPath,
  hasVerifiedBundledBinary as hasVerifiedBundledMarkItDownBinary,
  metadataPathFor as markItDownMetadataPath,
} from '../../../scripts/markitdown-bundle-validation.mjs';
import { type ExtractionStatusRecord, getExtractionStatusRecord, setExtractionStatusRecord } from '../../extraction-status.js';
import { FileStore } from '../../file-store.js';
import { VectorStore, OpenAIEmbeddingProvider, type EmbeddingProvider } from '../../vector-store.js';
import { parseBoundary, parseMultipart, MultipartParseError } from '../../http/multipart.js';
// Phase 8 — project-manifest publish + install (UI-driven onboarding flow).
// Daemon constructs a self-pointing DkgClient (localhost:listenPort) and
// reuses the same publish/fetch/plan/write helpers the CLI uses, so wire
// format stays identical between curator/joiner/CLI paths.
import {
  publishManifest as publishManifestImpl,
  assembleStandardTemplates,
} from '@origintrail-official/dkg-mcp/manifest/publish';
import { fetchManifest as fetchManifestImpl } from '@origintrail-official/dkg-mcp/manifest/fetch';
import {
  planInstall as planInstallImpl,
  writeInstall as writeInstallImpl,
  buildReviewMarkdown as buildReviewMarkdownImpl,
  type InstallContext,
} from '@origintrail-official/dkg-mcp/manifest/install';
import { DkgClient } from '@origintrail-official/dkg-mcp/client';

// Daemon sub-module imports — every public symbol from sibling
// modules is pulled in here because the legacy monolithic file used
// them all without explicit imports. Unused ones are tolerated by
// the project's tsconfig (`noUnusedLocals` is off).
import {
  daemonState,
  DEBUG_SYNC_TRACE,
  resolveAutoUpdateEnabled,
  type CorsAllowlist,
} from '../state.js';
import {
  type CatchupJobState,
  type CatchupJob,
  type CatchupTracker,
  toCatchupStatusResponse,
} from '../types.js';
import {
  type MarkItDownTarget,
  manifestRepoRoot,
  type McpDkgAssets,
  resolveMcpDkgAssets,
  readMcpDkgVersion,
  parseSemver,
  cmpSemverForRange,
  versionSatisfiesRange,
  manifestNetworkLabel,
  formatDaemonAuthority,
  manifestSelfClient,
  manifestPublisherUri,
  type SupportedTool,
  nicknameToSlug,
  buildManifestInstallContext,
  _autoUpdateIo,
  loadMarkItDownTargets,
  getNodeVersion,
  getCurrentCommitShort,
  loadSkillTemplate,
  buildSkillMd,
  skillEtag,
  DAEMON_EXIT_CODE_RESTART,
  parseRequiredSignatures,
  normalizeDetectedContentType,
  currentBundledMarkItDownAssetName,
  bindingValue,
  carryForwardBundledMarkItDownBinary,
} from '../manifest.js';
import {
  resolveNameToPeerId,
  isPublishQuad,
  parsePublishRequestBody,
  jsonResponse,
  safeDecodeURIComponent,
  safeParseJson,
  validateOptionalSubGraphName,
  validateRequiredContextGraphId,
  normalizeContextGraphIdOrUri,
  resolveRequiredWriteContextGraphId,
  validateEntities,
  validateConditions,
  MAX_BODY_BYTES,
  SMALL_BODY_BYTES,
  MAX_UPLOAD_BYTES,
  type ImportFileExtractionPayload,
  buildImportFileResponse,
  isPayloadTooLargeError,
  payloadTooLargeResponseBody,
  unregisteredSubGraphError,
  readBody,
  readBodyBuffer,
  buildCorsAllowlist,
  resolveCorsOrigin,
  corsHeaders,
  HttpRateLimiter,
  isLoopbackClientIp,
  isLoopbackRateLimitExemptPath,
  shouldBypassRateLimitForLoopbackTraffic,
  isValidContextGraphId,
  shortId,
  sleep,
  deriveBlockExplorerUrl,
} from '../http-utils.js';
import {
  normalizeRepo,
  parseTagName,
  isValidRef,
  isValidRepoSpec,
  repoToFetchUrl,
  githubRepoForApi,
  resolveRemoteCommitSha,
  type PendingUpdateState,
  type CommitCheckStatus,
  readPendingUpdateState,
  clearPendingUpdateState,
  writePendingUpdateState,
  type NpmVersionResult,
  resolveLatestNpmVersion,
  compareSemver,
  getCurrentCliVersion,
  type NpmVersionStatus,
  checkForNpmVersionUpdate,
  type UpdateStatus,
  acquireUpdateLock,
  releaseUpdateLock,
  performNpmUpdate,
} from '../auto-update.js';
import {
  OPENCLAW_UI_CONNECT_TIMEOUT_MS,
  OPENCLAW_UI_CONNECT_POLL_MS,
  OPENCLAW_CHANNEL_RESPONSE_TIMEOUT_MS,
  type PendingOpenClawUiAttachJob,
  isOpenClawBridgeHealthCacheValid,
  type OpenClawChannelTarget,
  trimTrailingSlashes,
  buildOpenClawGatewayBase,
  loadBridgeAuthToken,
  getOpenClawChannelTargets,
  type OpenClawBridgeHealthState,
  type OpenClawGatewayHealthState,
  type OpenClawChannelHealthReport,
  transportPatchFromOpenClawTarget,
  probeOpenClawChannelHealth,
  runOpenClawUiSetup,
  localOpenclawConfigPath,
  isOpenClawMemorySlotElected,
  restartOpenClawGateway,
  waitForOpenClawChatReady,
  type OpenClawUiAttachDeps,
  formatOpenClawUiAttachFailure,
  scheduleOpenClawUiAttachJob,
  cancelPendingLocalAgentAttachJob,
  isOpenClawUiAttachCancelled,
  shouldTryNextOpenClawTarget,
  buildOpenClawChannelHeaders,
  ensureOpenClawBridgeAvailable,
  type OpenClawStreamRequest,
  type OpenClawStreamResponse,
  type OpenClawStreamReader,
  writeOpenClawStreamChunk,
  pipeOpenClawStream,
  isValidOpenClawPersistTurnPayload,
  type OpenClawAttachmentRef,
  normalizeOpenClawAttachmentRef,
  normalizeOpenClawAttachmentRefs,
  type OpenClawChatContextEntry,
  normalizeOpenClawChatContextEntry,
  normalizeOpenClawChatContextEntries,
  hasOpenClawChatTurnContent,
  unescapeOpenClawAttachmentLiteralBody,
  stripOpenClawAttachmentLiteral,
  parseOpenClawAttachmentTripleCount,
  isOpenClawAttachmentAssertionUriForContextGraph,
  extractionRecordMatchesOpenClawAttachmentRef,
  verifyOpenClawAttachmentRefsProvenance,
} from '../openclaw.js';
import {
  type LocalAgentIntegrationDefinition,
  type LocalAgentIntegrationRecord,
  LOCAL_AGENT_INTEGRATION_DEFINITIONS,
  isPlainRecord,
  normalizeIntegrationId,
  normalizeLocalAgentTransport,
  normalizeLocalAgentCapabilities,
  normalizeLocalAgentManifest,
  normalizeLocalAgentRuntime,
  isLocalAgentExplicitlyUserDisabled,
  isExplicitLocalAgentDisconnectPatch,
  normalizeExplicitLocalAgentDisconnectBody,
  mergeLocalAgentIntegrationConfig,
  getStoredLocalAgentIntegrations,
  computeLocalAgentIntegrationStatus,
  buildLocalAgentIntegrationRecord,
  listLocalAgentIntegrations,
  getLocalAgentIntegration,
  pruneLegacyOpenClawConfig,
  extractLocalAgentIntegrationPatch,
  connectLocalAgentIntegration,
  updateLocalAgentIntegration,
  hasConfiguredLocalAgentChat,
  hasStoredLocalAgentTransportConfig,
  connectLocalAgentIntegrationFromUi,
  type ReverseLocalAgentSetupDeps,
  reverseLocalAgentSetupForUi,
  refreshLocalAgentIntegrationFromUi,
} from '../local-agents.js';

import type { RequestContext } from './context.js';

const DKG_ONTOLOGY = 'http://dkg.io/ontology/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const PROV = 'http://www.w3.org/ns/prov#';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const XSD_DATE_TIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
const MAX_MARKDOWN_READ_BYTES = 5 * 1024 * 1024;
const DEFAULT_MARKDOWN_READ_BYTES = 1024 * 1024;

type ImportedArtifactResolution = {
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
  markdownAvailability?: 'local' | 'fetchable' | 'unavailable';
  canFetchMarkdown?: boolean;
  markdownUnavailableReason?: string;
  sourcePeerId?: string;
  sourcePeerIds?: string[];
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

class ImportArtifactRouteError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
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
  return stripOpenClawAttachmentLiteral(bindingCellValue(cell)).trim();
}

function normalizeIriBinding(cell: unknown): string {
  return bindingCellValue(cell).replace(/^<|>$/g, '').trim();
}

function singletonMetadataBinding(
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

function optionalPositiveInteger(cell: unknown): number | undefined {
  return parseOpenClawAttachmentTripleCount(bindingCellValue(cell));
}

function optionalStrictPositiveInteger(cell: unknown): number | undefined {
  const value = normalizeLiteralBinding(cell);
  if (!/^\+?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function hashFromFileUrn(value: string | undefined): string | undefined {
  const prefix = 'urn:dkg:file:';
  if (!value?.startsWith(prefix)) return undefined;
  const hash = value.slice(prefix.length);
  return /^[a-z0-9]+:[0-9a-f]{64}$/i.test(hash) ? hash : undefined;
}

function validateContentHash(hash: string): boolean {
  return /^(?:sha256:|keccak256:)?[0-9a-f]{64}$/i.test(hash);
}

function validatePromoteJobId(jobId: string): { valid: true } | { valid: false; reason: string } {
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

function decodePromoteJobId(encoded: string, res: ServerResponse): string | null {
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

function isoFromEpochMs(ms: number | undefined): string | undefined {
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
function asyncPromoteUnavailable(res: ServerResponse): boolean {
  if (daemonState.promoteWorkerAvailable) return false;
  const reason = daemonState.promoteWorkerUnavailableReason;
  jsonResponse(res, 503, {
    error:
      `async-promote worker is not available` +
      (reason ? `: ${reason}` : ''),
  });
  return true;
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

function normalizeSemanticQuads(raw: unknown): Array<{ subject: string; predicate: string; object: string }> {
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

function rdfLiteral(value: string): string {
  return `"${escapeRdfLiteralBody(value)}"`;
}

function typedLiteral(value: string | number, typeIri: string): string {
  return `"${escapeRdfLiteralBody(String(value))}"^^<${typeIri}>`;
}

function escapeRdfLiteralBody(value: string): string {
  return escapeDkgRdfLiteral(value).replace(
    /[\x00-\x07\x0B\x0E-\x1F\x7F]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
  );
}

function buildSemanticEnrichmentProvenanceQuads(args: {
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

function sortAssertionQuads<T>(quads: T[]): T[] {
  return [...quads].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function normalizeMarkdownReadLimit(raw: unknown): number {
  if (raw == null) return DEFAULT_MARKDOWN_READ_BYTES;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new ImportArtifactRouteError(400, '"maxBytes" must be a positive integer');
  }
  return Math.min(raw, MAX_MARKDOWN_READ_BYTES);
}

function normalizeGeneratedAt(raw: unknown): string {
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

function normalizeGeneratedBy(raw: unknown, requestAgentAddress: string): string {
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

function assertImportedArtifactOwnerAddress(
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
async function canReadImportedArtifactSharedSource(
  agent: {
    getContextGraphOnChainPolicy?: (id: string) => Promise<{ accessPolicy?: number; publishPolicy?: number }>;
  },
  contextGraphId: string,
): Promise<boolean> {
  let policy: { accessPolicy?: number; publishPolicy?: number };
  try {
    policy = typeof agent.getContextGraphOnChainPolicy === 'function'
      ? await agent.getContextGraphOnChainPolicy(contextGraphId)
      : {};
  } catch {
    return false;
  }
  if (policy.accessPolicy === 0) {
    return policy.publishPolicy === 1;
  }
  return false;
}

function normalizeSourcePeerId(raw: unknown): string | undefined {
  const peerId = normalizeLiteralBinding(raw);
  return peerId && peerId !== 'unknown' ? peerId : undefined;
}

function importedArtifactMarkdownCacheMarkerSubject(assertionUri: string, peerId: string): string {
  return `${assertionUri}#cached-markdown-${encodeURIComponent(peerId)}`;
}

function importedArtifactMarkdownCacheMarkerGraph(peerId: string): string {
  return `urn:dkg:local:imported-artifact-markdown-cache:${encodeURIComponent(peerId)}`;
}

function parseAgentLastSeenMs(raw: unknown): number {
  if (typeof raw !== 'string' || !raw.trim()) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

async function resolveLegacyImportedArtifactSourcePeerIds(
  ctx: RequestContext,
  assertionAgentAddress: string,
): Promise<string[]> {
  const findAgents = ctx.agent.findAgents;
  if (typeof findAgents !== 'function') return [];
  const strippedAssertionAgentAddress = assertionAgentAddress.startsWith('did:dkg:agent:')
    ? assertionAgentAddress.slice('did:dkg:agent:'.length)
    : assertionAgentAddress;
  const agents = await findAgents.call(ctx.agent).catch(() => []) as Array<Record<string, unknown>>;
  const candidates = new Map<string, number>();
  for (const agent of agents) {
    const peerId = normalizeSourcePeerId(agent.peerId);
    if (!peerId) continue;
    let matches = peerId === assertionAgentAddress || peerId === strippedAssertionAgentAddress;
    const candidateAddresses = [agent.agentAddress, agent.agentUri]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    matches ||= candidateAddresses.some((candidate) => isSameAgentAddress(candidate, assertionAgentAddress));
    if (matches) {
      const lastSeenMs = parseAgentLastSeenMs(agent.lastSeen);
      const existing = candidates.get(peerId);
      if (existing === undefined || lastSeenMs > existing) {
        candidates.set(peerId, lastSeenMs);
      }
    }
  }
  return [...candidates.entries()]
    .sort(([leftPeerId, leftLastSeen], [rightPeerId, rightLastSeen]) =>
      rightLastSeen - leftLastSeen || leftPeerId.localeCompare(rightPeerId))
    .map(([peerId]) => peerId);
}

async function hasVerifiedImportedArtifactMarkdownCache(
  ctx: RequestContext,
  artifact: Pick<ImportedArtifactResolution, 'contextGraphId' | 'assertionUri' | 'markdownHash'>,
): Promise<boolean> {
  if (!artifact.markdownHash) return false;
  const markerGraph = importedArtifactMarkdownCacheMarkerGraph(ctx.agent.peerId);
  const markerSubject = importedArtifactMarkdownCacheMarkerSubject(artifact.assertionUri, ctx.agent.peerId);
  const result = await ctx.agent.store.query(`
    SELECT ?cachedMarkdownHash WHERE {
      GRAPH <${markerGraph}> {
        <${markerSubject}> <${DKG_ONTOLOGY}cachedMarkdownHash> ?cachedMarkdownHash .
      }
    }
    LIMIT 1
  `) as { type?: string; bindings?: Array<Record<string, unknown>> };
  const cachedHash = normalizeLiteralBinding(result.bindings?.[0]?.cachedMarkdownHash);
  return cachedHash === artifact.markdownHash
    ? ctx.fileStore.has(artifact.markdownHash).catch(() => false)
    : false;
}

async function markVerifiedImportedArtifactMarkdownCache(
  ctx: RequestContext,
  artifact: Pick<ImportedArtifactResolution, 'contextGraphId' | 'assertionUri' | 'markdownHash'>,
): Promise<void> {
  if (!artifact.markdownHash) return;
  const insert = ctx.agent.store.insert;
  if (typeof insert !== 'function') return;
  const markerGraph = importedArtifactMarkdownCacheMarkerGraph(ctx.agent.peerId);
  const markerSubject = importedArtifactMarkdownCacheMarkerSubject(artifact.assertionUri, ctx.agent.peerId);
  await insert.call(ctx.agent.store, [{
    subject: markerSubject,
    predicate: `${DKG_ONTOLOGY}cachedMarkdownHash`,
    object: rdfLiteral(artifact.markdownHash),
    graph: markerGraph,
  }]).catch(() => undefined);
}

async function finalizeImportedArtifactAvailability(
  ctx: RequestContext,
  artifact: ImportedArtifactResolution,
): Promise<ImportedArtifactResolution> {
  if (!artifact.markdownHash) {
    return {
      ...artifact,
      markdownAvailability: 'unavailable',
      markdownUnavailableReason: 'no-markdown-source',
    };
  }
  if (artifact.canReadMarkdown) {
    return {
      ...artifact,
      markdownAvailability: 'local',
      canFetchMarkdown: false,
    };
  }
  const sourcePeerIds = [
    artifact.sourcePeerId,
    ...(artifact.sourcePeerIds ?? []),
  ].reduce<string[]>((peers, peerId) => {
    const normalized = normalizeSourcePeerId(peerId);
    if (normalized && !peers.includes(normalized)) peers.push(normalized);
    return peers;
  }, []);
  const sourcePeerId = sourcePeerIds.find((peerId) => peerId !== ctx.agent.peerId) ?? sourcePeerIds[0];
  if (!sourcePeerId) {
    return {
      ...artifact,
      markdownAvailability: 'unavailable',
      canFetchMarkdown: false,
      markdownUnavailableReason: 'source-peer-unavailable',
    };
  }
  if (sourcePeerId === ctx.agent.peerId) {
    return {
      ...artifact,
      sourcePeerId,
      sourcePeerIds,
      markdownAvailability: 'unavailable',
      canFetchMarkdown: false,
      markdownUnavailableReason: 'source-peer-unavailable',
    };
  }
  return {
    ...artifact,
    sourcePeerId,
    sourcePeerIds: sourcePeerIds.filter((peerId) => peerId !== ctx.agent.peerId),
    markdownAvailability: 'fetchable',
    canFetchMarkdown: true,
  };
}

function contentHashMatchesBytes(hash: string, bytes: Buffer): boolean {
  const lower = hash.toLowerCase();
  if (lower.startsWith('keccak256:')) {
    return ethers.keccak256(bytes).replace(/^0x/, '').toLowerCase() === lower.slice('keccak256:'.length);
  }
  const sha = createHash('sha256').update(bytes).digest('hex').toLowerCase();
  return sha === lower.replace(/^sha256:/, '');
}

async function hydrateImportedArtifactMarkdown(
  ctx: RequestContext,
  artifact: ImportedArtifactResolution,
  maxBytes: number,
): Promise<{ bytes?: Buffer; tooLargeBytes?: number; error?: string }> {
  const sourcePeerIds = [
    artifact.sourcePeerId,
    ...(artifact.sourcePeerIds ?? []),
  ].reduce<string[]>((peers, peerId) => {
    const normalized = normalizeSourcePeerId(peerId);
    if (normalized && normalized !== ctx.agent.peerId && !peers.includes(normalized)) peers.push(normalized);
    return peers;
  }, []);
  if (!artifact.markdownHash || sourcePeerIds.length === 0 || !artifact.canFetchMarkdown) {
    return { error: 'source peer unavailable' };
  }
  const fetcher = ctx.agent.fetchImportedSourceBlobFromPeer;
  if (typeof fetcher !== 'function') {
    return { error: 'source blob fetch is unavailable on this agent' };
  }
  let lastError = 'source peer unavailable';
  for (const sourcePeerId of sourcePeerIds) {
    let fetched;
    try {
      fetched = await fetcher.call(ctx.agent, sourcePeerId, {
        contextGraphId: artifact.contextGraphId,
        assertionUri: artifact.assertionUri,
        blobHash: artifact.markdownHash,
        maxBytes,
        ...(artifact.subGraphName ? { subGraphName: artifact.subGraphName } : {}),
        requestAgentAddress: ctx.requestAgentAddress,
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }
    if (fetched.denied) {
      lastError = fetched.denied;
      continue;
    }
    if (typeof fetched.totalBytes === 'number' && fetched.totalBytes > maxBytes) return { tooLargeBytes: fetched.totalBytes };
    if (fetched.truncated) return { tooLargeBytes: fetched.totalBytes ?? maxBytes + 1 };
    if (!fetched.bytes) {
      lastError = 'source blob fetch returned no bytes';
      continue;
    }
    const bytes = Buffer.from(fetched.bytes);
    if (bytes.length > maxBytes) return { tooLargeBytes: bytes.length };
    if (!contentHashMatchesBytes(artifact.markdownHash, bytes)) {
      lastError = 'source blob hash mismatch';
      continue;
    }
    const stored = await ctx.fileStore.put(bytes, 'text/markdown');
    if (!contentHashMatchesBytes(artifact.markdownHash, bytes)) {
      return { error: 'source blob hash mismatch after cache write' };
    }
    if (
      artifact.markdownHash.startsWith('keccak256:') && stored.keccak256 !== artifact.markdownHash ||
      artifact.markdownHash.startsWith('sha256:') && stored.hash !== artifact.markdownHash
    ) {
      return { error: 'cached source blob hash mismatch' };
    }
    await markVerifiedImportedArtifactMarkdownCache(ctx, artifact);
    artifact.sourcePeerId = sourcePeerId;
    artifact.canReadMarkdown = true;
    artifact.markdownAvailability = 'local';
    artifact.canFetchMarkdown = false;
    delete artifact.markdownUnavailableReason;
    return { bytes };
  }
  return { error: lastError };
}

function handleImportArtifactRouteError(res: ServerResponse, err: unknown): boolean {
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

async function resolveImportedArtifactFromSharedMemory(
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
  // SWM triples are replicated graph content, not durable import provenance.
  // Non-owner reads require a marker from prior verified hydration before
  // reusing local bytes. Owner reads may use the local file store directly:
  // those bytes are the source node's own imported artifact cache.
  const markdownAvailableLocally = markdownHash
    ? args.ownerGuardRelaxed
      ? await hasVerifiedImportedArtifactMarkdownCache(ctx, {
          contextGraphId: args.contextGraphId,
          assertionUri: args.assertionUri,
          markdownHash,
        }).catch(() => false)
      : await ctx.fileStore.has(markdownHash).catch(() => false)
    : false;
  const sourcePeerIds = await resolveLegacyImportedArtifactSourcePeerIds(ctx, args.assertionAgentAddress)
    .catch(() => []);

  return finalizeImportedArtifactAvailability(ctx, {
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
    ...(sourcePeerIds[0] ? { sourcePeerId: sourcePeerIds[0], sourcePeerIds } : {}),
    canReadMarkdown: markdownAvailableLocally,
    ...(args.ownerGuardRelaxed ? { ownerGuardRelaxed: true } : {}),
  });
}

async function resolveImportedArtifact(
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
  const canReadSharedSource = canRelaxGuard
    ? await canReadImportedArtifactSharedSource(ctx.agent, contextGraphId)
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
    if (canRelaxGuard && canReadSharedSource && !parsedAssertion.legacy) {
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
    SELECT ?fileHash ?contentType ?rootEntity ?structuralTripleCount ?semanticTripleCount ?extractionMethod ?extractionStatus ?mdIntermediateHash ?sourceFileName ?sourcePublisherPeerId WHERE {
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
        OPTIONAL { <${assertionUri}> <${DKG_ONTOLOGY}publisherPeerId> ?sourcePublisherPeerId }
      }
    }
    LIMIT 1
  `) as { type?: string; bindings?: Array<Record<string, unknown>> };
  const metaBinding = metaResult.bindings?.[0];
  if (!metaBinding) {
    if (canRelaxGuard && !parsedAssertion.legacy) {
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

  // Replicated import metadata may have a `markdownHash` even when the
  // raw source bytes are absent from this peer's file store. Derive local
  // readability from the file store for both owner and non-owner reads;
  // a known source peer can still satisfy the read through hydration.
  const markdownAvailableLocally = markdownHash
    ? await ctx.fileStore.has(markdownHash).catch(() => false)
    : false;
  const durableSourcePeerId = normalizeSourcePeerId(metaBinding.sourcePublisherPeerId);
  const legacySourcePeerIds = durableSourcePeerId
    ? []
    : await resolveLegacyImportedArtifactSourcePeerIds(ctx, parsedAssertion.assertionAgentAddress).catch(() => []);
  const sourcePeerId = durableSourcePeerId ?? legacySourcePeerIds[0];

  return finalizeImportedArtifactAvailability(ctx, {
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
    ...(sourcePeerId ? { sourcePeerId } : {}),
    ...(legacySourcePeerIds.length > 0 ? { sourcePeerIds: legacySourcePeerIds } : {}),
    ...(ownerGuardRelaxed ? { ownerGuardRelaxed: true } : {}),
  });
}

export async function handleAssertionRoutes(ctx: RequestContext): Promise<void> {
  const {
    req,
    res,
    agent,
    publisherControl,
    config,
    startedAt,
    dashDb,
    opWallets,
    network,
    tracker,
    memoryManager,
    bridgeAuthToken,
    nodeVersion,
    nodeCommit,
    catchupTracker,
    extractionRegistry,
    fileStore,
    extractionStatus,
    assertionImportLocks,
    vectorStore,
    embeddingProvider,
    validTokens,
    apiHost,
    apiPortRef,
    url,
    path,
    requestToken,
    requestAgentAddress,
    emitMemoryGraphChanged,
    emitNotification,
  } = ctx;
  const writePreflightCallerAgentAddress = requestToken
    ? agent.resolveAgentByToken(requestToken)
    : undefined;
  const writePreflightContextGraphOpts = {
    callerAgentAddress: writePreflightCallerAgentAddress,
    allowLocalExactFallback: !writePreflightCallerAgentAddress,
  };

  // POST /api/assertion/import-artifact/resolve
  // Resolve a completed deterministic import artifact from graph metadata.
  if (req.method === "POST" && path === "/api/assertion/import-artifact/resolve") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    try {
      const artifact = await resolveImportedArtifact(ctx, parsed as Record<string, unknown>, {
        requestAgentAddress,
        message: 'Import artifact metadata can only be read from imported assertions owned by the requesting agent',
        // Issue #872 — this is a read; opt into the public + open
        // policy relaxation. The write route below does NOT set this.
        relaxOnPublicOpenCg: true,
      });
      return jsonResponse(res, 200, { artifact });
    } catch (err) {
      if (handleImportArtifactRouteError(res, err)) return;
      throw err;
    }
  }

  // POST /api/assertion/import-artifact/read-markdown
  // Read only the Markdown blob tied to a completed imported assertion.
  if (req.method === "POST" && path === "/api/assertion/import-artifact/read-markdown") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    try {
      const artifact = await resolveImportedArtifact(ctx, parsed as Record<string, unknown>, {
        requestAgentAddress,
        message: 'Import artifact Markdown can only be read from imported assertions owned by the requesting agent',
        // Issue #872 — read path; opt into the public + open relaxation.
        relaxOnPublicOpenCg: true,
      });
      const maxBytes = normalizeMarkdownReadLimit((parsed as Record<string, unknown>).maxBytes);
      if (!artifact.markdownHash) {
        return jsonResponse(res, 409, {
          error: 'Import artifact does not have a readable Markdown source',
          artifact,
        });
      }
      let bytes = artifact.canReadMarkdown
        ? await fileStore.get(artifact.markdownHash)
        : null;
      if (!bytes && artifact.canFetchMarkdown) {
        const hydrated = await hydrateImportedArtifactMarkdown(ctx, artifact, maxBytes);
        if (hydrated.tooLargeBytes) {
          return jsonResponse(res, 413, {
            error: `Markdown content exceeds maxBytes (${maxBytes})`,
            artifact,
            bytes: hydrated.tooLargeBytes,
          });
        }
        if (hydrated.error) {
          return jsonResponse(res, 502, {
            error: `Markdown source fetch failed: ${hydrated.error}`,
            artifact,
          });
        }
        if (hydrated.bytes) bytes = hydrated.bytes;
      }
      if (!bytes) {
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

  // POST /api/assertion/semantic-enrichment/write
  // Write model-derived semantic triples into the completed imported assertion with provenance.
  if (req.method === "POST" && path === "/api/assertion/semantic-enrichment/write") {
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

  // POST /api/assertion/create
  //   Body: {
  //     contextGraphId, name,
  //     subGraphName?,
  //     quads?,                               // one-shot write
  //     finalize?: boolean,                   // one-shot finalize
  //     promote?: boolean,                    // one-shot promote-to-SWM
  //     authorAgentAddress?, preSignedAuthorAttestation?, schemeVersion?,  // forwarded to finalize
  //   }
  //
  // Phase B convenience: a Hermes/OpenClaw client used to need 4 round
  // trips (create → write → finalize → promote) just to stage an
  // assertion for VM publish. This endpoint folds the chain into one
  // call by treating the optional `quads`, `finalize`, and `promote`
  // flags as opt-in steps. Each is independent — a caller can do
  // `{ name }` only (legacy create), `{ name, quads }` (create+write),
  // `{ name, quads, finalize: true, promote: true }` (full lifecycle
  // up to but not including chain submit).
  if (req.method === "POST" && path === "/api/assertion/create") {
    const body = await readBody(req);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const {
      contextGraphId,
      name,
      subGraphName,
      quads,
      finalize: shouldFinalize,
      promote: shouldPromote,
      authorAgentAddress: bodyAuthorAgentAddress,
      preSignedAuthorAttestation: bodyPreSignedAttestation,
      schemeVersion,
    } = parsed;
    if (!name) return jsonResponse(res, 400, { error: 'Missing "name"' });
    const resolvedContextGraphId = await resolveRequiredWriteContextGraphId(
      agent,
      contextGraphId,
      res,
      writePreflightContextGraphOpts,
    );
    if (!resolvedContextGraphId) return;
    if (typeof name !== "string")
      return jsonResponse(res, 400, { error: '"name" must be a string' });
    const nameVal = validateAssertionName(name);
    if (!nameVal.valid)
      return jsonResponse(res, 400, {
        error: `Invalid "name": ${nameVal.reason}`,
      });
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    if (quads !== undefined) {
      if (!Array.isArray(quads) || quads.length === 0) {
        return jsonResponse(res, 400, {
          error: '"quads" must be a non-empty array when supplied',
        });
      }
    }
    if (shouldFinalize === true && quads === undefined) {
      return jsonResponse(res, 400, {
        error: '"finalize: true" requires "quads" — cannot finalize an empty assertion',
      });
    }
    if (shouldPromote === true && shouldFinalize !== true) {
      return jsonResponse(res, 400, {
        error: '"promote: true" requires "finalize: true" — promote runs after the seal is in place',
      });
    }
    if (
      bodyAuthorAgentAddress != null &&
      bodyPreSignedAttestation != null
    ) {
      return jsonResponse(res, 400, {
        error:
          '"authorAgentAddress" and "preSignedAuthorAttestation" are mutually exclusive',
      });
    }
    let resolvedPreSignedAttestation:
      | { address: string; signature: { r: Uint8Array; vs: Uint8Array } }
      | undefined;
    if (bodyPreSignedAttestation != null) {
      const validated = validatePreSignedAuthorAttestation(
        bodyPreSignedAttestation,
        res,
      );
      if (validated === undefined) return;
      resolvedPreSignedAttestation = validated;
    }
    let resolvedAuthorAgentAddress: string | undefined;
    if (resolvedPreSignedAttestation == null) {
      if (
        typeof bodyAuthorAgentAddress === 'string' &&
        bodyAuthorAgentAddress.length > 0
      ) {
        if (!/^0x[0-9a-fA-F]{40}$/.test(bodyAuthorAgentAddress)) {
          return jsonResponse(res, 400, {
            error: '"authorAgentAddress" must be a 0x-prefixed 20-byte EVM address',
          });
        }
        resolvedAuthorAgentAddress = bodyAuthorAgentAddress;
      } else {
        const requestToken = extractBearerToken(req.headers.authorization);
        const tokenAgentAddress = requestToken
          ? agent.resolveAgentByToken(requestToken)
          : undefined;
        if (tokenAgentAddress != null) {
          resolvedAuthorAgentAddress = tokenAgentAddress;
        }
      }
    }
    if (
      schemeVersion != null &&
      (typeof schemeVersion !== 'number' || !Number.isInteger(schemeVersion) || schemeVersion < 1)
    ) {
      return jsonResponse(res, 400, {
        error: '"schemeVersion" must be a positive integer when supplied',
      });
    }
    try {
      const assertionUri = await agent.assertion.create(
        resolvedContextGraphId,
        name,
        subGraphName ? { subGraphName } : undefined,
      );
      emitMemoryGraphChanged?.({
        contextGraphId: resolvedContextGraphId,
        layers: ["wm"],
        subGraphName,
        operation: "assertion_created",
        source: "api",
        counts: { triples: 0 },
      });
      // ADR-002: scoped `created` activity row. Mirrors the moment the
      // publisher writes `dkg:AssertionCreated` into `_meta` (inside
      // `assertionCreate`), so the bell pane and the per-CG Overview feed
      // agree on what "created" means. Actor = the request/author agent;
      // the row is born CG-scoped (the caller is a writer on this CG).
      // Never throws into the write path (helper + try/catch).
      try {
        recordAssertionActivity(dashDb, {
          contextGraphId: resolvedContextGraphId,
          kind: "created",
          actorAgentAddress: resolvedAuthorAgentAddress ?? requestAgentAddress,
          subGraphName,
        });
        emitNotification?.({ contextGraphId: resolvedContextGraphId, type: "assertion_activity" });
      } catch { /* never break the create path */ }
      const response: Record<string, unknown> = { assertionUri };
      if (Array.isArray(quads) && quads.length > 0) {
        await agent.assertion.write(
          resolvedContextGraphId,
          name,
          quads,
          subGraphName ? { subGraphName } : undefined,
        );
        emitMemoryGraphChanged?.({
          contextGraphId: resolvedContextGraphId,
          layers: ["wm"],
          subGraphName,
          operation: "assertion_written",
          source: "api",
          counts: { triples: quads.length },
        });
        response.written = quads.length;
      }
      if (shouldFinalize === true) {
        const seal = await agent.assertion.finalize(resolvedContextGraphId, name, {
          ...(subGraphName ? { subGraphName } : {}),
          ...(resolvedAuthorAgentAddress
            ? { authorAgentAddress: resolvedAuthorAgentAddress }
            : {}),
          ...(resolvedPreSignedAttestation
            ? { preSignedAuthorAttestation: resolvedPreSignedAttestation }
            : {}),
          ...(schemeVersion != null ? { schemeVersion } : {}),
        });
        emitMemoryGraphChanged?.({
          contextGraphId: resolvedContextGraphId,
          layers: ["wm"],
          subGraphName,
          operation: "assertion_finalized",
          source: "api",
        });
        response.seal = {
          merkleRoot: ethers.hexlify(seal.merkleRoot),
          authorAddress: seal.authorAddress,
          schemeVersion: seal.schemeVersion,
          chainId: seal.chainId.toString(),
          kav10Address: seal.kav10Address,
          eip712Digest: seal.eip712Digest,
        };
      }
      if (shouldPromote === true) {
        const promoteResult = await agent.assertion.promote(
          resolvedContextGraphId,
          name,
          subGraphName ? { subGraphName } : undefined,
        );
        if (promoteResult.promotedCount !== 0) {
          emitMemoryGraphChanged?.({
            contextGraphId: resolvedContextGraphId,
            layers: ["wm", "swm"],
            subGraphName,
            operation: "assertion_promoted",
            source: "api",
            counts: { triples: promoteResult.promotedCount },
          });
          // ADR-002: scoped `promoted` activity row (WM→SWM). Only when
          // something actually promoted (promotedCount !== 0).
          try {
            recordAssertionActivity(dashDb, {
              contextGraphId: resolvedContextGraphId,
              kind: "promoted",
              actorAgentAddress: resolvedAuthorAgentAddress ?? requestAgentAddress,
              subGraphName,
              tripleCount: promoteResult.promotedCount,
            });
            emitNotification?.({ contextGraphId: resolvedContextGraphId, type: "assertion_activity" });
          } catch { /* never break the promote path */ }
        }
        response.promotedCount = promoteResult.promotedCount;
      }
      return jsonResponse(res, 200, response);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      if (
        message.includes("already exists") ||
        message.includes("not found") ||
        message.includes("Invalid") ||
        message.includes('Unsafe') ||
        message.includes('not registered') ||
        message.includes('mutually exclusive') ||
        message.includes('not a registered local agent') ||
        message.includes('signer mismatch') ||
        message.includes('has no quads') ||
        message.includes('different merkleRoot') ||
        message.includes('reserved namespace') ||
        err?.name === 'ReservedNamespaceError'
      ) {
        return jsonResponse(res, 400, { error: message });
      }
      throw err;
    }
  }

  // POST /api/assertion/:name/write  { contextGraphId, quads, subGraphName? }
  if (
    req.method === "POST" &&
    path.startsWith("/api/assertion/") &&
    path.endsWith("/write")
  ) {
    const assertionName = safeDecodeURIComponent(
      path.slice("/api/assertion/".length, -"/write".length),
      res,
    );
    if (assertionName === null) return;
    const nameVal = validateAssertionName(assertionName);
    if (!nameVal.valid)
      return jsonResponse(res, 400, {
        error: `Invalid assertion name: ${nameVal.reason}`,
      });
    const body = await readBody(req);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const { contextGraphId, quads, subGraphName } = parsed;
    if (!quads?.length)
      return jsonResponse(res, 400, { error: 'Missing "quads"' });
    const resolvedContextGraphId = await resolveRequiredWriteContextGraphId(
      agent,
      contextGraphId,
      res,
      writePreflightContextGraphOpts,
    );
    if (!resolvedContextGraphId) return;
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    try {
      await agent.assertion.write(
        resolvedContextGraphId,
        assertionName,
        quads,
        subGraphName ? { subGraphName } : undefined,
      );
      emitMemoryGraphChanged?.({
        contextGraphId: resolvedContextGraphId,
        layers: ["wm"],
        subGraphName,
        operation: "assertion_written",
        source: "api",
        counts: { triples: quads.length },
      });
      return jsonResponse(res, 200, { written: quads.length });
    } catch (err: any) {
      if (
        err.message?.includes("not found") ||
        err.message?.includes("Invalid") ||
        err.message?.includes("Unsafe") ||
        // Round 9 Bug 25: reserved-namespace writes surface as 400.
        err.name === "ReservedNamespaceError" ||
        err.message?.includes("reserved namespace")
      ) {
        return jsonResponse(res, 400, { error: err.message });
      }
      throw err;
    }
  }

  // POST /api/assertion/:name/query  { contextGraphId, subGraphName? }
  if (
    req.method === "POST" &&
    path.startsWith("/api/assertion/") &&
    path.endsWith("/query")
  ) {
    const assertionName = safeDecodeURIComponent(
      path.slice("/api/assertion/".length, -"/query".length),
      res,
    );
    if (assertionName === null) return;
    const nameVal = validateAssertionName(assertionName);
    if (!nameVal.valid)
      return jsonResponse(res, 400, {
        error: `Invalid assertion name: ${nameVal.reason}`,
      });
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const { contextGraphId, subGraphName } = parsed;
    if (!validateRequiredContextGraphId(contextGraphId, res)) return;
    const normalizedContextGraphId = normalizeContextGraphIdOrUri(contextGraphId);
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    try {
      const quads = await agent.assertion.query(
        normalizedContextGraphId,
        assertionName,
        subGraphName ? { subGraphName } : undefined,
      );
      const sortedQuads = sortAssertionQuads(quads);
      return jsonResponse(res, 200, { quads: sortedQuads, count: sortedQuads.length });
    } catch (err: any) {
      if (
        err.message?.includes("not found") ||
        err.message?.includes("Invalid") ||
        err.message?.includes("Unsafe")
      ) {
        return jsonResponse(res, 400, { error: err.message });
      }
      throw err;
    }
  }

  // POST /api/assertion/:name/promote  { contextGraphId, entities?, subGraphName? }
  if (
    req.method === "POST" &&
    path.startsWith("/api/assertion/") &&
    path.endsWith("/promote")
  ) {
    const assertionName = safeDecodeURIComponent(
      path.slice("/api/assertion/".length, -"/promote".length),
      res,
    );
    if (assertionName === null) return;
    const nameVal = validateAssertionName(assertionName);
    if (!nameVal.valid)
      return jsonResponse(res, 400, {
        error: `Invalid assertion name: ${nameVal.reason}`,
      });
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const { contextGraphId, entities, subGraphName } = parsed;
    const resolvedContextGraphId = await resolveRequiredWriteContextGraphId(
      agent,
      contextGraphId,
      res,
      writePreflightContextGraphOpts,
    );
    if (!resolvedContextGraphId) return;
    if (!validateEntities(entities, res)) return;
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    try {
      const result = await agent.assertion.promote(
        resolvedContextGraphId,
        assertionName,
        { entities: entities ?? "all", subGraphName },
      );
      const promotedCount = typeof result?.promotedCount === "number" ? result.promotedCount : undefined;
      if (promotedCount !== 0) {
        emitMemoryGraphChanged?.({
          contextGraphId: resolvedContextGraphId,
          layers: ["wm", "swm"],
          subGraphName,
          operation: "assertion_promoted",
          source: "api",
          counts: { triples: promotedCount },
        });
        // ADR-002: scoped `promoted` activity row (dedicated promote route).
        try {
          recordAssertionActivity(dashDb, {
            contextGraphId: resolvedContextGraphId,
            kind: "promoted",
            actorAgentAddress: requestAgentAddress,
            subGraphName,
            tripleCount: promotedCount,
          });
          emitNotification?.({ contextGraphId: resolvedContextGraphId, type: "assertion_activity" });
        } catch { /* never break the promote path */ }
      }
      return jsonResponse(res, 200, result);
    } catch (err: any) {
      // Issue #864 — translate the publisher's typed "_meta says completed
      // but data graph is empty" error into a 409 with a structured body
      // the UI can pattern-match on. Keep it ahead of the generic 400
      // branch so the more specific code wins. Duck-type the check by
      // name + code so we don't have to import the publisher's error
      // class into the cli package's compile graph.
      if (isPayloadTooLargeError(err)) {
        return jsonResponse(res, 413, payloadTooLargeResponseBody(err));
      }
      if (err?.name === "AssertionNotPersistedError" || err?.code === "ASSERTION_NOT_PERSISTED") {
        return jsonResponse(res, 409, {
          error: err.message,
          code: "ASSERTION_NOT_PERSISTED",
          contextGraphId: err.contextGraphId,
          assertionGraph: err.assertionGraph,
          expectedTripleCount: err.expectedTripleCount,
        });
      }
      if (
        err.message?.includes("not found") ||
        err.message?.includes("Invalid") ||
        err.message?.includes("Unsafe")
      ) {
        return jsonResponse(res, 400, { error: err.message });
      }
      throw err;
    }
  }

  // ── Async-promote queue (RFC: docs/specs/SPEC_ASYNC_PROMOTE_QUEUE.md) ──
  //
  // Five routes that mirror the sync /promote contract but enqueue work
  // for an in-process worker (PR #3) instead of running it inline. All
  // routes share the SMALL_BODY_BYTES cap from sync /promote — see
  // RFC §3.1.
  //
  // The list/status/cancel/recover routes are unambiguous because the
  // jobId lives in the path; the enqueue route uses `/promote-async`
  // as the trailing segment so it doesn't conflict with assertion
  // names containing the word "promote".

  // POST /api/assertion/:name/promote-async  { contextGraphId, entities?, subGraphName? }
  if (
    req.method === "POST" &&
    path.startsWith("/api/assertion/") &&
    path.endsWith("/promote-async")
  ) {
    const assertionName = safeDecodeURIComponent(
      path.slice("/api/assertion/".length, -"/promote-async".length),
      res,
    );
    if (assertionName === null) return;
    const nameVal = validateAssertionName(assertionName);
    if (!nameVal.valid)
      return jsonResponse(res, 400, {
        error: `Invalid assertion name: ${nameVal.reason}`,
      });
    if (asyncPromoteUnavailable(res)) return;
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const { contextGraphId, entities, subGraphName } = parsed;
    const resolvedContextGraphId = await resolveRequiredWriteContextGraphId(
      agent,
      contextGraphId,
      res,
      writePreflightContextGraphOpts,
    );
    if (!resolvedContextGraphId) return;
    if (!validateEntities(entities, res)) return;
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    try {
      const result = await agent.assertion.promoteAsync(
        resolvedContextGraphId,
        assertionName,
        { entities: entities ?? "all", subGraphName },
      );
      return jsonResponse(res, 200, {
        jobId: result.jobId,
        state: "queued",
      });
    } catch (err: any) {
      if (err instanceof PromoteJobConflictError) {
        return jsonResponse(res, 409, {
          error: err.message,
          existingJobId: err.existingJobId,
        });
      }
      if (
        err.message?.includes("required") ||
        err.message?.includes("Invalid") ||
        err.message?.includes("must be")
      ) {
        return jsonResponse(res, 400, { error: err.message });
      }
      throw err;
    }
  }

  // GET /api/assertion/promote-async  ?contextGraphId=<cg>&state=queued,running,...&limit=<n>
  // List jobs filtered by contextGraphId / state. Must come BEFORE the
  // `/:jobId` route below because Node URL routing here is by `startsWith`
  // + `endsWith` rather than a real router; an exact-prefix GET to the
  // collection URL would otherwise be claimed by the per-job handler.
  if (
    req.method === "GET" &&
    path === "/api/assertion/promote-async"
  ) {
    if (asyncPromoteUnavailable(res)) return;
    const stateParam = url.searchParams.get("state");
    const requestedStates = stateParam ? stateParam.split(",").map((s) => s.trim()) : undefined;
    if (
      requestedStates &&
      (requestedStates.length === 0 ||
        requestedStates.some((s) => !(PROMOTE_JOB_STATES as readonly string[]).includes(s)))
    ) {
      return jsonResponse(res, 400, {
        error: `Invalid state filter: ${stateParam}. Allowed: ${PROMOTE_JOB_STATES.join(",")}`,
      });
    }
    const stateFilter = requestedStates as PromoteJobState[] | undefined;
    const contextGraphId = url.searchParams.get("contextGraphId") ?? undefined;
    const limitParam = url.searchParams.get("limit");
    if (limitParam !== null && !/^[1-9]\d*$/.test(limitParam)) {
      return jsonResponse(res, 400, {
        error: "limit must be a positive integer ≤ 1000",
      });
    }
    const limit = limitParam !== null ? Number.parseInt(limitParam, 10) : undefined;
    if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0 || limit > 1000)) {
      return jsonResponse(res, 400, {
        error: "limit must be a positive integer ≤ 1000",
      });
    }
    const jobs = await agent.assertion.listPromoteAsyncJobs({
      state: stateFilter,
      contextGraphId,
      limit,
    });
    return jsonResponse(res, 200, { jobs: jobs.map(promoteJobToView) });
  }

  // GET /api/assertion/promote-async/:jobId
  if (
    req.method === "GET" &&
    path.startsWith("/api/assertion/promote-async/") &&
    !path.endsWith("/recover")
  ) {
    if (asyncPromoteUnavailable(res)) return;
    const jobId = decodePromoteJobId(path.slice("/api/assertion/promote-async/".length), res);
    if (jobId === null) return;
    const job = await agent.assertion.getPromoteAsyncStatus(jobId);
    if (!job) {
      return jsonResponse(res, 404, { error: `Promote job not found: ${jobId}` });
    }
    return jsonResponse(res, 200, promoteJobToView(job));
  }

  // DELETE /api/assertion/promote-async/:jobId   — cancel a queued/failed_retrying job
  if (
    req.method === "DELETE" &&
    path.startsWith("/api/assertion/promote-async/")
  ) {
    const jobId = decodePromoteJobId(path.slice("/api/assertion/promote-async/".length), res);
    if (jobId === null) return;
    try {
      await agent.assertion.cancelPromoteAsync(jobId);
      const job = await agent.assertion.getPromoteAsyncStatus(jobId);
      return jsonResponse(res, 200, { jobId, state: job?.state ?? "failed" });
    } catch (err: any) {
      if (err.message?.includes("not found")) {
        return jsonResponse(res, 404, { error: err.message });
      }
      // "Cannot cancel job in state 'running'" etc.
      if (err.message?.includes("Cannot cancel")) {
        return jsonResponse(res, 409, { error: err.message });
      }
      throw err;
    }
  }

  // POST /api/assertion/promote-async/:jobId/recover   — requeue a terminal-failed job
  if (
    req.method === "POST" &&
    path.startsWith("/api/assertion/promote-async/") &&
    path.endsWith("/recover")
  ) {
    const jobId = decodePromoteJobId(
      path.slice("/api/assertion/promote-async/".length, -"/recover".length),
      res,
    );
    if (jobId === null) return;
    try {
      await agent.assertion.recoverPromoteAsync(jobId);
      const job = await agent.assertion.getPromoteAsyncStatus(jobId);
      return jsonResponse(res, 200, { jobId, state: job?.state ?? "queued" });
    } catch (err: any) {
      if (err.message?.includes("not found")) {
        return jsonResponse(res, 404, { error: err.message });
      }
      if (err.message?.includes("Cannot recover")) {
        return jsonResponse(res, 409, { error: err.message });
      }
      throw err;
    }
  }

  // POST /api/assertion/:name/finalize  { contextGraphId, subGraphName?, authorAgentAddress?, preSignedAuthorAttestation?, schemeVersion? }
  //
  // RFC-001 §9.x — seal an assertion's content with an EIP-712
  // AuthorAttestation signed at this point in the lifecycle (as opposed
  // to the publish-time path that signs over SWM contents at chain-tx
  // time). After finalize, the seal lives in `_meta` keyed by the
  // assertion URI and travels with the assertion through SWM gossip;
  // publish reads the seal and forwards it verbatim to KAv10.
  //
  // Author resolution (mirrors `/api/shared-memory/publish` Phase 4):
  //   1. body `preSignedAuthorAttestation` (self-sovereign)
  //   2. body `authorAgentAddress` (admin-asserted custodial)
  //   3. agent-scoped bearer token → that agent (custodial auto-attribution)
  //   4. node admin token → publisher EOA fallback
  if (
    req.method === "POST" &&
    path.startsWith("/api/assertion/") &&
    path.endsWith("/finalize")
  ) {
    const assertionName = safeDecodeURIComponent(
      path.slice("/api/assertion/".length, -"/finalize".length),
      res,
    );
    if (assertionName === null) return;
    const nameVal = validateAssertionName(assertionName);
    if (!nameVal.valid)
      return jsonResponse(res, 400, {
        error: `Invalid assertion name: ${nameVal.reason}`,
      });
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const {
      contextGraphId,
      subGraphName,
      authorAgentAddress: bodyAuthorAgentAddress,
      preSignedAuthorAttestation: bodyPreSignedAttestation,
      schemeVersion,
    } = parsed;
    const resolvedContextGraphId = await resolveRequiredWriteContextGraphId(
      agent,
      contextGraphId,
      res,
      writePreflightContextGraphOpts,
    );
    if (!resolvedContextGraphId) return;
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    if (
      bodyAuthorAgentAddress != null &&
      bodyPreSignedAttestation != null
    ) {
      return jsonResponse(res, 400, {
        error:
          '"authorAgentAddress" and "preSignedAuthorAttestation" are mutually exclusive',
      });
    }
    let resolvedPreSignedAttestation:
      | { address: string; signature: { r: Uint8Array; vs: Uint8Array } }
      | undefined;
    if (bodyPreSignedAttestation != null) {
      const validated = validatePreSignedAuthorAttestation(
        bodyPreSignedAttestation,
        res,
      );
      if (validated === undefined) return;
      resolvedPreSignedAttestation = validated;
    }
    let resolvedAuthorAgentAddress: string | undefined;
    if (resolvedPreSignedAttestation == null) {
      if (
        typeof bodyAuthorAgentAddress === 'string' &&
        bodyAuthorAgentAddress.length > 0
      ) {
        if (!/^0x[0-9a-fA-F]{40}$/.test(bodyAuthorAgentAddress)) {
          return jsonResponse(res, 400, {
            error: '"authorAgentAddress" must be a 0x-prefixed 20-byte EVM address',
          });
        }
        resolvedAuthorAgentAddress = bodyAuthorAgentAddress;
      } else {
        // Auto-attribute when the request was authenticated with an
        // agent-scoped bearer token. Node admin tokens fall through to
        // the publisher-wallet fallback inside `assertionFinalize`.
        const requestToken = extractBearerToken(req.headers.authorization);
        const tokenAgentAddress = requestToken
          ? agent.resolveAgentByToken(requestToken)
          : undefined;
        if (tokenAgentAddress != null) {
          resolvedAuthorAgentAddress = tokenAgentAddress;
        }
      }
    }
    if (
      schemeVersion != null &&
      (typeof schemeVersion !== 'number' || !Number.isInteger(schemeVersion) || schemeVersion < 1)
    ) {
      return jsonResponse(res, 400, {
        error: '"schemeVersion" must be a positive integer when supplied',
      });
    }
    try {
      const seal = await agent.assertion.finalize(resolvedContextGraphId, assertionName, {
        ...(subGraphName ? { subGraphName } : {}),
        ...(resolvedAuthorAgentAddress
          ? { authorAgentAddress: resolvedAuthorAgentAddress }
          : {}),
        ...(resolvedPreSignedAttestation
          ? { preSignedAuthorAttestation: resolvedPreSignedAttestation }
          : {}),
        ...(schemeVersion != null ? { schemeVersion } : {}),
      });
      // Mirror the chained /create handler: every step in the sign-at-creation
      // lifecycle emits a memory_graph_changed SSE so a UI watching the graph
      // (staking-ui, dkg-node-ui) reflects the state machine in real time.
      // The chained handler emits 4 events (created/written/finalized/promoted);
      // the standalone routes must each emit their own — otherwise a client
      // composing the chain by hand would miss the `assertion_finalized` step.
      emitMemoryGraphChanged?.({
        contextGraphId: resolvedContextGraphId,
        layers: ["wm"],
        subGraphName,
        operation: "assertion_finalized",
        source: "api",
      });
      return jsonResponse(res, 200, {
        assertionUri: seal.assertionUri,
        merkleRoot: ethers.hexlify(seal.merkleRoot),
        authorAddress: seal.authorAddress,
        schemeVersion: seal.schemeVersion,
        chainId: seal.chainId.toString(),
        kav10Address: seal.kav10Address,
        eip712Digest: seal.eip712Digest,
      });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      if (
        message.includes('not found') ||
        message.includes('Invalid') ||
        message.includes('Unsafe') ||
        message.includes('not registered') ||
        message.includes('mutually exclusive') ||
        message.includes('not a registered local agent') ||
        message.includes('signer mismatch') ||
        message.includes('has no quads') ||
        message.includes('different merkleRoot') ||
        message.includes('not registered on-chain')
      ) {
        return jsonResponse(res, 400, { error: message });
      }
      throw err;
    }
  }

  // POST /api/assertion/:name/discard  { contextGraphId, subGraphName? }
  if (
    req.method === "POST" &&
    path.startsWith("/api/assertion/") &&
    path.endsWith("/discard")
  ) {
    const assertionName = safeDecodeURIComponent(
      path.slice("/api/assertion/".length, -"/discard".length),
      res,
    );
    if (assertionName === null) return;
    const nameVal = validateAssertionName(assertionName);
    if (!nameVal.valid)
      return jsonResponse(res, 400, {
        error: `Invalid assertion name: ${nameVal.reason}`,
      });
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const { contextGraphId, subGraphName } = parsed;
    const resolvedContextGraphId = await resolveRequiredWriteContextGraphId(
      agent,
      contextGraphId,
      res,
      writePreflightContextGraphOpts,
    );
    if (!resolvedContextGraphId) return;
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    try {
      await agent.assertion.discard(
        resolvedContextGraphId,
        assertionName,
        subGraphName ? { subGraphName } : undefined,
      );
      const assertionUri = contextGraphAssertionUri(
        resolvedContextGraphId,
        requestAgentAddress,
        assertionName,
        subGraphName,
      );
      extractionStatus.delete(assertionUri);
      emitMemoryGraphChanged?.({
        contextGraphId: resolvedContextGraphId,
        layers: ["wm"],
        subGraphName,
        operation: "assertion_discarded",
        source: "api",
      });
      return jsonResponse(res, 200, { discarded: true });
    } catch (err: any) {
      if (
        err.message?.includes("not found") ||
        err.message?.includes("Invalid") ||
        err.message?.includes("Unsafe")
      ) {
        return jsonResponse(res, 400, { error: err.message });
      }
      throw err;
    }
  }

  // GET /api/assertion/:name/history?contextGraphId=...&agentAddress=...
  if (
    req.method === "GET" &&
    path.startsWith("/api/assertion/") &&
    path.includes("/history")
  ) {
    const assertionName = safeDecodeURIComponent(
      path.slice("/api/assertion/".length, -"/history".length),
      res,
    );
    if (assertionName === null) return;
    const nameVal = validateAssertionName(assertionName);
    if (!nameVal.valid)
      return jsonResponse(res, 400, {
        error: `Invalid assertion name: ${nameVal.reason}`,
      });
    const qs = new URL(req.url ?? "", "http://localhost").searchParams;
    const contextGraphId = qs.get("contextGraphId");
    if (!validateRequiredContextGraphId(contextGraphId, res)) return;
    const normalizedContextGraphId = normalizeContextGraphIdOrUri(contextGraphId!);
    const rawAgentAddress = qs.get("agentAddress") ?? undefined;
    if (rawAgentAddress && !/^[\w:.\-]+$/.test(rawAgentAddress)) {
      return jsonResponse(res, 400, { error: "Invalid agentAddress format" });
    }
    const subGraphName = qs.get("subGraphName") ?? undefined;
    try {
      const descriptor = await agent.assertion.history(
        normalizedContextGraphId,
        assertionName,
        { ...(rawAgentAddress ? { agentAddress: rawAgentAddress } : {}), ...(subGraphName ? { subGraphName } : {}) },
      );
      if (!descriptor) {
        return jsonResponse(res, 404, {
          error: `No lifecycle record found for assertion "${assertionName}"`,
        });
      }
      return jsonResponse(res, 200, descriptor);
    } catch (err: any) {
      if (
        err.message?.includes("not found") ||
        err.message?.includes("Invalid") ||
        err.message?.includes("Unsafe")
      ) {
        return jsonResponse(res, 400, { error: err.message });
      }
      throw err;
    }
  }

  // POST /api/assertion/:name/import-file  (multipart/form-data)
  //   file (required):           the uploaded document bytes
  //   contextGraphId (required): target context graph
  //   contentType (optional):    override the file part's Content-Type
  //   ontologyRef (optional):    CG _ontology URI for guided Phase 2 extraction
  //   subGraphName (optional):   target sub-graph inside the CG
  //
  // Orchestration:
  //   1. Parse multipart, store original file in file store → fileHash
  //   2. Resolve detectedContentType (explicit field > multipart content-type)
  //   3. If content type is text/markdown: skip Phase 1, use raw bytes as mdIntermediate
  //      Else if a converter is registered: run Phase 1, store mdIntermediate → mdIntermediateHash
  //      Else: graceful degrade — return extraction.status="skipped", no triples written
  //   4. Run Phase 2 markdown extractor on the mdIntermediate → triples + provenance
  //   5. Write triples + provenance to the assertion graph via agent.assertion.write
  //   6. Record the extraction status in the in-memory Map, return ImportFileResponse
  if (
    req.method === "POST" &&
    path.startsWith("/api/assertion/") &&
    path.endsWith("/import-file")
  ) {
    const assertionName = safeDecodeURIComponent(
      path.slice("/api/assertion/".length, -"/import-file".length),
      res,
    );
    if (assertionName === null) return;
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

    const detectedContentType = normalizeDetectedContentType(
      contentTypeOverride ?? filePart.contentType,
    );

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
            await agent.store.deleteByPattern({
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
          await agent.publisher.assertionCreate(
            contextGraphId!,
            assertionName,
            requestAgentAddress,
            subGraphName,
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

        let skippedMetaCleanupSucceeded = false;
        let skippedDataDropSucceeded = false;
        try {
          await agent.store.deleteByPattern({
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
              await agent.store.deleteByPattern({
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
      // bypasses `assertion.write` so the daemon can set per-quad graph
      // fields directly — `publisher.assertionWrite` hardcodes every quad to
      // the assertion graph URI, which defeats the multi-graph atomicity
      // we need here. Sub-graph registration is already validated by
      // `assertion.create`, so bypassing `assertion.write` doesn't skip any
      // safety checks.
      const assertionGraph = contextGraphAssertionUri(
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
      const dataGraphQuads = [
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
      // Durable source-peer locator for cross-peer source blob hydration.
      if (typeof agent.peerId === 'string' && agent.peerId.trim()) {
        metaQuads.push({
          subject: assertionUri,
          predicate: "http://dkg.io/ontology/publisherPeerId",
          object: JSON.stringify(agent.peerId.trim()),
          graph: metaGraph,
        });
      }
      // Optional Markdown intermediate hash — only emitted when Phase 1 actually ran (PDF/DOCX path).
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
          await agent.publisher.assertionCreate(
            contextGraphId!,
            assertionName,
            requestAgentAddress,
            subGraphName,
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
        //  - `dataDropSucceeded` → restore `dataSnapshot`
        //  - insert succeeded → no rollback
        //  - `deleteByPattern` itself failed → no rollback (nothing
        //    changed, retry converges cleanly)
        //
        // The rollback is best-effort: compound failures record a rich
        // error with every failure message, then rethrow the ORIGINAL
        // error so the 500 envelope matches what the caller experienced.
        let metaCleanupSucceeded = false;
        let dataDropSucceeded = false;
        try {
          await agent.store.deleteByPattern({
            subject: assertionUri,
            graph: metaGraph,
          });
          metaCleanupSucceeded = true;
          await agent.store.dropGraph(assertionGraph);
          dataDropSucceeded = true;
          // ── Atomic multi-graph insert: rows 1-13 + rows 14-20 in one call ──
          // A single `store.insert` across two graphs — either both
          // land or neither does, per the adapter contracts.
          await agent.store.insert([...dataGraphQuads, ...metaQuads]);
        } catch (writeErr: any) {
          const writeMsg = writeErr?.message ?? String(writeErr);
          const rollbackErrors: string[] = [];
          // Restore each side we corrupted, in reverse order of the
          // forward sequence (insert → dropGraph → deleteByPattern).
          // `dataSnapshot` is restored only if `dropGraph` succeeded
          // (before then the old data is still in the store); likewise
          // `metaSnapshot` is restored only if `deleteByPattern`
          // succeeded. On a `deleteByPattern`-only failure both flags
          // are false and no rollback fires — the state is unchanged.
          if (dataDropSucceeded && dataSnapshot.length > 0) {
            try {
              await agent.store.insert(dataSnapshot);
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

  // GET /api/assertion/:name/extraction-status?contextGraphId=...&subGraphName=...
  // Returns the current extraction job state for the given assertion.
  // Synchronous extractions (V10.0 default) return status="completed" immediately
  // on the import-file response; this endpoint lets agents re-query the status
  // later without having to hold the import-file response, and provides the hook
  // for async extraction workflows in V10.x.
  if (
    req.method === "GET" &&
    path.startsWith("/api/assertion/") &&
    path.endsWith("/extraction-status")
  ) {
    const assertionName = safeDecodeURIComponent(
      path.slice("/api/assertion/".length, -"/extraction-status".length),
      res,
    );
    if (assertionName === null) return;
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

  // GET /api/file/:hash — serve a stored file by its content hash.
  // Accepts sha256:<hex>, keccak256:<hex>, or bare <hex> (treated as sha256).
  if (req.method === 'GET' && path.startsWith('/api/file/')) {
    const fileHash = safeDecodeURIComponent(path.slice('/api/file/'.length), res);
    if (fileHash === null) return;
    if (!fileHash) {
      return jsonResponse(res, 400, { error: 'Missing file hash' });
    }
    const bytes = await fileStore.get(fileHash);
    if (!bytes) {
      return jsonResponse(res, 404, { error: `File not found: ${fileHash}` });
    }
    const SAFE_PREVIEW_TYPES = new Set([
      'application/pdf',
      'application/json',
      'text/plain',
      'text/csv',
      'text/markdown',
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
    ]);
    const rawCt = normalizeDetectedContentType(
      url.searchParams.get('contentType') ?? undefined,
    );
    const contentType = SAFE_PREVIEW_TYPES.has(rawCt)
      ? rawCt
      : 'application/octet-stream';
    const disposition = SAFE_PREVIEW_TYPES.has(rawCt) ? 'inline' : 'attachment';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': disposition,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600',
    });
    res.end(bytes);
    return;
  }

  // GET /api/kc/:id — chain-confirmed metadata for a knowledge
  // collection. Returns latest merkleRoot (hex) and the author tuple.
  // Useful for LU-8 verification: members fetch the merkleRoot off-chain
  // and feed it to verify-batch as `expectedMerkleRoot`.
  if (req.method === 'GET' && /^\/api\/kc\/[^/]+$/.test(path)) {
    const idStr = decodeURIComponent(path.split('/')[3] ?? '');
    if (!/^\d+$/.test(idStr)) {
      return jsonResponse(res, 400, {
        error: 'Invalid kaId — must be a non-negative integer',
      });
    }
    const kaId = BigInt(idStr);
    try {
      const chain: any = (agent as any).chain ?? (agent as any).chainAdapter;
      if (!chain?.getLatestMerkleRoot) {
        return jsonResponse(res, 503, {
          error: 'Chain adapter does not expose getLatestMerkleRoot',
        });
      }
      const rootBytes: Uint8Array = await chain.getLatestMerkleRoot(kaId);
      const rootHex = '0x' + Array.from(rootBytes).map((b: number) => b.toString(16).padStart(2, '0')).join('');
      let author: string | null = null;
      try {
        if (typeof agent.getKnowledgeCollectionAuthor === 'function') {
          const a = await agent.getKnowledgeCollectionAuthor(kaId);
          if (a && a !== '0x0000000000000000000000000000000000000000') author = a;
        }
      } catch { /* attestation lookup is optional */ }
      return jsonResponse(res, 200, {
        kaId: idStr,
        merkleRoot: rootHex,
        author,
      });
    } catch (err: any) {
      // Codex PR #609 R2 #5 — mirror the unknown-kaId mapping the
      // sibling `/api/kc/:id/author` route already does so callers
      // can branch on "not published yet" (404) vs. server failure
      // (500). KCS reverts on lookups for ids that don't exist;
      // matching the same regex keeps the two routes in lockstep.
      const msg = err?.message ?? String(err);
      if (/unknown kaId|nonexistent|out-of-bounds/i.test(msg)) {
        return jsonResponse(res, 404, { error: `Unknown kaId ${idStr}` });
      }
      return jsonResponse(res, 500, { error: msg });
    }
  }

  // GET /api/kc/:id/author — chain-confirmed author for a knowledge
  // collection's latest merkle-root entry.
  //
  // Delegates to `agent.getKnowledgeCollectionAuthor`, which reads
  // `KnowledgeCollectionStorage.getLatestMerkleRootAuthor(kaId)` via the
  // configured chain adapter. The view returns:
  //   - the EIP-712-recovered (or EIP-1271-verified) author for V10.1+
  //     publishes, or
  //   - the zero address for un-attested writes (legacy V8 / V9 publishes
  //     and the current V10.1 update path).
  //
  // We surface the zero-address case explicitly via `attested: false` so
  // clients don't have to know the convention. Adapters that don't
  // implement the view (no-chain mode, pre-V10.1 evm-adapter copies)
  // return 503 — this is "feature requires V10.1 chain adapter," not a
  // 404 about the kaId.
  if (req.method === 'GET' && /^\/api\/kc\/[^/]+\/author$/.test(path)) {
    const idStr = decodeURIComponent(path.split('/')[3] ?? '');
    if (!/^\d+$/.test(idStr)) {
      return jsonResponse(res, 400, {
        error: 'Invalid kaId — must be a non-negative integer',
      });
    }
    const kaId = BigInt(idStr);
    try {
      const author = await agent.getKnowledgeCollectionAuthor(kaId);
      if (author === null) {
        return jsonResponse(res, 503, {
          error:
            'Chain adapter does not expose getLatestMerkleRootAuthor — ' +
            'V10.1 author attestation is not available on this deployment',
        });
      }
      const ZERO = '0x0000000000000000000000000000000000000000';
      const attested = author.toLowerCase() !== ZERO;
      return jsonResponse(res, 200, {
        kaId: idStr,
        author: attested ? author : null,
        attested,
      });
    } catch (err: any) {
      // KCS reverts on unknown kaId; map to 404 so callers can branch
      // on "not published yet" vs "no attestation."
      const msg = err?.message ?? String(err);
      if (/unknown kaId|nonexistent|out-of-bounds/i.test(msg)) {
        return jsonResponse(res, 404, { error: `Unknown kaId ${idStr}` });
      }
      throw err;
    }
  }
}
