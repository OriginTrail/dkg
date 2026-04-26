// daemon/routes/openclaw.ts
//
// Route handlers for OpenClaw agent listing, chat, channel send/stream/persist-turn/health.
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


export async function handleOpenclawRoutes(ctx: RequestContext): Promise<void> {
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


  // GET /api/openclaw-agents — discover connected OpenClaw agents
  if (req.method === "GET" && path === "/api/openclaw-agents") {
    try {
      const allAgents = await agent.findAgents({ framework: "OpenClaw" });
      const allConns = agent.node.libp2p.getConnections();
      const connectedPeers = new Set(
        allConns.map((c: any) => c.remotePeer.toString()),
      );
      const healthMap = agent.getPeerHealth();

      const enriched = allAgents.map((a: any) => {
        const isConnected = connectedPeers.has(a.peerId);
        const health = healthMap.get(a.peerId);
        return {
          peerId: a.peerId,
          name: a.name,
          description: a.description,
          framework: a.framework,
          connected: isConnected,
          lastSeen: health?.lastSeen ?? null,
          latencyMs: health?.latencyMs ?? null,
        };
      });
      return jsonResponse(res, 200, { agents: enriched });
    } catch (err: any) {
      return jsonResponse(res, 500, { error: err.message });
    }
  }

  // POST /api/chat-openclaw  { peerId: "...", text: "..." }
  // Sends a message to an OpenClaw agent via P2P and waits for a response.
  if (req.method === "POST" && path === "/api/chat-openclaw") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const { peerId: rawPeerId, text } = JSON.parse(body);
    if (!rawPeerId || !text)
      return jsonResponse(res, 400, { error: 'Missing "peerId" or "text"' });

    const peerId = await resolveNameToPeerId(agent, rawPeerId);
    if (!peerId)
      return jsonResponse(res, 404, {
        error: `Agent "${rawPeerId}" not found`,
      });

    const waitStart = Date.now();
    const sendResult = await agent.sendChat(peerId, text);
    try {
      dashDb.insertChatMessage({
        ts: Date.now(),
        direction: "out",
        peer: peerId,
        text,
        delivered: sendResult.delivered,
      });
    } catch {
      /* never crash */
    }

    if (!sendResult.delivered) {
      return jsonResponse(res, 200, {
        delivered: false,
        reply: null,
        timedOut: false,
        error:
          sendResult.error ?? "Message not delivered — agent may be offline",
      });
    }

    // Wait for a reply from the OpenClaw agent (poll incoming messages)
    const TIMEOUT_MS = 30_000;
    const POLL_MS = 500;
    let reply: string | null = null;

    while (Date.now() - waitStart < TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      try {
        const rows = dashDb.getChatMessages({
          peer: peerId,
          since: waitStart - 100,
          limit: 10,
        });
        const incoming = rows.filter(
          (r: any) =>
            r.direction === "in" && r.ts >= waitStart && r.peer === peerId,
        );
        if (incoming.length > 0) {
          reply = incoming[incoming.length - 1].text;
          break;
        }
      } catch {
        /* ignore */
      }
    }

    return jsonResponse(res, 200, {
      delivered: true,
      reply: reply ?? null,
      timedOut: reply === null,
      waitMs: Date.now() - waitStart,
    });
  }

  // -----------------------------------------------------------------------
  // OpenClaw channel bridge — routes DKG UI messages through OpenClaw agent
  // -----------------------------------------------------------------------

  // POST /api/openclaw-channel/send  { text, correlationId, identity?, attachmentRefs?, contextEntries?, contextGraphId? }
  // DKG Node UI frontend calls this to send a message to the local OpenClaw
  // agent.  The daemon forwards to the adapter's channel bridge server and
  // returns the agent's reply. `contextGraphId` carries the UI-selected
  // project context graph so the adapter's memory slot can scope
  // slot-backed recall to the user's current project.
  if (req.method === "POST" && path === "/api/openclaw-channel/send") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    let payload: {
      text?: string;
      correlationId?: string;
      identity?: string;
      attachmentRefs?: unknown;
      contextEntries?: unknown;
      contextGraphId?: unknown;
    };
    try {
      payload = JSON.parse(body);
    } catch {
      return jsonResponse(res, 400, { error: "Invalid JSON" });
    }

    const normalizedAttachmentRefs = normalizeOpenClawAttachmentRefs(payload.attachmentRefs);
    if (payload.attachmentRefs != null && normalizedAttachmentRefs === undefined) {
      return jsonResponse(res, 400, { error: 'Invalid "attachmentRefs"' });
    }
    const normalizedContextEntries = normalizeOpenClawChatContextEntries(
      payload.contextEntries,
    );
    if (payload.contextEntries != null && normalizedContextEntries === undefined) {
      return jsonResponse(res, 400, { error: 'Invalid "contextEntries"' });
    }
    const uiContextGraphId =
      typeof payload.contextGraphId === "string" && payload.contextGraphId.trim()
        ? payload.contextGraphId.trim()
        : undefined;
    const { text, correlationId, identity } = payload;
    if (!hasOpenClawChatTurnContent(text, normalizedAttachmentRefs)) {
      return jsonResponse(res, 400, { error: 'Missing "text"' });
    }
    const corrId = correlationId ?? crypto.randomUUID();
    const attachmentRefs = await verifyOpenClawAttachmentRefsProvenance(
      agent,
      extractionStatus,
      normalizedAttachmentRefs,
    );
    if (payload.attachmentRefs != null && attachmentRefs === undefined) {
      return jsonResponse(res, 400, { error: 'Invalid "attachmentRefs"' });
    }

    const targets = getOpenClawChannelTargets(config);
    let lastFailure: {
      status?: number;
      details?: string;
      offline?: boolean;
    } | null = null;

    for (const target of targets) {
      const availability = await ensureOpenClawBridgeAvailable(
        target,
        bridgeAuthToken,
      );
      if (!availability.ok) {
        lastFailure = availability;
        continue;
      }

      try {
        const forwardRes = await fetch(target.inboundUrl, {
          method: "POST",
          headers: buildOpenClawChannelHeaders(target, bridgeAuthToken, {
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({
            text,
            correlationId: corrId,
            identity: identity ?? "owner",
            ...(attachmentRefs ? { attachmentRefs } : {}),
            ...(normalizedContextEntries
              ? { contextEntries: normalizedContextEntries }
              : {}),
            ...(uiContextGraphId ? { uiContextGraphId } : {}),
          }),
          signal: AbortSignal.timeout(OPENCLAW_CHANNEL_RESPONSE_TIMEOUT_MS),
        });
        if (!forwardRes.ok) {
          const details = await forwardRes.text().catch(() => "");
          if (shouldTryNextOpenClawTarget(forwardRes.status)) {
            lastFailure = {
              status: forwardRes.status,
              details: details || `${target.name} transport unavailable`,
              offline: forwardRes.status === 503,
            };
            continue;
          }
          return jsonResponse(res, 502, {
            error: "Bridge error",
            code: "BRIDGE_ERROR",
            details,
          });
        }
        if (target.name === "bridge") {
          daemonState.openClawBridgeHealth = { ok: true, ts: Date.now() };
        }
        const reply = await forwardRes.json();
        return jsonResponse(res, 200, reply);
      } catch (err: any) {
        if (err.name === "TimeoutError") {
          return jsonResponse(res, 504, {
            error: "Agent response timeout",
            code: "AGENT_TIMEOUT",
            correlationId: corrId,
          });
        }
        if (target.name === "bridge") {
          daemonState.openClawBridgeHealth = { ok: false, ts: Date.now() };
        }
        lastFailure = { details: err.message, offline: true };
      }
    }

    return jsonResponse(res, lastFailure?.offline ? 503 : 502, {
      error: lastFailure?.offline
        ? "OpenClaw bridge unreachable"
        : "Bridge error",
      code: lastFailure?.offline ? "BRIDGE_OFFLINE" : "BRIDGE_ERROR",
      details: lastFailure?.details,
    });
  }

  // POST /api/openclaw-channel/stream  { text, correlationId, identity?, attachmentRefs? }
  // SSE streaming variant — pipes agent response chunks as they arrive.
  if (req.method === "POST" && path === "/api/openclaw-channel/stream") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    let payload: {
      text?: string;
      correlationId?: string;
      identity?: string;
      attachmentRefs?: unknown;
      contextEntries?: unknown;
      contextGraphId?: unknown;
    };
    try {
      payload = JSON.parse(body);
    } catch {
      return jsonResponse(res, 400, { error: "Invalid JSON" });
    }

    const normalizedAttachmentRefs = normalizeOpenClawAttachmentRefs(payload.attachmentRefs);
    if (payload.attachmentRefs != null && normalizedAttachmentRefs === undefined) {
      return jsonResponse(res, 400, { error: 'Invalid "attachmentRefs"' });
    }
    const normalizedContextEntries = normalizeOpenClawChatContextEntries(
      payload.contextEntries,
    );
    if (payload.contextEntries != null && normalizedContextEntries === undefined) {
      return jsonResponse(res, 400, { error: 'Invalid "contextEntries"' });
    }
    const uiContextGraphId =
      typeof payload.contextGraphId === "string" && payload.contextGraphId.trim()
        ? payload.contextGraphId.trim()
        : undefined;
    const { text, correlationId, identity } = payload;
    if (!hasOpenClawChatTurnContent(text, normalizedAttachmentRefs)) {
      return jsonResponse(res, 400, { error: 'Missing "text"' });
    }
    const corrId = correlationId ?? crypto.randomUUID();
    const attachmentRefs = await verifyOpenClawAttachmentRefsProvenance(agent, extractionStatus, normalizedAttachmentRefs);
    if (payload.attachmentRefs != null && attachmentRefs === undefined) {
      return jsonResponse(res, 400, { error: 'Invalid "attachmentRefs"' });
    }

    const targets = getOpenClawChannelTargets(config);
    let lastFailure: {
      status?: number;
      details?: string;
      offline?: boolean;
    } | null = null;

    for (const target of targets) {
      const availability = await ensureOpenClawBridgeAvailable(
        target,
        bridgeAuthToken,
      );
      if (!availability.ok) {
        lastFailure = availability;
        continue;
      }

      try {
        const transportRes = await fetch(target.streamUrl ?? target.inboundUrl, {
          method: 'POST',
          headers: buildOpenClawChannelHeaders(
            target,
            bridgeAuthToken,
            {
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
            },
          ),
          body: JSON.stringify({
            text,
            correlationId: corrId,
            identity: identity ?? "owner",
            ...(attachmentRefs ? { attachmentRefs } : {}),
            ...(normalizedContextEntries
              ? { contextEntries: normalizedContextEntries }
              : {}),
            ...(uiContextGraphId ? { uiContextGraphId } : {}),
          }),
          signal: AbortSignal.timeout(OPENCLAW_CHANNEL_RESPONSE_TIMEOUT_MS),
        });

        if (!transportRes.ok) {
          const details = await transportRes.text().catch(() => "");
          if (shouldTryNextOpenClawTarget(transportRes.status)) {
            lastFailure = {
              status: transportRes.status,
              details: details || `${target.name} transport unavailable`,
              offline: transportRes.status === 503,
            };
            continue;
          }
          return jsonResponse(res, 502, {
            error: "Bridge error",
            code: "BRIDGE_ERROR",
            details,
          });
        }

        if (target.name === "bridge") {
          daemonState.openClawBridgeHealth = { ok: true, ts: Date.now() };
        }

        const contentType = (
          transportRes.headers.get("content-type") ?? ""
        ).toLowerCase();
        if (contentType.includes("text/event-stream") && transportRes.body) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            ...corsHeaders(resolveCorsOrigin(req, daemonState.moduleCorsAllowed)),
          });

          try {
            await pipeOpenClawStream(
              req,
              res,
              (transportRes.body as any).getReader(),
            );
          } catch (err: any) {
            if (!res.writableEnded) {
              res.write(
                `data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`,
              );
            }
          }
          if (!res.writableEnded) res.end();
          return;
        }

        const reply = await transportRes.json();
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...corsHeaders(resolveCorsOrigin(req, daemonState.moduleCorsAllowed)),
        });
        res.write(
          `data: ${JSON.stringify({ type: "final", text: reply.text ?? "", correlationId: reply.correlationId ?? corrId })}\n\n`,
        );
        res.end();
        return;
      } catch (err: any) {
        if (err.name === "TimeoutError") {
          return jsonResponse(res, 504, {
            error: "Agent response timeout",
            code: "AGENT_TIMEOUT",
            correlationId: corrId,
          });
        }
        if (target.name === "bridge") {
          daemonState.openClawBridgeHealth = { ok: false, ts: Date.now() };
        }
        lastFailure = { details: err.message, offline: true };
      }
    }

    return jsonResponse(res, lastFailure?.offline ? 503 : 502, {
      error: lastFailure?.offline
        ? "OpenClaw bridge unreachable"
        : "Bridge error",
      code: lastFailure?.offline ? "BRIDGE_OFFLINE" : "BRIDGE_ERROR",
      details: lastFailure?.details,
    });
  }

  // POST /api/openclaw-channel/persist-turn  { sessionId, userMessage, assistantReply, attachmentRefs?, ... }
  // Called by the adapter to persist an OpenClaw turn into the `'chat-turns'`
  // Working Memory assertion of the `'agent-context'` context graph (the
  // ChatMemoryManager default since the openclaw-dkg-primary-memory retarget).
  // Uses the same ChatMemoryManager pathway as the node-owned local-agent
  // chat flow — chat-turn content never reaches Shared Working Memory in v1.
  if (req.method === 'POST' && path === '/api/openclaw-channel/persist-turn') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    let payload: any;
    try {
      payload = JSON.parse(body);
    } catch {
      return jsonResponse(res, 400, { error: "Invalid JSON" });
    }

    if (!isValidOpenClawPersistTurnPayload(payload)) {
      return jsonResponse(res, 400, {
        error:
          "Missing required fields: sessionId, userMessage, assistantReply",
      });
    }
    const { sessionId, userMessage, assistantReply, turnId, toolCalls, attachmentRefs, persistenceState, failureReason } =
      payload;
    const normalizedToolCalls = Array.isArray(toolCalls)
      ? (toolCalls as Array<{
          name: string;
          args: Record<string, unknown>;
          result: unknown;
        }>)
      : undefined;
    const normalizedAttachmentRefs = normalizeOpenClawAttachmentRefs(attachmentRefs);
    if (attachmentRefs != null && normalizedAttachmentRefs === undefined) {
      return jsonResponse(res, 400, { error: 'Invalid "attachmentRefs"' });
    }
    const verifiedAttachmentRefs = await verifyOpenClawAttachmentRefsProvenance(agent, extractionStatus, normalizedAttachmentRefs);
    if (attachmentRefs != null && verifiedAttachmentRefs === undefined) {
      return jsonResponse(res, 400, { error: 'Invalid "attachmentRefs"' });
    }
    const normalizedTurnId =
      typeof turnId === "string" ? turnId : crypto.randomUUID();
    const normalizedPersistenceState = persistenceState === 'failed' || persistenceState === 'pending'
      ? persistenceState
      : 'stored';
    const normalizedFailureReason = typeof failureReason === 'string'
      ? failureReason.trim() || undefined
      : undefined;
    try {
      await memoryManager.storeChatExchange(
        sessionId,
        userMessage,
        assistantReply,
        normalizedToolCalls,
        {
          turnId: normalizedTurnId,
          attachmentRefs: verifiedAttachmentRefs,
          persistenceState: normalizedPersistenceState,
          failureReason: normalizedFailureReason,
        },
      );
      return jsonResponse(res, 200, { ok: true });
    } catch (err: any) {
      return jsonResponse(res, 500, { error: err.message });
    }
  }

  // GET /api/openclaw-channel/health — check if the channel bridge is reachable
  if (req.method === 'GET' && path === '/api/openclaw-channel/health') {
    return jsonResponse(res, 200, await probeOpenClawChannelHealth(config, bridgeAuthToken));
  }
}
