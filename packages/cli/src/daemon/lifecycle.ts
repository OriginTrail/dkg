// daemon/lifecycle.ts
//
// `runDaemon` + `runDaemonInner` extracted verbatim from the legacy
// monolithic `daemon.ts`. Owns the daemon boot sequence: PID file,
// config load, agent construction, http server, signal handling,
// shutdown.
//
// The router (`handleRequest`) is in `./handle-request.ts` and
// imported here purely so `createServer` can wire it up.

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, randomUUID } from "node:crypto";
import {
  buildContextGraphDeclarationsSparql,
  contextGraphIdsFromDeclarationBindings,
  contextGraphIdsFromLocalRootMetaGraphs,
  contextGraphIdsFromMetricSubscriptionCandidates,
  countContextGraphsFromGraphUris,
  GET_TOTAL_TRIPLES_SPARQL,
  parseRdfInt,
  shadowContextGraphIdsFromMetricSubscriptionCandidates,
} from "./metrics-queries.js";
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
import type { NetworkInterfaceInfo } from 'node:os';
import { checkCoreRelayPrereqs } from './core-prereq-check.js';
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
import {
  MockChainAdapter,
  type ApprovalPolicy,
} from '@origintrail-official/dkg-chain';
import { DKGAgent, loadOpWallets, KaNumberAllocator } from '@origintrail-official/dkg-agent';
import { isExternalBackend } from '@origintrail-official/dkg-storage';
import { computeNetworkId, createOperationContext, createLogRedactor, DKGEvent, Logger, PayloadTooLargeError, GET_VIEWS, TrustLevel, validateSubGraphName, validateAssertionName, validateContextGraphId, isSafeIri, assertSafeIri, sparqlIri, contextGraphSharedMemoryUri, contextGraphAssertionUri, contextGraphMetaUri, DEFAULT_PROTOCOL_OUTBOX_BACKOFFS_MS, DEFAULT_PROTOCOL_OUTBOX_MAX_AGE_MS, pickNetworkTunables } from '@origintrail-official/dkg-core';
import {
  findReservedSubjectPrefix,
  isSkolemizedUri,
  type AsyncKnowledgeAssetVmPublishExecutionInput,
  type AsyncLiftPublisherConfig,
} from '@origintrail-official/dkg-publisher';
import {
  DashboardDB,
  MetricsCollector,
  OperationTracker,
  handleNodeUIRequest,
  ChatMemoryManager,
  LogPushWorker,
  OtlpLogWorker,
  initTelemetry,
  shutdownTelemetry,
  LlmClient,
  SqliteMessageIdempotencyStore,
  SqliteProtocolOutboxStore,
  SqliteSyncCheckpointStore,
  SqliteKaNumberStore,
  type MetricsSource,
} from "@origintrail-official/dkg-node-ui";
import {
  loadConfig,
  saveConfig,
  loadNetworkConfig,
  resolveAutoUpdateConfig,
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
  type NetworkConfig,
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
  resolveApprovalPolicy,
  resolveSharedMemoryTtlMs,
  repoDir,
  releasesDir,
  activeSlot,
  inactiveSlot,
  swapSlot,
  gitCommandEnv,
  gitCommandArgs,
  isStandaloneInstall,
  resolveAutoUpdateSource,
  slotEntryPoint,
  CLI_NPM_PACKAGE,
  exitOnStoreConfigErrors,
  validateNetworkConfigReadiness,
} from '../config.js';
import { resolveOtelSignals, resolveLogExporterMode, isUnknownLogExporter } from '../telemetry-config.js';
import { createDaemonLogSink } from './log-sink.js';
import { createPublicSnapshotStore, createPublisherControlFromStore, startPublisherRuntimeIfEnabled, type PublisherRuntime } from '../publisher-runner.js';
import { createCatchupRunner, type CatchupJobResult, type CatchupRunner } from '../catchup-runner.js';
import { loadTokens, httpAuthGuard } from '../auth.js';
import { ExtractionPipelineRegistry } from '@origintrail-official/dkg-core';
import { MarkItDownConverter, isMarkItDownAvailable, extractFromMarkdown, extractWithLlm } from '../extraction/index.js';
import {
  expectedBundledMarkItDownBuildMetadata,
  readCliPackageVersion,
  type BundledMarkItDownMetadata,
} from "../extraction/markitdown-bundle-metadata.js";
import {
  checksumPathFor as markItDownChecksumPath,
  hasVerifiedBundledBinary as hasVerifiedBundledMarkItDownBinary,
  metadataPathFor as markItDownMetadataPath,
} from '../../scripts/markitdown-bundle-validation.mjs';
import { type ExtractionStatusRecord, getExtractionStatusRecord, setExtractionStatusRecord } from '../extraction-status.js';
import { FileStore } from '../file-store.js';
import { VectorStore, OpenAIEmbeddingProvider, type EmbeddingProvider } from '../vector-store.js';
import { parseBoundary, parseMultipart, MultipartParseError } from '../http/multipart.js';
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
  resolveStandaloneInstall,
  type CorsAllowlist,
} from './state.js';
import {
  type CatchupJobState,
  type CatchupJob,
  type CatchupTracker,
  toCatchupStatusResponse,
} from './types.js';
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
  buildSkillMd,
  skillEtag,
  DAEMON_EXIT_CODE_RESTART,
  parseRequiredSignatures,
  normalizeDetectedContentType,
  currentBundledMarkItDownAssetName,
  bindingValue,
  carryForwardBundledMarkItDownBinary,
} from './manifest.js';
import {
  SHUTDOWN_HARD_TIMEOUT_MS,
  encodeForcedShutdownExitCode,
  raceShutdownWithTimeout,
} from './shutdown.js';
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
  InFlightLimiter,
  type AdmissionStatsView,
  admitRequest,
  resolveIntSetting,
  applyServerLimits,
  isLoopbackClientIp,
  isLoopbackRateLimitExemptPath,
  shouldBypassRateLimitForLoopbackTraffic,
  isValidContextGraphId,
  shortId,
  sleep,
  deriveBlockExplorerUrl,
  respondWithDaemonError,
} from './http-utils.js';
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
  deriveUpdateCheckState,
  type UpdateStatus,
  acquireUpdateLock,
  releaseUpdateLock,
  performNpmUpdate,
  performNpmUpdateEdge,
} from './auto-update.js';
import { chainResetWipe, detectBackendSwitch, detectNetworkSwitch } from './chain-reset-wipe.js';
import {
  checkExternalStoreReachable,
  checkOrSetStoreIdentity,
  formatHealthCheckFailure,
  formatIdentityTagMismatch,
} from './store-health-check.js';
import { startManagedOxigraph } from './oxigraph-managed.js';
import type { OxigraphServerHandle } from './oxigraph-server.js';
import { resetNatStatus, startNatStatusWatcher } from './nat-status.js';
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
} from './openclaw.js';
import { buildChatAcl } from './chat-acl.js';
import { recordAssertionActivity, localNodeInvolvedInContextGraph } from './activity-notification.js';
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
} from './local-agents.js';

import { handleRequest } from './handle-request.js';
import { loadRoutePlugins, countConfiguredPluginSpecs } from './plugin-loader.js';
import type { MemoryGraphChangedEvent, MemoryGraphLayer } from './routes/context.js';
import {
  createPromoteWorkerSupervisor,
  type PromoteWorkerConfig,
  type PromoteWorkerSupervisor,
} from './worker/async-promote-worker.js';

type MultiaddrLike = { toString: () => string };

function stringifyMultiaddrList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((ma) => {
      try {
        return (ma as MultiaddrLike).toString();
      } catch {
        return '';
      }
    })
    .filter((addr) => addr.length > 0);
}

function listenerMultiaddrs(listener: unknown): string[] {
  const candidate = listener as {
    getAddrs?: () => unknown;
    getMultiaddrs?: () => unknown;
    addrs?: unknown;
    multiaddrs?: unknown;
  };
  if (typeof candidate?.getAddrs === 'function') {
    const addrs = stringifyMultiaddrList(candidate.getAddrs());
    if (addrs.length > 0) return addrs;
  }
  if (typeof candidate?.getMultiaddrs === 'function') {
    const addrs = stringifyMultiaddrList(candidate.getMultiaddrs());
    if (addrs.length > 0) return addrs;
  }
  const addrs = stringifyMultiaddrList(candidate?.addrs);
  if (addrs.length > 0) return addrs;
  return stringifyMultiaddrList(candidate?.multiaddrs);
}

function getBoundListenMultiaddrs(libp2p: unknown): string[] | null {
  const node = libp2p as {
    components?: { transportManager?: unknown };
    services?: { transportManager?: unknown };
    transportManager?: unknown;
    getMultiaddrs?: () => unknown;
  };
  const managers = [
    node.components?.transportManager,
    node.services?.transportManager,
    node.transportManager,
  ];
  for (const manager of managers) {
    const getListeners = (manager as { getListeners?: () => unknown } | undefined)?.getListeners;
    if (typeof getListeners !== 'function') continue;
    const listeners = getListeners.call(manager);
    if (!Array.isArray(listeners)) continue;
    const addrs = listeners.flatMap((listener) => listenerMultiaddrs(listener));
    if (addrs.length > 0) return Array.from(new Set(addrs));
  }

  // If this libp2p shape does not expose transport listeners, prefer an
  // indeterminate result over treating advertised self-addresses as bound
  // listener evidence.
  return null;
}

/**
 * Resolve the WM agentAddress the daemon hands to `ChatMemoryManager`.
 *
 * `agent.assertion.write` (the path chat-turn persistence rides on)
 * internally resolves the assertion graph URI from
 * `defaultAgentAddress ?? peerId` — see
 * `packages/agent/src/dkg-agent.ts::get assertion()`. The memory manager
 * must read under the SAME address writes land on, or the two sides
 * resolve to structurally different `contextGraphAssertionUri(...)`
 * graphs and `/api/memory/sessions` silently returns `[]` (issue #277).
 *
 * Extracted as a pure function so the daemon-wiring contract is
 * unit-testable without booting a real `DKGAgent` (Hardhat / libp2p).
 * Changes to this resolver MUST stay in lockstep with the agent-side
 * resolution in `get assertion()`.
 */
export function resolveMemoryAgentAddress(agent: {
  getDefaultAgentAddress(): string | undefined;
  peerId: string;
}): string {
  return agent.getDefaultAgentAddress() ?? agent.peerId;
}

/**
 * rc.9 PR-7 — operator-preferred-relay merge helper.
 *
 * Computes the effective `relayPeers` list for daemon startup by
 * prepending operator-supplied multiaddrs (CLI flag + config field)
 * onto the network/explicit relay set, while preserving the public
 * relays as fallback. Exported as a pure function so the merge
 * contract is unit-testable without booting the full daemon.
 *
 * Source precedence (declaration order, then dedupe first-seen):
 *   1. `envValue` — comma-separated string from `DKG_RELAY_PREFERRED`
 *      env var. Set by `dkg start --relay-preferred <ma>`.
 *   2. `configPreferred` — array from `~/.dkg/config.json`
 *      `preferredRelays` field.
 *   3. `networkAndConfigRelays` — whatever `config.relay` /
 *      `network.relays` produced upstream.
 *
 * Returned `relayPeers` is the de-duplicated concatenation, with
 * operator-supplied multiaddrs ALWAYS appearing before public
 * relays. Counts (`envCount`, `configCount`, `preferredCount`) are
 * reported back for the operator-visible startup log line.
 */
/**
 * PR3 / RC11 — known-public JSON-RPC hostnames that emit a startup
 * WARN when the daemon inherits them from `network/<env>.json#chain.rpcUrl`
 * without an explicit operator override. The list is intentionally
 * conservative: only well-known free public endpoints make the cut, so
 * a private RPC behind a load balancer never trips it. Match against
 * the parsed URL's hostname (lowercased) so a private proxy URL that
 * happens to embed a public hostname in its PATH (e.g.
 * `https://rpc.my-company.example/proxy?url=https://sepolia.base.org/`)
 * is never misclassified as public. The trigger is purely
 * informational — it does NOT block startup, it only gives the
 * operator a single prominent log line so the dzudza failure mode
 * (silent RPC rate-limit during ACK pre-flight) becomes self-diagnostic.
 *
 * If the list grows out of sync with reality the cost is a noisy
 * WARN for a private RPC whose hostname is literally one of the entries
 * (over-warn) or a quiet false-negative on a new public endpoint
 * (under-warn). Both are recoverable by editing this list — and an
 * operator who reads the WARN can always suppress it by setting
 * `chain.rpcUrl` in their config.json. The default behaviour stays
 * correct either way.
 */
const KNOWN_PUBLIC_RPC_HOSTS = [
  'sepolia.base.org',
  'mainnet.base.org',
  'rpc.sepolia.org',
  'ethereum-sepolia.publicnode.com',
  'rpc.ankr.com',
  'eth-sepolia.public.blastapi.io',
  'sepolia.gateway.tenderly.co',
];

export function isLikelyPublicRpc(url: string): boolean {
  // PR3 (review fix #2): parse the URL and match against `hostname`
  // only. The previous implementation did a `lower.includes(host)`
  // against the full URL string, which would flag a private proxy
  // URL like `https://rpc.my-company.example/upstream/sepolia.base.org`
  // as public — the host substring appears in the PATH, not the host.
  //
  // Endpoint suffix match (`===` OR `.endsWith('.' + host)`) is the
  // standard way to match a hostname against a known list while still
  // matching well-known subdomains (e.g. `eu.rpc.ankr.com` for
  // `rpc.ankr.com`). Falls back to the old substring scan if the URL
  // is unparseable (e.g. a bare host without a scheme), so the
  // diagnostic surface stays the same for malformed inputs an operator
  // might still want flagged.
  let hostname: string | undefined;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    hostname = undefined;
  }
  if (hostname !== undefined) {
    return KNOWN_PUBLIC_RPC_HOSTS.some(
      (host) => hostname === host || hostname!.endsWith(`.${host}`),
    );
  }
  const lower = url.toLowerCase();
  return KNOWN_PUBLIC_RPC_HOSTS.some((host) => lower.includes(host));
}

export function mergePreferredRelays(input: {
  envValue: string | undefined;
  configPreferred: unknown;
  networkAndConfigRelays: readonly string[] | undefined;
}): {
  relayPeers: string[];
  envCount: number;
  configCount: number;
  preferredCount: number;
} {
  const envParsed = (input.envValue ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const rawConfigPreferred = Array.isArray(input.configPreferred) ? input.configPreferred : [];
  const configParsed = rawConfigPreferred.filter(
    (s): s is string => typeof s === 'string' && s.trim().length > 0,
  ).map((s) => s.trim());

  const preferred = [...envParsed, ...configParsed];
  const baseline = [...(input.networkAndConfigRelays ?? [])];
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const ma of [...preferred, ...baseline]) {
    if (seen.has(ma)) continue;
    seen.add(ma);
    merged.push(ma);
  }

  // Recompute the count of preferred multiaddrs that actually ended
  // up in the result (some may be duplicated within the preferred
  // list itself — first wins). This is what the log line wants.
  const preferredInResult = merged.filter((ma) => preferred.includes(ma));

  return {
    relayPeers: merged,
    envCount: envParsed.length,
    configCount: configParsed.length,
    preferredCount: preferredInResult.length,
  };
}

export function shouldUseIncrementalChainDiscoveryScan(input: {
  run: number;
  watermarkSeeded: boolean;
  fullScanEvery: number;
}): boolean {
  return (
    input.watermarkSeeded &&
    input.run !== 0 &&
    input.run % input.fullScanEvery !== 0
  );
}

export function chainDiscoveryScanOptions(incremental: boolean):
  | { incremental: true }
  | { seedIncrementalWatermark: true; throwOnChainScanFailure: true } {
  return incremental
    ? { incremental: true }
    : { seedIncrementalWatermark: true, throwOnChainScanFailure: true };
}

export interface PromoteWorkerDaemonLifecycle {
  waitForStartup(): Promise<void>;
  stop(reason?: string | null): Promise<void>;
  getSupervisor(): PromoteWorkerSupervisor | null;
}

