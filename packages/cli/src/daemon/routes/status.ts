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
import { enrichEvmError, MockChainAdapter, resolveRpcUrls, getRpcFailoverStats } from '@origintrail-official/dkg-chain';
import { DKGAgent, loadOpWallets } from '@origintrail-official/dkg-agent';
import { isExternalBackend } from '@origintrail-official/dkg-storage';
import { resolveManagedOxigraphPort } from '../oxigraph-managed.js';
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
  resolveNetworkConfigName,
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
import { buildRelayStatusBlock } from '../relay-status-block.js';
import { fetchAllEntries, resolveRegistryConfig } from '../../integrations/registry-client.js';
import type { IntegrationEntry, TrustTier } from '../../integrations/schema.js';
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
import { VectorStore, type EmbeddingProvider } from '../../vector-store.js';
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
  loadBuildInfo,
  detectInstallMode,
  loadSkillTemplate,
  loadImporterSkillTemplate,
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
  respondIfChainRpcTransportError,
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

// In-process cache for the dkg-integrations registry. Sidebar polls
// open/close and 60s refresh would otherwise hit GitHub on every tick;
// the registry doesn't change minute-to-minute, so a 5-minute TTL is fine.
const REGISTRY_CACHE_TTL_MS = 5 * 60_000;

interface RegistryCacheSnapshot {
  entries: IntegrationEntry[];
  failures: Array<{ slug: string; error: string }>;
  fetchedAt: number;
}

let registryCache: RegistryCacheSnapshot | null = null;
let registryCacheInflight: Promise<RegistryCacheSnapshot> | null = null;

function routeWithTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

async function probeRpcEndpoint(rpcUrl: string, index: number): Promise<{
  index: number;
  role: 'primary' | 'backup';
  ok: boolean;
  latencyMs: number | null;
  blockNumber: number | null;
  error?: string;
}> {
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
  const start = Date.now();
  try {
    const blockNumber = await routeWithTimeout(provider.getBlockNumber(), 3_000, 'RPC health probe');
    return {
      index,
      role: index === 0 ? 'primary' : 'backup',
      ok: true,
      latencyMs: Date.now() - start,
      blockNumber,
    };
  } catch (err) {
    return {
      index,
      role: index === 0 ? 'primary' : 'backup',
      ok: false,
      latencyMs: null,
      blockNumber: null,
      error: err instanceof Error && err.message.includes('timed out')
        ? 'RPC health probe timed out'
        : 'RPC health probe failed',
    };
  }
}

function createRouteEvmProvider(rpcUrl: string, rpcUrls?: string[]): ethers.JsonRpcProvider | ethers.FallbackProvider {
  const providers = resolveRpcUrls(rpcUrl, rpcUrls)
    .map((url) => new ethers.JsonRpcProvider(url, undefined, { cacheTimeout: -1 }));
  if (providers.length === 1) return providers[0];
  return new ethers.FallbackProvider(
    providers.map((provider, index) => ({
      provider,
      priority: index + 1,
      stallTimeout: 4_000,
      weight: 1,
    })),
    undefined,
    { quorum: 1 },
  );
}

// Quad-count cache for external SPARQL backends. Every /api/status hit
// otherwise issues a `SELECT (COUNT(*))` against the remote endpoint —
// expensive on a large namespace, and the route is polled by the
// dashboard, telemetry, and `dkg status` operators. 30 s TTL is short
// enough that a fresh wipe / bulk publish shows up quickly without
// flooding Blazegraph. Cold/stale callers get the current snapshot while
// one refresh runs in the background, so status never waits on the count.
// Local backends bypass this entirely (file-bytes metric stays on the
// metrics collector tick).
const STORE_QUADS_CACHE_TTL_MS = 30_000;
type StoreQuadsStatus = 'pending' | 'ready' | 'unreachable';
interface StoreQuadsSnapshot {
  value: number | null;
  status: StoreQuadsStatus;
}

let storeQuadsCache: {
  value: number | null;
  status: Exclude<StoreQuadsStatus, 'pending'>;
  fetchedAt: number;
} | null = null;
let storeQuadsInflight: Promise<void> | null = null;

/** Drop cached quad counts (e.g. when the managed Oxigraph child exits). */
export function invalidateExternalStoreQuadsCache(): void {
  storeQuadsCache = null;
  storeQuadsInflight = null;
}

