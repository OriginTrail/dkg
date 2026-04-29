// daemon/routes/status.ts
//
// Route handlers for status, info, connections, host, wallet, chain, identity, integrations, shutdown.
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


export async function handleStatusRoutes(ctx: RequestContext): Promise<void> {
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

  if (req.method === "GET" && path === "/.well-known/skill.md") {
    const proto = req.headers["x-forwarded-proto"] ?? "http";
    const host =
      req.headers["x-forwarded-host"] ??
      req.headers.host ??
      `localhost:${config.listenPort ?? 9200}`;
    const baseUrl = `${proto}://${host}`;
    // text/markdown is always handled natively by the import-file route
    // (skip Phase 1, run the Phase 2 markdown extractor directly), even when
    // no Phase 1 converter is registered. Surface it in the discovery list so
    // skill-driven clients see Markdown ingestion as supported regardless of
    // converter availability.
    const pipelines = extractionRegistry.availableContentTypes();
    const content = buildSkillMd({
      version: nodeVersion,
      baseUrl,
      peerId: agent.peerId,
      nodeRole: config.nodeRole ?? "edge",
      extractionPipelines: [...new Set(["text/markdown", ...pipelines])],
    });
    const etag = skillEtag(content);
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304).end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      ETag: etag,
      "Cache-Control": "public, max-age=300",
      Vary: "Host, X-Forwarded-Host, X-Forwarded-Proto",
    });
    res.end(content);
    return;
  }

  // GET /api/status
  if (req.method === "GET" && path === "/api/status") {
    const allConns = agent.node.libp2p.getConnections();
    const directConns = allConns.filter(
      (c) => !c.remoteAddr?.toString().includes("/p2p-circuit"),
    );
    const relayedConns = allConns.length - directConns.length;
    const uniquePeers = new Set(allConns.map((c) => c.remotePeer.toString()));
    const circuitAddrs = agent.multiaddrs.filter((a) =>
      a.includes("/p2p-circuit/"),
    );
    const networkId = await computeNetworkId();
    const chainConf = resolveChainConfig(config, network);
    const blockExplorerUrl =
      config.blockExplorerUrl ?? deriveBlockExplorerUrl(chainConf?.chainId);
    const identityId = agent.publisher.getIdentityId();
    const localAgentIntegrations = listLocalAgentIntegrations(config);
    return jsonResponse(res, 200, {
      name: config.name,
      version: nodeVersion,
      commit: nodeCommit || null,
      peerId: agent.peerId,
      nodeRole: config.nodeRole ?? "edge",
      networkId: networkId.slice(0, 16),
      networkName: network?.networkName ?? null,
      storeBackend: config.store?.backend ?? "oxigraph-worker",
      uptimeMs: Date.now() - startedAt,
      connectedPeers: uniquePeers.size,
      connections: {
        total: allConns.length,
        direct: directConns.length,
        relayed: relayedConns,
      },
      relayConnected: circuitAddrs.length > 0,
      multiaddrs: agent.multiaddrs,
      blockExplorerUrl,
      identityId: String(identityId),
      hasIdentity: identityId > 0n,
      hasOpenClawChannel: hasConfiguredLocalAgentChat(config, 'openclaw'),
      localAgentIntegrations,
      connectedLocalAgentIds: localAgentIntegrations.filter((integration) => integration.enabled).map((integration) => integration.id),
      autoUpdate: resolveAutoUpdateEnabled(config),
      updateAvailable:
        daemonState.lastUpdateCheck.checkedAt > 0 ? !daemonState.lastUpdateCheck.upToDate : null,
      latestCommit: daemonState.lastUpdateCheck.latestCommit || null,
      latestVersion: daemonState.lastUpdateCheck.latestVersion || null,
    });
  }

  // GET /api/info — lightweight DevOps health check (authenticated)
  if (req.method === "GET" && path === "/api/info") {
    const allConns = agent.node.libp2p.getConnections();
    const uniquePeers = new Set(allConns.map((c) => c.remotePeer.toString()));
    const chainConf = resolveChainConfig(config, network);
    const now = Date.now();

    return jsonResponse(res, 200, {
      status: "running",
      version: getNodeVersion(),
      name: config.name,
      peerId: agent.peerId,
      nodeRole: config.nodeRole ?? "edge",
      network: network?.networkName ?? null,
      startedAt: new Date(startedAt).toISOString(),
      uptimeSeconds: Math.floor((now - startedAt) / 1000),
      timestamp: new Date(now).toISOString(),
      chain: chainConf
        ? {
            chainId: chainConf.chainId ?? null,
            rpcUrl: chainConf.rpcUrl,
            hubAddress: chainConf.hubAddress,
          }
        : null,
      peers: uniquePeers.size,
      paranets: resolveContextGraphs(config).length,
      telemetry: config.telemetry?.enabled ?? false,
      autoUpdate: resolveAutoUpdateEnabled(config),
      auth: config.auth?.enabled !== false,
    });
  }

  // GET /api/connections — detailed per-connection info with transport type
  if (req.method === "GET" && path === "/api/connections") {
    const allConns = agent.node.libp2p.getConnections();
    const connections = allConns.map((c) => {
      const addr = c.remoteAddr?.toString() ?? "unknown";
      return {
        peerId: c.remotePeer.toString(),
        remoteAddr: addr,
        transport: addr.includes("/p2p-circuit") ? "relayed" : "direct",
        direction: c.direction,
        openedAt: c.timeline?.open ?? null,
        durationMs: c.timeline?.open ? Date.now() - c.timeline.open : null,
      };
    });
    const direct = connections.filter((c) => c.transport === "direct").length;
    return jsonResponse(res, 200, {
      total: connections.length,
      direct,
      relayed: connections.length - direct,
      connections,
    });
  }

  // GET /api/host/info — surface enough host info for the WireWorkspacePanel
  // to render real absolute defaults (no `~` paths). Auth-required because
  // hostname/username can be considered identifying. Returns nothing
  // sensitive — just $HOME, hostname, platform, and a sensible default
  // workspace parent dir.
  if (req.method === 'GET' && path === '/api/host/info') {
    try {
      const home = osModule.homedir();
      const hostname = osModule.hostname();
      const username = osModule.userInfo().username;
      const platform = process.platform;
      // Default workspace parent: ~/code if it exists, else ~/dev,
      // else ~. Most operators put projects under ~/code in macOS / Linux.
      const candidates = [`${home}/code`, `${home}/dev`, `${home}/projects`];
      let defaultWorkspaceParent = home;
      for (const c of candidates) {
        try {
          if (existsSync(c)) { defaultWorkspaceParent = c; break; }
        } catch { /* ignore */ }
      }
      return jsonResponse(res, 200, {
        homedir: home,
        hostname,
        username,
        platform,
        defaultWorkspaceParent,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse(res, 500, { error: `host info failed: ${msg}` });
    }
  }

  // GET /api/integrations — aggregated view for Integrations panel
  if (req.method === 'GET' && path === '/api/integrations') {
    const [skills, paranets] = await Promise.all([agent.findSkills(), agent.listContextGraphs()]);
    const localAgentIntegrations = listLocalAgentIntegrations(config);
    const adapters = localAgentIntegrations.map((integration) => ({
      id: integration.id,
      name: integration.name,
      enabled: integration.enabled,
      description: integration.description,
      status: integration.status,
      capabilities: integration.capabilities,
    }));
    return jsonResponse(res, 200, { adapters, localAgentIntegrations, skills, paranets });
  }

  // POST /api/register-adapter — legacy OpenClaw alias for /api/local-agent-integrations/connect
  if (req.method === 'POST' && path === '/api/register-adapter') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(body); } catch { return jsonResponse(res, 400, { error: 'Invalid JSON body' }); }
    if (parsed.id !== undefined && parsed.id !== 'openclaw') {
      return jsonResponse(res, 400, { error: `Unknown adapter id: ${String(parsed.id)}` });
    }
    try {
      const integration = connectLocalAgentIntegration(config, {
        ...parsed,
        id: parsed.id ?? 'openclaw',
        capabilities: {
          localChat: true,
          connectFromUi: true,
          installNode: true,
          dkgPrimaryMemory: true,
          wmImportPipeline: true,
          nodeServedSkill: true,
          ...(isPlainRecord(parsed.capabilities) ? parsed.capabilities : {}),
        },
      });
      await saveConfig(config);
      return jsonResponse(res, 200, { ok: true, integration });
    } catch (err: any) {
      return jsonResponse(res, 400, { error: err?.message ?? 'Invalid JSON body' });
    }
  }

  // GET /api/wallets (list addresses only)
  if (
    req.method === "GET" &&
    (path === "/api/wallet" || path === "/api/wallets")
  ) {
    return jsonResponse(res, 200, {
      wallets: opWallets.wallets.map((w) => w.address),
      chainId: resolveChainConfig(config, network)?.chainId,
    });
  }

  // GET /api/wallets/balances — ETH + TRAC per wallet, RPC health
  if (req.method === "GET" && path === "/api/wallets/balances") {
    const chain = resolveChainConfig(config, network);
    const rpcUrl = chain?.rpcUrl;
    const hubAddress = chain?.hubAddress;
    const chainId = chain?.chainId ?? null;
    if (!rpcUrl || !hubAddress || !opWallets.wallets.length) {
      return jsonResponse(res, 200, {
        wallets: [],
        balances: [],
        chainId,
        rpcUrl: rpcUrl ?? null,
        error: !rpcUrl || !hubAddress ? "Chain not configured" : "No wallets",
      });
    }
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const hub = new ethers.Contract(
        hubAddress,
        ["function getContractAddress(string) view returns (address)"],
        provider,
      );
      const tokenAddr = await hub.getContractAddress("Token").catch(() => null);
      let token: ethers.Contract | null = null;
      let tokenSymbol = "TRAC";
      if (tokenAddr && tokenAddr !== ethers.ZeroAddress) {
        token = new ethers.Contract(
          tokenAddr,
          [
            "function balanceOf(address) view returns (uint256)",
            "function symbol() view returns (string)",
          ],
          provider,
        );
        tokenSymbol = await token.symbol().catch(() => "TRAC");
      }
      const balances: Array<{
        address: string;
        eth: string;
        trac: string;
        symbol: string;
      }> = [];
      for (const w of opWallets.wallets) {
        const ethBal = await provider.getBalance(w.address);
        const tracBal = token ? await token.balanceOf(w.address) : 0n;
        balances.push({
          address: w.address,
          eth: ethers.formatEther(ethBal),
          trac: ethers.formatEther(tracBal),
          symbol: tokenSymbol,
        });
      }
      return jsonResponse(res, 200, {
        wallets: opWallets.wallets.map((w) => w.address),
        balances,
        chainId,
        rpcUrl,
        symbol: tokenSymbol,
      });
    } catch (err: any) {
      return jsonResponse(res, 200, {
        wallets: opWallets.wallets.map((w) => w.address),
        balances: [],
        chainId,
        rpcUrl,
        error: err.message,
      });
    }
  }

  // GET /api/chain/rpc-health
  if (req.method === "GET" && path === "/api/chain/rpc-health") {
    const chain = resolveChainConfig(config, network);
    const rpcUrl = chain?.rpcUrl;
    if (!rpcUrl) {
      return jsonResponse(res, 200, {
        ok: false,
        rpcUrl: null,
        latencyMs: null,
        blockNumber: null,
        error: "Chain not configured",
      });
    }
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const start = Date.now();
      const blockNumber = await provider.getBlockNumber();
      const latencyMs = Date.now() - start;
      return jsonResponse(res, 200, {
        ok: true,
        rpcUrl,
        latencyMs,
        blockNumber,
      });
    } catch (err: any) {
      return jsonResponse(res, 200, {
        ok: false,
        rpcUrl,
        latencyMs: null,
        blockNumber: null,
        error: err.message,
      });
    }
  }

  // GET /api/identity — current on-chain identity status
  if (req.method === "GET" && path === "/api/identity") {
    const identityId = agent.publisher.getIdentityId();
    return jsonResponse(res, 200, {
      identityId: String(identityId),
      hasIdentity: identityId > 0n,
    });
  }

  // POST /api/identity/ensure — (re)attempt on-chain identity creation
  if (req.method === "POST" && path === "/api/identity/ensure") {
    try {
      const identityId = await agent.ensureIdentity();
      return jsonResponse(res, 200, {
        identityId: String(identityId),
        hasIdentity: identityId > 0n,
      });
    } catch (err: any) {
      return jsonResponse(res, 500, {
        error: err.message,
        identityId: "0",
        hasIdentity: false,
      });
    }
  }

  // POST /api/shutdown
  if (req.method === "POST" && path === "/api/shutdown") {
    jsonResponse(res, 200, { ok: true });
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 100);
    return;
  }
}