export function startPromoteWorkerDaemonLifecycle(input: {
  agent: PromoteWorkerConfig['agent'];
  log: (msg: string) => void;
  emitMemoryGraphChanged: (event: MemoryGraphChangedEvent) => void;
  enabled?: boolean;
  isShuttingDown?: () => boolean;
  workerConfig?: Omit<PromoteWorkerConfig, 'agent' | 'log' | 'emitMemoryGraphChanged'>;
}): PromoteWorkerDaemonLifecycle {
  let promoteWorkerSupervisor: PromoteWorkerSupervisor | null = null;
  let promoteWorkerStartup: Promise<void> | null = null;
  let promoteWorkerTimer: ReturnType<typeof setTimeout> | null = null;

  if (input.enabled === false) {
    daemonState.promoteWorkerAvailable = false;
    daemonState.promoteWorkerUnavailableReason = 'disabled via config.promoteQueue.enabled=false';
    input.log("Async promote worker disabled via config.promoteQueue.enabled=false");
    return {
      waitForStartup: async () => {},
      stop: async (reason: string | null = 'disabled via config.promoteQueue.enabled=false') => {
        daemonState.promoteWorkerAvailable = false;
        daemonState.promoteWorkerUnavailableReason = reason;
      },
      getSupervisor: () => null,
    };
  }

  promoteWorkerTimer = setTimeout(() => {
    promoteWorkerTimer = null;
    void (async () => {
      if (input.isShuttingDown?.()) return;
      // Async-promote queue worker (PR #3) — drains the queue introduced
      // in PR #1 + #2. It is intentionally independent from async-publisher
      // bootstrap: `/promote-async` jobs only need the agent assertion API,
      // and should not sit queued forever if publisher wallet/chain recovery
      // hangs.
      const supervisor = createPromoteWorkerSupervisor({
        ...input.workerConfig,
        agent: input.agent,
        log: (msg) => input.log(`[promote-worker] ${msg}`),
        emitMemoryGraphChanged: input.emitMemoryGraphChanged,
      });
      promoteWorkerSupervisor = supervisor;
      let startup!: Promise<void>;
      startup = (async () => {
        try {
          await supervisor.start();
          if (!input.isShuttingDown?.() && promoteWorkerSupervisor === supervisor) {
            daemonState.promoteWorkerAvailable = true;
            daemonState.promoteWorkerUnavailableReason = null;
            input.log("[async-promote-worker] supervisor started; /promote-async accepting jobs");
          }
        } catch (err: any) {
          // Codex PR #665 review (id=3300423547): a single startup
          // failure here used to leave the queue silently dead. The
          // route layer now gates `/promote-async` on
          // `promoteWorkerAvailable`, so enqueue / list / status all
          // 503 until something explicitly restarts the supervisor.
          // The structured `[async-promote-worker]` tag makes the
          // failure trivially greppable in operator logs alongside
          // the daemon's other startup banners.
          const message = err?.message ?? String(err);
          daemonState.promoteWorkerAvailable = false;
          daemonState.promoteWorkerUnavailableReason = message;
          if (!input.isShuttingDown?.()) {
            input.log(
              `[async-promote-worker] startup failed; queue is read-only until daemon restart: ${message}`,
            );
          }
          if (promoteWorkerSupervisor === supervisor) {
            promoteWorkerSupervisor = null;
          }
        } finally {
          if (promoteWorkerStartup === startup) {
            promoteWorkerStartup = null;
          }
        }
      })();
      promoteWorkerStartup = startup;
      await startup;
    })();
  }, 0);
  if (promoteWorkerTimer.unref) promoteWorkerTimer.unref();

  async function waitForStartup(): Promise<void> {
    if (promoteWorkerTimer) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    await promoteWorkerStartup;
  }

  async function stop(reason: string | null = null): Promise<void> {
    if (promoteWorkerTimer) {
      clearTimeout(promoteWorkerTimer);
      promoteWorkerTimer = null;
    }
    daemonState.promoteWorkerAvailable = false;
    daemonState.promoteWorkerUnavailableReason = reason;
    await promoteWorkerSupervisor
      ?.stop()
      .catch((err: any) =>
        input.log(`Promote worker stop error: ${err?.message ?? String(err)}`),
      );
    await promoteWorkerStartup
      ?.catch((err: any) =>
        input.log(`Promote worker startup wait error: ${err?.message ?? String(err)}`),
      );
  }

  return {
    waitForStartup,
    stop,
    getSupervisor: () => promoteWorkerSupervisor,
  };
}

type StartupGenesisValidation =
  | { ok: true; networkId: string }
  | { ok: false; networkId: string; messages: string[] };

type StartupGenesisValidationInput = Partial<Pick<NetworkConfig, '_status' | 'genesisId' | 'networkId' | 'networkName' | 'relays'>>;

type KnowledgeAssetVmPublishExecutor = NonNullable<AsyncLiftPublisherConfig['knowledgeAssetVmPublishExecutor']>;
type KnowledgeAssetVmPublishPreflight = NonNullable<AsyncLiftPublisherConfig['knowledgeAssetVmPublishPreflight']>;
type QueuedKnowledgeAssetVmPublishOptions = Parameters<DKGAgent['publishQueuedKnowledgeAssetVmPublish']>[2];

export function createKnowledgeAssetVmPublishExecutor(agent: DKGAgent): KnowledgeAssetVmPublishExecutor {
  return async ({ request, publishOptions, publisher }: AsyncKnowledgeAssetVmPublishExecutionInput) => {
    const publishOpts: QueuedKnowledgeAssetVmPublishOptions = {
      ...(publisher ? { publisherOverride: publisher } : {}),
    };
    try {
      return await agent.publishQueuedKnowledgeAssetVmPublish(
        request,
        publishOptions,
        publishOpts,
      );
    } catch (firstErr: any) {
      if (
        firstErr?.code !== "CG_NOT_REGISTERED" &&
        !/not registered on-chain/i.test(firstErr?.message ?? String(firstErr))
      ) {
        throw firstErr;
      }
      const defaultAgentAddress = request.agentAddress ?? agent.getDefaultAgentAddress();
      await agent.ensureRegisteredForPublish(request.contextGraphId, {
        ...(defaultAgentAddress ? { callerAgentAddress: defaultAgentAddress } : {}),
      });
      return await agent.publishQueuedKnowledgeAssetVmPublish(
        request,
        publishOptions,
        publishOpts,
      );
    }
  };
}

export function createKnowledgeAssetVmPublishPreflight(agent: DKGAgent): KnowledgeAssetVmPublishPreflight {
  return async ({ request, publisher }) =>
    agent.preflightQueuedKnowledgeAssetVmPublishExecution(
      request,
      publisher ? { publisherOverride: publisher } : undefined,
    );
}

export async function validateStartupGenesis(
  network: StartupGenesisValidationInput | null | undefined,
): Promise<StartupGenesisValidation> {
  const networkId = await computeNetworkId(network?.genesisId);
  const readiness = validateNetworkConfigReadiness(network);
  const messages = readiness.ok ? [] : [...readiness.messages];
  if (network?.networkId && network.networkId !== networkId) {
    messages.push(
      `FATAL: genesis mismatch! Expected networkId ${network.networkId.slice(0, 16)}... but computed ${networkId.slice(0, 16)}...`,
    );
    messages.push(
      `This node's genesis does not match ${network.networkName}. Rebuild or update the selected network config.`,
    );
  }
  if (messages.length > 0) return { ok: false, networkId, messages };
  return { ok: true, networkId };
}

export async function runDaemon(foreground: boolean): Promise<void> {
  await ensureDkgDir();
  const config = await loadConfig();
  const startedAt = Date.now();

  // Write PID early so the CLI detects the process is alive while
  // initialization (sync, on-chain identity, profile publish) proceeds.
  // Wrapped in try/finally so the PID file is cleaned up if boot fails.
  await writePid(process.pid);
  try {
    await runDaemonInner(foreground, config, startedAt);
  } catch (err) {
    await removePid().catch(() => {});
    throw err;
  }
}

export async function resolveDaemonPublishEncryption(
  agent: DKGAgent,
  publishOptions: {
    contextGraphId: string;
    subGraphName?: string;
    publishContextGraphId?: string;
  },
): Promise<{
  encryptInlinePayload: Awaited<ReturnType<DKGAgent['_resolveEncryptInlinePayload']>>;
  encryptInlineChunked: Awaited<ReturnType<DKGAgent['_resolveEncryptInlineChunked']>>;
}> {
  const requestedTarget = publishOptions.publishContextGraphId?.trim();
  // Async lift resolves this from the source workspace slice before it reaches
  // generic PublishOptions. Treat it as binding-only; future explicit async
  // remaps need a separate provenance field.
  const bindingOptions = requestedTarget
    ? { aeadBindingContextGraphId: requestedTarget }
    : undefined;
  const encryptInlinePayload = await agent._resolveEncryptInlinePayload(
    publishOptions.contextGraphId,
    publishOptions.subGraphName,
    undefined,
    undefined,
    bindingOptions,
  );
  const encryptInlineChunked = await agent._resolveEncryptInlineChunked(
    publishOptions.contextGraphId,
    publishOptions.subGraphName,
    undefined,
    undefined,
    bindingOptions,
  );
  return {
    encryptInlinePayload,
    encryptInlineChunked,
  };
}