function getCachedExternalStoreQuads(
  agent: DKGAgent,
  now: number,
): StoreQuadsSnapshot {
  if (storeQuadsCache && now - storeQuadsCache.fetchedAt < STORE_QUADS_CACHE_TTL_MS) {
    return { value: storeQuadsCache.value, status: storeQuadsCache.status };
  }

  const currentSnapshot: StoreQuadsSnapshot = storeQuadsCache
    ? { value: storeQuadsCache.value, status: storeQuadsCache.status }
    : { value: null, status: 'pending' };
  if (!storeQuadsInflight) {
    const refresh = (async () => {
      try {
        const r = await agent.store.query(
          'SELECT (COUNT(*) AS ?c) WHERE { GRAPH ?g { ?s ?p ?o } }',
        );
        let value: number | null = null;
        if (r.type === 'bindings' && r.bindings.length > 0) {
          const cell = r.bindings[0].c ?? '';
          const digits = cell.match(/\d+/)?.[0];
          value = digits ? parseInt(digits, 10) : 0;
        }
        storeQuadsCache = {
          value,
          status: value === null ? 'unreachable' : 'ready',
          fetchedAt: Date.now(),
        };
      } catch {
        // Surface "unknown" rather than a stale value; operators can
        // distinguish unreachable from genuinely-empty via storeBackend +
        // their network logs. Cache the null briefly to avoid hammering
        // a flapping endpoint.
        storeQuadsCache = { value: null, status: 'unreachable', fetchedAt: Date.now() };
      }
    })();
    storeQuadsInflight = refresh;
    void refresh.finally(() => {
      if (storeQuadsInflight === refresh) storeQuadsInflight = null;
    });
  }
  return currentSnapshot;
}

async function getRegistryCacheSnapshot(): Promise<RegistryCacheSnapshot> {
  const now = Date.now();
  if (registryCache && now - registryCache.fetchedAt < REGISTRY_CACHE_TTL_MS) {
    return registryCache;
  }
  if (registryCacheInflight) return registryCacheInflight;
  registryCacheInflight = (async () => {
    const cfg = resolveRegistryConfig();
    const { entries, failures } = await fetchAllEntries(cfg);
    const snap: RegistryCacheSnapshot = { entries, failures, fetchedAt: Date.now() };
    registryCache = snap;
    return snap;
  })().finally(() => {
    registryCacheInflight = null;
  });
  return registryCacheInflight;
}

// Trims a registry entry down to the fields the sidebar/browse UI consumes.
// Full entries (security blocks, install specs, etc.) stay on the daemon
// until the eventual /integrations browse page asks for them.
function summarizeRegistryEntry(e: IntegrationEntry) {
  return {
    slug: e.slug,
    name: e.name,
    description: e.description,
    trustTier: e.trustTier,
    memoryLayers: e.memoryLayers,
    installKind: e.install.kind,
    repo: e.repo,
    maintainer: e.maintainer.github,
    targetAgents: e.targetAgents ?? [],
  };
}

