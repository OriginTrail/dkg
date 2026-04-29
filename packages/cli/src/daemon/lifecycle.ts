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
} from '../config.js';
import { createPublisherControlFromStore, startPublisherRuntimeIfEnabled, type PublisherRuntime } from '../publisher-runner.js';
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
  checkForNewCommit,
  checkForNewCommitWithStatus,
  type UpdateStatus,
  acquireUpdateLock,
  releaseUpdateLock,
  performUpdate,
  performUpdateWithStatus,
  performNpmUpdate,
  checkForUpdate,
} from './auto-update.js';
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

 ██████╗ ██████╗  █████╗ ██████╗ ██╗  ██╗              ██████╗ ██╗  ██╗ ██████╗     ██╗   ██╗ █████╗
██╔════╝ ██╔══██╗██╔══██╗██╔══██╗██║  ██║              ██╔══██╗██║ ██╔╝██╔════╝     ██║   ██║██╔══██╗
██║  ███╗██████╔╝███████║██████╔╝███████║    █████╗    ██║  ██║█████╔╝ ██║  ███╗    ██║   ██║╚██████║
██║   ██║██╔══██╗██╔══██║██╔═══╝ ██╔══██║    ╚════╝    ██║  ██║██╔═██╗ ██║   ██║    ╚██╗ ██╔╝ ╚═══██║
╚██████╔╝██║  ██║██║  ██║██║     ██║  ██║              ██████╔╝██║  ██╗╚██████╔╝     ╚████╔╝  █████╔╝
 ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝              ╚═════╝ ╚═╝  ╚═╝ ╚═════╝       ╚═══╝   ╚════╝
