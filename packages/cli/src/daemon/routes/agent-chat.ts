// daemon/routes/agent-chat.ts
//
// Route handlers for agent registration/identity/listing, skills, chat, messages, connect, update.
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
  resolveChainConfig,
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


export async function handleAgentChatRoutes(ctx: RequestContext): Promise<void> {
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


  // POST /api/agent/register — register a new agent on this node
  if (req.method === "POST" && path === "/api/agent/register") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = JSON.parse(body);
    const { name, publicKey, framework } = parsed;
    if (!name || typeof name !== "string") {
      return jsonResponse(res, 400, { error: 'Missing required field "name"' });
    }
    try {
      const record = await agent.registerAgent(name, { publicKey, framework });
      validTokens.add(record.authToken);
      const response: Record<string, unknown> = {
        agentAddress: record.agentAddress,
        authToken: record.authToken,
        mode: record.mode,
      };
      if (record.mode === "custodial") {
        response.publicKey = record.publicKey;
        response.privateKey = record.privateKey;
      }
      return jsonResponse(res, 200, response);
    } catch (err: any) {
      return jsonResponse(res, 400, { error: err.message });
    }
  }

  // GET /api/agent/identity — current agent identity for the requesting token
  if (req.method === "GET" && path === "/api/agent/identity") {
    const token = extractBearerToken(req.headers.authorization);
    const agentAddress = agent.resolveAgentAddress(token);
    const localAgents = agent.listLocalAgents();
    const current = localAgents.find((a) => a.agentAddress === agentAddress);
    return jsonResponse(res, 200, {
      agentAddress,
      agentDid: `did:dkg:agent:${agentAddress}`,
      name: current?.name ?? agent.nodeName,
      framework: current?.framework ?? agent.nodeFramework,
      peerId: agent.peerId,
      nodeIdentityId: String(agent.publisher.getIdentityId()),
    });
  }

  // GET /api/agents — enriched with live connection health
  // Optional query params: ?framework=X &skill_type=X
  if (req.method === "GET" && path === "/api/agents") {
    const frameworkFilter = url.searchParams.get("framework") || undefined;
    const skillTypeFilter = url.searchParams.get("skill_type") || undefined;
    const agents = await agent.findAgents({
      ...(frameworkFilter ? { framework: frameworkFilter } : {}),
    });
    // If skill_type filter is requested, find agents offering that skill and intersect
    let filteredAgents = agents;
    if (skillTypeFilter) {
      const offerings = await agent.findSkills({ skillType: skillTypeFilter });
      const agentUris = new Set(offerings.map((o: any) => o.agentUri));
      filteredAgents = agents.filter((a: any) => agentUris.has(a.agentUri));
    }
    const allConns = agent.node.libp2p.getConnections();
    const connByPeer = new Map<
      string,
      { transport: string; direction: string; sinceMs: number }
    >();
    for (const c of allConns) {
      const pid = c.remotePeer.toString();
      if (!connByPeer.has(pid)) {
        connByPeer.set(pid, {
          transport: c.remoteAddr?.toString().includes("/p2p-circuit")
            ? "relayed"
            : "direct",
          direction: c.direction,
          sinceMs: c.timeline?.open ? Date.now() - c.timeline.open : 0,
        });
      }
    }
    const myPeerId = agent.peerId;
    const healthMap = agent.getPeerHealth();
    const enriched = filteredAgents.map((a: any) => {
      const isSelf = a.peerId === myPeerId;
      const conn = connByPeer.get(a.peerId);
      const health = healthMap.get(a.peerId);
      return {
        ...a,
        connectionStatus: isSelf ? "self" : conn ? "connected" : "disconnected",
        connectionTransport: conn?.transport ?? null,
        connectionDirection: conn?.direction ?? null,
        connectedSinceMs: conn?.sinceMs ?? null,
        lastSeen: isSelf ? Date.now() : (health?.lastSeen ?? null),
        latencyMs: health?.latencyMs ?? null,
      };
    });
    return jsonResponse(res, 200, { agents: enriched });
  }

  // GET /api/peer-info?peerId=<id>
  if (req.method === "GET" && path === "/api/peer-info") {
    const peerId = url.searchParams.get("peerId");
    if (!peerId) {
      return jsonResponse(res, 400, { error: 'Missing "peerId" query param' });
    }

    const allConns = agent.node.libp2p.getConnections();
    const peerConns = allConns.filter((c) => c.remotePeer.toString() === peerId);
    const protocols = await agent.getPeerProtocols(peerId);

    const health = agent.getPeerHealth().get(peerId);
    return jsonResponse(res, 200, {
      peerId,
      connected: peerConns.length > 0,
      connectionCount: peerConns.length,
      transports: peerConns.map((c) =>
        c.remoteAddr?.toString().includes('/p2p-circuit') ? 'relayed' : 'direct',
      ),
      directions: peerConns.map((c) => c.direction),
      remoteAddrs: peerConns.map((c) => c.remoteAddr?.toString() ?? null),
      protocols,
      syncCapable: protocols.includes('/dkg/10.0.0/sync'),
      lastSeen: health?.lastSeen ?? null,
      latencyMs: health?.latencyMs ?? null,
    });
  }

  // GET /api/skills
  // Optional query params: ?skillType=X
  if (req.method === "GET" && path === "/api/skills") {
    const skillTypeFilter = url.searchParams.get("skillType") || undefined;
    const skills = await agent.findSkills(
      skillTypeFilter ? { skillType: skillTypeFilter } : undefined,
    );
    return jsonResponse(res, 200, { skills });
  }

  // POST /api/invoke-skill  { peerId: "...", skillUri: "...", input: "..." }
  if (req.method === "POST" && path === "/api/invoke-skill") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body);
    } catch {
      return jsonResponse(res, 400, { error: "Invalid JSON body" });
    }
    const rawPeerId = parsed.peerId ? String(parsed.peerId) : "";
    const skillUri = parsed.skillUri ? String(parsed.skillUri) : "";
    const input = parsed.input != null ? String(parsed.input) : "";
    if (!rawPeerId || !skillUri)
      return jsonResponse(res, 400, {
        error: 'Missing "peerId" or "skillUri"',
      });

    // Resolve name → peerId
    const peerId = await resolveNameToPeerId(agent, rawPeerId);
    if (!peerId)
      return jsonResponse(res, 404, {
        error: `Agent "${rawPeerId}" not found`,
      });

    try {
      const inputData = new TextEncoder().encode(input);
      const response = await agent.invokeSkill(peerId, skillUri, inputData);
      return jsonResponse(res, 200, {
        success: response.success,
        output: response.outputData
          ? new TextDecoder().decode(response.outputData)
          : undefined,
        error: response.error,
        executionTimeMs: response.executionTimeMs,
      });
    } catch (err: any) {
      return jsonResponse(res, 502, { error: err.message });
    }
  }

  // POST /api/chat  { to: "name-or-peerId", text: "..." }
  if (req.method === "POST" && path === "/api/chat") {
    const serverT0 = Date.now();
    const body = await readBody(req, SMALL_BODY_BYTES);
    const { to, text } = JSON.parse(body);
    if (!to || !text)
      return jsonResponse(res, 400, { error: 'Missing "to" or "text"' });

    const resolveT0 = Date.now();
    const peerId = await resolveNameToPeerId(agent, to);
    const resolveDur = Date.now() - resolveT0;
    if (!peerId)
      return jsonResponse(res, 404, { error: `Agent "${to}" not found` });

    const sendT0 = Date.now();
    const result = await Promise.race([
      agent.sendChat(peerId, text),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("sendChat timeout (30s)")), 30_000),
      ),
    ]);
    const sendDur = Date.now() - sendT0;
    try {
      dashDb.insertChatMessage({
        ts: Date.now(),
        direction: "out",
        peer: peerId,
        text,
        delivered: result.delivered,
      });
    } catch {
      /* never crash */
    }
    return jsonResponse(res, 200, {
      ...result,
      phases: {
        resolve: resolveDur,
        send: sendDur,
        serverTotal: Date.now() - serverT0,
      },
    });
  }

  // GET /api/messages?peer=<name-or-id>&limit=N
  if (req.method === "GET" && path === "/api/messages") {
    const peerFilter = url.searchParams.get("peer");
    const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
    const since = parseInt(url.searchParams.get("since") ?? "0", 10);

    let peer: string | undefined;
    if (peerFilter) {
      peer = (await resolveNameToPeerId(agent, peerFilter)) ?? undefined;
    }
    const rows = dashDb.getChatMessages({ peer, since: since || undefined, limit });
    const msgs = rows.map((r: any) => ({
      ts: r.ts,
      direction: r.direction,
      peer: r.peer,
      peerName: r.peer_name ?? undefined,
      text: r.text,
      delivered: r.delivered == null ? undefined : r.delivered === 1,
    }));
    return jsonResponse(res, 200, { messages: msgs });
  }

  // POST /api/connect  { multiaddr: "..." }
  if (req.method === "POST" && path === "/api/connect") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const { multiaddr: addr } = JSON.parse(body);
    if (!addr) return jsonResponse(res, 400, { error: 'Missing "multiaddr"' });
    try {
      await agent.connectTo(addr);
    } catch (err: any) {
      return jsonResponse(res, 400, {
        error: err.message ?? "Failed to connect",
      });
    }
    return jsonResponse(res, 200, { connected: true });
  }

  // POST /api/update  { kcId: "...", contextGraphId|paranetId: "...", quads: [...], privateQuads?: [...] }
  if (req.method === "POST" && path === "/api/update") {
    const body = await readBody(req);
    const parsed = JSON.parse(body);
    const { kcId, quads, privateQuads } = parsed;
    const paranetId = parsed.contextGraphId ?? parsed.paranetId;
    if (!kcId || !paranetId || !quads?.length) {
      return jsonResponse(res, 400, {
        error: 'Missing "kcId", "contextGraphId" (or "paranetId"), or "quads"',
      });
    }
    let kcIdBigInt: bigint;
    try {
      kcIdBigInt = BigInt(kcId);
    } catch {
      return jsonResponse(res, 400, {
        error: `Invalid "kcId": ${String(kcId).slice(0, 50)}`,
      });
    }
    const ctx = createOperationContext("update");
    tracker.start(ctx, {
      contextGraphId: paranetId,
      details: { kcId: String(kcId), tripleCount: quads.length, source: "api" },
    });
    try {
      const result = await agent.update(
        kcIdBigInt,
        paranetId,
        quads,
        privateQuads,
        {
          operationCtx: ctx,
          onPhase: tracker.phaseCallback(ctx),
        },
      );
      const chain = result.onChainResult;
      if (chain) {
        tracker.setCost(ctx, {
          gasUsed: chain.gasUsed,
          gasPrice: chain.effectiveGasPrice,
          gasCost: chain.gasCostWei,
          tracCost: chain.tokenAmount,
        });
        const chainId = resolveChainConfig(config, network)?.chainId;
        tracker.setTxHash(
          ctx,
          chain.txHash,
          chainId ? Number(chainId) : undefined,
        );
      }
      if (result.status === "failed") {
        tracker.fail(ctx, new Error(`Update failed on-chain (kcId=${kcId})`));
      } else {
        tracker.complete(ctx, {
          tripleCount: quads.length,
          details: { kcId: String(result.kcId), status: result.status },
        });
      }
      const opDetail = dashDb.getOperation(ctx.operationId);
      return jsonResponse(res, 200, {
        kcId: String(result.kcId),
        status: result.status,
        kas: result.kaManifest.map((ka) => ({
          tokenId: String(ka.tokenId),
          rootEntity: ka.rootEntity,
        })),
        ...(chain && { txHash: chain.txHash, blockNumber: chain.blockNumber }),
        phases: opDetail.phases,
      });
    } catch (err) {
      tracker.fail(ctx, err);
      throw err;
    }
  }
}
