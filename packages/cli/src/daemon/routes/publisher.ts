// daemon/routes/publisher.ts
//
// Route handlers for publisher jobs / stats / cancel / retry / clear.
//
// Extracted verbatim from the legacy monolithic `handleRequest` --
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
// OpenClaw config helper (~line 2535) uses a bare `homedir()` -- aliased
// below so both sites coexist without a duplicate-module import.
import * as osModule from 'node:os';
const { homedir } = osModule;
const MAX_PUBLISH_EPOCHS = 0xffffffff;
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
import { computeNetworkId, createOperationContext, DKGEvent, Logger, PayloadTooLargeError, GET_VIEWS, TrustLevel, validateSubGraphName, validateAssertionName, validateContextGraphId, isSafeIri, assertSafeIri, sparqlIri, contextGraphSharedMemoryUri, contextGraphAssertionUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import {
  findReservedSubjectPrefix,
  isSafeJobId,
  isSkolemizedUri,
  SAFE_JOB_ID_ERROR,
} from '@origintrail-official/dkg-publisher';
import type { AsyncPreparedPublishPayload, LiftJobRetryProjection, PersistedLiftJob } from '@origintrail-official/dkg-publisher';
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
import { createPublisherControlFromStore, startPublisherRuntimeIfEnabled, type AsyncPublisherAvailability, type PublisherRuntime } from '../../publisher-runner.js';
import { createCatchupRunner, type CatchupJobResult, type CatchupRunner } from '../../catchup-runner.js';
import { loadTokens, httpAuthGuard, extractBearerToken } from '../../auth.js';
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
// Phase 8 -- project-manifest publish + install (UI-driven onboarding flow).
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

// Daemon sub-module imports -- every public symbol from sibling
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
import { respondTerminalClearOutcome } from './terminal-clear-response.js';
import {
  resolveNameToPeerId,
  jsonResponse,
  safeDecodeURIComponent,
  safeParseJson,
  validateOptionalSubGraphName,
  validateRequiredContextGraphId,
  normalizeContextGraphIdOrUri,
  validateEntities,
  validateConditions,
  MAX_BODY_BYTES,
  SMALL_BODY_BYTES,
  MAX_UPLOAD_BYTES,
  type ImportFileExtractionPayload,
  buildImportFileResponse,
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
  shortId,
  sleep,
  deriveBlockExplorerUrl,
} from '../http-utils.js';
import {
  normalizeRepo,
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
import { isValidRef, parseTagName } from '../../auto-update-ref.js';
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


interface PublisherLifecycleFacts {
  contextGraphId: string;
  name: string;
  subGraphName?: string;
  agentAddress: string;
  intentKey?: string;
}

// #1828/#1829 — parse + validate the lifecycle facts shared by GET /job-by-intent and
// GET /journal from query params, using the SAME normalization admission persisted (or a
// facts read silently misses entries): contextGraphId trimmed + prefix-stripped
// (normalizeContextGraphIdOrUri); an empty subGraphName rejected (root lane = OMIT the
// param); agentAddress defaulted to the caller lane (admission persists a non-empty lane,
// an explicit param wins); C0/DEL control chars rejected so a crafted value cannot forge a
// colliding U+001F-joined lifecycle key. Returns null after sending a 400 on any violation.
function parsePublisherLifecycleFactsFromQuery(
  url: URL,
  res: ServerResponse,
  requestAgentAddress: string,
): PublisherLifecycleFacts | null {
  const rawContextGraphId = url.searchParams.get("contextGraphId");
  const name = url.searchParams.get("name") ?? undefined;
  if (!rawContextGraphId || !name) {
    jsonResponse(res, 400, { error: "Missing required contextGraphId and name" });
    return null;
  }
  const intentKey = url.searchParams.get("intentKey") ?? undefined;
  if (intentKey !== undefined && !/^sha256:[0-9a-f]{64}$/.test(intentKey)) {
    jsonResponse(res, 400, { error: "Malformed intentKey" });
    return null;
  }
  const contextGraphId = normalizeContextGraphIdOrUri(rawContextGraphId.trim());
  const rawSubGraphName = url.searchParams.get("subGraphName");
  if (!validateOptionalSubGraphName(rawSubGraphName, res)) return null;
  const subGraphName = rawSubGraphName ?? undefined;
  const explicitAgentAddress = url.searchParams.get("agentAddress")?.trim() || undefined;
  const agentAddress = explicitAgentAddress ?? requestAgentAddress;
  const hasControlChar = (value: string | undefined): boolean =>
    value !== undefined && [...value].some((ch) => {
      const code = ch.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    });
  if ([contextGraphId, name, subGraphName, agentAddress].some(hasControlChar)) {
    jsonResponse(res, 400, {
      error: "contextGraphId, name, subGraphName and agentAddress must not contain control characters",
    });
    return null;
  }
  return { contextGraphId, name, subGraphName, agentAddress, intentKey };
}

/**
 * GH#2270 — the job-detail response bodies, one typed builder per route generation, both over the
 * same {@link runtimeRetryState}. Two builders rather than one with a mode flag: the shapes differ
 * in KIND, not in a boolean, and a route that picks the wrong one should be a type error rather
 * than a body that silently nests (or spreads) the job the other way round. Building them here at
 * all is what keeps a fifth surface from shipping without `retryState`.
 *
 * `retryState` is DERIVED (never persisted), so it sits BESIDE the job rather than inside it: the
 * job stays byte-identical to what the store holds.
 *
 * `payload` is included only when passed — omitting it drops the key, while `null` is a REAL value
 * (a named lifecycle publish job has no raw prepared payload).
 */
function wrappedJobDetailBody(
  ctx: JobDetailContext,
  job: PersistedLiftJob,
  payload?: AsyncPreparedPublishPayload | null,
): { job: PersistedLiftJob; payload?: AsyncPreparedPublishPayload | null; retryState: LiftJobRetryProjection } {
  return {
    job,
    ...(payload === undefined ? {} : { payload }),
    retryState: runtimeRetryState(ctx, job),
  };
}

/** The legacy shape: the job spread at the top level, where `payload` already lives. */
function legacyJobDetailBody(
  ctx: JobDetailContext,
  job: PersistedLiftJob,
  payload?: AsyncPreparedPublishPayload | null,
): PersistedLiftJob & { payload?: AsyncPreparedPublishPayload | null; retryState: LiftJobRetryProjection } {
  return {
    ...job,
    ...(payload === undefined ? {} : { payload }),
    retryState: runtimeRetryState(ctx, job),
  };
}

type JobDetailContext = Pick<RequestContext, 'publisherControl' | 'publisherState'>;

/** The ONE place the operator-facing retry answer is derived: the publisher's configured view, */
/** narrowed by this daemon's runtime availability. */
function runtimeRetryState(ctx: JobDetailContext, job: PersistedLiftJob): LiftJobRetryProjection {
  return narrowRetryStateToRuntime(
    ctx.publisherControl.describeConfiguredRetryState(job),
    ctx.publisherState.availability,
  );
}

/**
 * GH#2270 — the publisher's projection answers "does this node's CONFIGURATION retry this job",
 * because that is all the queue can see: it derives from the job and the retry knobs and has no
 * idea whether a publisher RUNTIME is actually running. The daemon does know, so the honesty is
 * restored HERE — the one layer where both facts are in scope.
 *
 * With no runtime (no funded publisher wallet, a startup failure, still starting, or the publisher
 * switched off) nothing will fire a scheduled retry, so `autoRetryEligible` is false and a job that
 * would have reported `backoff` reports `operator` instead — which is what the availability reason
 * beside it tells the operator to go and fix. Every other reason is untouched: a job held for chain
 * proof, owned by recovery, or out of budget is waiting on that whatever the runtime does.
 */
function narrowRetryStateToRuntime(
  projection: LiftJobRetryProjection,
  availability: AsyncPublisherAvailability,
): LiftJobRetryProjection {
  if (availability.available) return projection;
  return {
    ...projection,
    autoRetryEligible: false,
    ...(projection.waitingReason === 'backoff' ? { waitingReason: 'operator' as const } : {}),
  };
}

// #1890 — one request-body boundary for the publisher admin POST routes (cancel / retry /
// clear / clear-job). Reads the small JSON body, applies the shared invalid-JSON mapping
// (400 `{ error: 'Invalid JSON body' }`), and normalizes a missing / `null` / primitive /
// array body to `{}` so no route destructures a non-object — a `null` body must not
// TypeError into a 500. Each route keeps its OWN field validation and response shape.
// Returns `null` AFTER responding, so callers do:
//   const parsed = await readSmallJsonObject(req, res); if (!parsed) return;
async function readSmallJsonObject(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | null> {
  const body = await readBody(req, SMALL_BODY_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    jsonResponse(res, 400, { error: "Invalid JSON body" });
    return null;
  }
  return isPlainRecord(parsed) ? parsed : {};
}

export async function handlePublisherRoutes(ctx: RequestContext): Promise<void> {
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
  } = ctx;


  // GET /api/publisher/jobs?status=...
  if (req.method === "GET" && path === "/api/publisher/jobs") {
    const status =
      typeof url.searchParams.get("status") === "string"
        ? url.searchParams.get("status")!
        : undefined;
    const jobs = await publisherControl.list(
      status ? { status: status as any } : undefined,
    );
    return jsonResponse(res, 200, { jobs });
  }

  // GET /api/publisher/job?id=...  (new route, wrapped response)
  if (req.method === "GET" && path === "/api/publisher/job") {
    const jobId = url.searchParams.get("id");
    if (!jobId) return jsonResponse(res, 400, { error: "Missing job id" });
    const job = await publisherControl.getStatus(jobId);
    if (!job)
      return jsonResponse(res, 404, {
        error: `Publisher job not found: ${jobId}`,
      });
    return jsonResponse(res, 200, wrappedJobDetailBody(ctx, job));
  }

  // GET /api/publisher/job-payload?id=...  (new route, wrapped response)
  if (req.method === "GET" && path === "/api/publisher/job-payload") {
    const jobId = url.searchParams.get("id");
    if (!jobId) return jsonResponse(res, 400, { error: "Missing job id" });
    const job = await publisherControl.getStatus(jobId);
    if (!job)
      return jsonResponse(res, 404, {
        error: `Publisher job not found: ${jobId}`,
      });
    const payload = await publisherControl.inspectPreparedPayload(jobId);
    return jsonResponse(res, 200, wrappedJobDetailBody(ctx, job, payload));
  }

  // GET /api/publisher/job-by-intent?contextGraphId=&name=&subGraphName=&agentAddress=&intentKey=
  // #1828 — read-only durable-admission recovery, keyed on the lifecycle facts a
  // client always retains (the lost 202 also loses jobId + intentKey). intentKey,
  // when supplied, only qualifies exactIntentMatch. Never mutates.
  if (req.method === "GET" && path === "/api/publisher/job-by-intent") {
    const facts = parsePublisherLifecycleFactsFromQuery(url, res, requestAgentAddress);
    if (!facts) return; // a 400 was already sent
    const lookup = await publisherControl.lookupKnowledgeAssetVmPublishJobByIntent(facts);
    const { kind, ...rest } = lookup;
    return jsonResponse(res, 200, { result: kind, ...rest });
  }

  // GET /api/publisher/journal?jobId=  OR  ?contextGraphId=&name=&subGraphName=&agentAddress=&intentKey=
  // #1829 — read-only append-only admission/transaction journal. By jobId, or facts-pure
  // by lifecycle identity (derived with the SAME normalization admission persisted).
  // txHashes are ATTEMPTED submissions — reconcile against chain, never treat as sent.
  if (req.method === "GET" && path === "/api/publisher/journal") {
    const jobId = url.searchParams.get("jobId")?.trim() || undefined;
    if (jobId !== undefined) {
      const result = await publisherControl.readJournalByJob(jobId);
      return jsonResponse(res, 200, result);
    }
    const facts = parsePublisherLifecycleFactsFromQuery(url, res, requestAgentAddress);
    if (!facts) return; // a 400 was already sent
    const result = await publisherControl.readJournalByIntent(facts);
    return jsonResponse(res, 200, result);
  }

  // Legacy: GET /api/publisher/jobs/:id and /api/publisher/jobs/:id/payload (bare response)
  if (req.method === "GET" && path.startsWith("/api/publisher/jobs/")) {
    const segments = path.slice("/api/publisher/jobs/".length).split("/");
    const jobId = segments[0];
    if (!jobId) return jsonResponse(res, 400, { error: "Missing job id" });
    const job = await publisherControl.getStatus(jobId);
    if (!job)
      return jsonResponse(res, 404, {
        error: `Publisher job not found: ${jobId}`,
      });
    // GH#2270 — this legacy shape spreads the job at the top level, so `retryState` joins it
    // there (as `payload` already does); the shared builder keeps every job field's value.
    if (segments[1] === "payload") {
      const payload = await publisherControl.inspectPreparedPayload(jobId);
      return jsonResponse(res, 200, legacyJobDetailBody(ctx, job, payload));
    }
    return jsonResponse(res, 200, legacyJobDetailBody(ctx, job));
  }

  // GET /api/publisher/stats -- returns the raw status map directly for backward compat
  if (req.method === "GET" && path === "/api/publisher/stats") {
    const stats = await publisherControl.getStats();
    return jsonResponse(res, 200, stats);
  }

  // POST /api/publisher/cancel
  if (req.method === "POST" && path === "/api/publisher/cancel") {
    const parsed = await readSmallJsonObject(req, res);
    if (!parsed) return;
    const jobId = parsed.jobId as string | undefined;
    if (!jobId) return jsonResponse(res, 400, { error: "Missing jobId" });
    await publisherControl.cancel(jobId);
    return jsonResponse(res, 200, { cancelled: jobId });
  }

  // POST /api/publisher/retry
  if (req.method === "POST" && path === "/api/publisher/retry") {
    const parsed = await readSmallJsonObject(req, res);
    if (!parsed) return;
    const status = parsed.status as string | undefined;
    if (status && status !== "failed")
      return jsonResponse(res, 400, {
        error: "Only status=failed is supported",
      });
    const jobId = parsed.jobId;
    if (jobId !== undefined && (typeof jobId !== "string" || !isSafeJobId(jobId))) {
      return jsonResponse(res, 400, {
        error: SAFE_JOB_ID_ERROR,
      });
    }
    // GH#2270 — `retried` keeps its exact pre-#2270 meaning (jobs reaccepted), so an
    // operator script reading it is unaffected; the two additive counts explain the jobs
    // left failed instead of leaving them invisible: `blockedPendingRecovery` may carry an
    // on-chain transaction and needs chain proof, `skipped` has nothing left to reaccept.
    const outcome = await publisherControl.retryDetailed({
      status: "failed",
      ...(typeof jobId === "string" ? { jobId } : {}),
    });
    return jsonResponse(res, 200, {
      retried: outcome.retried,
      blockedPendingRecovery: outcome.blockedPendingRecovery,
      skipped: outcome.skipped,
    });
  }

  // POST /api/publisher/clear
  if (req.method === "POST" && path === "/api/publisher/clear") {
    const parsed = await readSmallJsonObject(req, res);
    if (!parsed) return;
    const status = parsed.status as string | undefined;
    if (status !== "failed" && status !== "finalized") {
      return jsonResponse(res, 400, {
        error: "status must be failed or finalized",
      });
    }
    const count = await publisherControl.clear(status);
    return jsonResponse(res, 200, { cleared: count, status });
  }

  // POST /api/publisher/clear-job  { jobId }
  // #1837 — atomic by-exact-jobId TERMINAL clear. DISTINCT from cancel (which aborts an
  // ACCEPTED job) and from bulk /clear (status-scoped): clears exactly one job iff it is
  // in a native terminal state, is idempotent for an absent job (already_absent = 200,
  // NOT 404), and never touches another job. Preserves the #1829 journal (subject-scoped).
  if (req.method === "POST" && path === "/api/publisher/clear-job") {
    // readSmallJsonObject normalizes a `null`/primitive body to `{}`, so `jobId` is
    // undefined there and falls through to the malformed guard (400) — never a 500.
    const parsed = await readSmallJsonObject(req, res);
    if (!parsed) return;
    const jobId = parsed.jobId;
    if (typeof jobId !== "string" || jobId.trim().length === 0) {
      return jsonResponse(res, 400, { outcome: "rejected", reason: "malformed", error: "Missing jobId" });
    }
    // GH#2270 follow-up (🔴 3823952704, 🔴 3824098476) — clearing a job whose transaction may
    // still land is a DESTRUCTIVE override, and this route is open to every registered agent token
    // with no ownership check of its own. The route therefore states WHO is asking and WHAT they
    // asked for; it does not look the job up itself.
    //
    // That matters: an earlier version read the job here, which put an unvalidated jobId into a
    // query before `clearTerminalJob`'s safe-id guard ran, and decided ownership outside the claim
    // lock the clear then takes. Validation, the ownership decision and the delete now happen on
    // one record behind one boundary.
    return respondTerminalClearOutcome(
      res,
      await publisherControl.clearTerminalJob(jobId, parsed.allowPendingTransaction === true
        ? { pendingTransactionOverride: { requestedBy: requestAgentAddress } }
        : {}),
      jobId,
    );
  }
}