export async function runDaemonInner(
  foreground: boolean,
  config: Awaited<ReturnType<typeof loadConfig>>,
  startedAt: number,
): Promise<void> {
  const logFile = logPath();

  // Tee all stdout/stderr (including structured Logger output) into the log file
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    appendFile(
      logFile,
      typeof chunk === "string" ? chunk : chunk.toString(),
    ).catch(() => {});
    return origStdoutWrite(chunk, ...args);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: any, ...args: any[]) => {
    appendFile(
      logFile,
      typeof chunk === "string" ? chunk : chunk.toString(),
    ).catch(() => {});
    return origStderrWrite(chunk, ...args);
  }) as typeof process.stderr.write;

  function log(msg: string) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    if (foreground) origStdoutWrite(line + "\n");
    appendFile(logFile, line + "\n").catch(() => {});
  }

  process.on("uncaughtException", (err) => {
    const msg = err?.message ?? String(err);
    if (
      msg.includes("Cannot write to a stream that is") ||
      msg.includes("StreamStateError")
    ) {
      log(`[warn] Suppressed GossipSub stream error: ${msg}`);
      return;
    }
    log(`[fatal] Uncaught exception: ${err?.stack ?? msg}`);
    removePid()
      .catch(() => {})
      .finally(() => process.exit(1));
  });

  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (
      msg.includes("Cannot write to a stream that is") ||
      msg.includes("StreamStateError")
    ) {
      log(`[warn] Suppressed GossipSub stream rejection: ${msg}`);
      return;
    }
    log(
      `[warn] Unhandled rejection: ${reason instanceof Error ? reason.stack : msg}`,
    );
  });

  const role = config.nodeRole ?? "edge";

  const banner = `
██████╗ ███████╗ ██████╗███████╗███╗   ██╗████████╗██████╗  █████╗ ██╗     ██╗███████╗███████╗██████╗
██╔══██╗██╔════╝██╔════╝██╔════╝████╗  ██║╚══██╔══╝██╔══██╗██╔══██╗██║     ██║╚══███╔╝██╔════╝██╔══██╗
██║  ██║█████╗  ██║     █████╗  ██╔██╗ ██║   ██║   ██████╔╝███████║██║     ██║  ███╔╝ █████╗  ██║  ██║
██║  ██║██╔══╝  ██║     ██╔══╝  ██║╚██╗██║   ██║   ██╔══██╗██╔══██║██║     ██║ ███╔╝  ██╔══╝  ██║  ██║
██████╔╝███████╗╚██████╗███████╗██║ ╚████║   ██║   ██║  ██║██║  ██║███████╗██║███████╗███████╗██████╔╝
╚═════╝ ╚══════╝ ╚═════╝╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝╚══════╝╚══════╝╚═════╝

██╗  ██╗███╗   ██╗ ██████╗ ██╗    ██╗██╗     ███████╗██████╗  ██████╗ ███████╗
██║ ██╔╝████╗  ██║██╔═══██╗██║    ██║██║     ██╔════╝██╔══██╗██╔════╝ ██╔════╝
█████╔╝ ██╔██╗ ██║██║   ██║██║ █╗ ██║██║     █████╗  ██║  ██║██║  ███╗█████╗
██╔═██╗ ██║╚██╗██║██║   ██║██║███╗██║██║     ██╔══╝  ██║  ██║██║   ██║██╔══╝
██║  ██╗██║ ╚████║╚██████╔╝╚███╔███╔╝███████╗███████╗██████╔╝╚██████╔╝███████╗
╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝  ╚══╝╚══╝ ╚══════╝╚══════╝╚═════╝  ╚═════╝ ╚══════╝

 ██████╗ ██████╗  █████╗ ██████╗ ██╗  ██╗              ██████╗ ██╗  ██╗ ██████╗     ██╗   ██╗ ██╗ ██████╗
██╔════╝ ██╔══██╗██╔══██╗██╔══██╗██║  ██║              ██╔══██╗██║ ██╔╝██╔════╝     ██║   ██║███║██╔═████╗
██║  ███╗██████╔╝███████║██████╔╝███████║    █████╗    ██║  ██║█████╔╝ ██║  ███╗    ██║   ██║╚██║██║██╔██║
██║   ██║██╔══██╗██╔══██║██╔═══╝ ██╔══██║    ╚════╝    ██║  ██║██╔═██╗ ██║   ██║    ╚██╗ ██╔╝ ██║████╔╝██║
╚██████╔╝██║  ██║██║  ██║██║     ██║  ██║              ██████╔╝██║  ██╗╚██████╔╝     ╚████╔╝  ██║╚██████╔╝
 ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝              ╚═════╝ ╚═╝  ╚═╝ ╚═════╝       ╚═══╝   ╚═╝ ╚═════╝
`;
  origStdoutWrite(banner + "\n");
  appendFile(logFile, banner + "\n").catch(() => {});

  const nodeVersion = getNodeVersion();
  const nodeCommit = getCurrentCommitShort(); // cached once at startup — avoids execSync in hot path
  const versionTag = nodeCommit
    ? `v${nodeVersion}, ${nodeCommit}`
    : `v${nodeVersion}`;
  log(`Starting DKG ${role} node "${config.name}" (${versionTag})...`);

  // RFC-41 §4.9 / §4.3: structured startup log lines for telemetry.
  // The doctor's state summary correlates these with /api/status —
  // every successful daemon start emits a parseable JSON line that
  // an operator or CI pipeline can grep without needing the API up.
  // Distinct tags (`dkg-build-info` + `install-mode-detected`) so a
  // log shipper can split them into separate streams.
  try {
    const buildInfo = loadBuildInfo();
    const installMode = detectInstallMode();
    log(
      `[dkg-build-info] ${JSON.stringify({
        version: nodeVersion,
        commit: buildInfo.commit,
        commitShort: buildInfo.commitShort,
        buildTime: buildInfo.buildTime,
        distTag: buildInfo.distTag,
        ciRun: buildInfo.ciRun,
      })}`,
    );
    log(
      `[install-mode-detected] ${JSON.stringify({
        installMode,
        nodeRole: role,
      })}`,
    );
  } catch (err) {
    // Never fail startup on a telemetry-log failure.
    log(`[dkg-build-info] WARNING: failed to emit startup telemetry: ${String(err)}`);
  }

  const selectedNetworkConfig = config.networkConfig?.trim();
  const network = await loadNetworkConfig(selectedNetworkConfig);
  if (selectedNetworkConfig && !network) {
    log(`FATAL: network config "${selectedNetworkConfig}" was not found (expected network/${selectedNetworkConfig}.json).`);
    process.exit(1);
  }
  const genesisValidation = await validateStartupGenesis(network);
  const networkId = genesisValidation.networkId;
  if (!genesisValidation.ok) {
    for (const message of genesisValidation.messages) log(message);
    process.exit(1);
  }
  const syncContextGraphs = [
    ...new Set([
      ...resolveContextGraphs(config),
      ...resolveNetworkDefaultContextGraphs(network),
    ]),
  ];

  // Auto-wipe per-node chain-state derived files (oxigraph store, publish
  // journal, random-sampling WAL) when the maintainer bumps
  // network/<env>.json#chainResetMarker. This makes future testnet resets
  // zero-touch for operators: the maintainer bumps the marker in the
  // reset commit, daemon auto-update brings it within ≤ 5 min, this hook
  // detects the change and wipes the now-orphaned chain state.
  // Operator's keystore + dashboard DB + uploaded files are preserved.
  // See docs/TESTNET_RESET.md and packages/cli/src/daemon/chain-reset-wipe.ts.
  // Detect backend switch first. If the operator hand-edited
  // store.backend between boots, refuse to start unless they opt in
  // via DKG_ACCEPT_STORE_RESET=1. The new backend is fresh — any data
  // held in the previous one is invisible to this boot. Booting
  // silently would look like data loss to the operator.
  const backendSwitch = detectBackendSwitch({
    dataDir: dkgDir(),
    currentBackend: config.store?.backend ?? 'oxigraph-worker',
    acceptStoreReset: process.env.DKG_ACCEPT_STORE_RESET === '1',
    log,
  });
  if (backendSwitch.aborted) {
    process.exit(1);
  }

  // Detect a network switch (config.networkConfig repointed at a different
  // network on an existing data dir). The store still holds the previous
  // network's chain-derived state, which is meaningless on the new chain —
  // and chainResetWipe won't catch it (mainnet overlays ship no
  // chainResetMarker). Abort unless DKG_ACCEPT_NETWORK_SWITCH=1. Compare the
  // RESOLVED name so a legacy config (no networkConfig) is treated as its
  // 'testnet' fallback and never spuriously trips on a normal restart.
  const networkSwitch = detectNetworkSwitch({
    dataDir: dkgDir(),
    currentNetworkConfig: resolveNetworkConfigName(config),
    acceptNetworkSwitch: process.env.DKG_ACCEPT_NETWORK_SWITCH === '1',
    log,
  });
  if (networkSwitch.aborted) {
    process.exit(1);
  }

  // Managed local Oxigraph server (`store.backend: 'oxigraph-server'`,
  // Release 2 opt-in). Fetch/verify the pinned binary, spawn a loopback
  // `oxigraph serve` child, and expose a runtime `sparql-http` view (without
  // mutating persisted `config.store`) so every downstream step
  // (config validation, health check, identity tag, chain-reset wipe,
  // the adapter) reuses the existing external-backend path unchanged.
  // Runs AFTER detectBackendSwitch (which persisted the raw
  // 'oxigraph-server' value) and BEFORE exitOnStoreConfigErrors so the
  // normalised config is what gets validated and probed.
  let managedOxigraph: OxigraphServerHandle | null = null;
  let managed: Awaited<ReturnType<typeof startManagedOxigraph>> = null;
  try {
    managed = await startManagedOxigraph({ config, dataDir: dkgDir(), log });
    if (managed) {
      managedOxigraph = managed.handle;
      // Every remaining fatal boot path (config validation, store health
      // check, identity mismatch, later failures) calls process.exit(),
      // which bypasses the graceful shutdown hook. Register a synchronous
      // best-effort kill so none of them orphan the spawned server.
      process.once('exit', () => managedOxigraph?.killSync());
      log(`Managed Oxigraph server backing store: ${managed.handle.queryEndpoint}`);
    }
  } catch (err) {
    log(
      `[STORE] failed to start managed Oxigraph server: ${(err as Error).message}\n` +
        `Fix the cause, or switch \`store.backend\` to oxigraph-worker (embedded) or ` +
        `sparql-http (operator-managed endpoint) in ~/.dkg/config.json.`,
    );
    process.exit(1);
  }

  // Runtime store view for the managed Oxigraph server. We deliberately do
  // NOT mutate `config.store` to the loopback `sparql-http` shape: `config`
  // is the persisted/operator-facing object, and every later
  // `saveConfig(config)` would otherwise write the ephemeral loopback
  // endpoints to disk (breaking the next boot, which would no longer spawn
  // the managed server) and `/api/status` would report `sparql-http` instead
  // of the configured `oxigraph-server`. Instead the boot steps that talk to
  // the live store (validation, reachability, identity, chain-reset wipe, the
  // agent) read these runtime values, while `config` keeps `oxigraph-server`.
  // For the directory-backed blob/snapshot stores we use the managed
  // defaults (the rewritten sparql-http backend has no `options.path` to
  // infer a directory from, unlike the local Oxigraph backend).
  const runtimeStore = managed?.storeConfig ?? config.store;
  const runtimeLargeLiteralStorage =
    managed?.largeLiteralStorage ?? config.largeLiteralStorage;
  const runtimeSnapshotStorage =
    managed?.sharedMemoryPublicSnapshotStorage ?? config.sharedMemoryPublicSnapshotStorage;
  // Config view used only for the boot-time store validation/health steps
  // below: same as `config` but with the runtime store/blob/snapshot values
  // swapped in, so a managed config validates against what actually runs.
  const runtimeStoreConfig: DkgConfig = managed
    ? {
        ...config,
        store: runtimeStore,
        largeLiteralStorage: runtimeLargeLiteralStorage,
        sharedMemoryPublicSnapshotStorage: runtimeSnapshotStorage,
      }
    : config;

  // Refuse to start on invalid external-backend config (missing URL,
  // missing blob/snapshot directory). This fires before the health
  // check so operators see a single-line config error, not a confusing
  // probe failure when the URL is just plain absent.
  exitOnStoreConfigErrors(runtimeStoreConfig, log);

  // External triple-store backends (Blazegraph, sparql-http) get a
  // boot-time reachability probe before anything that depends on them
  // runs. We want operators who misconfigure the URL to see an
  // actionable error within seconds — not a confusing failure deep in
  // agent boot after we've already partially wiped local state.
  //
  // Sequencing: this fires BEFORE chainResetWipe so a marker bump
  // against an unreachable endpoint doesn't strand the operator with
  // wiped local files but stale remote data; we'd rather not start at
  // all and let them fix the URL.
  if (isExternalBackend(runtimeStore?.backend)) {
    const health = await checkExternalStoreReachable({
      storeConfig: runtimeStore,
    });
    if (!health.ok) {
      log(formatHealthCheckFailure(health));
      process.exit(1);
    }
    log(
      `External triple-store reachable: ${health.backend} ${health.endpoint}`,
    );

    // Namespace identity check (RFC 120, plan PR 3 item 3). Refuses to
    // start if another DKG node has already booted against this same
    // namespace — without this, two daemons sharing one Blazegraph
    // namespace silently corrupt each other. Fires BEFORE
    // chainResetWipe so a mismatched tag never triggers a wipe of
    // someone else's data.
    const identity = await checkOrSetStoreIdentity({
      storeConfig: runtimeStore,
      nodeName: config.name,
    });
    if (!identity.ok) {
      if (identity.action === 'mismatch') {
        log(formatIdentityTagMismatch(identity));
      } else {
        log(`[STORE-IDENTITY] failed to verify namespace ownership: ${identity.error}`);
      }
      process.exit(1);
    }
    if (identity.action === 'tagged') {
      log(`Tagged triple-store namespace for node "${identity.nodeName}".`);
    }
  }

  const wipeResult = await chainResetWipe({
    dataDir: dkgDir(),
    currentMarker: network?.chainResetMarker,
    // Honour operator's `randomSampling.walPath` override; the prover
    // writes its WAL there, so a fresh chain reset must wipe that file
    // (not the default ~/.dkg/random-sampling.wal which would be empty).
    randomSamplingWalPath: config.randomSampling?.walPath,
    // For external triple-store backends, the wipe extends from local
    // files to a SPARQL DROP/DELETE on the remote endpoint; otherwise
    // operators with a chain-reset marker bump would keep stale V10 data
    // in Blazegraph / sparql-http even after the local store.nq is gone.
    storeConfig: runtimeStore,
    log,
  });
  if (wipeResult.wiped) {
    log(
      `Chain-state auto-wipe complete: ${wipeResult.removedFiles.length} file(s) removed ` +
      `(prev marker: ${wipeResult.prevMarker ?? '<none>'}, now: ${network?.chainResetMarker})`,
    );
    // A DKG-managed external wipe uses DROP ALL, which also removes the
    // namespace ownership tag verified above. Re-tag before continuing so
    // this daemon never runs against an unclaimed namespace.
    if (isExternalBackend(runtimeStore?.backend)) {
      const identity = await checkOrSetStoreIdentity({
        storeConfig: runtimeStore,
        nodeName: config.name,
      });
      if (!identity.ok) {
        if (identity.action === 'mismatch') {
          log(formatIdentityTagMismatch(identity));
        } else {
          log(`[STORE-IDENTITY] failed to re-tag namespace after wipe: ${identity.error}`);
        }
        process.exit(1);
      }
      if (identity.action === 'tagged') {
        log(`Re-tagged triple-store namespace for node "${identity.nodeName}" after chain-state wipe.`);
      }
    }
  }

  // Load admin + operational wallets from ~/.dkg/wallets.json (auto-generated on first run)
  const opWallets = await loadOpWallets(dkgDir());
  log(`Admin wallet:`);
  if (opWallets.adminWallet) {
    log(`  ${opWallets.adminWallet.address}`);
  } else {
    log(`  (missing from legacy wallets.json; auto-registration requires adding the profile admin key)`);
  }
  log(`Operational wallets (${opWallets.wallets.length}):`);
  for (const w of opWallets.wallets) {
    log(`  ${w.address}`);
  }

  // Field-level merge of CLI config + network/<env>.json#chain.
  // Operators can override individual fields (e.g. just rpcUrl) without
  // restating the rest; missing fields fall back to the network defaults.
  const chainBase = resolveChainConfig(config, network);

  // PR3 / RC11 — operator-visible WARN when the node is going to talk
  // to the chain through a known-public, rate-limited JSON-RPC
  // endpoint that it inherited from the network defaults. The dzudza
  // failure (Sun 20:42 UTC) traced to a `-32016 over rate limit`
  // error on the public Base Sepolia RPC during the V10 ACK
  // pre-flight; without an explicit `chain.rpcUrl` override the
  // operator never noticed they were sharing a budget with the rest
  // of the internet. A startup WARN gives them a single, prominent
  // line in the daemon log instead of waiting for a publish to
  // silently fail. Skip the WARN entirely in mock mode.
  //
  // The "operator overrode it" detection is purposely structural —
  // only an explicit `config.chain.rpcUrl` entry suppresses the
  // warning; an empty `chain` block in config that inherits rpcUrl
  // from network defaults still trips the WARN. That matches the
  // intent: the operator knows about the rpcUrl iff they set it
  // themselves.
  if (chainBase?.type !== 'mock' && chainBase?.rpcUrl) {
    const operatorSetRpc = config.chain?.rpcUrl !== undefined;
    if (!operatorSetRpc && isLikelyPublicRpc(chainBase.rpcUrl)) {
      log(
        `[warn] chain.rpcUrl is using the network-default public endpoint (${chainBase.rpcUrl}). ` +
        `Publishing nodes share a global rate-limit budget on public RPCs and may see ` +
        `ACK pre-flight failures (RpcPreconditionError on eth_chainId, etc.). ` +
        `Set chain.rpcUrl in ~/.dkg/config.json to a private endpoint to avoid this.`,
      );
    }
  }

  // Relay: prefer config.relay, fall back to network testnet.json relays so
  // local nodes connect without having run init or set relay manually.
  // "none" disables relay entirely (used by devnet relay nodes to prevent
  // cross-network leakage into testnet).
  let relayPeers: string[] | undefined;
  if (config.relay === "none") {
    relayPeers = undefined;
    log(
      'Relay disabled (config.relay = "none") — this node will not connect to any relay',
    );
  } else if (config.relay) {
    relayPeers = [config.relay];
  } else if (network?.relays?.length) {
    relayPeers = network.relays;
    log(`Using relay(s) from network config (${network.networkName})`);
  }

  // rc.9 PR-7 — operator-preferred relays. See `mergePreferredRelays`
  // JSDoc for the merge semantics; this block is just the lifecycle
  // call site + the operator-visible log line.
  if (config.relay !== "none") {
    const result = mergePreferredRelays({
      envValue: process.env.DKG_RELAY_PREFERRED,
      configPreferred: config.preferredRelays,
      networkAndConfigRelays: relayPeers,
    });
    if (result.preferredCount > 0) {
      relayPeers = result.relayPeers;
      log(
        `Preferred relays (rc.9 PR-7): ${result.preferredCount} operator-supplied multiaddr(s) prepended (sources: ${result.envCount} from --relay-preferred, ${result.configCount} from config.preferredRelays). Effective relayPeers count: ${relayPeers.length}.`,
      );
    }
  }

  if (
    !relayPeers?.length &&
    !config.bootstrapPeers?.length &&
    config.relay !== "none"
  ) {
    log(
      'No relay or bootstrap peers configured. Set "relay" or "bootstrapPeers" in ~/.dkg/config.json or run from repo so network/testnet.json is found.',
    );
  }

  const mockIdentityId = chainBase?.type === 'mock' && chainBase.mockIdentityId != null
    ? BigInt(chainBase.mockIdentityId)
    : undefined;
  const mockChainAdapter = chainBase?.type === 'mock'
    ? (() => {
        const signerAddress = opWallets.wallets[0]?.address;
        const adapter = new MockChainAdapter(chainBase.chainId ?? 'mock:31337', signerAddress);
        if (signerAddress && mockIdentityId != null) {
          adapter.seedIdentity(signerAddress, mockIdentityId);
        }
        return adapter;
      })()
    : undefined;

  const dashDb = new DashboardDB({ dataDir: dkgDir() });

  if (role === 'core' && config.core?.allowDegradedRelay === false) {
    const hostInterfaces = Object.values(osModule.networkInterfaces())
      .flat()
      .filter((i): i is NetworkInterfaceInfo => i !== undefined);
    const prereq = checkCoreRelayPrereqs({
      listenAddresses: [`/ip4/0.0.0.0/tcp/${config.listenPort ?? 0}`],
      hostInterfaces,
      announceAddresses: config.announceAddresses ?? [],
      nodeRole: 'core',
    });
    if (prereq.looksDegraded) {
      log(
        `[CORE-PREREQ] FATAL before libp2p start: this Core node looks degraded as a relay. ` +
          `reasons: ${prereq.reasons.join('; ')}. ` +
          `non-routable addresses: ${prereq.nonRoutableAddresses
            .map((a) => `${a.addr} (${a.class})`)
            .join(', ')}. ` +
          `Set core.allowDegradedRelay: true to downgrade this to a warning.`,
      );
      try {
        dashDb.close();
      } catch (err: any) {
        log(`Core prereq fatal DB close error: ${err?.message ?? String(err)}`);
      }
      await removePid().catch(() => {});
      process.exit(1);
      return;
    }
  }

  // Universal Messenger substrate stores (rc.9 PR-2). Wired into the
  // DKGAgent's Messenger so any caller that opts into
  // `messenger.sendReliable` gets durable receiver-side idempotency
  // + sender-side outbox retries against the shared DashboardDB.
  // No caller exercises this path until PR-3 (chat + skill migration);
  // wiring early keeps Milestone A trivially deployable + soak-testable.
  const messengerIdempotencyStore = new SqliteMessageIdempotencyStore(dashDb);
  const messengerOutboxStore = new SqliteProtocolOutboxStore(dashDb, {
    maxAgeMs: DEFAULT_PROTOCOL_OUTBOX_MAX_AGE_MS,
    backoffFor: (attempts) => {
      const idx = Math.min(
        Math.max(attempts - 1, 0),
        DEFAULT_PROTOCOL_OUTBOX_BACKOFFS_MS.length - 1,
      );
      return DEFAULT_PROTOCOL_OUTBOX_BACKOFFS_MS[idx];
    },
  });
  const syncCheckpointStore = new SqliteSyncCheckpointStore(dashDb);

  // OT-RFC-43 Option-1 deterministic KA identity (B2 allocator core).
  // Durable per-author KA-number sequence backing the off-chain
  // `KaNumberAllocator`. Constructed here (alongside the other durable
  // substrate stores) so the V20 `ka_numbers` table is opened and its
  // sequence is co-located with the rest of the node's persistent state.
  //
  // OT-RFC-43 Option 1: the publisher allocates a deterministic packed
  // reservedKaId per V10 mint (DKGPublisher.ensureReservedKaId) and lazily
  // reconciles each author's floor against the chain's highest minted number on
  // first use (chain.getMaxKaNumberForAuthor), satisfying the RFC §4.5 cold-start
  // guard. (A blocking startup reconciliation sweep + the ongoing
  // KnowledgeAssetCreated poller→reconcile wiring remain a hardening follow-up.)
  const kaNumberStore = new SqliteKaNumberStore(dashDb);
  const kaNumberAllocator = new KaNumberAllocator(kaNumberStore);

  const agent = await DKGAgent.create({
    kaNumberAllocator,
    name: config.name,
    genesisId: network?.genesisId,
    framework: "DKG",
    listenPort: config.listenPort,
    dataDir: dkgDir(),
    bootstrapPeers: config.bootstrapPeers,
    relayPeers,
    announceAddresses: config.announceAddresses,
    nodeRole: role,
    relayServerCapacity: config.relayServerCapacity,
    relayReservationCount: config.relayReservationCount,
    // `dkg/<semver>` convention: broadcast our release on every libp2p
    // identify exchange so remote operators can answer "which DKG
    // release is each peer running?" via /api/peer-info instead of
    // having to guess from contract registrations. Travels the wire
    // as libp2p's `AgentVersion` PB field (their naming, not ours).
    nodeVersion: `dkg/${nodeVersion}`,
    ...pickNetworkTunables(config.network ?? {}),
    agentProfileHeartbeatMs: config.network?.agentProfileHeartbeatMs,
    syncContextGraphs: syncContextGraphs,
    maxRehydratedContextGraphSubscriptions: config.maxRehydratedContextGraphSubscriptions,
    // OT-RFC-38 LU-6 / OT-RFC-49 WS-A — plumb the host-mode block (eviction
    // tiers, discovery rate limits, and the `stripCiphertext` private-ciphertext
    // strip kill-switch) from config.json. Without this forward the whole
    // `swmHostMode` config is inert and only in-agent defaults apply, so an
    // operator could not toggle the strip via config (the rung-1 inert-flag bug).
    swmHostMode: config.swmHostMode,
    storeConfig: runtimeStore ? {
      backend: runtimeStore.backend,
      options: runtimeStore.options,
      graphSetIndex: runtimeStore.graphSetIndex,
    } : undefined,
    largeLiteralStorage: runtimeLargeLiteralStorage,
    sharedMemoryPublicSnapshotStorage: runtimeSnapshotStorage,
    syncSharedMemoryOnConnect: config.syncSharedMemoryOnConnect,
    swmAwaitCuratorAck: config.swmAwaitCuratorAck,
    syncAgentsMeta: role === 'core' ? true : config.syncAgentsMeta,
    queryAccess: config.queryAccess,
    chainAdapter: mockChainAdapter,
    // Only forward chain to the agent when both required fields resolved.
    // resolveChainConfig() may return a partial block if neither config nor
    // network supplies one of them; the agent expects rpcUrl + hubAddress.
    chainConfig: chainBase?.rpcUrl && chainBase?.hubAddress ? {
      rpcUrl: chainBase.rpcUrl,
      rpcUrls: chainBase.rpcUrls,
      hubAddress: chainBase.hubAddress,
      tokenAddress: chainBase.tokenAddress,
      ...(opWallets.adminWallet
        ? { adminPrivateKey: opWallets.adminWallet.privateKey }
        : {}),
      operationalKeys: opWallets.wallets.map((w) => w.privateKey),
      chainId: chainBase.chainId,
      approvalPolicy: resolveApprovalPolicy(chainBase.approvalPolicy) as ApprovalPolicy | undefined,
      cgRegistryScanPageSize: chainBase.cgRegistryScanPageSize,
    } : undefined,
    sharedMemoryTtlMs: resolveSharedMemoryTtlMs(config),
    // RFC ka-metadata-trim P3.3 — lifecycle PROV event writes (default true).
    metadataProvenanceEvents: config.metadata?.provenanceEvents,
    randomSamplingWalPath: config.randomSampling?.walPath,
    randomSamplingTickIntervalMs: config.randomSampling?.tickIntervalMs,
    randomSamplingUseWorkerThread: config.randomSampling?.useWorkerThread,
    syncCheckpointStore,
    contextGraphSubscriptionStore: {
      loadAll: async () => dashDb.listContextGraphSubscriptions().map((row) => ({
        id: row.context_graph_id,
        name: row.name ?? undefined,
        subscribed: row.subscribed === 1,
        synced: row.synced === 1,
        sharedMemorySynced: row.shared_memory_synced == null ? undefined : row.shared_memory_synced === 1,
        metaSynced: row.meta_synced == null ? undefined : row.meta_synced === 1,
        onChainId: row.on_chain_id ?? undefined,
        onChainHash: row.on_chain_hash ?? undefined,
        lastReconciledOrdinal: row.last_reconciled_ordinal ?? undefined,
        coreHosted: row.core_hosted == null ? undefined : row.core_hosted === 1,
        syncScoped: row.sync_scoped === 1,
      })),
      load: async (contextGraphId) => {
        const row = dashDb.getContextGraphSubscription(contextGraphId);
        return row ? {
          id: row.context_graph_id,
          name: row.name ?? undefined,
          subscribed: row.subscribed === 1,
          synced: row.synced === 1,
          sharedMemorySynced: row.shared_memory_synced == null ? undefined : row.shared_memory_synced === 1,
          metaSynced: row.meta_synced == null ? undefined : row.meta_synced === 1,
          onChainId: row.on_chain_id ?? undefined,
          onChainHash: row.on_chain_hash ?? undefined,
          lastReconciledOrdinal: row.last_reconciled_ordinal ?? undefined,
          coreHosted: row.core_hosted == null ? undefined : row.core_hosted === 1,
          syncScoped: row.sync_scoped === 1,
        } : null;
      },
      save: async (record) => {
        dashDb.upsertContextGraphSubscription({
          context_graph_id: record.id,
          name: record.name ?? null,
          subscribed: record.subscribed ? 1 : 0,
          synced: record.synced ? 1 : 0,
          shared_memory_synced: record.sharedMemorySynced == null ? null : record.sharedMemorySynced ? 1 : 0,
          meta_synced: record.metaSynced == null ? null : record.metaSynced ? 1 : 0,
          on_chain_id: record.onChainId ?? null,
          on_chain_hash: record.onChainHash ?? null,
          last_reconciled_ordinal: record.lastReconciledOrdinal ?? null,
          core_hosted: record.coreHosted == null ? null : record.coreHosted ? 1 : 0,
          sync_scoped: record.syncScoped ? 1 : 0,
          updated_at: Date.now(),
        });
      },
      delete: async (contextGraphId) => {
        dashDb.deleteContextGraphSubscription(contextGraphId);
      },
    },
    contextGraphMembershipStore: {
      upsert: async (record) => {
        dashDb.upsertContextGraphMember({
          context_graph_id: record.contextGraphId,
          principal_type: record.principalType,
          principal_id: record.principalId,
          role: record.role ?? null,
          status: record.status,
          source: record.source ?? null,
          display_name: record.displayName ?? null,
          metadata: record.metadata ? JSON.stringify(record.metadata) : null,
          first_seen_at: record.firstSeenAt ?? record.updatedAt,
          updated_at: record.updatedAt,
        });
      },
      delete: async (contextGraphId, principalType, principalId) => {
        dashDb.deleteContextGraphMember(contextGraphId, principalType, principalId);
      },
    },
    messengerStores: {
      idempotencyStore: messengerIdempotencyStore,
      outboxStore: messengerOutboxStore,
    },
    // Phase F — persist chain-driven VM reconciliation telemetry so the
    // /ui/observability Replication tab can aggregate it. Best-effort: a
    // failed insert must never disrupt reconciliation, and the agent already
    // guards the sink call in a try/catch.
    onReplicationEvent: (event) => {
      dashDb.insertReplicationEvent({
        ts: event.ts,
        context_graph_id: event.contextGraphId,
        on_chain_cg_id: event.onChainCgId ?? null,
        action: event.action,
        ual: event.ual ?? null,
        ordinal: event.ordinal ?? null,
        ka_id: event.kaId ?? null,
        from_watermark: event.fromWatermark ?? null,
        to_watermark: event.toWatermark ?? null,
        head: event.head ?? null,
        reconciled: event.reconciled ?? null,
        pending: event.pending ?? null,
        detail: event.detail ?? null,
      });
    },
  });

  let publisherRuntime: PublisherRuntime | null = null;
  // Holds the running async-promote worker lifecycle (PR #3 of the
  // async-promote-queue series). Initialised in `startPostApiPublishing`
  // after the API is up so a recoverOnStartup hiccup never blocks boot;
  // torn down in `shutdown` before `agent.stop()` so the queue store is
  // still open when we wait for in-flight promotes to drain.
  let promoteWorkerLifecycle: PromoteWorkerDaemonLifecycle | null = null;
  let shuttingDown = false;

  const publisherControl = createPublisherControlFromStore(
    agent.store,
    createPublicSnapshotStore(dkgDir(), config),
  );
  log(`Network: ${networkId.slice(0, 16)}...`);
  if (network) {
    log(
      `Network config: ${network.networkName} (genesis v${network.genesisVersion})`,
    );
  }

  // Inbound chat authorisation (Phase 1 of agent debug chat RFC). Layered
  // on top of the protocol-level Ed25519 signature check that messaging.ts
  // already does — this controls *which* authenticated peers we'll accept
  // chats from, configured via `chat.acl` in the node config. When unset,
  // the legacy "accept all authenticated peers" behaviour is preserved.
  agent.setChatAcl(
    buildChatAcl({
      config: config.chat?.acl,
      dashDb,
      getLocalPeerId: () => agent.peerId,
      log,
    }),
  );

  // GH #462 — skill_request authorization. Default-deny remote skill invocation
  // (any connected peer could otherwise invoke any registered skill). Operators
  // restore open skills with `messaging.openSkills: true`, or allowlist specific
  // peers via `messaging.skillAllowedPeers`.
  {
    const openSkills = config.messaging?.openSkills === true;
    const allowedSkillPeers = new Set(config.messaging?.skillAllowedPeers ?? []);
    agent.setSkillAcl((senderPeerId: string) => {
      if (openSkills) return { accept: true };
      if (allowedSkillPeers.has(senderPeerId)) return { accept: true };
      return {
        accept: false,
        reason:
          'unauthorized: skill invocation is default-deny for remote peers; ' +
          'set messaging.openSkills or add this peer to messaging.skillAllowedPeers (GH #462)',
      };
    });
  }

  let chatDb: DashboardDB | null = null;
  agent.onChat((text, senderPeerId, _convId, senderContextGraphId, verifiedContextGraphId, messageId) => {
    if (chatDb) {
      // `messageId` is forwarded from the encrypted payload (V11+
      // senders). `insertChatMessage` uses it as the dedup key
      // against the `idx_chat_msgid` partial unique index — same
      // logical message arriving twice on parallel transport paths
      // (the seq=13 class from the May 2026 soak postmortem) gets
      // silently dropped on the second insert. The outcome now governs
      // LOGGING only (ADR-001 removed the bell `chat_message` notification
      // this block used to fire — chat owns its own unread surface):
      //   - `'stored'`  — fresh row written, log normally.
      //   - `'deduped'` — `INSERT OR IGNORE` dropped a duplicate row; log a
      //                   `(deduped)` line and return (operator already saw
      //                   the first one).
      //   - `'failed'`  — `insertChatMessage` threw. We log the failure and
      //                   fall through to the normal CHAT IN log so the
      //                   inbound message is still visible to the operator
      //                   even when persistence failed (the spirit of the
      //                   Codex PR #534 fix, minus the now-removed notify).
      let writeOutcome: 'stored' | 'deduped' | 'failed' = 'failed';
      try {
        const inserted = chatDb.insertChatMessage({
          ts: Date.now(),
          direction: "in",
          peer: senderPeerId,
          text,
          messageId,
        });
        writeOutcome = inserted ? 'stored' : 'deduped';
      } catch (err) {
        log(
          `CHAT IN  [${shortId(senderPeerId)}] chat_messages persistence failed (message still logged below): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      if (writeOutcome === 'deduped') {
        const cgTag = verifiedContextGraphId ? ` cg=${shortId(verifiedContextGraphId)}` : '';
        log(`CHAT IN  [${shortId(senderPeerId)}]${cgTag} (deduped): ${text}`);
        return;
      }
      // ADR-001: inbound peer chat no longer produces a bell notification —
      // peer-to-peer chat is a separate surface that owns its own unread
      // state, and these rows aren't CG-scoped. The message itself is still
      // persisted via `insertChatMessage` above; we only drop the
      // bell-pane `chat_message` notification.
    }
    const cgTag = verifiedContextGraphId ? ` cg=${shortId(verifiedContextGraphId)}` : '';
    log(`CHAT IN  [${shortId(senderPeerId)}]${cgTag}: ${text}`);
  });

  await agent.start();

  // Core-only post-start checks (PR-5 NAT-status watcher + PR-3 relay
  // prereq sanity check). Edge nodes skip both — they don't need to be
  // publicly reachable, and reset any stale NAT-status state.
  //
  // PR-5 (#668): AutoNAT-driven boot self-probe. Subscribes to libp2p's
  // self:peer:update event and updates the module-level NAT-status
  // cache that PR-4's /api/status relay block reads. Returns a stop()
  // handle that the shutdown closure MUST call to remove the listener;
  // otherwise a respawn leaks listeners (eventually libp2p logs
  // max-listener warnings).
  //
  // PR-3 (#661): Core-relay capability sanity check. Runs post-start so
  // libp2p has already expanded `0.0.0.0` to per-interface bindings.
  // Strict `allowDegradedRelay: false` operators also get a pre-start
  // pass above so we can refuse before binding sockets. If the node
  // declares itself as a Core (`nodeRole: "core"`) but its
  // actually-bound multiaddrs can't serve inbound traffic (all
  // loopback / RFC1918 / CGNAT / IPv6 ULA — beacon-01 was the
  // canonical Tailscale-only case), surface a structured
  // `[CORE-PREREQ]` log so the operator sees it before any
  // peer-discovery noise scrolls past. Behaviour gated by
  // `config.core.allowDegradedRelay`: `true` (default) is warn-only,
  // `false` is refuse-to-boot. Uses transport listener addresses
  // (`getBoundListenMultiaddrs`) not `libp2p.getMultiaddrs()`: the
  // latter is the advertised self-address set and can include public
  // announce addrs or `/p2p-circuit` reservations.
  let natStatusWatcherStop: (() => void) | null = null;
  if (role === 'core') {
    const watcher = startNatStatusWatcher({
      node: agent.node.libp2p as unknown as {
        addEventListener(event: 'self:peer:update', h: () => void): void;
        removeEventListener(event: 'self:peer:update', h: () => void): void;
        getMultiaddrs(): Array<{ toString(): string }>;
      },
      onClassification: (status, previous) => {
        log(`[CORE-PREREQ] AutoNAT status transition: ${previous} → ${status}`);
      },
    });
    natStatusWatcherStop = watcher.stop;

    try {
      const resolvedMultiaddrs = getBoundListenMultiaddrs(agent.node.libp2p);
      if (resolvedMultiaddrs === null) {
        log(
          `[CORE-PREREQ] WARNING: could not inspect bound libp2p listener addresses; ` +
            `skipping post-start relay prerequisite verdict.`,
        );
      } else {
        const hostInterfaces = Object.values(osModule.networkInterfaces())
          .flat()
          .filter((i): i is NetworkInterfaceInfo => i !== undefined);
        const prereq = checkCoreRelayPrereqs({
          listenAddresses: resolvedMultiaddrs,
          hostInterfaces,
          announceAddresses: config.announceAddresses ?? [],
          nodeRole: 'core',
        });
        if (prereq.looksDegraded) {
          const allowDegraded = config.core?.allowDegradedRelay !== false;
          const verb = allowDegraded ? 'WARNING' : 'FATAL';
          log(
            `[CORE-PREREQ] ${verb}: this Core node looks degraded as a relay. ` +
              `reasons: ${prereq.reasons.join('; ')}. ` +
              `non-routable addresses: ${prereq.nonRoutableAddresses
                .map((a) => `${a.addr} (${a.class})`)
                .join(', ')}. ` +
              (allowDegraded
                ? `Set core.allowDegradedRelay: false in ~/.dkg/config.json to refuse-to-boot on this state. ` +
                  `See docs/specs/SPEC_RELAY_DISCOVERY.md for the full rationale.`
                : `Refusing to boot. Set core.allowDegradedRelay: true to downgrade this to a warning.`),
          );
          if (!allowDegraded) {
            natStatusWatcherStop?.();
            resetNatStatus();
            await agent.stop().catch((err: any) =>
              log(`Core prereq fatal-stop error: ${err?.message ?? String(err)}`),
            );
            try {
              dashDb.close();
            } catch (err: any) {
              log(`Core prereq fatal DB close error: ${err?.message ?? String(err)}`);
            }
            await removePid().catch(() => {});
            process.exit(1);
            return;
          }
        } else if (prereq.indeterminate) {
          // Codex (#661#discussion_r3302752893): the DNS-rescue / warn-only
          // path previously fell into the unconditional `OK` branch below
          // and hid the indeterminate verdict the checker had just
          // computed. Surface the reasons so operators see why the prereq
          // sweep neither passed strictly nor failed; the lifecycle
          // continues to boot since this is a soft rescue.
          log(
            `[CORE-PREREQ] INDETERMINATE: ${prereq.publicListenAddresses.length} ` +
              `public-class listen address${prereq.publicListenAddresses.length === 1 ? '' : 'es'} bound. ` +
              `reasons: ${prereq.reasons.join('; ')}.`,
          );
        } else {
          log(
            `[CORE-PREREQ] OK: ${prereq.publicListenAddresses.length} ` +
              `public-class listen address${prereq.publicListenAddresses.length === 1 ? '' : 'es'} bound.`,
          );
        }
      }
    } catch (err) {
      log(
        `[CORE-PREREQ] check failed (continuing boot): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    resetNatStatus();
  }

  const publisherChainBase = chainBase?.rpcUrl && chainBase?.hubAddress
    ? {
        rpcUrl: chainBase.rpcUrl,
        rpcUrls: chainBase.rpcUrls,
        hubAddress: chainBase.hubAddress,
        tokenAddress: chainBase.tokenAddress,
        chainId: chainBase.chainId,
      }
    : undefined;
  const startPostApiPublishing = () => {
    const profileTimer = setTimeout(() => {
      void agent.publishProfile().catch((err: any) => {
        log(`Agent profile publish failed: ${err?.message ?? String(err)}`);
      });
    }, 0);
    if (profileTimer.unref) profileTimer.unref();

    const promoteWorkerConfig = config.promoteQueue;
    promoteWorkerLifecycle = startPromoteWorkerDaemonLifecycle({
      agent,
      log,
      emitMemoryGraphChanged,
      isShuttingDown: () => shuttingDown,
      enabled: promoteWorkerConfig?.enabled !== false,
      workerConfig: {
        workerConcurrency: promoteWorkerConfig?.workerConcurrency,
        pollIntervalMs: promoteWorkerConfig?.pollIntervalMs,
        heartbeatIntervalMs: promoteWorkerConfig?.heartbeatIntervalMs,
        shutdownTimeoutMs: promoteWorkerConfig?.shutdownTimeoutMs,
      },
    });

    const publisherTimer = setTimeout(() => {
      void (async () => {
        try {
          const runtime = await startPublisherRuntimeIfEnabled({
            dataDir: dkgDir(),
            config,
            store: agent.store,
            keypair: agent.wallet.keypair,
            chainBase: publisherChainBase,
            ackTransportFactory: () => ({
              publisherPeerId: agent.peerId,
              gossipPublish: async (topic: string, data: Uint8Array) => {
                await agent.gossip.publish(topic, data);
              },
              // Route storage-ack + verify-proposal outbound sends through
              // the Messenger rather than directly through ProtocolRouter
              // (rc.9 PR-2 wiring). Today this is semantically identical
              // to the prior `agent.router.send` path — `/dkg/10.0.0/*`
              // protocols travel `Messenger.sendToPeer` (legacy pass-
              // through) → `ProtocolRouter.send`. The wiring matters at
              // Milestone C PR-11 when `/storage-ack` + `/verify-proposal`
              // migrate to `/dkg/10.0.1/*` and start using
              // `messenger.sendReliable`, picking up the substrate's
              // durable outbox + sender-side idempotency without
              // touching this factory again.
              //
              // HIGH RISK gate (rc.9 plan): Milestone C migration of
              // these protocols MUST include an explicit publishing-flow
              // integration test covering ACK quorum collection + the
              // ackTransportFactory hot path before the prefix bump
              // lands.
              // rc.9 PR-11: /storage-ack + /verify-proposal migrated to
              // /dkg/10.0.1/* and now route through messenger.sendReliable
              // (envelope wrap + sender-side idempotency + durable
              // outbox). queued surfaces as a thrown transport error so
              // ACKCollector's MAX_RETRIES loop + per-peer skip semantics
              // kick in unchanged.
              sendP2P: async (peerId: string, protocol: string, data: Uint8Array) => {
                const sendResult = await agent.messenger.sendReliable(peerId, protocol, data);
                if (!sendResult.delivered) {
                  throw new Error(`substrate queued (transport): ${sendResult.error}`);
                }
                return sendResult.response;
              },
              // ACK peer classification is owned by the agent (otReviewAgent
              // #1404): the daemon must NOT re-derive it by casting into the
              // private `knownCorePeerIds` set. This hands back the padded dial
              // pool (`getConnectedCorePeers`, quorum-aware per #1107) plus the
              // confirmed-core-only readiness probe (`getReadinessCorePeers`,
              // no padding so a connected edge peer can't disarm the wait), from
              // the same typed boundary the agent's own publish path uses.
              ...agent.getACKTransportPeerSelectors(),
              log,
            }),
            publishEncryptionFactory: (publishOptions) => resolveDaemonPublishEncryption(agent, publishOptions),
            knowledgeAssetVmPublishExecutor: createKnowledgeAssetVmPublishExecutor(agent),
            knowledgeAssetVmPublishPreflight: createKnowledgeAssetVmPublishPreflight(agent),
            log,
          });
          publisherRuntime = runtime;
        } catch (err: any) {
          log(`Async publisher startup failed: ${err?.message ?? String(err)}`);
        }
      })();
    }, 0);
    if (publisherTimer.unref) publisherTimer.unref();
  };

  log(`PeerId: ${agent.peerId}`);
  for (const a of agent.multiaddrs) log(`  ${a}`);

  if (relayPeers?.length) {
    log(
      `Relay: ${relayPeers[0]}${relayPeers.length > 1 ? ` (+${relayPeers.length - 1} more)` : ""}`,
    );
    for (let i = 0; i < 10; i++) {
      await sleep(1000);
      const circuitAddrs = agent.multiaddrs.filter((a) =>
        a.includes("/p2p-circuit/"),
      );
      if (circuitAddrs.length) {
        log(`Circuit reservation granted (${circuitAddrs.length} addresses)`);
        break;
      }
      if (i === 9) log("WARNING: no circuit addresses after 10s");
    }
  }

  // RFC 04 v0.3 / Issue #461 — sync the on-chain `relayCapable` hint
  // flag from the operator's intent (config.relayCapable). Multiaddrs
  // themselves are NOT published here — they go in per-RS-round
  // attestation KCs once submitProofV2 lands (RFC 04 Phase 2).
  // Best-effort and non-blocking: fired on a setTimeout(0) so chain RPC
  // slowness can't delay daemon ready, and agent.publishRelayRegistry()
  // is itself a no-throw (logs+returns on every error path).
  //
  // Pass `config.relayCapable` directly (no `=== true` coercion) so the
  // agent can distinguish three cases (Codex PR #506 fix):
  //   - true      → ensure on-chain flag is true
  //   - false     → ensure on-chain flag is false (clears stale opt-in)
  //   - undefined → don't touch on-chain (preserve manual admin flips)
  const relayRegistryTimer = setTimeout(() => {
    void agent
      .publishRelayRegistry({ relayCapable: config.relayCapable })
      .catch((err: unknown) => {
        log(
          `Relay registry publish failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }, 0);
  if (relayRegistryTimer.unref) relayRegistryTimer.unref();

  // Ensure configured context graphs + network defaults are subscribed and available.
  // Uses ensureContextGraphLocal (idempotent) to avoid duplicate creator claims
  // and to survive "already exists" gracefully.
  const contextGraphsToSubscribe = new Set(syncContextGraphs);
  for (const p of contextGraphsToSubscribe) {
    try {
      await agent.ensureContextGraphLocal({
        id: p,
        name: p,
        description: `Default context graph: ${p}`,
      });
      log(`Ensured context graph: ${p}`);
    } catch (err) {
      log(
        `Context graph "${p}" setup failed: ${err instanceof Error ? err.message : String(err)} — will discover via sync/gossip`,
      );
      agent.subscribeToContextGraph(p);
    }
  }

  // Run an initial chain scan for context graphs we might not know about,
  // then repeat every 30 minutes as a fallback discovery mechanism.
  const CHAIN_SCAN_INTERVAL_MS = 30 * 60 * 1000;
  const CHAIN_FULL_SCAN_EVERY = 48; // about once per day at the 30-minute cadence
  let chainScanRuns = 0;
  const runChainDiscoveryScan = async () => {
    try {
      const run = chainScanRuns++;
      const incremental = shouldUseIncrementalChainDiscoveryScan({
        run,
        watermarkSeeded: await agent.hasContextGraphRegistryScanWatermark(),
        fullScanEvery: CHAIN_FULL_SCAN_EVERY,
      });
      const found = await agent.discoverContextGraphsFromChain(
        chainDiscoveryScanOptions(incremental),
      );
      if (found > 0)
        log(`Chain scan: discovered ${found} new context graph(s)`);
    } catch {
      /* non-critical */
    }
  };
  setTimeout(runChainDiscoveryScan, 15_000);
  const chainScanTimer = setInterval(runChainDiscoveryScan, CHAIN_SCAN_INTERVAL_MS);
  if (chainScanTimer.unref) chainScanTimer.unref();

  // Periodic peer health ping (every 2 minutes)
  const PING_INTERVAL_MS = 2 * 60 * 1000;
  setTimeout(async () => {
    try {
      await agent.pingPeers();
    } catch {
      /* non-critical */
    }
  }, 30_000);
  const pingTimer = setInterval(async () => {
    try {
      await agent.pingPeers();
    } catch {
      /* non-critical */
    }
  }, PING_INTERVAL_MS);
  if (pingTimer.unref) pingTimer.unref();

  // Version check + auto-update.
  // The resolver merges repo/branch/interval field-by-field across
  // ~/.dkg/config.json → network/<env>.json → project.json, so defaults
  // in the shipped configs take effect even when the local config
  // omits the field (the common case after `dkg init` with default answers).
  let updateInterval: ReturnType<typeof setInterval> | null = null;
  const au = resolveAutoUpdateConfig(config, network);
  // OT-RFC-41 §4.2 / §5 PR 5: auto-update polling is npm-only.
  // `resolveStandaloneInstall` still seeds `daemonState.standaloneCache`
  // for `/api/status` consumers; monorepo dev daemons (standalone=false)
  // skip the polling loop entirely — contributors update via
  // `git pull && pnpm install && pnpm build`.
  const standalone = resolveStandaloneInstall(au?.source ?? resolveAutoUpdateSource(config, network));

  if (standalone) {
    const checkIntervalMs = (au?.checkIntervalMinutes ?? 30) * 60_000;
    // Even in version-check-only mode (au is null because auto-apply is
    // disabled) the policy used for the check must reflect the operator's
    // shipped intent, and must mirror resolveAutoUpdateConfig's precedence:
    // local config BEFORE network default. A disabled node with a local
    // channel / allowPrerelease pin must observe its own cohort, not the
    // network's.
    const allowPre = au?.allowPrerelease ?? config.autoUpdate?.allowPrerelease ?? network?.autoUpdate?.allowPrerelease ?? true;
    const channel = au?.channel ?? config.autoUpdate?.channel ?? network?.autoUpdate?.channel;

    log(
      `Auto-update (npm): ${au ? "enabled" : "disabled — version check only"}${channel ? ` channel="${channel}"` : ""} (every ${au?.checkIntervalMinutes ?? 30}min)`,
    );

    const runCheck = async () => {
      const npmStatus = await checkForNpmVersionUpdate(log, allowPre, channel);
      const derived = deriveUpdateCheckState(npmStatus);
      if (derived) {
        daemonState.lastUpdateCheck.checkedAt = Date.now();
        daemonState.lastUpdateCheck.upToDate = derived.upToDate;
        daemonState.lastUpdateCheck.channelTargetMissing = derived.channelTargetMissing;
        // Always write (including '') so a prior "available" version does not
        // linger after the target disappears or the node catches up.
        daemonState.lastUpdateCheck.latestVersion = derived.latestVersion;
        if (npmStatus.status === "no-target")
          log(
            `Auto-update (npm): WARNING — channel "${npmStatus.channel}" has no acceptable target (tag missing or rejected by allowPrerelease); node will not update until it is published.`,
          );
      }
      if (npmStatus.status !== "available" || !npmStatus.version) return;
      if (!au) return; // version check only — no auto-apply when polling disabled

      daemonState.isUpdating = true;
      // OT-RFC-41 Bundle B1b: Edge → npm install -g, Core → slot install.
      const role = config.nodeRole ?? "edge";
      const status = role === "edge"
        ? await performNpmUpdateEdge(npmStatus.version, getCurrentCliVersion(), log)
        : await performNpmUpdate(npmStatus.version, log);
      const updated = status === "updated";
      daemonState.isUpdating = false;
      if (updated) {
        log("Auto-update: update activated; exiting for supervised restart.");
        await shutdown(DAEMON_EXIT_CODE_RESTART);
        return;
      }
    };

    setTimeout(runCheck, 15_000);
    updateInterval = setInterval(runCheck, checkIntervalMs);
  } else if (au?.enabled) {
    // Monorepo dev daemon with auto-update enabled in config — log
    // once at boot so contributors understand why polling is silent.
    log(
      "Auto-update: skipped — monorepo checkout detected. Use `git pull && pnpm install && pnpm build` to update.",
    );
  }

  // --- Dashboard DB + Metrics ---

  chatDb = dashDb;
  log("Dashboard DB initialized at " + join(dkgDir(), "node-ui.db"));

  // Redactor for the copy of each record that LEAVES the node. The local
  // dashboard DB keeps full-fidelity records (it's the operator's own machine);
  // redaction only protects data crossing the trust boundary to a collector.
  const redactForRemote = createLogRedactor(config.telemetry?.logs?.redact);

  // Local DB gets the FULL record; remote shippers get a single REDACTED copy.
  // `remoteShippers` is evaluated per record so runtime enable/disable of the
  // syslog/OTLP workers is reflected without re-wiring. Logic lives in
  // createDaemonLogSink so this trust boundary is unit-tested (log-sink.test.ts).
  Logger.setSink(
    createDaemonLogSink({
      insertLog: (rec) => dashDb.insertLog(rec),
      redact: redactForRemote,
      remoteShippers: () => [logPusher, otlpExporter],
    }),
  );

  // Extract the plain value from an RDF typed literal like "6"^^<xsd:integer>
  const metricsSource: MetricsSource = {
    getPeerCount: () =>
      new Set(
        agent.node.libp2p.getConnections().map((c) => c.remotePeer.toString()),
      ).size,
    getDirectPeerCount: () =>
      new Set(
        agent.node.libp2p
          .getConnections()
          .filter((c) => !c.remoteAddr?.toString().includes("/p2p-circuit"))
          .map((c) => c.remotePeer.toString()),
      ).size,
    getRelayedPeerCount: () =>
      new Set(
        agent.node.libp2p
          .getConnections()
          .filter((c) => c.remoteAddr?.toString().includes("/p2p-circuit"))
          .map((c) => c.remotePeer.toString()),
      ).size,
    getMeshPeerCount: () => {
      try {
        return (agent.gossip as any).gossipsub?.getMeshPeers?.()?.length ?? 0;
      } catch {
        return 0;
      }
    },
    getContextGraphCount: async () => {
      const graphUris = await agent.store.listGraphs();
      const knownContextGraphIds = new Set<string>();
      const subscribedContextGraphs = agent.getSubscribedContextGraphs();
      const shadowContextGraphIds = new Set(
        shadowContextGraphIdsFromMetricSubscriptionCandidates(subscribedContextGraphs.entries()),
      );
      for (const contextGraphId of contextGraphIdsFromMetricSubscriptionCandidates(
        subscribedContextGraphs.entries(),
      )) {
        knownContextGraphIds.add(contextGraphId);
      }
      for (const contextGraphId of contextGraphIdsFromLocalRootMetaGraphs(
        graphUris,
        subscribedContextGraphs.keys(),
      )) {
        if (!shadowContextGraphIds.has(contextGraphId)) knownContextGraphIds.add(contextGraphId);
      }
      const declarationQuery = buildContextGraphDeclarationsSparql(graphUris, knownContextGraphIds);
      const declarationResult = declarationQuery
        ? await agent.store.query(declarationQuery)
        : null;
      if (declarationResult?.type === "bindings") {
        for (const contextGraphId of contextGraphIdsFromDeclarationBindings(
          declarationResult.bindings as Record<string, string>[],
        )) {
          if (!shadowContextGraphIds.has(contextGraphId)) knownContextGraphIds.add(contextGraphId);
        }
      }
      return countContextGraphsFromGraphUris(graphUris, knownContextGraphIds, shadowContextGraphIds);
    },
    // The count getters below each issue a data-proportional full-scan COUNT,
    // but the only caller is the 30 s metrics tick (metricsSource is consumed
    // solely by MetricsCollector — no on-demand /api/status path), so each tick
    // already re-reads the store fresh and there is nothing concurrent to
    // coalesce. They are intentionally left uncached so a snapshot never serves
    // a stale count and can't mask a store outage. The context-graph count
    // avoids the composite context-graph listing enrichment path. It uses the
    // cached store graph inventory plus backed subscription/declaration evidence,
    // then dedupes local layer graphs. It intentionally includes private CG graphs
    // that are backed by local subscription/declaration state.
    // These COUNTs are cheap (~0.015 CPU-s/tick on a 75k-triple store).
    getTotalTriples: async () => {
      const r = await agent.query(GET_TOTAL_TRIPLES_SPARQL);
      return parseRdfInt(r?.bindings?.[0]?.c);
    },
    // RFC ka-metadata-trim (Phase 2 ⊕ / Phase 3 P3.1): the KC/KA counters are
    // predicate-based, not rdf:type-based — `generateKCMetadata` no longer
    // emits `rdf:type dkg:KnowledgeCollection` / `dkg:KnowledgeAsset` rows.
    //   - KC ≙ a subject carrying `dkg:status` (every KC row, old shape or
    //     new, has exactly one tentative/confirmed status quad).
    //   - KA ≙ read-both: a legacy `<ual>/<n>` token row carrying
    //     `dkg:partOf`, OR (collapsed shape, P3.1) a UAL subject carrying
    //     `dkg:status` + the entity pair with NO token row pointing at it
    //     (the NOT-EXISTS guard prevents double-counting old-shape rows,
    //     whose aggregate UAL node also carries `dkg:rootEntity`).
    getTotalKCs: async () => {
      const r = await agent.query(
        "SELECT (COUNT(DISTINCT ?kc) AS ?c) WHERE { GRAPH ?g { ?kc <http://dkg.io/ontology/status> ?s } }",
      );
      return parseRdfInt(r?.bindings?.[0]?.c);
    },
    getTotalKAs: async () => {
      const r = await agent.query(
        `SELECT (COUNT(DISTINCT ?ka) AS ?c) WHERE { GRAPH ?g {
          { ?ka <http://dkg.io/ontology/partOf> ?kc }
          UNION
          { ?ka <http://dkg.io/ontology/status> ?st .
            ?ka <http://dkg.io/ontology/rootEntity> ?re .
            FILTER NOT EXISTS { ?tok <http://dkg.io/ontology/partOf> ?ka } }
        } }`,
      );
      return parseRdfInt(r?.bindings?.[0]?.c);
    },
    getConfirmedKCs: async () => {
      const r = await agent.query(
        'SELECT (COUNT(DISTINCT ?kc) AS ?c) WHERE { GRAPH ?g { ?kc <http://dkg.io/ontology/status> "confirmed" } }',
      );
      return parseRdfInt(r?.bindings?.[0]?.c);
    },
    getTentativeKCs: async () => {
      const r = await agent.query(
        'SELECT (COUNT(DISTINCT ?kc) AS ?c) WHERE { GRAPH ?g { ?kc <http://dkg.io/ontology/status> "tentative" } }',
      );
      return parseRdfInt(r?.bindings?.[0]?.c);
    },
    getStoreBytes: async () => {
      // External SPARQL backends own no local file; `null` is the
      // correct signal here (returning 0 misleads operators into
      // thinking the store is empty). Quad count is exposed on
      // demand via /api/status instead — too expensive to compute
      // on the metrics tick. (RFC 120, plan PR 1 item 2.) A managed
      // oxigraph-server keeps its data in RocksDB (no store.nq), so it
      // takes the same null path via the runtime sparql-http view.
      if (isExternalBackend(runtimeStore?.backend)) {
        return null;
      }
      try {
        const s = await stat(join(dkgDir(), "store.nq"));
        return s.size;
      } catch {
        return 0;
      }
    },
    getRpcLatencyMs: async () => 0,
    isRpcHealthy: async () => true,
    getRelayStats: () => {
      // Returns null on edge nodes (no relay server); the collector
      // tolerates undefined/null and writes the relay_* columns as
      // NULL in that case.
      const stats = agent.node.getRelayStats();
      if (!stats) return null;
      // Strip the unbounded `reservations[]` array — that lives only
      // on the live `/api/relay/stats` route, not in the periodic
      // SQLite snapshot. See RelayStatsSnapshot docstring in
      // metrics-collector.ts for the full rationale.
      return {
        capacity: stats.capacity,
        reservationCount: stats.reservationCount,
        activeCircuits: stats.activeCircuits,
        bytesIn: stats.bytesIn,
        bytesOut: stats.bytesOut,
      };
    },
  };

  const metricsCollector = new MetricsCollector(
    dashDb,
    metricsSource,
    dkgDir(),
  );
  metricsCollector.start();
  log("Metrics collector started (30s interval)");

  // --- Telemetry: syslog log streaming (opt-in) ---
  const networkKey = network?.networkName?.toLowerCase().includes("testnet")
    ? "testnet"
    : "mainnet";
  const syslogEndpoint = TELEMETRY_ENDPOINTS[networkKey]?.syslog;
  let logPusher: LogPushWorker | null = null;
  let otlpExporter: OtlpLogWorker | null = null;

  function startLogPusher(): { ok: boolean; error?: string } {
    if (logPusher) return { ok: true };
    if (!syslogEndpoint || !syslogEndpoint.port) {
      return {
        ok: false,
        error: `Telemetry streaming is not available for ${networkKey} (no syslog endpoint configured)`,
      };
    }
    const autoUpdateEnabled = config.autoUpdate?.enabled ?? false;
    logPusher = new LogPushWorker({
      host: syslogEndpoint.host,
      port: syslogEndpoint.port,
      peerId: agent.peerId,
      network: networkKey,
      nodeName: config.name,
      version: nodeVersion,
      commit: nodeCommit,
      role: config.nodeRole ?? "edge",
      autoUpdate: autoUpdateEnabled,
      versionStatus: () => {
        if (!autoUpdateEnabled) return "disabled";
        if (daemonState.isUpdating) return "updating";
        if (daemonState.lastUpdateCheck.checkedAt === 0) return "unknown";
        return daemonState.lastUpdateCheck.upToDate ? "latest" : "behind";
      },
    });
    logPusher.start();
    log(
      `Telemetry: log streaming enabled → ${syslogEndpoint.host}:${syslogEndpoint.port}`,
    );
    return { ok: true };
  }

  function stopLogPusher(): void {
    if (!logPusher) return;
    logPusher.stop();
    logPusher = null;
    log("Telemetry: log streaming disabled");
  }

  function startOtlpExporter(): { ok: boolean; error?: string } {
    if (otlpExporter) return { ok: true };
    // Resolve env-first, matching the traces/metrics precedence (resolveOtelSignals):
    // the standard OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, then OTEL_EXPORTER_OTLP_ENDPOINT
    // + /v1/logs, then config. NO hardcoded per-network fallback — logs must never
    // ship to a placeholder/TBD URL the operator never set.
    const envBase = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/$/, "");
    const endpoint =
      process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ||
      (envBase ? `${envBase}/v1/logs` : undefined) ||
      config.telemetry?.logs?.endpoint;
    if (!endpoint) {
      return {
        ok: false,
        error: `OTLP log export is not configured for ${networkKey} (set config.telemetry.logs.endpoint or OTEL_EXPORTER_OTLP_ENDPOINT)`,
      };
    }
    const minLevel = config.telemetry?.logs?.level ?? "info";
    otlpExporter = new OtlpLogWorker({
      endpoint,
      token: config.telemetry?.logs?.token,
      network: networkKey,
      peerId: agent.peerId,
      nodeName: config.name,
      version: nodeVersion,
      commit: nodeCommit,
      role: config.nodeRole ?? "edge",
      chainId: config.chain?.chainId,
      minLevel,
      bufferMaxEntries: config.telemetry?.logs?.bufferMaxEntries,
      onError: (m) => log(`Telemetry(OTLP): ${m}`),
    });
    otlpExporter.start();
    log(`Telemetry: OTLP log export enabled → ${endpoint} (level ≥ ${minLevel})`);
    return { ok: true };
  }

  async function stopOtlpExporter(): Promise<void> {
    if (!otlpExporter) return;
    // Await the final flush so disable/shutdown can't return while logs are
    // still in flight or stranded in the buffer.
    await otlpExporter.shutdown();
    otlpExporter = null;
    log("Telemetry: OTLP log export disabled");
  }

  // OTel traces + metrics SDK (independent of the log-exporter path below).
  // Endpoints resolve env-first (standard OTEL_EXPORTER_OTLP_* names) then
  // config; a signal registers ONLY when its endpoint resolves — never a
  // guessed prod default. Idempotent (initTelemetry no-ops once configured), so
  // it is safe to call both at boot AND from the runtime enable toggle.
  async function startOtelSdk(): Promise<void> {
    const { tracesEndpoint, metricsEndpoint, tracesOn, metricsOn } = resolveOtelSignals(
      config.telemetry,
    );
    if (!tracesOn && !metricsOn) return;
    try {
      await initTelemetry({
        enabled: true,
        resource: {
          serviceName: "dkg-node",
          serviceVersion: nodeVersion,
          serviceInstanceId: config.name,
          network: networkKey,
          peerId: agent.peerId,
          nodeName: config.name,
          nodeRole: config.nodeRole ?? "edge",
          commit: nodeCommit,
          chainId: config.chain?.chainId,
        },
        traces: tracesOn
          ? {
              endpoint: tracesEndpoint,
              token: config.telemetry?.traces?.token,
              sampleRatio: config.telemetry?.traces?.sampleRatio,
            }
          : undefined,
        metrics: metricsOn
          ? {
              endpoint: metricsEndpoint,
              token: config.telemetry?.metrics?.token,
              exportIntervalMs: config.telemetry?.metrics?.exportIntervalMs,
            }
          : undefined,
      });
      log(
        `Telemetry: OTel SDK registered (traces=${tracesOn ? tracesEndpoint : "off"}, metrics=${metricsOn ? metricsEndpoint : "off"})`,
      );
    } catch (err) {
      // Telemetry must never block startup.
      log(`Telemetry: OTel init failed (non-fatal): ${String(err)}`);
    }
  }

  // Start ALL telemetry signals under the master gate: OTel traces/metrics
  // (SDK) AND the configured log exporter. Used at boot and from the runtime
  // enable toggle so both behave identically (the bug fixed here: enabling from
  // a boot-disabled state previously started only logs, never traces/metrics).
  // The log-exporter result is returned separately — a failed log shipper must
  // NOT tear down or disable the independent traces/metrics signals.
  // Await the SDK init first (it is dynamically imported) so traces/metrics are
  // fully registered before the log exporter result is returned — that ordering
  // lets the runtime-enable path roll the SDK back if the log exporter fails.
  async function startTelemetry(): Promise<{ ok: boolean; error?: string }> {
    await startOtelSdk();
    // Dispatch to the configured log exporter. 'syslog' is the default when
    // unset (preserves prior behaviour); 'otlp' is the recommended path; 'none'
    // keeps logs local-only even while telemetry is enabled. An UNKNOWN/typo'd
    // value fails closed to 'none' (never silently syslog → off-node).
    if (isUnknownLogExporter(config.telemetry)) {
      log(
        `Telemetry: unknown logs.exporter "${config.telemetry?.logs?.exporter}" — ` +
          `keeping logs local-only (no off-node forwarding). Use 'otlp', 'syslog', or 'none'.`,
      );
    }
    const mode = resolveLogExporterMode(config.telemetry);
    if (mode === "none") return { ok: true };
    if (mode === "otlp") return startOtlpExporter();
    return startLogPusher();
  }

  // Stop ALL telemetry signals: log exporters AND the OTel SDK (flush + shut
  // down + clear the API globals). Async so a runtime disable actually stops
  // traces/metrics — not just logs — and callers can await an orderly teardown.
  async function stopTelemetry(): Promise<void> {
    stopLogPusher();
    await stopOtlpExporter();
    await shutdownTelemetry().catch(() => {});
  }

  if (config.telemetry?.enabled) {
    const r = await startTelemetry();
    if (!r.ok) {
      // Log forwarding failed to start (e.g. mainnet syslog port 0). Disable
      // ONLY the log signal — leave the master gate and any registered
      // traces/metrics intact; they are independent signals. (Boot path:
      // best-effort per signal; the runtime toggle below rolls back instead.)
      log(`Telemetry: log exporter not started — ${r.error} (traces/metrics unaffected)`);
    }
  }

  const MAX_LOG_BYTES = 50 * 1024 * 1024; // 50 MB
  const PRUNE_INTERVAL_MS = 6 * 60 * 60_000; // 6 hours
  const pruneTimer = setInterval(async () => {
    try {
      dashDb.prune();
      const st = await stat(logFile).catch(() => null);
      if (st && st.size > MAX_LOG_BYTES) {
        const tail = await readFile(logFile, "utf8");
        const keepFrom = tail.length - Math.floor(MAX_LOG_BYTES * 0.7);
        const newlineIdx = tail.indexOf("\n", keepFrom);
        if (newlineIdx > 0) {
          await writeFile(logFile, tail.slice(newlineIdx + 1));
        } else {
          await writeFile(logFile, tail.slice(keepFrom));
        }
        log(
          `Rotated daemon.log (was ${(st.size / 1024 / 1024).toFixed(1)} MB)`,
        );
      }
    } catch {
      /* never crash the daemon */
    }
  }, PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  const tracker = new OperationTracker(dashDb);

  // Track peer connections
  agent.eventBus.on(DKGEvent.CONNECTION_OPEN, (data: any) => {
    const ctx = createOperationContext("connect");
    tracker.start(ctx, { peerId: data.peerId });
    tracker.complete(ctx, {
      details: { transport: data.transport, direction: data.direction },
    });
  });

  // ADR-001 (notifications-pane redesign): peer connect/disconnect no longer
  // produce bell notifications — pure transport churn that dominated the
  // pane for graphs the user has nothing to do with. Connection telemetry is
  // unaffected: the CONNECTION_OPEN handler above still records it via
  // `tracker`. We drop the PEER_CONNECTED / PEER_DISCONNECTED notification
  // emitters entirely (clean cut, no `category` compat flag).

  // Track publishes via KC_PUBLISHED event (covers GossipSub-received publishes)
  agent.eventBus.on(DKGEvent.KC_PUBLISHED, (data: any) => {
    const ctx = createOperationContext("publish");
    const kaId = data.kaId != null ? String(data.kaId) : undefined;
    tracker.start(ctx, {
      contextGraphId: data.contextGraphId,
      details: { kaId, source: "gossipsub" },
    });
    tracker.complete(ctx, { tripleCount: data.tripleCount });
    try {
      // ADR-001: the raw `kc_published` bell notification is removed — it
      // fired for ANY CG overheard on gossip (not just the user's), the
      // dominant pane noise. Live graph refresh below is unaffected.
      // (ADR-002/A3 layers a MEMBERSHIP-GATED, remote-only `assertion_activity`
      // emitter on top of this handler as the legitimate scoped replacement.)
      if (data.contextGraphId) {
        emitMemoryGraphChanged({
          contextGraphId: data.contextGraphId,
          layers: ["vm"],
          ...(typeof data.subGraphName === "string" ? { subGraphName: data.subGraphName } : {}),
          operation: "knowledge_collection_published",
          source: "gossipsub",
          counts: {
            triples: typeof data.tripleCount === "number" ? data.tripleCount : undefined,
          },
        });
        // ADR-002 / CR-2: cross-node `published` activity for a collaborator's
        // publish. REMOTE-ONLY — gate on `data.from` (the gossip payload's
        // sender peer id, set ONLY on gossipsub-received publishes by
        // publish-handler.ts; the LOCAL publisher emit carries no `from`).
        // This prevents double-counting: a local publish is recorded by
        // routes/memory.ts, a remote one here. Membership-gated so we only
        // record activity for CGs this node is actually involved in (not
        // every CG overheard on gossip — the dominant noise ADR-001 removed).
        const remotePublisherPeer =
          typeof data.from === "string" && data.from.length > 0 ? data.from : undefined;
        if (remotePublisherPeer && localNodeInvolvedInContextGraph(dashDb, data.contextGraphId)) {
          recordAssertionActivity(dashDb, {
            contextGraphId: data.contextGraphId,
            kind: "published",
            actorAgentAddress: remotePublisherPeer,
            ...(typeof data.subGraphName === "string" ? { subGraphName: data.subGraphName } : {}),
            ...(typeof data.tripleCount === "number" ? { tripleCount: data.tripleCount } : {}),
          });
          emitNotification({ contextGraphId: data.contextGraphId, type: "assertion_activity" });
        }
      }
    } catch {
      /* never crash */
    }
  });

  // Track remote KA updates (gossipsub-received only — local updates are
  // already tracked by the /api/update route with full phase/tx context)
  agent.eventBus.on(DKGEvent.KA_UPDATED, (data: any) => {
    try {
      if (!data.fromPeerId) return;
      const ctx = createOperationContext("ka-update");
      tracker.start(ctx, {
        contextGraphId: data.contextGraphId,
        peerId: data.fromPeerId,
        details: {
          batchId: data.batchId,
          ual: data.ual,
          rootEntities: Array.isArray(data.rootEntities) ? data.rootEntities.slice(0, 5) : undefined,
        },
      });
      if (data.txHash) tracker.setTxHash(ctx, data.txHash);
      tracker.complete(ctx);
    } catch { /* never crash */ }
  });

  // SSE (Server-Sent Events) broadcast: real-time push to connected UI clients
  const sseClients = new Set<ServerResponse>();
  function sseBroadcast(event: string, payload: Record<string, unknown>) {
    const data = JSON.stringify(payload);
    const msg = `event: ${event}\ndata: ${data}\n\n`;
    for (const client of sseClients) {
      try { client.write(msg); } catch { sseClients.delete(client); }
    }
  }
  function emitMemoryGraphChanged(event: MemoryGraphChangedEvent) {
    if (!event.contextGraphId) return;
    sseBroadcast("memory_graph_changed", {
      ...event,
      timestamp: new Date().toISOString(),
    });
  }
  // A5: single generic `notification` SSE refresh for the bell pane. Fired
  // once per scoped notification write (join_* + assertion_activity) so the
  // pane re-fetches the scoped feed via ONE listener. The three legacy
  // join-specific events still fire (other consumers — PendingJoinRequests
  // Section, useMyContextGraphs — listen on them); this is ADDITIVE.
  function emitNotification(event: { contextGraphId: string; type: string }) {
    if (!event.contextGraphId) return;
    sseBroadcast("notification", {
      contextGraphId: event.contextGraphId,
      type: event.type,
    });
  }

  agent.eventBus.on(DKGEvent.JOIN_REQUEST_RECEIVED, (data: any) => {
    try {
      dashDb.insertNotification({
        ts: Date.now(),
        type: "join_request",
        title: "Join request received",
        message: `${data.agentName ?? shortId(data.agentAddress)} wants to join project ${shortId(data.contextGraphId)}`,
        source: "access-control",
        // R2-1: the scoping key MUST be on the top-level `context_graph_id`
        // column (not only in `meta`) — the scoped read filters on the column
        // (getNotificationsForContextGraphs), so without this the row is NULL-
        // scoped and dropped from the bell entirely.
        contextGraphId: data.contextGraphId,
        meta: JSON.stringify({
          contextGraphId: data.contextGraphId,
          agentAddress: data.agentAddress,
          agentName: data.agentName,
        }),
      });
      sseBroadcast("join_request", {
        contextGraphId: data.contextGraphId,
        agentAddress: data.agentAddress,
        agentName: data.agentName,
      });
      emitNotification({ contextGraphId: data.contextGraphId, type: "join_request" });
    } catch {
      /* never crash */
    }
  });

  agent.eventBus.on(DKGEvent.JOIN_APPROVED, (data: any) => {
    try {
      dashDb.insertNotification({
        ts: Date.now(),
        type: "join_approved",
        title: "Join approved",
        message: `You have been approved to join project ${shortId(data.contextGraphId)}`,
        source: "access-control",
        // R2-1: top-level scoping column so the scoped read returns it.
        contextGraphId: data.contextGraphId,
        meta: JSON.stringify({
          contextGraphId: data.contextGraphId,
          agentAddress: data.agentAddress,
        }),
      });
      sseBroadcast("join_approved", {
        contextGraphId: data.contextGraphId,
        agentAddress: data.agentAddress,
      });
      emitNotification({ contextGraphId: data.contextGraphId, type: "join_approved" });
    } catch {
      /* never crash */
    }
  });

  agent.eventBus.on(DKGEvent.JOIN_REJECTED, (data: any) => {
    try {
      dashDb.insertNotification({
        ts: Date.now(),
        type: "join_rejected",
        title: "Join request rejected",
        message: `Your request to join project ${shortId(data.contextGraphId)} was declined by the curator.`,
        source: "access-control",
        // R2-1: top-level scoping column so the scoped read returns it.
        contextGraphId: data.contextGraphId,
        meta: JSON.stringify({
          contextGraphId: data.contextGraphId,
          agentAddress: data.agentAddress,
        }),
      });
      sseBroadcast("join_rejected", {
        contextGraphId: data.contextGraphId,
        agentAddress: data.agentAddress,
      });
      emitNotification({ contextGraphId: data.contextGraphId, type: "join_rejected" });
    } catch {
      /* never crash */
    }
  });

  agent.eventBus.on(DKGEvent.PROJECT_SYNCED, (data: any) => {
    try {
      sseBroadcast("project_synced", {
        contextGraphId: data.contextGraphId,
        dataSynced: data.dataSynced,
        sharedMemorySynced: data.sharedMemorySynced,
      });
      const layers: MemoryGraphLayer[] = [];
      if (data.dataSynced) layers.push("vm");
      if (data.sharedMemorySynced) layers.push("swm");
      if (data.contextGraphId && layers.length > 0) {
        emitMemoryGraphChanged({
          contextGraphId: data.contextGraphId,
          layers,
          operation: "project_synced",
          source: "sync",
          dataSynced: data.dataSynced,
          sharedMemorySynced: data.sharedMemorySynced,
        });
      }
    } catch {
      /* never crash */
    }
  });

  agent.eventBus.on(DKGEvent.MEMORY_GRAPH_CHANGED, (data: any) => {
    try {
      const layers = Array.isArray(data?.layers)
        ? data.layers.filter((layer: unknown): layer is MemoryGraphLayer =>
            layer === "wm" || layer === "swm" || layer === "vm",
          )
        : [];
      if (!data?.contextGraphId || layers.length === 0) return;
      const counts = data.counts && typeof data.counts === "object"
        ? data.counts as MemoryGraphChangedEvent["counts"]
        : undefined;
      emitMemoryGraphChanged({
        contextGraphId: String(data.contextGraphId),
        layers,
        ...(typeof data.subGraphName === "string" ? { subGraphName: data.subGraphName } : {}),
        operation: typeof data.operation === "string" ? data.operation : "memory_graph_changed",
        source: typeof data.source === "string" ? data.source : "event_bus",
        ...(counts ? { counts } : {}),
      });
    } catch {
      /* never crash */
    }
  });

  const agentToolsContext = {
    query: (
      sparql: string,
      opts?: {
        contextGraphId?: string;
        graphSuffix?: "_shared_memory";
        includeSharedMemory?: boolean;
        view?: "working-memory" | "shared-working-memory" | "verifiable-memory";
        agentAddress?: string;
        assertionName?: string;
        subGraphName?: string;
      },
    ) => agent.query(sparql, opts),
    createAssertion: async (
      contextGraphId: string,
      name: string,
      opts?: { subGraphName?: string },
    ): Promise<{ assertionUri: string | null; alreadyExists: boolean }> => {
      try {
        const assertionUri = await agent.assertion.create(
          contextGraphId,
          name,
          opts?.subGraphName ? { subGraphName: opts.subGraphName } : undefined,
        );
        return { assertionUri, alreadyExists: false };
      } catch (err: any) {
        if (err?.message?.includes("already exists")) {
          return { assertionUri: null, alreadyExists: true };
        }
        throw err;
      }
    },
    writeAssertion: async (
      contextGraphId: string,
      name: string,
      quads: any[],
      opts?: { subGraphName?: string },
    ): Promise<{ written: number }> => {
      await agent.assertion.write(
        contextGraphId,
        name,
        quads,
        opts?.subGraphName ? { subGraphName: opts.subGraphName } : undefined,
      );
      emitMemoryGraphChanged({
        contextGraphId,
        layers: ["wm"],
        subGraphName: opts?.subGraphName,
        operation: "assertion_written",
        source: "agent_tool",
        counts: { triples: quads.length },
      });
      return { written: quads.length };
    },
    createContextGraph: (opts: {
      id: string;
      name: string;
      description?: string;
      private?: boolean;
    }) => agent.createContextGraph(opts),
    listContextGraphs: () => agent.listContextGraphs(),
  };
  // See `resolveMemoryAgentAddress` for the write/read-URI invariant
  // this encodes (issue #277). The helper is exported purely so the
  // daemon-wiring contract stays unit-testable without a real agent.
  const memoryAgentAddress = resolveMemoryAgentAddress(agent);
  const memoryManager = new ChatMemoryManager(
    agentToolsContext,
    config.llm ?? { apiKey: '' },
    { agentAddress: memoryAgentAddress },
  );
  log('Memory manager ready');
  if (config.llm) log('Memory enrichment LLM ready');
  else log('Memory enrichment LLM not configured');

  const llmSettings = {
    getLlm: () => config.llm,
    setLlm: async (
      llm: { apiKey: string; model?: string; baseURL?: string } | null,
    ) => {
      if (llm) {
        config.llm = llm;
        memoryManager.updateConfig(llm);
        log("LLM config updated via settings");
      } else {
        delete config.llm;
        memoryManager.updateConfig({ apiKey: '' });
        log('LLM config cleared via settings');
      }
      await saveConfig(config);
    },
  };

  const telemetrySettings = {
    getTelemetryEnabled: () => config.telemetry?.enabled ?? false,
    setTelemetryEnabled: async (
      enabled: boolean,
    ): Promise<{ ok: boolean; error?: string }> => {
      if (enabled) {
        const r = await startTelemetry();
        if (!r.ok) {
          // The OTel SDK may have started before the log exporter failed. Roll
          // it back so we never leave traces/metrics exporting while we report
          // failure and persist nothing — the API/UI state stays consistent
          // (telemetry remains off) with what is actually running.
          await stopTelemetry();
          return r;
        }
      } else {
        await stopTelemetry();
      }
      config.telemetry = { ...config.telemetry, enabled };
      await saveConfig(config);
      return { ok: true };
    },
  };

  // Resolve the static UI directory (built by @origintrail-official/dkg-node-ui)
  //
  // The last fallback walks the filesystem from THIS module's compiled
  // location. PR #258 nests this module under `dist/daemon/lifecycle.js`,
  // one level deeper than the pre-split `dist/lifecycle.js` layout, so
  // the relative walk needs one extra `..` to land at the monorepo's
  // `packages/` directory. Without it, dashboard assets resolve to
  // `packages/cli/node-ui/dist-ui` and 404 on the rare paths that hit
  // this branch (when both `import.meta.resolve` and `repoDir()` fail).
  let nodeUiStaticDir: string;
  try {
    const nodeUiPkg = import.meta.resolve("@origintrail-official/dkg-node-ui");
    const nodeUiDir = dirname(fileURLToPath(nodeUiPkg));
    nodeUiStaticDir = join(nodeUiDir, "..", "dist-ui");
  } catch {
    const root = repoDir();
    nodeUiStaticDir = root
      ? join(root, "packages", "node-ui", "dist-ui")
      : resolve(
          dirname(fileURLToPath(import.meta.url)),
          "..",
          "..",
          "..",
          "node-ui",
          "dist-ui",
        );
  }

  // --- Authentication ---

  const authEnabled = config.auth?.enabled !== false;
  const validTokens = await loadTokens(config.auth);
  const bridgeAuthToken =
    (await loadBridgeAuthToken()) ??
    (validTokens.size > 0
      ? (validTokens.values().next().value as string)
      : undefined);
  // Register per-agent Bearer tokens so the auth guard accepts them
  for (const a of agent.listLocalAgents()) {
    validTokens.add(a.authToken);
  }

  if (authEnabled) {
    log(
      `API authentication enabled (${validTokens.size} token${validTokens.size !== 1 ? "s" : ""} loaded)`,
    );
    log(`Token file: ${join(dkgDir(), "auth.token")}`);
  } else {
    log("API authentication disabled (auth.enabled = false)");
  }

  // Trusted server-side port binding used downstream (SSRF defence in
  // manifestSelfClient; passed to handleRequest + route modules).
  const apiPortRef = { value: 0 };

  const catchupTracker: CatchupTracker = {
    jobs: new Map(),
    latestByContextGraph: new Map(),
  };

  // --- Extraction Pipelines ---

  const extractionRegistry = new ExtractionPipelineRegistry();
  if (isMarkItDownAvailable()) {
    extractionRegistry.register(new MarkItDownConverter());
  }
  // text/markdown is always natively handled by the import-file route
  // regardless of converter registration; report the full effective set so
  // operators see the same list that /.well-known/skill.md advertises.
  const supportedIngestionTypes = [
    ...new Set([
      "text/markdown",
      ...extractionRegistry.availableContentTypes(),
    ]),
  ];
  log(`Extraction pipelines: ${supportedIngestionTypes.join(", ")}`);
  if (!isMarkItDownAvailable()) {
    log(
      "MarkItDown binary not found — non-markdown document extraction unavailable (files stored as blobs)",
    );
  }

  // --- File Store ---

  const fileStore = new FileStore(join(dkgDir(), "files"));
  agent.registerImportedArtifactByteStore(fileStore);

  // --- Vector Store (optional, for tri-modal memory) ---
  const vectorStore = new VectorStore(dkgDir());
  let embeddingProvider: EmbeddingProvider | null = null;
  if (config.llm?.apiKey) {
    embeddingProvider = new OpenAIEmbeddingProvider({
      apiKey: config.llm.apiKey,
      baseURL: config.llm.baseURL,
    });
  }

  // In-memory extraction job status tracker. Synchronous extractions (the V10.0
  // default) populate this with a completed record on the same request; async
  // workflows can be layered later without changing the endpoint contract.
  const extractionStatus = new Map<string, ExtractionStatusRecord>();

  // Round 6 Bug 19: per-assertion mutex for the import-file snapshot+
  // insert+rollback sequence. Without this, concurrent imports of the
  // SAME assertion URI race: request A commits, request B (which
  // snapshotted the older state) fails, B's rollback then re-inserts
  // its stale snapshot and silently wipes A's successful commit.
  //
  // Lock scope is the full snapshot → cleanup → atomic insert →
  // rollback critical section. Imports of DIFFERENT assertion URIs
  // run in parallel — the lock is per-URI.
  //
  // CAVEAT: single-process lock only. Multi-daemon deployments sharing
  // a triple store need storage-layer optimistic concurrency control
  // (version counters or ETag-like compare-and-swap) to close the race
  // across processes — out of scope for Round 6.
  const assertionImportLocks = new Map<string, Promise<void>>();

  // --- HTTP API ---

  const rateLimiter = new HttpRateLimiter(
    config.rateLimit?.requestsPerMinute ?? 120,
    config.rateLimit?.exempt ?? [
      "/api/status",
      "/api/chain/rpc-health",
      "/.well-known/skill.md",
    ],
  );

  // Admission control: cap concurrent in-flight requests so a burst (including
  // loopback traffic, which bypasses the per-IP rate limiter) can't pile
  // unbounded pending work onto the single event loop / store worker thread.
  // IP-agnostic on purpose — local agents legitimately burst, so we shed by
  // concurrency (503 + Retry-After) rather than by per-minute rate. Tunable via
  // DKG_MAX_INFLIGHT (explicit 0 disables); default 64. Malformed/empty values
  // fall back to the default instead of silently disabling the cap.
  const maxInFlight = resolveIntSetting(
    process.env.DKG_MAX_INFLIGHT,
    config.maxInFlightRequests,
    64,
    { allowNonPositive: true },
  );
  const inFlightLimiter = new InFlightLimiter(maxInFlight);
  // Read-only live view of the limiter's counters for the plugin-facing
  // RequestContext / /api/status: only the three getters, never the mutating
  // tryAcquire()/release(). The enforcement path (admitRequest, below) keeps the
  // real limiter; route/plugin code can read shed stats but can't reach — even
  // via a runtime cast — the methods that corrupt slot accounting.
  const admissionStats: AdmissionStatsView = {
    get inFlight() {
      return inFlightLimiter.inFlight;
    },
    get max() {
      return inFlightLimiter.max;
    },
    get rejectedTotal() {
      return inFlightLimiter.rejectedTotal;
    },
  };
  // Throttle the "shedding" warning so a sustained burst can't spam the log,
  // while still letting operators see the limiter is active (per review).
  let lastShedLogAt = 0;
  const SHED_LOG_THROTTLE_MS = 10_000;

  let corsAllowed: CorsAllowlist = "*";
  daemonState.catchupRunner = createCatchupRunner(agent);

  const server = createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);

      // Resolve CORS origin once per request (request-scoped, not global)
      const reqCorsOrigin = resolveCorsOrigin(req, corsAllowed) ?? null;
      (res as any).__corsOrigin = reqCorsOrigin;

      // Rate limiting — include CORS headers so browsers surface 429 instead of opaque CORS failure
      const clientIp = req.socket.remoteAddress ?? 'unknown';
      if (!shouldBypassRateLimitForLoopbackTraffic(clientIp, reqUrl.pathname)
        && !rateLimiter.isAllowed(clientIp, reqUrl.pathname)) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60', ...corsHeaders(reqCorsOrigin) });
        res.end(JSON.stringify({ error: 'Too many requests' }));
        return;
      }

      // Admission control — shed load (503 + Retry-After) when too many
      // requests are already in flight. Applied to ALL traffic (not bypassed
      // for loopback) so it also bounds local agents the per-IP rate limiter
      // exempts; OPTIONS preflight and cheap health/liveness paths are exempt
      // inside admitRequest so monitoring stays answerable under saturation.
      const gate = admitRequest(inFlightLimiter, req.method, reqUrl.pathname, res, reqCorsOrigin);
      if (!gate.admitted) {
        const nowMs = Date.now();
        if (nowMs - lastShedLogAt >= SHED_LOG_THROTTLE_MS) {
          lastShedLogAt = nowMs;
          log(
            `admission-control: shedding requests (503) — inFlight=${inFlightLimiter.inFlight}/${inFlightLimiter.max} rejectedTotal=${inFlightLimiter.rejectedTotal}`,
          );
        }
        return;
      }
      // (admitRequest registers slot release on the response's `close` event —
      // covers streaming/plugin responses; nothing to release here.)

      // CORS preflight
      if (req.method === "OPTIONS") {
        if (!reqCorsOrigin && corsAllowed !== "*") {
          res.writeHead(403).end();
          return;
        }
        res.writeHead(204, {
          ...(reqCorsOrigin
            ? { "Access-Control-Allow-Origin": reqCorsOrigin }
            : {}),
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        });
        res.end();
        return;
      }

      // Auth guard — rejects with 401 if token is invalid/missing
      const authAllowed = await httpAuthGuard(
        req,
        res,
        authEnabled,
        validTokens,
        resolveCorsOrigin(req, corsAllowed),
      );
      if (!authAllowed) return;

      // Retired installable apps framework (V9): respond with 410 Gone so upgraded
      // nodes give a clear migration hint for both the JSON API and any bookmarked
      // app URLs, instead of an opaque 404. The replacement surface is the
      // `dkg integration` CLI (see packages/cli/src/integrations/).
      if (
        reqUrl.pathname === "/api/apps" ||
        reqUrl.pathname.startsWith("/api/apps/") ||
        reqUrl.pathname === "/apps" ||
        reqUrl.pathname.startsWith("/apps/")
      ) {
        res.writeHead(410, {
          "Content-Type": "application/json",
          ...corsHeaders(reqCorsOrigin),
        });
        res.end(
          JSON.stringify({
            error: "Gone",
            reason:
              "The installable DKG apps framework was retired in V10. Use the `dkg integration` CLI instead.",
            docs: "https://github.com/OriginTrail/dkg/tree/main/packages/cli#extending-the-node",
          }),
        );
        return;
      }

      // GET /api/events — SSE stream for real-time UI updates
      if (req.method === "GET" && reqUrl.pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          ...corsHeaders(resolveCorsOrigin(req, corsAllowed)),
        });
        res.write(`event: connected\ndata: {}\n\n`);
        sseClients.add(res);
        const heartbeat = setInterval(() => {
          try { res.write(`: heartbeat\n\n`); } catch { /* closed */ }
        }, 30_000);
        req.on("close", () => { sseClients.delete(res); clearInterval(heartbeat); });
        return;
      }

      // Shared memory (workspace) TTL settings — V10 and legacy routes
      if (
        req.method === "GET" &&
        (reqUrl.pathname === "/api/settings/shared-memory-ttl" ||
          reqUrl.pathname === "/api/settings/workspace-ttl")
      ) {
        const ttlMs =
          resolveSharedMemoryTtlMs(config) ?? 30 * 24 * 60 * 60 * 1000;
        return jsonResponse(res, 200, {
          ttlMs,
          ttlDays: Math.round(ttlMs / (24 * 60 * 60 * 1000)),
        });
      }
      if (
        req.method === "PUT" &&
        (reqUrl.pathname === "/api/settings/shared-memory-ttl" ||
          reqUrl.pathname === "/api/settings/workspace-ttl")
      ) {
        try {
          const bodyStr = await readBody(req, SMALL_BODY_BYTES);
          const { ttlDays } = JSON.parse(bodyStr ?? "{}") as {
            ttlDays?: number;
          };
          if (
            typeof ttlDays !== "number" ||
            !Number.isFinite(ttlDays) ||
            ttlDays < 0
          ) {
            return jsonResponse(res, 400, {
              error: "ttlDays must be a finite non-negative number",
            });
          }
          const ttlMs = Math.round(ttlDays * 24 * 60 * 60 * 1000);
          config.sharedMemoryTtlMs = ttlMs;
          config.workspaceTtlMs = ttlMs;
          agent.setSharedMemoryTtlMs(ttlMs);
          await saveConfig(config);
          return jsonResponse(res, 200, { ok: true, ttlMs, ttlDays });
        } catch (err: any) {
          if (err instanceof PayloadTooLargeError) throw err;
          return jsonResponse(res, 500, {
            error: err.message ?? "Failed to update shared memory TTL",
          });
        }
      }

      // Node UI routes (metrics, operations, logs, saved queries, chat, static UI)
      const firstToken = validTokens.size > 0 ? validTokens.values().next().value as string : undefined;
      // Only inject the relay-stats provider when this node is actually
      // running a relay server. Without this gate, edge nodes always
      // hit the `relayStatsProvider != null` branch in `api.ts` and
      // surface the "not yet ready" 404 path even though they're a
      // perfectly healthy non-relay node — Codex review on PR #525
      // (round 2) flagged this as a misleading 404. The "this node is
      // not running a relay server" branch was unreachable in
      // production until now.
      //
      // The daemon's DkgConfig doesn't expose `enableRelayServer`
      // independently of `nodeRole` — DKGNode.start() defaults
      // `enableRelayServer` to `nodeRole === 'core'`, and that's the
      // only path the daemon uses. So role-based gating here matches
      // the actual runtime behaviour.
      const relayStatsProvider = role === 'core' ? () => agent.node.getRelayStats() : undefined;
      const handled = await handleNodeUIRequest(req, res, reqUrl, dashDb, nodeUiStaticDir, undefined, metricsCollector, authEnabled ? firstToken : undefined, memoryManager, llmSettings, telemetrySettings, resolveCorsOrigin(req, corsAllowed), relayStatsProvider);
      if (handled) return;

      await handleRequest(
        req,
        res,
        agent,
        publisherControl,
        publisherRuntime,
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
        routePlugins,
        admissionStats,
        emitMemoryGraphChanged,
        emitNotification,
      );
    } catch (err: any) {
      // Single top-level error→HTTP mapping (in http-utils.ts
      // respondWithDaemonError): 413 payload-too-large; 400 SyntaxError /
      // reserved-namespace / NO_FUNDED_PUBLISHER_WALLET; 503/504 for a transient
      // chain-RPC transport exhaustion (so rethrowing lifecycle publish routes
      // get the retryable status); else 500.
      respondWithDaemonError(res, err);
    }
    // Note: the admission slot is released on the response's `close` event
    // (registered above), not in a finally here — see the comment at acquire.
  });

  // Bound simultaneous sockets and slow-header connections so a flood of
  // clients can't exhaust file descriptors or park half-open connections.
  // Resolution + assignment live in applyServerLimits (unit-tested); tunable via
  // DKG_MAX_CONNECTIONS / DKG_HEADERS_TIMEOUT_MS, with malformed/empty values
  // falling back to defaults rather than becoming NaN.
  applyServerLimits(server, {
    maxConnectionsEnv: process.env.DKG_MAX_CONNECTIONS,
    maxConnectionsConfig: config.maxConnections,
    headersTimeoutEnv: process.env.DKG_HEADERS_TIMEOUT_MS,
  });

  const apiPort = config.apiPort || 0;
  const apiHost = config.apiHost || "127.0.0.1";

  // Route plugins: loaded before listen() so requests can't race the array; fail-soft per ADR 0001.
  // OT-RFC-41 §4.6.1 / Bundle B1e: bare-name specs resolve from
  // ~/.dkg/plugins (stable root) before the daemon-local node_modules,
  // so plugin installs survive Core slot swaps and Edge npm reinstalls.
  const routePlugins = await loadRoutePlugins(
    config.routePlugins,
    new Logger('route-plugins'),
    { dkgHome: dkgDir() },
  );
  // Validated count for telemetry — `configured=` is 0 for non-arrays so a typo doesn't report character count.
  const configuredCount = countConfiguredPluginSpecs(config.routePlugins);
  log(
    `route-plugins-loaded loaded=${routePlugins.length} configured=${configuredCount}`,
  );

  await new Promise<void>((resolve) => {
    server.listen(apiPort, apiHost, () => resolve());
  });
  const boundPort = (server.address() as any).port as number;
  apiPortRef.value = boundPort;
  await writeApiPort(boundPort);

  corsAllowed = buildCorsAllowlist(config, boundPort);
  daemonState.moduleCorsAllowed = corsAllowed;
  if (corsAllowed !== "*") {
    log(`CORS allowlist: ${corsAllowed.join(", ")}`);
  }

  log(`API listening on http://${apiHost}:${boundPort}`);
  log(`Node UI: http://${apiHost}:${boundPort}/ui`);
  log('Node is running. Use "dkg status" or "dkg peers" to interact.');
  startPostApiPublishing();

  // Graceful shutdown — wrapped with a hard wall-clock timeout so a deadlock in
  // any of the cleanup awaits below (notably `agent.stop()` when in-flight sync
  // work holds libp2p reads open) cannot leave the worker process a zombie. See
  // `./shutdown.ts` for the offset-exit-code convention used to signal forced
  // exits to the supervisor + external monitoring. (`shuttingDown` is hoisted
  // up next to `promoteWorkerLifecycle` above so the worker-stop call inside
  // the cleanup IIFE can read it.)
  async function shutdown(exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    log("Shutting down...");
    // Tell the supervisor's liveness watcher (PR #664) that this is a graceful
    // shutdown before any slow cleanup runs. The watcher reads `api.port`'s
    // absence as "worker is intentionally going down — don't SIGKILL me
    // mid-teardown." Idempotent with the second `removeApiPort()` below in
    // cleanupStateFiles; if shutdown crashes here we'd be in the same state as
    // if the late removeApiPort had failed.
    await removeApiPort().catch((err: any) =>
      log(`Early api.port cleanup error: ${err?.message ?? String(err)}`),
    );
    const cleanupStateFiles = async () => {
      await removePid().catch((err: any) =>
        log(`PID cleanup error: ${err?.message ?? String(err)}`),
      );
      await removeApiPort().catch((err: any) =>
        log(`API port cleanup error: ${err?.message ?? String(err)}`),
      );
    };
    const cleanup = (async () => {
      try {
        if (updateInterval) clearInterval(updateInterval);
        clearInterval(chainScanTimer);
        clearInterval(pingTimer);
        clearInterval(pruneTimer);
        rateLimiter.destroy();
        metricsCollector.stop();
        // Stops log exporters AND flushes + shuts down the OTel SDK.
        await stopTelemetry();
        natStatusWatcherStop?.();
        resetNatStatus();
        await publisherRuntime
          ?.stop()
          .catch((err: any) =>
            log(`Publisher runtime stop error: ${err?.message ?? String(err)}`),
          );
        // Drain the async-promote worker before closing the agent — once
        // `agent.stop()` runs the queue's underlying triple store goes
        // away. We let in-flight promotes complete (or hit
        // `shutdownTimeoutMs`); RFC §6.2 forbids marking `running →
        // queued` here so the next boot's `recoverOnStartup()` decides.
        await promoteWorkerLifecycle?.stop(shuttingDown ? 'daemon shutting down' : null);
        await daemonState.catchupRunner
          ?.close()
          .catch((err: any) =>
            log(`Catch-up runner stop error: ${err?.message ?? String(err)}`),
          );
        server.close();
        await agent.stop();
        // Stop the managed Oxigraph child AFTER the agent has stopped
        // issuing store queries, so an in-flight SPARQL request never
        // races the killed server. No-op when not using oxigraph-server.
        await managedOxigraph
          ?.stop()
          .catch((err: any) =>
            log(`Managed Oxigraph stop error: ${err?.message ?? String(err)}`),
          );
        dashDb.close();
        log("Stopped.");
      } finally {
        await cleanupStateFiles();
      }
    })().catch((err: any) => {
      log(`Shutdown cleanup error: ${err?.message ?? String(err)}`);
    });
    const { forced } = await raceShutdownWithTimeout(
      cleanup,
      SHUTDOWN_HARD_TIMEOUT_MS,
      log,
      cleanupStateFiles,
    );
    process.exit(forced ? encodeForcedShutdownExitCode(exitCode) : exitCode);
  }

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
}