`;
  origStdoutWrite(banner + "\n");
  appendFile(logFile, banner + "\n").catch(() => {});

  const nodeVersion = getNodeVersion();
  const nodeCommit = getCurrentCommitShort(); // cached once at startup — avoids execSync in hot path
  const versionTag = nodeCommit
    ? `v${nodeVersion}, ${nodeCommit}`
    : `v${nodeVersion}`;
  log(`Starting DKG ${role} node "${config.name}" (${versionTag})...`);

  const network = await loadNetworkConfig();
  const syncContextGraphs = [
    ...new Set([
      ...resolveContextGraphs(config),
      ...resolveNetworkDefaultContextGraphs(network),
    ]),
  ];

  // Load operational wallets from ~/.dkg/wallets.json (auto-generated on first run)
  const opWallets = await loadOpWallets(dkgDir());
  log(`Operational wallets (${opWallets.wallets.length}):`);
  for (const w of opWallets.wallets) {
    log(`  ${w.address}`);
  }

  // Field-level merge of CLI config + network/<env>.json#chain.
  // Operators can override individual fields (e.g. just rpcUrl) without
  // restating the rest; missing fields fall back to the network defaults.
  const chainBase = resolveChainConfig(config, network);

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

  const agent = await DKGAgent.create({
    name: config.name,
    framework: "DKG",
    listenPort: config.listenPort,
    dataDir: dkgDir(),
    bootstrapPeers: config.bootstrapPeers,
    relayPeers,
    announceAddresses: config.announceAddresses,
    nodeRole: role,
    syncContextGraphs: syncContextGraphs,
    storeConfig: config.store ? {
      backend: config.store.backend,
      options: config.store.options,
    } : undefined,
    chainAdapter: mockChainAdapter,
    // Only forward chain to the agent when both required fields resolved.
    // resolveChainConfig() may return a partial block if neither config nor
    // network supplies one of them; the agent expects rpcUrl + hubAddress.
    chainConfig: chainBase?.rpcUrl && chainBase?.hubAddress ? {
      rpcUrl: chainBase.rpcUrl,
      hubAddress: chainBase.hubAddress,
      operationalKeys: opWallets.wallets.map((w) => w.privateKey),
      chainId: chainBase.chainId,
    } : undefined,
    sharedMemoryTtlMs: resolveSharedMemoryTtlMs(config),
  });

  let publisherRuntime: PublisherRuntime | null = null;

  const networkId = await computeNetworkId();
  const publisherControl = createPublisherControlFromStore(agent.store);
  log(`Network: ${networkId.slice(0, 16)}...`);
  if (network?.networkId && network.networkId !== networkId) {
    log(
      `FATAL: genesis mismatch! Expected networkId ${network.networkId.slice(0, 16)}... but computed ${networkId.slice(0, 16)}...`,
    );
    log(
      `This node's genesis does not match network/testnet.json. Rebuild or update the repo.`,
    );
    process.exit(1);
  }
  if (network) {
    log(
      `Network config: ${network.networkName} (genesis v${network.genesisVersion})`,
    );
  }

  let chatDb: DashboardDB | null = null;
  agent.onChat((text, senderPeerId, _convId) => {
    if (chatDb) {
      try {
        chatDb.insertChatMessage({
          ts: Date.now(),
          direction: "in",
          peer: senderPeerId,
          text,
        });
      } catch {
        /* never crash */
      }
      try {
        chatDb.insertNotification({
          ts: Date.now(),
          type: "chat_message",
          title: "New message",
          message: `Message from ${shortId(senderPeerId)}: ${text.slice(0, 120)}`,
          source: "peer-chat",
          peer: senderPeerId,
        });
      } catch {
        /* never crash */
      }
    }
    log(`CHAT IN  [${shortId(senderPeerId)}]: ${text}`);
  });

  await agent.start();
  await agent.publishProfile();

  const publisherChainBase = chainBase?.rpcUrl && chainBase?.hubAddress
    ? {
        rpcUrl: chainBase.rpcUrl,
        hubAddress: chainBase.hubAddress,
        chainId: chainBase.chainId,
      }
    : undefined;
  publisherRuntime = await startPublisherRuntimeIfEnabled({
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
      sendP2P: async (peerId: string, protocol: string, data: Uint8Array) => {
        return agent.router.send(peerId, protocol, data);
      },
      getConnectedCorePeers: () => {
        const allPeers = agent.node.libp2p
          .getPeers()
          .map((p) => p.toString())
          .filter((id) => id !== agent.peerId);
        const knownCorePeerIds = (agent as any).knownCorePeerIds as
          | Set<string>
          | undefined;
        if (knownCorePeerIds && knownCorePeerIds.size > 0) {
          const filtered = allPeers.filter((id) => knownCorePeerIds.has(id));
          if (filtered.length > 0) return filtered;
        }
        return allPeers;
      },
      log,
    }),
    log,
  });

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

  // Ensure configured context graphs + network defaults are subscribed and available.
  // Uses ensureParanetLocal (idempotent) to avoid duplicate creator claims
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
  setTimeout(async () => {
    try {
      const found = await agent.discoverContextGraphsFromChain();
      if (found > 0)
        log(`Chain scan: discovered ${found} new context graph(s)`);
    } catch {
      /* non-critical */
    }
  }, 15_000);
  const chainScanTimer = setInterval(async () => {
    try {
      const found = await agent.discoverContextGraphsFromChain();
      if (found > 0)
        log(`Chain scan: discovered ${found} new context graph(s)`);
    } catch {
      /* non-critical */
    }
  }, CHAIN_SCAN_INTERVAL_MS);
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
  const standalone = isStandaloneInstall();
  const hasGitConfig = !!au;

  if (standalone || hasGitConfig) {
    const checkIntervalMs = (au?.checkIntervalMinutes ?? 30) * 60_000;
    const allowPre = au?.allowPrerelease ?? true;

    if (standalone) {
      log(
        `Auto-update (npm): ${au ? "enabled" : "disabled — version check only"} (every ${au?.checkIntervalMinutes ?? 30}min)`,
      );
    } else if (au) {
      log(
        `Auto-update enabled: ${au.repo}@${au.branch} (every ${au.checkIntervalMinutes}min)`,
      );
    }

    const runCheck = async () => {
      let updateAvailable = false;
      let targetNpmVersion = "";

      if (standalone) {
        const npmStatus = await checkForNpmVersionUpdate(log, allowPre);
        if (npmStatus.status !== "error") {
          daemonState.lastUpdateCheck.upToDate = npmStatus.status === "up-to-date";
          daemonState.lastUpdateCheck.checkedAt = Date.now();
          if (npmStatus.version)
            daemonState.lastUpdateCheck.latestVersion = npmStatus.version;
        }
        if (npmStatus.status === "available" && npmStatus.version) {
          updateAvailable = true;
          targetNpmVersion = npmStatus.version;
        }
      } else if (au) {
        const commitStatus = await checkForNewCommitWithStatus(au, log);
        if (commitStatus.status !== "error") {
          daemonState.lastUpdateCheck.upToDate = commitStatus.status === "up-to-date";
          daemonState.lastUpdateCheck.checkedAt = Date.now();
          if (commitStatus.commit)
            daemonState.lastUpdateCheck.latestCommit = commitStatus.commit.slice(0, 8);
        }
        updateAvailable = commitStatus.status === "available";
      }

      if (au && updateAvailable) {
        daemonState.isUpdating = true;
        let updated = false;
        if (standalone && targetNpmVersion) {
          const status = await performNpmUpdate(targetNpmVersion, log);
          updated = status === "updated";
        } else {
          updated = await checkForUpdate(au, log);
        }
        daemonState.isUpdating = false;
        if (updated) {
          log("Auto-update: update activated; exiting for supervised restart.");
          await shutdown(DAEMON_EXIT_CODE_RESTART);
          return;
        }
      }
    };

    setTimeout(runCheck, 15_000);
    updateInterval = setInterval(runCheck, checkIntervalMs);
  }

  // --- Dashboard DB + Metrics ---

  const dashDb = new DashboardDB({ dataDir: dkgDir() });
  chatDb = dashDb;
  log("Dashboard DB initialized at " + join(dkgDir(), "node-ui.db"));

  Logger.setSink((entry) => {
    try {
      dashDb.insertLog({
        ts: Date.now(),
        level: entry.level,
        operation_name: entry.operationName,
        operation_id: entry.operationId,
        module: entry.module,
        message: entry.message,
      });
    } catch {
      /* DB write must never break the node */
    }
    logPusher?.push(entry);
  });

  // Extract the plain value from an RDF typed literal like "6"^^<xsd:integer>
  function parseRdfInt(raw: string | undefined): number {
    if (!raw) return 0;
    const m = raw.match(/^"?(\d+)"?\^?\^/);
    if (m) return parseInt(m[1], 10);
    const n = parseInt(raw, 10);
    return isNaN(n) ? 0 : n;
  }

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
    getContextGraphCount: async () => (await agent.listContextGraphs()).length,
    getTotalTriples: async () => {
      const r = await agent.query(
        "SELECT (COUNT(*) AS ?c) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }",
      );
      return parseRdfInt(r?.bindings?.[0]?.c);
    },
    getTotalKCs: async () => {
      const r = await agent.query(
        "SELECT (COUNT(DISTINCT ?kc) AS ?c) WHERE { GRAPH ?g { ?kc a <http://dkg.io/ontology/KnowledgeCollection> } }",
      );
      return parseRdfInt(r?.bindings?.[0]?.c);
    },
    getTotalKAs: async () => {
      const r = await agent.query(
        "SELECT (COUNT(DISTINCT ?ka) AS ?c) WHERE { GRAPH ?g { ?ka a <http://dkg.io/ontology/KnowledgeAsset> } }",
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
      try {
        const s = await stat(join(dkgDir(), "store.nq"));
        return s.size;
      } catch {
        return 0;
      }
    },
    getRpcLatencyMs: async () => 0,
    isRpcHealthy: async () => true,
  };

  const metricsCollector = new MetricsCollector(
    dashDb,
    metricsSource,
    dkgDir(),
  );
  metricsCollector.start();
  log("Metrics collector started (2min interval)");

  // --- Telemetry: syslog log streaming (opt-in) ---
  const networkKey = network?.networkName?.toLowerCase().includes("testnet")
    ? "testnet"
    : "mainnet";
  const syslogEndpoint = TELEMETRY_ENDPOINTS[networkKey]?.syslog;
  let logPusher: LogPushWorker | null = null;

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

  if (config.telemetry?.enabled) {
    const r = startLogPusher();
    if (!r.ok) {
      log(`Telemetry: ${r.error}`);
      config.telemetry.enabled = false;
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

  // Notify on new peer connections
  agent.eventBus.on(DKGEvent.PEER_CONNECTED, (data: any) => {
    try {
      dashDb.insertNotification({
        ts: Date.now(),
        type: "peer_connected",
        title: "Peer connected",
        message: `Peer ${shortId(data.peerId)} connected`,
        source: "network",
        peer: data.peerId,
      });
    } catch {
      /* never crash */
    }
  });

  agent.eventBus.on(DKGEvent.PEER_DISCONNECTED, (data: any) => {
    try {
      dashDb.insertNotification({
        ts: Date.now(),
        type: "peer_disconnected",
        title: "Peer disconnected",
        message: `Peer ${shortId(data.peerId)} disconnected`,
        source: "network",
        peer: data.peerId,
      });
    } catch {
      /* never crash */
    }
  });

  // Track publishes via KC_PUBLISHED event (covers GossipSub-received publishes)
  agent.eventBus.on(DKGEvent.KC_PUBLISHED, (data: any) => {
    const ctx = createOperationContext("publish");
    tracker.start(ctx, {
      contextGraphId: data.paranetId,
      details: { kcId: data.kcId, source: "gossipsub" },
    });
    tracker.complete(ctx, { tripleCount: data.tripleCount });
    try {
      dashDb.insertNotification({
        ts: Date.now(),
        type: "kc_published",
        title: "Knowledge published",
        message: `Knowledge collection published${data.paranetId ? ` on context graph ${shortId(data.paranetId)}` : ""}`,
        source: "dkg",
        meta: JSON.stringify({
          kcId: data.kcId,
          contextGraphId: data.paranetId,
        }),
      });
    } catch {
      /* never crash */
    }
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

  agent.eventBus.on(DKGEvent.JOIN_REQUEST_RECEIVED, (data: any) => {
    try {
      dashDb.insertNotification({
        ts: Date.now(),
        type: "join_request",
        title: "Join request received",
        message: `${data.agentName ?? shortId(data.agentAddress)} wants to join project ${shortId(data.contextGraphId)}`,
        source: "access-control",
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
        meta: JSON.stringify({
          contextGraphId: data.contextGraphId,
          agentAddress: data.agentAddress,
        }),
      });
      sseBroadcast("join_approved", {
        contextGraphId: data.contextGraphId,
        agentAddress: data.agentAddress,
      });
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
        meta: JSON.stringify({
          contextGraphId: data.contextGraphId,
          agentAddress: data.agentAddress,
        }),
      });
      sseBroadcast("join_rejected", {
        contextGraphId: data.contextGraphId,
        agentAddress: data.agentAddress,
      });
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
        view?: "working-memory" | "shared-working-memory" | "verified-memory";
        agentAddress?: string;
        assertionName?: string;
        subGraphName?: string;
      },
    ) => agent.query(sparql, opts),
    share: (
      contextGraphId: string,
      quads: any[],
      opts?: { localOnly?: boolean; subGraphName?: string },
    ) => agent.share(contextGraphId, quads, opts),
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
      return { written: quads.length };
    },
    publishFromSharedMemory: (
      contextGraphId: string,
      selection: "all" | { rootEntities: string[] },
      opts?: { clearSharedMemoryAfter?: boolean },
    ) => agent.publishFromSharedMemory(contextGraphId, selection, opts),
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
        const r = startLogPusher();
        if (!r.ok) return r;
      } else {
        stopLogPusher();
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
    latestByParanet: new Map(),
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
      if (
        !httpAuthGuard(
          req,
          res,
          authEnabled,
          validTokens,
          resolveCorsOrigin(req, corsAllowed),
        )
      )
        return;

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
      const handled = await handleNodeUIRequest(req, res, reqUrl, dashDb, nodeUiStaticDir, undefined, metricsCollector, authEnabled ? firstToken : undefined, memoryManager, llmSettings, telemetrySettings, resolveCorsOrigin(req, corsAllowed));
      if (handled) return;

      await handleRequest(
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
      );
    } catch (err: any) {
      if (res.headersSent || res.writableEnded) return;
      if (err instanceof PayloadTooLargeError) {
        jsonResponse(res, 413, { error: err.message });
      } else if (err instanceof SyntaxError) {
        jsonResponse(res, 400, { error: err.message });
      } else if (
        // Round 9 Bug 25: user-authored quads with reserved URN prefixes
        // map to 400 at the top-level catch so share/publish/conditionalShare
        // routes (which rethrow for the top-level handler) get the correct
        // status without each route having to match on the error shape.
        err?.name === "ReservedNamespaceError" ||
        (typeof err?.message === "string" &&
          err.message.includes("reserved namespace"))
      ) {
        jsonResponse(res, 400, { error: err.message });
      } else {
        enrichEvmError(err);
        jsonResponse(res, 500, { error: err.message });
      }
    }
  });

  const apiPort = config.apiPort || 0;
  const apiHost = config.apiHost || "127.0.0.1";
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

  // Graceful shutdown
  let shuttingDown = false;
  async function shutdown(exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    log("Shutting down...");
    if (updateInterval) clearInterval(updateInterval);
    clearInterval(chainScanTimer);
    clearInterval(pingTimer);
    clearInterval(pruneTimer);
    rateLimiter.destroy();
    metricsCollector.stop();
    await publisherRuntime
      ?.stop()
      .catch((err: any) =>
        log(`Publisher runtime stop error: ${err?.message ?? String(err)}`),
      );
    await daemonState.catchupRunner
      ?.close()
      .catch((err: any) =>
        log(`Catch-up runner stop error: ${err?.message ?? String(err)}`),
      );
    server.close();
    await agent.stop();
    dashDb.close();
    await removePid();
    await removeApiPort();
    log("Stopped.");
    process.exit(exitCode);
  }

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
}
