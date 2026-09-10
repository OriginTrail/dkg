// daemon/routes/local-agents.ts
//
// Route handlers for local-agent-integrations list / connect / update / reverse / refresh.
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
  type LocalAgentAttachStatePatch,
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
  reverseHermesSetupForUi,
  reverseLocalAgentSetupForUi,
  refreshLocalAgentIntegrationFromUi,
} from '../local-agents.js';
import { mutableConfigSnapshot } from '../../daemon-config-store.js';
import {
  primeAgentDkgSessionId,
  readPrimeAgentSessions,
} from '../prime-agent.js';

import {
  currentDaemonConfig,
  updateDaemonConfig,
  type RequestContext,
} from './context.js';

/**
 * Prime Agent is the one integration whose "is it there" answer is not derivable
 * from config: a bridge exists per live session, so the count changes without
 * anything in the node changing. The listing therefore reads the discovery
 * directory (a sync readdir over a handful of small files, already the hot path
 * for the chat routes) so the UI can distinguish "installed but idle" from
 * "not installed" without a second round trip.
 */
function withPrimeAgentSessionCounts<T extends { id: string; metadata?: Record<string, unknown> }>(
  integrations: T[],
): T[] {
  return integrations.map((integration) => {
    if (integration.id !== 'prime-agent') return integration;
    let sessions: ReturnType<typeof readPrimeAgentSessions>;
    try {
      sessions = readPrimeAgentSessions();
    } catch {
      // Discovery is best-effort: an unreadable directory must not take down
      // the whole integrations listing.
      return integration;
    }
    const metadata: Record<string, unknown> = {
      ...(integration.metadata ?? {}),
      sessionCount: sessions.length,
    };
    if (sessions[0]) {
      metadata.activeSessionId = sessions[0].sessionId;
      metadata.activeMemorySessionId = primeAgentDkgSessionId(sessions[0].sessionId);
    } else {
      // A zero-session listing must not keep advertising the connect-time
      // session ids: node-ui pins history to activeMemorySessionId, and stale
      // raw/memory ids would route every send into a guaranteed 409.
      delete metadata.activeSessionId;
      delete metadata.activeMemorySessionId;
    }
    return { ...integration, metadata };
  });
}

/**
 * Single-integration responses (get / connect / refresh) need the same overlay
 * as the listing: node-ui upserts each of them into its integrations state, so
 * any un-overlaid response would regress the pinned session to the persisted
 * connect-time id until the next listing poll.
 */
function withPrimeAgentSessionCount<T extends { id: string; metadata?: Record<string, unknown> }>(
  integration: T,
): T {
  return withPrimeAgentSessionCounts([integration])[0];
}

function changedObjectFields<T extends Record<string, unknown>>(
  before: T | undefined,
  after: T | undefined,
): T | undefined {
  if (!after) return undefined;
  const changed = Object.fromEntries(Object.entries(after).filter(([key, value]) => (
    JSON.stringify(before?.[key]) !== JSON.stringify(value)
  ))) as T;
  return Object.keys(changed).length > 0 ? changed : undefined;
}