export async function handleStatusRoutes(ctx: RequestContext): Promise<void> {
  const {
    req,
    res,
    agent,
    publisherControl,
    publisherState,
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
    admission,
    url,
    path,
    requestToken,
    requestAgentAddress,
  } = ctx;

  if ((req.method === "GET" || req.method === "HEAD") && path === "/.well-known/skill.md") {
    // HEAD must return the same ETag/Cache-Control/Vary headers as GET so HTTP-cache-aware clients
    // can validate without a body roundtrip. Compute body+ETag, honour If-None-Match, then emit
    // headers and (for GET only) the body.
    const proto = req.headers["x-forwarded-proto"] ?? "http";
    const host =
      req.headers["x-forwarded-host"] ??
      req.headers.host ??
      `localhost:${config.listenPort ?? 9200}`;
    const baseUrl = `${proto}://${host}`;
    // text/markdown is always handled natively by the import-file route, so surface it in the
    // discovery list even when no Phase 1 converter is registered.
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
    res.end(req.method === "HEAD" ? undefined : content);
    return;
  }

  // Second agent-readable manual: the bulk-import / chunking / manifest /
  // async-promote-queue contract. Mirrors the `/.well-known/skill.md`
  // route exactly — public, GET/HEAD, ETag-cacheable, no dynamic
  // substitution because the importer skill doesn't carry node-state
  // placeholders today. See Codex PR #642 follow-up: until this endpoint
  // landed, the cross-link in dkg-node/SKILL.md was unreachable for
  // agents installed via setup flows.
  if (
    (req.method === "GET" || req.method === "HEAD") &&
    path === "/.well-known/skill-importer.md"
  ) {
    const importerContent = loadImporterSkillTemplate();
    const importerEtag = skillEtag(importerContent);
    if (req.headers["if-none-match"] === importerEtag) {
      res.writeHead(304).end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      ETag: importerEtag,
      "Cache-Control": "public, max-age=300",
      Vary: "Host, X-Forwarded-Host, X-Forwarded-Proto",
    });
    res.end(req.method === "HEAD" ? undefined : importerContent);
    return;
  }

  // GET /api/context-graph/{id}/members — local SQL membership cache.
  // Kept in this early route group so the cache has a lightweight read path.
  const contextGraphMembersMatch = path.match(/^\/api\/context-graph\/([^/]+)\/members$/);
  if (req.method === "GET" && contextGraphMembersMatch) {
    const contextGraphId = decodeURIComponent(contextGraphMembersMatch[1]);
    if (!isValidContextGraphId(contextGraphId)) {
      return jsonResponse(res, 400, { error: 'Invalid context graph id' });
    }
    return jsonResponse(res, 200, {
      contextGraphId,
      members: dashDb.listContextGraphMembers(contextGraphId),
    });
  }

  // GET/HEAD /api/status — HEAD claims early so liveness probes never reach plugins.
  if ((req.method === "GET" || req.method === "HEAD") && path === "/api/status") {
    if (req.method === "HEAD") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end();
      return;
    }
    const allConns = agent.node.libp2p.getConnections();
    const directConns = allConns.filter(
      (c) => !c.remoteAddr?.toString().includes("/p2p-circuit"),
    );
    const relayedConns = allConns.length - directConns.length;
    const uniquePeers = new Set(allConns.map((c) => c.remotePeer.toString()));
    const circuitAddrs = agent.multiaddrs.filter((a) =>
      a.includes("/p2p-circuit/"),
    );
    const networkId = network?.networkId ?? await computeNetworkId(network?.genesisId);
    const chainConf = resolveChainConfig(config, network);
    const rpcEndpointCount = chainConf?.rpcUrl
      ? resolveRpcUrls(chainConf.rpcUrl, chainConf.rpcUrls).length
      : 0;
    // Process-wide multi-RPC write-failover counters (host-only; no URLs).
    // Reflects WRITE failover/exhaustion across all chain adapters in this
    // daemon process; read-path failover is internal to the FallbackProvider.
    const rpcFailoverStats = getRpcFailoverStats();
    const blockExplorerUrl =
      config.blockExplorerUrl ?? deriveBlockExplorerUrl(chainConf?.chainId);
    const identityId = agent.publisher.getIdentityId();
    const localAgentIntegrations = listLocalAgentIntegrations(config);
    // Relay capability + capacity snapshot. Shape built by `buildRelayStatusBlock`
    // (../relay-status-block.ts) — same shape on edge and core (role-irrelevant
    // fields null) so consumers parse one schema. Common alerts:
    //   relay.isCore && reservationsHeld === reservationCapacity
    //     → Core at saturation, grow the fleet
    //   relay.isCore && relay.natStatus === 'private'
    //     → Core boots but the network can't reach it
    const isCore = (config.nodeRole ?? 'edge') === 'core';
    const relayStats = isCore ? agent.node.getRelayStats() : null;
    const relayBlock = buildRelayStatusBlock({
      isCore,
      relayStats,
      natStatus: daemonState.natStatus,
      advertisedAddresses: agent.multiaddrs,
      configuredAnnounceAddresses: config.announceAddresses ?? [],
    });
    const reportsExternalStoreQuads =
      isExternalBackend(config.store?.backend) || config.store?.backend === 'oxigraph-server';
    const storeQuadsSnapshot = reportsExternalStoreQuads
      ? getCachedExternalStoreQuads(agent, Date.now())
      : null;
    // RFC-41 §4.9 + §4.3: expose build-info + installMode for
    // doctor / agent disambiguation. loadBuildInfo() falls back to
    // the {commit: "uncommitted", distTag: "monorepo", ...}
    // sentinels when build-info.json is absent (monorepo / dev),
    // so consumers can branch reliably.
    const buildInfo = loadBuildInfo();
    return jsonResponse(res, 200, {
      name: config.name,
      version: nodeVersion,
      commit: buildInfo.commit !== "uncommitted" ? buildInfo.commit : (nodeCommit || null),
      commitShort: buildInfo.commitShort !== "00000000"
        ? buildInfo.commitShort
        : (nodeCommit ? nodeCommit.slice(0, 8) : null),
      buildTime: buildInfo.buildTime,
      distTag: buildInfo.distTag,
      installMode: detectInstallMode(),
      peerId: agent.peerId,
      nodeRole: config.nodeRole ?? "edge",
      networkConfig: resolveNetworkConfigName(config),
      networkId,
      networkName: network?.networkName ?? null,
      storeBackend: config.store?.backend ?? "oxigraph-worker",
      // External backend visibility (RFC 120 / plan PR 1 item 3). For
      // local backends the URL/count stay null and count status is omitted.
      storeUrl: isExternalBackend(config.store?.backend)
        ? (() => {
            const opts = (config.store?.options ?? {}) as Record<string, unknown>;
            const url = typeof opts.url === 'string' ? opts.url
              : typeof opts.queryEndpoint === 'string' ? opts.queryEndpoint
              : null;
            return url;
          })()
        : config.store?.backend === 'oxigraph-server'
          // Managed local server: report its loopback endpoint so `dkg status`
          // renders the external-store health path (storeQuads/unreachable)
          // instead of printing it like a quad-less local store.
          ? (() => {
              const opts = (config.store?.options ?? {}) as Record<string, unknown>;
              const port = resolveManagedOxigraphPort(opts);
              return `http://127.0.0.1:${port}/query`;
            })()
          : null,
      // A managed `oxigraph-server` keeps `config.store.backend` as
      // "oxigraph-server" (so it persists/labels correctly), but its quad
      // count is still worth surfacing — it's the only store-health signal
      // for that backend (getStoreBytes is null, there's no store.nq), and a
      // failed query here is how operators see the managed server is down
      // (e.g. after a failed revive) instead of it always looking healthy.
      storeQuads: storeQuadsSnapshot?.value ?? null,
      storeQuadsStatus: storeQuadsSnapshot?.status,
      uptimeMs: Date.now() - startedAt,
      // Concurrency admission control (PR #1209): inFlight = requests currently
      // holding a slot, max = the configured cap (0 = disabled), rejectedTotal =
      // monotonic count of 503-shed requests since boot. Surfaced so operators
      // can see whether the daemon is shedding load (and read the effective cap).
      admission: {
        inFlight: admission.inFlight,
        max: admission.max,
        rejectedTotal: admission.rejectedTotal,
      },
      connectedPeers: uniquePeers.size,
      connections: {
        total: allConns.length,
        direct: directConns.length,
        relayed: relayedConns,
      },
      relayConnected: circuitAddrs.length > 0,
      multiaddrs: agent.multiaddrs,
      relay: relayBlock,
      blockExplorerUrl,
      identityId: String(identityId),
      hasIdentity: identityId > 0n,
      asyncPublisher: publisherState.availability,
      hasOpenClawChannel: hasConfiguredLocalAgentChat(config, 'openclaw'),
      localAgentIntegrations,
      connectedLocalAgentIds: localAgentIntegrations.filter((integration) => integration.enabled).map((integration) => integration.id),
      autoUpdate: resolveAutoUpdateEnabled(config),
      chain: chainConf
        ? {
            chainId: chainConf.chainId ?? null,
            configured: Boolean(chainConf.rpcUrl && chainConf.hubAddress),
            rpcEndpointCount,
            hubConfigured: Boolean(chainConf.hubAddress),
            // Multi-RPC failover observability (counts only — no RPC URLs).
            rpcFailovers: rpcFailoverStats.failovers,
            rpcExhaustions: rpcFailoverStats.exhaustions,
            rpcFailoversByClass: rpcFailoverStats.byErrorClass,
            // Per-provider distribution (host-only). `served` is the success side
            // — which endpoint is actually carrying the traffic — and `failed` is
            // the failover side. Together they show provider health at a glance.
            rpcServedByEndpointHost: rpcFailoverStats.servedByEndpointHost,
            rpcFailoversByEndpointHost: rpcFailoverStats.byEndpointHost,
            // Endpoint-stickiness: times the client stuck to a backup after a
            // failover (a rising count = a configured primary is degraded).
            rpcPreferredEstablishments: rpcFailoverStats.preferredEstablishments,
          }
        : null,
      updateAvailable:
        daemonState.lastUpdateCheck.checkedAt > 0 ? !daemonState.lastUpdateCheck.upToDate : null,
      // True when this node pins an auto-update channel that has no acceptable
      // target yet (e.g. the `mainnet` tag is unpublished, or points at a
      // prerelease under allowPrerelease=false). Distinct from updateAvailable.
      updateChannelTargetMissing: daemonState.lastUpdateCheck.channelTargetMissing,
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
            rpcUrls: chainConf.rpcUrls ?? [],
            hubAddress: chainConf.hubAddress,
          }
        : null,
      peers: uniquePeers.size,
      contextGraphs: resolveContextGraphs(config).length,
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
    const [skills, contextGraphs] = await Promise.all([agent.findSkills(), agent.listContextGraphs()]);
    const localAgentIntegrations = listLocalAgentIntegrations(config);
    const adapters = localAgentIntegrations.map((integration) => ({
      id: integration.id,
      name: integration.name,
      enabled: integration.enabled,
      description: integration.description,
      status: integration.status,
      capabilities: integration.capabilities,
    }));
    return jsonResponse(res, 200, { adapters, localAgentIntegrations, skills, contextGraphs });
  }

  // GET /api/integrations/registry — proxies the public dkg-integrations
  // registry to the UI so the sidebar can list community integrations
  // without spending the user's GitHub rate-limit. Cached in-process for
  // REGISTRY_CACHE_TTL_MS to keep the sidebar responsive on poll/toggle.
  if (req.method === 'GET' && path === '/api/integrations/registry') {
    const tierParam = (url.searchParams.get('tier') ?? '').trim().toLowerCase();
    const minTier: TrustTier = tierParam === 'community' || tierParam === 'verified' || tierParam === 'featured'
      ? tierParam
      : 'community';
    try {
      const { entries, failures, fetchedAt } = await getRegistryCacheSnapshot();
      const TIER_RANK: Record<TrustTier, number> = { community: 0, verified: 1, featured: 2 };
      const filtered = entries.filter((e) => TIER_RANK[e.trustTier] >= TIER_RANK[minTier]);
      const summarized = filtered.map(summarizeRegistryEntry);
      return jsonResponse(res, 200, {
        entries: summarized,
        failures,
        fetchedAt,
        tier: minTier,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse(res, 502, { error: `registry fetch failed: ${msg}` });
    }
  }

  // POST /api/register-adapter — legacy OpenClaw alias for /api/local-agent-integrations/connect
  if (req.method === 'POST' && path === '/api/register-adapter') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(body); } catch { return jsonResponse(res, 400, { error: 'Invalid JSON body' }); }
    const adapterId = typeof parsed.id === 'string' && parsed.id.trim()
      ? normalizeIntegrationId(parsed.id)
      : 'openclaw';
    const definition = LOCAL_AGENT_INTEGRATION_DEFINITIONS[adapterId];
    if (!definition || adapterId !== 'openclaw') {
      return jsonResponse(res, 400, { error: `Unknown adapter id: ${String(parsed.id ?? adapterId)}` });
    }
    try {
      const integration = connectLocalAgentIntegration(config, {
        ...parsed,
        id: adapterId,
        transport: {
          kind: definition.transportKind,
          ...(isPlainRecord(parsed.transport) ? parsed.transport : {}),
        },
        manifest: {
          ...(definition.manifest ?? {}),
          ...(isPlainRecord(parsed.manifest) ? parsed.manifest : {}),
        },
        capabilities: {
          ...definition.capabilities,
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
        rpcUrls: chain?.rpcUrls ?? [],
        error: !rpcUrl || !hubAddress ? "Chain not configured" : "No wallets",
      });
    }
    try {
      const provider = createRouteEvmProvider(rpcUrl, chain?.rpcUrls);
      const tokenAddr = chain?.tokenAddress
        ?? (await new ethers.Contract(
          hubAddress,
          ["function getContractAddress(string) view returns (address)"],
          provider,
        ).getContractAddress("Token").catch(() => null));
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
      const balances = await Promise.all(
        opWallets.wallets.map(async (w) => {
          const [ethBal, tracBal] = await Promise.all([
            provider.getBalance(w.address),
            token ? token.balanceOf(w.address) : Promise.resolve(0n),
          ]);
          return {
            address: w.address,
            eth: ethers.formatEther(ethBal),
            trac: ethers.formatEther(tracBal),
            symbol: tokenSymbol,
          };
        }),
      );
      return jsonResponse(res, 200, {
        wallets: opWallets.wallets.map((w) => w.address),
        balances,
        chainId,
        rpcUrl,
        rpcUrls: chain?.rpcUrls ?? [],
        symbol: tokenSymbol,
      });
    } catch (err: any) {
      return jsonResponse(res, 200, {
        wallets: opWallets.wallets.map((w) => w.address),
        balances: [],
        chainId,
        rpcUrl,
        rpcUrls: chain?.rpcUrls ?? [],
        error: err.message,
      });
    }
  }

  // GET/HEAD /api/chain/rpc-health — HEAD claims early to short-circuit the RPC roundtrip for liveness probes.
  if ((req.method === "GET" || req.method === "HEAD") && path === "/api/chain/rpc-health") {
    if (req.method === "HEAD") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end();
      return;
    }
    const chain = resolveChainConfig(config, network);
    const rpcUrl = chain?.rpcUrl;
    if (!rpcUrl) {
      return jsonResponse(res, 200, {
        ok: false,
        configured: false,
        rpcEndpointCount: 0,
        latencyMs: null,
        blockNumber: null,
        rpcs: [],
        error: "Chain not configured",
      });
    }
    const rpcUrls = resolveRpcUrls(rpcUrl, chain?.rpcUrls);
    const rpcs = await Promise.all(rpcUrls.map((url, index) => probeRpcEndpoint(url, index)));
    const primary = rpcs[0];
    const healthy = rpcs.find((rpc) => rpc.ok);
    return jsonResponse(res, 200, {
      ok: !!healthy,
      configured: true,
      rpcEndpointCount: rpcUrls.length,
      latencyMs: healthy?.latencyMs ?? null,
      blockNumber: healthy?.blockNumber ?? null,
      error: healthy ? undefined : (primary?.error ?? "RPC health probe failed"),
      rpcs,
    });
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
      // A transient chain-RPC transport failure during on-chain identity
      // creation is retryable (503/504), not a hard 500. The extra body fields
      // preserve the route's identity contract on the retryable response.
      if (respondIfChainRpcTransportError(res, err, { identityId: "0", hasIdentity: false })) return;
      return jsonResponse(res, 500, {
        error: err.message,
        identityId: "0",
        hasIdentity: false,
      });
    }
  }

  // GET /api/random-sampling/status — V10 RandomSampling prover snapshot.
  // Read-only; no chain calls. Cheap enough to call every few seconds
  // from a dashboard or watch loop. Disabled nodes return enabled:false
  // with an explicit reason (edge, no identity, awaiting admission, etc.).
  if (req.method === 'GET' && path === '/api/random-sampling/status') {
    const status = agent.getRandomSamplingStatus();
    return jsonResponse(res, 200, status);
  }

  // POST /api/random-sampling/backfill-percgid-meta
  //
  // One-shot operator tool to rescue KCs that landed on a receiver core
  // BEFORE the cd68fa689 publisher fix (or before the receiver shipped
  // the defensive `ctxGraphId` lookup). Such KCs have their per-KC
  // metadata sitting at the canonical `<cgName>/_meta` URI, but the RS
  // prover's `extractV10KCFromStore` reads the per-cgId
  // `<cgName>/context/<cgId>/_meta` graph and so sees nothing — every
  // prover tick returns `kc-not-synced`.
  //
  // For each subscribed CG that has an on-chain id, we copy the
  // per-KC subset of `<cgName>/_meta` into
  // `<cgName>/context/<cgId>/_meta`. The "per-KC subset" matches the
  // shape `generateKCMetadata` emits (`packages/publisher/src/metadata.ts`):
  //   - KC UAL subjects (carry `dkg:batchId`, `dkg:merkleRoot`, `dkg:status`, …).
  //   - KA UAL subjects (`<UAL/tokenId>`; identified by `dkg:partOf <KC>`).
  // (RFC ka-metadata-trim Phase 1: the Publication-URI arm was removed —
  // `generateKCMetadata` no longer emits `dkg:Publication` subjects.)
  //
  // Granularity is PER-KC, not per-CG: each KC is gated by an
  // independent `FILTER NOT EXISTS` against the target graph, so a
  // mixed-state CG (some pre-fix KCs orphaned at `<cg>/_meta`, some
  // post-fix KCs already in the per-cgId graph) gets only the missing
  // KCs copied. Re-running the backfill after additional post-fix
  // publishes is a no-op for KCs already present in the target.
  //
  // Body (all fields optional):
  //   {
  //     "contextGraphIds": ["foo", "bar"], // restrict to specific CG names; omit/empty for all subscribed
  //     "dryRun": true                     // probe-only: don't write, just report what would happen
  //   }
  if (req.method === 'POST' && path === '/api/random-sampling/backfill-percgid-meta') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    let parsed: { contextGraphIds?: unknown; dryRun?: unknown };
    try {
      parsed = body.trim() ? JSON.parse(body) : {};
    } catch {
      return jsonResponse(res, 400, { error: 'Invalid JSON body' });
    }
    const requestedIds = Array.isArray(parsed.contextGraphIds)
      ? (parsed.contextGraphIds as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0)
      : [];
    const dryRun = parsed.dryRun === true;

    type CgReport = {
      contextGraphId: string;
      onChainId?: string;
      status: 'backfilled' | 'already-populated' | 'no-source-meta' | 'not-on-chain' | 'failed';
      /** Total triples written (or that would be written, in dry-run). */
      copiedTriples?: number;
      /** Distinct KCs that needed backfilling (rows where source had a KC absent from target). */
      copiedKcCount?: number;
      /** Distinct KCs present in `<cg>/_meta` regardless of target state — observability signal. */
      sourceKcCount?: number;
      error?: string;
    };

    const subscribed = agent.getSubscribedContextGraphs();
    const cgEntries: Array<[string, string]> = [];
    for (const [cgName, sub] of subscribed) {
      if (requestedIds.length > 0 && !requestedIds.includes(cgName)) continue;
      if (!sub.onChainId) {
        cgEntries.push([cgName, '']);
        continue;
      }
      cgEntries.push([cgName, String(sub.onChainId)]);
    }

    // Operator-typo guard: requested CG names that don't match any
    // subscribed CG on this node are surfaced explicitly so a no-op
    // run is diagnosable. Without this, a typo like
    // `miles-publish-stress-26mayyy` yields `processed: 0` and looks
    // identical to "nothing needed backfilling". (Codex review on PR
    // #763, round 2.)
    const subscribedNames = new Set(subscribed.keys());
    const unknownContextGraphIds = requestedIds.filter((id) => !subscribedNames.has(id));

    const DKG_BATCH_ID = 'http://dkg.io/ontology/batchId';
    const DKG_PART_OF = 'http://dkg.io/ontology/partOf';

    const reports: CgReport[] = [];
    for (const [cgName, onChainId] of cgEntries) {
      if (!onChainId) {
        reports.push({ contextGraphId: cgName, status: 'not-on-chain' });
        continue;
      }
      const sourceMeta = `did:dkg:context-graph:${cgName}/_meta`;
      const targetMeta = contextGraphMetaUri(cgName, onChainId);
      try {
        // Total distinct KCs present in source — observability counter.
        // Includes both KCs that need copying and KCs already in target.
        const sourceKcResult = await agent.store.query(
          `SELECT (COUNT(DISTINCT ?kc) AS ?n) WHERE { GRAPH <${sourceMeta}> { ?kc <${DKG_BATCH_ID}> ?bid } }`,
        );
        const sourceKcCount = sourceKcResult.type === 'bindings'
          ? Number((sourceKcResult.bindings[0]?.['n'] as string ?? '"0"').replace(/^"|".*$/g, ''))
          : 0;

        if (sourceKcCount === 0) {
          reports.push({ contextGraphId: cgName, onChainId, status: 'no-source-meta', sourceKcCount: 0 });
          continue;
        }

        // CONSTRUCT only the meta for KCs that are MISSING from the
        // target per-cgId graph. Two UNION arms:
        //   1. KC subjects (`?kc`) whose `dkg:batchId` is in source
        //      but not in target.
        //   2. KA subjects (`?ka`) whose parent KC is in that
        //      missing-from-target set.
        // (RFC ka-metadata-trim Phase 1: the third arm that copied
        // `dkg:Publication` subjects via `<KA> dkg:publication <pub>` was
        // removed together with the writer.)
        // Read-both (RFC ka-metadata-trim P3.1/P3.5): the collapsed shape
        // carries the member-entity pair + privateMerkleRoot directly on the
        // UAL subject, so arm 1 already copies everything a collapsed KC
        // needs (the RS prover's extractor is read-both too); arm 2 only
        // fires for legacy `<ual>/<n> partOf <ual>` token rows.
        //
        // The `FILTER NOT EXISTS` is anchored on the KC's `dkg:batchId`
        // because every per-KC promotion writes that triple — so its
        // presence in the target is the canonical signal that the KC
        // (and its KAs) are already there. Set semantics
        // of `store.insert` mean accidentally re-inserting a quad is a
        // no-op; the filter is for efficiency + clean diagnostic
        // counts, not for correctness.
        const constructResult = await agent.store.query(`CONSTRUCT { ?s ?p ?o } WHERE {
          GRAPH <${sourceMeta}> {
            {
              ?s ?p ?o .
              ?s <${DKG_BATCH_ID}> ?bid .
              FILTER NOT EXISTS { GRAPH <${targetMeta}> { ?s <${DKG_BATCH_ID}> ?bidT } }
            } UNION {
              ?s ?p ?o .
              ?s <${DKG_PART_OF}> ?kc .
              ?kc <${DKG_BATCH_ID}> ?bid2 .
              FILTER NOT EXISTS { GRAPH <${targetMeta}> { ?kc <${DKG_BATCH_ID}> ?bidT2 } }
            }
          }
        }`);
        const sourceQuads = constructResult.type === 'quads' ? constructResult.quads : [];

        // Distinct KCs in the construct result — every backfilled KC
        // shows up as at least one quad with itself as subject (the
        // first UNION arm). De-duplicating by subject is the cleanest
        // way to derive a per-KC count without a second SPARQL probe.
        const copiedKcCount = new Set(
          sourceQuads
            .filter(q => sourceQuads.some(qq => qq.subject === q.subject && qq.predicate === DKG_BATCH_ID))
            .map(q => q.subject),
        ).size;

        if (sourceQuads.length === 0) {
          // Source has KCs but none are missing from target — fully synced.
          reports.push({
            contextGraphId: cgName,
            onChainId,
            status: 'already-populated',
            sourceKcCount,
            copiedKcCount: 0,
            copiedTriples: 0,
          });
          continue;
        }

        if (dryRun) {
          reports.push({
            contextGraphId: cgName,
            onChainId,
            status: 'backfilled',
            sourceKcCount,
            copiedKcCount,
            copiedTriples: sourceQuads.length,
          });
          continue;
        }

        const targeted = sourceQuads.map(q => ({ ...q, graph: targetMeta }));
        await agent.store.insert(targeted);

        reports.push({
          contextGraphId: cgName,
          onChainId,
          status: 'backfilled',
          sourceKcCount,
          copiedKcCount,
          copiedTriples: targeted.length,
        });
      } catch (err) {
        reports.push({
          contextGraphId: cgName,
          onChainId,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return jsonResponse(res, 200, {
      dryRun,
      processed: reports.length,
      summary: {
        backfilled: reports.filter(r => r.status === 'backfilled').length,
        alreadyPopulated: reports.filter(r => r.status === 'already-populated').length,
        noSourceMeta: reports.filter(r => r.status === 'no-source-meta').length,
        notOnChain: reports.filter(r => r.status === 'not-on-chain').length,
        failed: reports.filter(r => r.status === 'failed').length,
      },
      // Always included so the script/operator can `.length > 0`-check.
      // Empty array when no filter was supplied or every requested CG
      // resolved against the local subscription set.
      unknownContextGraphIds,
      reports,
    });
  }

  // POST /api/shutdown
  if (req.method === "POST" && path === "/api/shutdown") {
    jsonResponse(res, 200, { ok: true });
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 100);
    return;
  }
}
