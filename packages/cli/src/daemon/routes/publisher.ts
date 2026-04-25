// daemon/routes/publisher.ts
//
// Route handlers for publisher enqueue / jobs / stats / cancel / retry / clear.
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
import { computeNetworkId, createOperationContext, DKGEvent, Logger, PayloadTooLargeError, GET_VIEWS, TrustLevel, validateSubGraphName, validateAssertionName, validateContextGraphId, isSafeIri, assertSafeIri, sparqlIri, contextGraphSharedMemoryUri, contextGraphAssertionUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { findReservedSubjectPrefix, isSkolemizedUri } from '@origintrail-official/dkg-publisher';
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
import { handleCapture, EpcisValidationError, handleEventsQuery, EpcisQueryError, type Publisher as EpcisPublisher } from '@origintrail-official/dkg-epcis';
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
  checkForNewCommit,
  checkForNewCommitWithStatus,
  type UpdateStatus,
  acquireUpdateLock,
  releaseUpdateLock,
  performUpdate,
  performUpdateWithStatus,
  performNpmUpdate,
  checkForUpdate,
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


  // POST /api/publisher/enqueue
  // Accepts both the old wrapped shape { request: LiftRequest } and the new flat shape.
  if (req.method === "POST" && path === "/api/publisher/enqueue") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    let raw: any;
    try {
      raw = JSON.parse(body);
    } catch {
      return jsonResponse(res, 400, { error: "Invalid JSON body" });
    }
    const parsed =
      raw.request && typeof raw.request === "object" ? raw.request : raw;
    const { roots, namespace, scope, authorityProofRef, priorVersion } = parsed;
    const contextGraphId = parsed.contextGraphId ?? parsed.paranetId;
    const shareOperationId =
      parsed.shareOperationId ?? parsed.workspaceOperationId;
    const swmId = parsed.swmId ?? parsed.workspaceId ?? "swm-main";
    const transitionType = parsed.transitionType ?? "CREATE";
    const authorityType =
      parsed.authorityType ?? parsed.authority?.type ?? "owner";
    const proofRef = authorityProofRef ?? parsed.authority?.proofRef;
    if (
      !contextGraphId ||
      !shareOperationId ||
      !Array.isArray(roots) ||
      roots.length === 0 ||
      !namespace ||
      !scope ||
      !proofRef
    ) {
      return jsonResponse(res, 400, {
        error: "Missing required enqueue fields",
      });
    }
    const jobId = await publisherControl.lift({
      swmId,
      shareOperationId,
      roots,
      contextGraphId,
      namespace,
      scope,
      transitionType,
      authority: { type: authorityType, proofRef },
      ...(priorVersion ? { priorVersion } : {}),
    } as any);
    return jsonResponse(res, 200, {
      jobId,
      contextGraphId,
      shareOperationId,
      rootsCount: roots.length,
    });
  }

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
    return jsonResponse(res, 200, { job });
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
    return jsonResponse(res, 200, { job, payload });
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
    if (segments[1] === "payload") {
      const payload = await publisherControl.inspectPreparedPayload(jobId);
      return jsonResponse(res, 200, { ...job, payload });
    }
    return jsonResponse(res, 200, job);
  }

  // GET /api/publisher/stats — returns the raw status map directly for backward compat
  if (req.method === "GET" && path === "/api/publisher/stats") {
    const stats = await publisherControl.getStats();
    return jsonResponse(res, 200, stats);
  }

  // POST /api/publisher/cancel
  if (req.method === "POST" && path === "/api/publisher/cancel") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      return jsonResponse(res, 400, { error: "Invalid JSON body" });
    }
    const { jobId } = parsed;
    if (!jobId) return jsonResponse(res, 400, { error: "Missing jobId" });
    await publisherControl.cancel(jobId);
    return jsonResponse(res, 200, { cancelled: jobId });
  }

  // POST /api/publisher/retry
  if (req.method === "POST" && path === "/api/publisher/retry") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    let retryParsed: any;
    try {
      retryParsed = JSON.parse(body || "{}");
    } catch {
      return jsonResponse(res, 400, { error: "Invalid JSON body" });
    }
    const { status } = retryParsed;
    if (status && status !== "failed")
      return jsonResponse(res, 400, {
        error: "Only status=failed is supported",
      });
    const count = await publisherControl.retry({ status: "failed" });
    return jsonResponse(res, 200, { retried: count });
  }

  // POST /api/publisher/clear
  if (req.method === "POST" && path === "/api/publisher/clear") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    let clearParsed: any;
    try {
      clearParsed = JSON.parse(body || "{}");
    } catch {
      return jsonResponse(res, 400, { error: "Invalid JSON body" });
    }
    const { status } = clearParsed;
    if (status !== "failed" && status !== "finalized") {
      return jsonResponse(res, 400, {
        error: "status must be failed or finalized",
      });
    }
    const count = await publisherControl.clear(status);
    return jsonResponse(res, 200, { cleared: count, status });
  }
}
