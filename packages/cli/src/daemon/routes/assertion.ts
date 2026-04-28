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
import { type ExtractionStatusRecord } from '../../extraction-status.js';
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
import {
  buildFileSemanticEventPayload,
  deletePersistedExtractionStatusRecord,
  getHydratedExtractionStatusRecord,
  queueLocalAgentSemanticEnrichmentBestEffort,
  requestAdvertisesLocalAgentSemanticEnrichment,
  requestLocalAgentWakeTransport,
  requestTargetsLocalAgentIntegration,
  setPersistedExtractionStatusRecord,
  updateExtractionStatusSemanticDescriptor,
} from '../semantic-enrichment.js';

import type { RequestContext } from './context.js';


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
  } = ctx;


  // POST /api/assertion/create  { contextGraphId, name, subGraphName? }
  if (req.method === "POST" && path === "/api/assertion/create") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const { contextGraphId, name, subGraphName } = parsed;
    if (!name) return jsonResponse(res, 400, { error: 'Missing "name"' });
    if (!validateRequiredContextGraphId(contextGraphId, res)) return;
    if (typeof name !== "string")
      return jsonResponse(res, 400, { error: '"name" must be a string' });
    const nameVal = validateAssertionName(name);
    if (!nameVal.valid)
      return jsonResponse(res, 400, {
        error: `Invalid "name": ${nameVal.reason}`,
      });
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    try {
      const assertionUri = await agent.assertion.create(
        contextGraphId,
        name,
        subGraphName ? { subGraphName } : undefined,
      );
      return jsonResponse(res, 200, { assertionUri });
    } catch (err: any) {
      if (
        err.message?.includes("already exists") ||
        err.message?.includes("not found") ||
        err.message?.includes("Invalid")
      ) {
        return jsonResponse(res, 400, { error: err.message });
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
    if (!validateRequiredContextGraphId(contextGraphId, res)) return;
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    try {
      await agent.assertion.write(
        contextGraphId,
        assertionName,
        quads,
        subGraphName ? { subGraphName } : undefined,
      );
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
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    try {
      const quads = await agent.assertion.query(
        contextGraphId,
        assertionName,
        subGraphName ? { subGraphName } : undefined,
      );
      return jsonResponse(res, 200, { quads, count: quads.length });
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
    if (!validateRequiredContextGraphId(contextGraphId, res)) return;
    if (!validateEntities(entities, res)) return;
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    try {
      const result = await agent.assertion.promote(
        contextGraphId,
        assertionName,
        { entities: entities ?? "all", subGraphName },
      );
      return jsonResponse(res, 200, result);
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
    if (!validateRequiredContextGraphId(contextGraphId, res)) return;
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    try {
      await agent.assertion.discard(
        contextGraphId,
        assertionName,
        subGraphName ? { subGraphName } : undefined,
      );
      const assertionUri = contextGraphAssertionUri(
        contextGraphId,
        requestAgentAddress,
        assertionName,
        subGraphName,
      );
      deletePersistedExtractionStatusRecord(extractionStatus, dashDb, assertionUri);
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
    const rawAgentAddress = qs.get("agentAddress") ?? undefined;
    if (rawAgentAddress && !/^[\w:.\-]+$/.test(rawAgentAddress)) {
      return jsonResponse(res, 400, { error: "Invalid agentAddress format" });
    }
    const subGraphName = qs.get("subGraphName") ?? undefined;
    try {
      const descriptor = await agent.assertion.history(
        contextGraphId!,
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
  //   ontologyRef (optional):    opaque v1 ontology hint for guided semantic extraction
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
    const contextGraphId = textField("contextGraphId");
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

    if (!validateRequiredContextGraphId(contextGraphId, res)) return;
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
        setPersistedExtractionStatusRecord(extractionStatus, dashDb, assertionUri, {
          status: "in_progress",
          fileHash: fileStoreEntry.keccak256,
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
          ...(importRootEntity ? { rootEntity: importRootEntity } : {}),
          detectedContentType,
          pipelineUsed: failedPipelineUsed,
          tripleCount,
          ...(mdIntermediateHash ? { mdIntermediateHash } : {}),
          error,
          startedAt,
          completedAt: new Date().toISOString(),
        };
        setPersistedExtractionStatusRecord(extractionStatus, dashDb, assertionUri, failedRecord);
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
      // Store the file blob, return status=skipped, no triples written.
      if (mdIntermediate === null) {
        const skippedRecord: ExtractionStatusRecord = {
          status: "skipped",
          fileHash: fileStoreEntry.keccak256,
          detectedContentType,
          pipelineUsed: null,
          tripleCount: 0,
          startedAt,
          completedAt: new Date().toISOString(),
        };
        setPersistedExtractionStatusRecord(
          extractionStatus,
          dashDb,
          assertionUri,
          skippedRecord,
        );
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
      // from the partition before `autoPartition` runs. Row 1 (whose
      // subject is the doc entity, not the file URN) is preserved through
      // promote; rows 4-13 are WM-only by design. See Codex Bug 8 Round 4
      // reconciled ruling — Round 3 tried blank-node subjects, but an
      // `autoPartition` audit showed they silently drop the prov block on
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
        {
          subject: assertionUri,
          predicate: "http://dkg.io/ontology/importStartedAt",
          object: startedAtLiteral,
          graph: metaGraph,
        },
        // Row 17
        {
          subject: assertionUri,
          predicate: "http://dkg.io/ontology/extractionMethod",
          object: JSON.stringify("structural"),
          graph: metaGraph,
        },
        // Row 18
        {
          subject: assertionUri,
          predicate: "http://dkg.io/ontology/structuralTripleCount",
          object: `"${triples.length}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
          graph: metaGraph,
        },
        // Row 19 — V10.0 has no semantic (Layer 2) extraction, so always zero.
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
      const uploadedFilename = filePart.filename?.trim() ?? "";
      if (uploadedFilename.length > 0) {
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
          await agent.assertion.create(
            contextGraphId!,
            assertionName,
            subGraphName ? { subGraphName } : undefined,
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
        throw err;
      }

      const completedRecord: ExtractionStatusRecord = {
        status: "completed",
        fileHash: fileStoreEntry.keccak256,
        ...(importRootEntity ? { rootEntity: importRootEntity } : {}),
        detectedContentType,
        pipelineUsed,
        tripleCount: triples.length,
        mdIntermediateHash,
        startedAt,
        completedAt: new Date().toISOString(),
      };
      setPersistedExtractionStatusRecord(
        extractionStatus,
        dashDb,
        assertionUri,
        completedRecord,
      );
      const semanticEnrichment = queueLocalAgentSemanticEnrichmentBestEffort({
        config,
        dashDb,
        integrationId: 'openclaw',
        kind: 'file_import',
        payload: buildFileSemanticEventPayload({
          contextGraphId: contextGraphId!,
          assertionName,
          assertionUri,
          importStartedAt: startedAt,
          sourceAgentAddress: requestAgentAddress,
          rootEntity: completedRecord.rootEntity,
          fileHash: fileStoreEntry.keccak256,
          mdIntermediateHash,
          detectedContentType,
          sourceFileName: uploadedFilename || undefined,
          ontologyRef: ontologyRef?.trim() || undefined,
        }),
        bridgeAuthToken,
        skipWhenUnavailable: true,
        liveSemanticEnrichmentSupported: requestAdvertisesLocalAgentSemanticEnrichment(req, 'openclaw'),
        requestFromIntegration: requestTargetsLocalAgentIntegration(req, 'openclaw'),
        requestWakeTransport: requestLocalAgentWakeTransport(req, 'openclaw'),
        logLabel: `file import semantic event for ${assertionUri}`,
      });
      if (semanticEnrichment) {
        updateExtractionStatusSemanticDescriptor(
          extractionStatus,
          dashDb,
          assertionUri,
          semanticEnrichment,
        );
      }

      return respondWithImportFileResponse(200, {
        status: "completed",
        tripleCount: triples.length,
        pipelineUsed,
        ...(mdIntermediateHash ? { mdIntermediateHash } : {}),
        ...(semanticEnrichment ? { semanticEnrichment } : {}),
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
      url.searchParams.get("paranetId");
    if (!validateRequiredContextGraphId(contextGraphId, res)) return;
    const subGraphName = url.searchParams.get("subGraphName") ?? undefined;
    if (!validateOptionalSubGraphName(subGraphName, res)) return;

    const assertionUri = contextGraphAssertionUri(
      contextGraphId!,
      requestAgentAddress,
      assertionName,
      subGraphName,
    );
    const record = getHydratedExtractionStatusRecord(extractionStatus, dashDb, assertionUri);
    if (!record) {
      return jsonResponse(res, 404, {
        error: `No extraction record found for assertion "${assertionName}" in context graph "${contextGraphId}"`,
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
      ...(record.semanticEnrichment ? { semanticEnrichment: record.semanticEnrichment } : {}),
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
}