function attachStateDelta(
  baselineEntry: LocalAgentIntegrationConfig | undefined,
  candidateEntry: LocalAgentIntegrationConfig,
): LocalAgentAttachStatePatch {
  const transport = changedObjectFields(
    baselineEntry?.transport as Record<string, unknown> | undefined,
    candidateEntry.transport as Record<string, unknown> | undefined,
  ) as LocalAgentIntegrationTransport | undefined;
  const runtime = changedObjectFields(
    baselineEntry?.runtime as Record<string, unknown> | undefined,
    candidateEntry.runtime as Record<string, unknown> | undefined,
  ) as LocalAgentIntegrationRuntime | undefined;
  const metadata = changedObjectFields(
    baselineEntry?.metadata,
    candidateEntry.metadata,
  );
  return {
    ...(baselineEntry?.enabled !== candidateEntry.enabled
      ? { enabled: candidateEntry.enabled }
      : {}),
    ...(transport ? { transport } : {}),
    ...(runtime ? { runtime } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

/** Rebase only deferred attach-owned state through the canonical config owner. */
export async function persistLocalAgentAttachPatch(
  ctx: Pick<RequestContext, 'configStore'>,
  id: string,
  attachPatch: LocalAgentAttachStatePatch,
): Promise<void> {
  const normalizedId = normalizeIntegrationId(id);
  if (!normalizedId) return;
  await ctx.configStore.update(current => {
    const stored = getStoredLocalAgentIntegrations(current);
    const currentEntry = stored[normalizedId];
    if (!currentEntry) return current;
    // An operator disconnect that completed after setup started always wins,
    // including when a failed attach also proposes enabled:false.
    if (
      currentEntry?.enabled === false
      && (isLocalAgentExplicitlyUserDisabled(currentEntry) || attachPatch.enabled !== false)
    ) {
      return current;
    }
    const next = mutableConfigSnapshot(current);
    updateLocalAgentIntegration(next, normalizedId, attachPatch);
    return next;
  });
}

async function commitPreparedLocalAgentCandidate(
  ctx: Pick<RequestContext, 'configStore'>,
  id: string,
  candidate: DkgConfig,
  baseline: Readonly<DkgConfig>,
  patch?: LocalAgentAttachStatePatch,
): Promise<LocalAgentIntegrationRecord> {
  const normalizedId = normalizeIntegrationId(id);
  const candidateEntry = getStoredLocalAgentIntegrations(candidate)[normalizedId];
  if (!normalizedId || !candidateEntry) throw new Error(`Unknown integration: ${id}`);
  const baselineEntry = getStoredLocalAgentIntegrations(baseline)[normalizedId];
  await ctx.configStore.update(current => {
    const currentEntry = getStoredLocalAgentIntegrations(current)[normalizedId];
    const disconnectedWhilePreparing = !isLocalAgentExplicitlyUserDisabled(baselineEntry)
      && currentEntry?.enabled === false
      && isLocalAgentExplicitlyUserDisabled(currentEntry);
    if (disconnectedWhilePreparing) return current;
    const next = mutableConfigSnapshot(current);
    if (patch) {
      updateLocalAgentIntegration(next, normalizedId, patch);
    } else {
      next.localAgentIntegrations = {
        ...getStoredLocalAgentIntegrations(next),
        [normalizedId]: mergeLocalAgentIntegrationConfig(
          getStoredLocalAgentIntegrations(next)[normalizedId],
          structuredClone(candidateEntry),
          { mergeTransport: normalizedId === 'hermes' },
        ),
      };
      if (normalizedId === 'openclaw') pruneLegacyOpenClawConfig(next);
    }
    return next;
  });
  return getLocalAgentIntegration(ctx.configStore.current as DkgConfig, normalizedId)!;
}

export interface LocalAgentRoutesDeps {
  connectFromUi?: typeof connectLocalAgentIntegrationFromUi;
  refreshFromUi?: typeof refreshLocalAgentIntegrationFromUi;
}

type PreparedUiConnectOutcome =
  | { ok: true; result: { integration: LocalAgentIntegrationRecord; notice?: string } }
  | { ok: false; error: unknown };

export async function handleLocalAgentsRoutes(
  ctx: RequestContext,
  deps: LocalAgentRoutesDeps = {},
): Promise<void> {
  const {
    req,
    res,
    agent,
    publisherControl,
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
    requestAgentAddress,
  } = ctx;
  const config = currentDaemonConfig(ctx);
  // GET /api/local-agent-integrations — generic local agent registry/status surface
  if (req.method === 'GET' && path === '/api/local-agent-integrations') {
    return jsonResponse(res, 200, {
      integrations: withPrimeAgentSessionCounts(listLocalAgentIntegrations(config)),
    });
  }

  // GET /api/local-agent-integrations/:id — single local agent integration status
  if (req.method === 'GET' && path.startsWith('/api/local-agent-integrations/')) {
    const id = path.slice('/api/local-agent-integrations/'.length);
    if (!id) return jsonResponse(res, 404, { error: 'Integration not found' });
    const integration = getLocalAgentIntegration(config, id);
    if (!integration) return jsonResponse(res, 404, { error: `Unknown integration: ${id}` });
    return jsonResponse(res, 200, { integration: withPrimeAgentSessionCount(integration) });
  }

  // POST /api/local-agent-integrations/connect — upsert/connect an integration
  if (req.method === 'POST' && path === '/api/local-agent-integrations/connect') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(body); } catch { return jsonResponse(res, 400, { error: 'Invalid JSON body' }); }
    if (normalizeIntegrationId(typeof parsed.id === 'string' ? parsed.id : '') === 'local-llm') {
      return jsonResponse(res, 409, {
        error: 'DKG Local LLM is daemon-managed and does not require a connect or install step.',
        code: 'DAEMON_MANAGED_INTEGRATION',
      });
    }
    try {
      const source = isPlainRecord(parsed.metadata) && typeof parsed.metadata.source === 'string'
        ? parsed.metadata.source
        : undefined;
      if (source !== 'node-ui') {
        const integration = await updateDaemonConfig(
          ctx,
          draft => connectLocalAgentIntegration(draft, parsed),
        );
        return jsonResponse(res, 200, {
          ok: true,
          integration: withPrimeAgentSessionCount(integration),
        });
      }

      const id = String(parsed.id ?? '');
      const baseline = ctx.configStore.current;
      const candidate = mutableConfigSnapshot(baseline);
      let releaseInitialCommit!: () => void;
      const initialCommitFinished = new Promise<void>(resolve => {
        releaseInitialCommit = resolve;
      });
      let outcome: PreparedUiConnectOutcome;
      try {
        outcome = {
          ok: true,
          result: await (deps.connectFromUi ?? connectLocalAgentIntegrationFromUi)(candidate, parsed, bridgeAuthToken, {
            saveConfig: async (_deferredCandidate, patch) => {
              await initialCommitFinished;
              await persistLocalAgentAttachPatch(ctx, id, patch);
            },
          }),
        };
      } catch (error) {
        outcome = { ok: false, error };
        const normalizedId = normalizeIntegrationId(id);
        if (normalizedId && getStoredLocalAgentIntegrations(candidate)[normalizedId]) {
          updateLocalAgentIntegration(candidate, normalizedId, {
            runtime: {
              status: 'error',
              ready: false,
              lastError: error instanceof Error ? error.message : 'Local agent attach failed',
            },
          });
        }
      }

      if (!outcome.ok && !getStoredLocalAgentIntegrations(candidate)[normalizeIntegrationId(id)]) {
        releaseInitialCommit();
        throw outcome.error;
      }

      let integration: LocalAgentIntegrationRecord;
      try {
        integration = await commitPreparedLocalAgentCandidate(ctx, id, candidate, baseline);
      } finally {
        releaseInitialCommit();
      }
      if (!outcome.ok) throw outcome.error;
      return jsonResponse(res, 200, {
        ok: true,
        integration: withPrimeAgentSessionCount(integration),
        notice: outcome.result.notice,
      });
    } catch (err: any) {
      return jsonResponse(res, 400, { error: err?.message ?? 'Invalid local agent integration payload' });
    }
  }

  // POST /api/local-agent-integrations/:id/refresh — re-probe bridge health (OpenClaw) or
  // return the current record (other integrations that don't yet have a bridge).
  if (
    req.method === 'POST'
    && path.startsWith('/api/local-agent-integrations/')
    && path.endsWith('/refresh')
  ) {
    const segments = path.slice('/api/local-agent-integrations/'.length, -'/refresh'.length);
    if (!segments || segments.includes('/')) {
      return jsonResponse(res, 404, { error: 'Unknown integration' });
    }
    const rawId = decodeURIComponent(segments);
    const normalizedId = normalizeIntegrationId(rawId);
    if (!LOCAL_AGENT_INTEGRATION_DEFINITIONS[normalizedId]) {
      return jsonResponse(res, 404, { error: 'Unknown integration' });
    }
    try {
      const baseline = ctx.configStore.current;
      const candidate = mutableConfigSnapshot(baseline);
      await (deps.refreshFromUi ?? refreshLocalAgentIntegrationFromUi)(candidate, normalizedId, bridgeAuthToken);
      const candidateEntry = getStoredLocalAgentIntegrations(candidate)[normalizedId]!;
      const integration = await commitPreparedLocalAgentCandidate(
        ctx,
        normalizedId,
        candidate,
        baseline,
        attachStateDelta(getStoredLocalAgentIntegrations(baseline)[normalizedId], candidateEntry),
      );
      return jsonResponse(res, 200, { ok: true, integration: withPrimeAgentSessionCount(integration) });
    } catch (err: any) {
      return jsonResponse(res, 400, { error: err?.message ?? 'Integration refresh failed' });
    }
  }

  // PUT /api/local-agent-integrations/:id — partial update for stored integration state
  if (req.method === 'PUT' && path.startsWith('/api/local-agent-integrations/')) {
    const id = path.slice('/api/local-agent-integrations/'.length);
    if (!id) return jsonResponse(res, 404, { error: 'Integration not found' });
    if (normalizeIntegrationId(id) === 'local-llm') {
      return jsonResponse(res, 409, {
        error: 'DKG Local LLM is daemon-managed and cannot be connected or disconnected.',
        code: 'DAEMON_MANAGED_INTEGRATION',
      });
    }
    const body = await readBody(req, SMALL_BODY_BYTES);
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(body); } catch { return jsonResponse(res, 400, { error: 'Invalid JSON body' }); }
    try {
      const normalizedId = normalizeIntegrationId(id);
      const normalizedPatch = normalizeExplicitLocalAgentDisconnectBody(parsed);
      const explicitDisconnect = normalizedPatch.enabled === false
        && isPlainRecord(normalizedPatch.runtime)
        && normalizedPatch.runtime.status === 'disconnected';
      if (explicitDisconnect && normalizedId) {
        cancelPendingLocalAgentAttachJob(normalizedId);
      }

      if (explicitDisconnect && normalizedId === 'openclaw') {
        try {
          await reverseLocalAgentSetupForUi(config);
        } catch (err: any) {
          const integration = await updateDaemonConfig(ctx, draft => (
            updateLocalAgentIntegration(draft, id, {
              runtime: {
                status: 'error',
                ready: false,
                lastError: `OpenClaw disconnect failed: ${err?.message ?? 'unknown error'}`,
              },
            })
          ));
          return jsonResponse(res, 200, { ok: true, integration });
        }
      }

      if (explicitDisconnect && normalizedId === 'prime-agent') {
        // Reverse setup removes our entry from settings.json.extensions. A
        // restore failure must NOT be reported as a failed disconnect: the
        // integration really is disconnected either way, and surfacing it as
        // `error` would leave the operator unable to clear the state. Same
        // posture as the Hermes branch below — warn, do not fail.
        let restoreError: string | undefined;
        try {
          const { restorePrimeAgentProfile } = await import('@origintrail-official/dkg-adapter-prime-agent');
          const result = await restorePrimeAgentProfile({});
          if (!result?.ok) restoreError = result?.restoreError ?? 'restore reported failure';
        } catch (err: any) {
          restoreError = `Prime Agent restore failed: ${err?.message ?? 'unknown error'}`;
        }
        const integration = await updateDaemonConfig(ctx, draft => (
          updateLocalAgentIntegration(draft, id, {
            runtime: {
              status: 'disconnected',
              ready: false,
              lastError: restoreError ?? null,
            },
          })
        ));
        return jsonResponse(res, 200, { ok: true, integration });
      }

      if (explicitDisconnect && normalizedId === 'hermes') {
        let hermesRestoreError: string | undefined;
        try {
          const result = await reverseHermesSetupForUi(config);
          hermesRestoreError = result.restoreError;
        } catch (err: any) {
          // Disconnect proper failed (not restore) — surface as error,
          // matching today's behavior. Restore-only failures fall through
          // to the disconnected-with-warning patch below.
          const integration = await updateDaemonConfig(ctx, draft => (
            updateLocalAgentIntegration(draft, id, {
              runtime: {
                status: 'error',
                ready: false,
                lastError: `Hermes disconnect failed: ${err?.message ?? 'unknown error'}`,
              },
            })
          ));
          return jsonResponse(res, 200, { ok: true, integration });
        }

        // Per setup-entrypoint-contract.md §6: restore failure does NOT roll
        // back the disconnect. Integration stays `disconnected`; the failure
        // surfaces as a warning via `runtime.lastError` while the rest of the
        // patch (enabled:false, runtime.status:'disconnected', ready:false)
        // proceeds normally. The UI's disconnected pill + warning chip
        // (PanelRight.tsx, S3 step 5) renders this combination as warning-not-error.
        if (hermesRestoreError) {
          const integration = await updateDaemonConfig(ctx, draft => (
            updateLocalAgentIntegration(draft, id, {
              ...normalizedPatch,
              runtime: {
                ...(isPlainRecord(normalizedPatch.runtime) ? normalizedPatch.runtime : {}),
                status: 'disconnected',
                ready: false,
                lastError: hermesRestoreError,
              },
            })
          ));
          return jsonResponse(res, 200, { ok: true, integration });
        }
      }

      const integration = await updateDaemonConfig(
        ctx,
        draft => updateLocalAgentIntegration(draft, id, normalizedPatch),
      );
      return jsonResponse(res, 200, { ok: true, integration });
    } catch (err: any) {
      return jsonResponse(res, 400, { error: err?.message ?? 'Invalid local agent integration payload' });
    }
  }
}
