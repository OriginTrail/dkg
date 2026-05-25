// daemon/routes/context-graph.ts
//
// Route handlers for context-graph (+ contextGraph, sub-graph) CRUD, participants, join flow, manifest publish/install.
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

/**
 * Map a `registerContextGraph` failure message to an HTTP status +
 * stable error body. Shared by:
 *   - POST /api/context-graph/register (standalone register call).
 *   - POST /api/context-graph/create { register: true, pcaAccountId }
 *     (atomic combined-flow inline register leg).
 *
 * Codex PR #502 round-8: the combined-flow register failure used to
 * always return HTTP 200 with `registered: false`, which silently
 * masks PCA / authz / shape errors as success unless callers
 * remember to inspect the response body. Both endpoints now share
 * the same 4xx / 5xx mapping for caller-input / unsupported-feature
 * failures; only genuinely transient chain failures keep the
 * 200-partial-success shape via `genericFallbackStatus = 200`.
 *
 * Returns `undefined` when no specific mapping applies — callers
 * decide whether that means generic 500 (standalone /register
 * shape) or a 200-partial-success body (combined flow's transient
 * fallback).
 */
function classifyRegisterContextGraphError(msg: string): { status: number; body?: Record<string, unknown> } | undefined {
  if (msg.includes('already registered')) return { status: 409, body: { error: msg } };
  if (msg.includes('does not exist')) return { status: 404, body: { error: msg } };
  if (msg.includes('no known creator')) return { status: 503, body: { error: msg, hint: 'Creator not yet synced. Retry after sync completes.' } };
  if (msg.includes('Only the context graph creator')) return { status: 403, body: { error: msg } };
  if (msg.includes('Only the context graph curator')) return { status: 403, body: { error: msg } };
  if (msg.includes('address-scoped curator')) return { status: 403, body: { error: msg } };
  if (msg.includes('PCA account id can only be used with curated publish policy')
    || msg.includes('PCA account id can only be used with curated/private context graphs')) {
    return { status: 400, body: { error: msg } };
  }
  if (msg.includes('PCA account id must be a positive integer')) return { status: 400, body: { error: msg } };
  if (msg.includes('requires chain adapter PCA owner lookup support')) return { status: 501, body: { error: msg } };
  if (/PCA account \d+ does not exist or cannot be looked up/.test(msg)) return { status: 404, body: { error: msg } };
  if (/PCA account \d+ is owned by/.test(msg)) return { status: 403, body: { error: msg } };
  // PCA chain-signer / signer-introspection invariants (Codex round-4/5/8):
  if (msg.includes('chain signer') && msg.includes('differs from PCA owner')) return { status: 403, body: { error: msg } };
  if (msg.includes('does not expose its registration-tx signer')
    || msg.includes('invariant cannot be verified')) {
    return { status: 501, body: { error: msg } };
  }
  return undefined;
}

function parseOptionalPcaAccountId(body: Record<string, unknown>): { value?: bigint; error?: string } {
  const raw = body.pcaAccountId;
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw <= 0) {
      return { error: 'pcaAccountId must be a positive safe integer' };
    }
    return { value: BigInt(raw) };
  }
  if (typeof raw === 'string') {
    if (!/^[1-9]\d*$/.test(raw)) {
      return { error: 'pcaAccountId must be a positive decimal integer string' };
    }
    return { value: BigInt(raw) };
  }
  return { error: 'pcaAccountId must be a positive integer or decimal integer string' };
}

export async function handleContextGraphRoutes(ctx: RequestContext): Promise<void> {
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
    emitMemoryGraphChanged,
  } = ctx;


  // POST /api/context-graph/create — context graph definition create.
  // SPEC_CG_MEMORY_MODEL / Codex PR #595 round-4: per-CG hosting
  // committees and per-CG quorum overrides were removed end-to-end.
  // The on-chain contract no longer accepts those args, so silently
  // stripping `participantIdentityIds` / `requiredSignatures` from the
  // request body would let callers believe they created an M-of-N /
  // roster-constrained CG when those constraints were actually
  // discarded. We reject any body that still carries either field with
  // a structured 400 + machine-readable `code`, forcing callers to
  // migrate. The on-chain semantics those fields requested no longer
  // exist; there is no faithful translation.
  if (req.method === "POST" && path === "/api/context-graph/create") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = JSON.parse(body);
    if (parsed.participantIdentityIds !== undefined || parsed.requiredSignatures !== undefined) {
      return jsonResponse(res, 400, {
        error:
          '`participantIdentityIds` and `requiredSignatures` were removed in SPEC_CG_MEMORY_MODEL. Per-CG hosting committees and per-CG quorum overrides no longer exist on-chain — every CG uses the system-wide ACK quorum (parametersStorage.minimumRequiredSignatures()) and the network sharding table for hosting. Remove these fields from the request body and use `{ id, name, accessPolicy?, publishPolicy?, allowedAgents? }` instead.',
        code: 'DEPRECATED_CONTEXT_GRAPH_FIELDS',
        deprecatedFields: [
          ...(parsed.participantIdentityIds !== undefined ? ['participantIdentityIds'] : []),
          ...(parsed.requiredSignatures !== undefined ? ['requiredSignatures'] : []),
        ],
      });
    }
    // Body has `id` + `name` → context-graph-style context graph definition create (handled below)
    const { id, name, description, allowedAgents, allowedPeers, participantAgents, publishPolicy, accessPolicy, register } = parsed;
    if (!id || !name)
      return jsonResponse(res, 400, { error: 'Missing "id" or "name"' });
    if (!isValidContextGraphId(id))
      return jsonResponse(res, 400, { error: "Invalid context graph id" });
    const parsedPcaAccountId = parseOptionalPcaAccountId(parsed);
    if (parsedPcaAccountId.error) {
      return jsonResponse(res, 400, { error: parsedPcaAccountId.error });
    }
    // publishPolicy override is forwarded to `registerContextGraph` in
    // the combined-flow path (Codex PR #502 round-10) — validate the
    // shape the same way /api/context-graph/register does so callers
    // get an actionable 400 instead of a 500 from the agent layer.
    if (publishPolicy !== undefined && publishPolicy !== 0 && publishPolicy !== 1) {
      return jsonResponse(res, 400, { error: '"publishPolicy" must be 0 (curated) or 1 (open)' });
    }
    // pcaAccountId is a curated-publish signal: reject ONLY the
    // explicit `publishPolicy: 1 (open)` combo at the API boundary
    // instead of letting it surface as a 500 from the agent.
    //
    // Note: we deliberately do NOT reject `accessPolicy: 0 (public)`
    // alongside pcaAccountId — the on-chain
    // `ContextGraphs.createContextGraph` contract supports
    // `{ accessPolicy: 0, publishPolicy: 0, pcaAccountId: !=0 }`
    // (publicly-discoverable CG where only PCA-authorized publishers
    // can write). Rejecting it here would block a valid registration
    // mode (Codex PR #502 round-7).
    if (parsedPcaAccountId.value !== undefined && publishPolicy === 1) {
      return jsonResponse(res, 400, { error: 'pcaAccountId is only valid with curated publish policy (publishPolicy=0)' });
    }
    // OT-RFC-38 / LU-6 Phase B (Codex PR #610 fd5b31f1 fix):
    // pcaAccountId on a create-only request used to be a silent foot-
    // gun because `createContextGraph()` didn't persist it, so a later
    // auto-register on first VM publish would silently fall back to
    // raw EOA-curated. The same was true for `publishPolicy` — the UI
    // exposes a curated-vs-open radio at create time, but the choice
    // was lost when registration deferred. Both knobs are now
    // persisted at create time via `DKG_PUBLISH_POLICY` /
    // `DKG_PUBLISH_AUTHORITY_ACCOUNT_ID` triples and re-read by
    // `memory.ts`'s deferred-register call. Codex PR #502 round-5's
    // safety rationale is preserved end-to-end without forcing
    // callers into the combined-flow constraint.
    // Effective accessPolicy for both the create and the (optional)
    // register-during-create leg below. Priority:
    //   1. `private: true` is a curated signal that overrides any
    //      explicit `accessPolicy` (matches the agent's createContextGraph
    //      treatment of the legacy `private` flag).
    //   2. Explicit `accessPolicy` wins next.
    //   3. `pcaAccountId` alone is a curated signal — coerce to 1 so raw
    //      HTTP/SDK callers don't have to also know to set accessPolicy.
    //   4. Otherwise leave undefined and let the agent default it.
    // Codex review #502-2: the register leg used to read raw `accessPolicy`
    // here, so `{ private: true, accessPolicy: 0, pcaAccountId, register: true }`
    // created the CG locally and then immediately failed registration as
    // open-with-PCA. Routing through `inferredAccessPolicy` keeps the
    // create+register pair consistent.
    const inferredAccessPolicy = parsed.private === true
      ? 1
      : typeof accessPolicy === 'number'
        ? accessPolicy
        : parsedPcaAccountId.value !== undefined
          ? 1
          : undefined;
    try {
      // OT-RFC-38 / LU-6 Phase B (Codex PR #610 fd5b31f1 fix):
      // forward both register-time knobs to createContextGraph so the
      // user's create-time choice survives the deferred-registration
      // path. Re-supplying them on `/register` still wins (caller
      // arg > stored), so the two-step flow keeps its override
      // semantics; the one-step flow keeps its single-call UX.
      await agent.createContextGraph({
        id,
        name,
        description,
        allowedAgents: Array.isArray(allowedAgents) ? allowedAgents : undefined,
        allowedPeers: Array.isArray(allowedPeers) ? allowedPeers : undefined,
        participantAgents: Array.isArray(participantAgents) ? participantAgents : undefined,
        accessPolicy: inferredAccessPolicy,
        publishPolicy: typeof publishPolicy === 'number' ? publishPolicy : undefined,
        publishAuthorityAccountId: parsedPcaAccountId.value,
        callerAgentAddress: requestAgentAddress,
        ...(parsed.private === true ? { private: true } : {}),
      });
    } catch (err: any) {
      const msg = err?.message ?? "";
      if (
        msg.includes("already exists") ||
        msg.includes("duplicate") ||
        msg.includes("conflict")
      ) {
        return jsonResponse(res, 409, { error: msg });
      }
      throw err;
    }
    // Registration is opt-in: callers that want on-chain registration
    // pass `register: true`. Otherwise CG stays local-only and can be
    // registered later via POST /api/context-graph/register.
    if (register === true) {
      try {
        const regResult = await agent.registerContextGraph(id, {
          callerAgentAddress: requestAgentAddress,
          accessPolicy: inferredAccessPolicy,
          publishPolicy: typeof publishPolicy === 'number' ? publishPolicy : undefined,
          publishAuthorityAccountId: parsedPcaAccountId.value,
        });
        return jsonResponse(res, 200, {
          created: id,
          uri: `did:dkg:context-graph:${id}`,
          registered: true,
          onChainId: regResult.onChainId,
        });
      } catch (regErr: any) {
        const regMsg = regErr?.message ?? 'unknown error';
        process.stderr.write(`[DKG-Daemon] WARN: Context graph "${id}" created locally but on-chain registration failed: ${regMsg}\n`);
        // No rollback of `pcaAccountId` needed: `createContextGraph`
        // no longer persists it (Codex PR #502 round-3) — callers must
        // resupply at register time, so a failed register leg simply
        // leaves the CG with no stored PCA id, which is the correct
        // "no PCA yet" state.
        //
        // We deliberately keep the 200 partial-success shape here even
        // for "classified" register failures (Codex PR #502 round-9
        // reversal of round-8). The create leg already succeeded —
        // the CG exists locally — so returning a hard HTTP error
        // would break existing callers that rely on
        // `created: true, registered: false` to retry the register
        // step without re-running create (or hitting 409). Callers
        // detect register-leg failures by inspecting `registered`
        // (`true`/`false`) and `registerError`; the classified
        // status code from `classifyRegisterContextGraphError` is
        // surfaced as `registerErrorStatus` so SDK callers can map
        // it to the same 4xx semantics as the standalone /register
        // endpoint without changing the HTTP envelope status.
        const classified = classifyRegisterContextGraphError(regMsg);
        return jsonResponse(res, 200, {
          created: id,
          uri: `did:dkg:context-graph:${id}`,
          registered: false,
          registerError: regMsg,
          ...(classified ? { registerErrorStatus: classified.status } : {}),
          hint: 'CG created locally. Use POST /api/context-graph/register to retry on-chain registration.',
        });
      }
    }
    return jsonResponse(res, 200, { created: id, uri: `did:dkg:context-graph:${id}` });
  }

  // POST /api/context-graph/register — on-chain registration (upgrade from free CG)
  if (req.method === 'POST' && path === '/api/context-graph/register') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const { id, accessPolicy, publishPolicy, strictEoaCuratorMatch } = parsed;
    if (!id) return jsonResponse(res, 400, { error: 'Missing "id"' });
    if (typeof id !== 'string') return jsonResponse(res, 400, { error: '"id" must be a string' });
    if (!isValidContextGraphId(id)) return jsonResponse(res, 400, { error: 'Invalid context graph id' });
    if (accessPolicy !== undefined && (accessPolicy !== 0 && accessPolicy !== 1)) {
      return jsonResponse(res, 400, { error: '"accessPolicy" must be 0 (open) or 1 (private)' });
    }
    if (publishPolicy !== undefined && (publishPolicy !== 0 && publishPolicy !== 1)) {
      return jsonResponse(res, 400, { error: '"publishPolicy" must be 0 (curated) or 1 (open)' });
    }
    if (strictEoaCuratorMatch !== undefined && typeof strictEoaCuratorMatch !== 'boolean') {
      return jsonResponse(res, 400, { error: '"strictEoaCuratorMatch" must be a boolean' });
    }
    const parsedPcaAccountId = parseOptionalPcaAccountId(parsed);
    if (parsedPcaAccountId.error) {
      return jsonResponse(res, 400, { error: parsedPcaAccountId.error });
    }
    if (parsedPcaAccountId.value !== undefined && publishPolicy === 1) {
      return jsonResponse(res, 400, { error: 'pcaAccountId is only valid for curated context graphs (publishPolicy=0)' });
    }
    try {
      // OT-RFC-38 / LU-6 Phase B (Codex PR #610 fd5b31f1 round-2):
      // expose `strictEoaCuratorMatch` opt-in on the public registration
      // API. Default behaviour is the relaxed "auto-promote chain signer
      // as on-chain owner" path (single-tenant edge nodes — the mainnet
      // launch deployment shape — see `registerContextGraph` jsdoc),
      // but multi-tenant operators can pass `strictEoaCuratorMatch:true`
      // to require an exact wallet match before registration proceeds.
      const result = await agent.registerContextGraph(id, {
        accessPolicy,
        publishPolicy,
        callerAgentAddress: requestAgentAddress,
        publishAuthorityAccountId: parsedPcaAccountId.value,
        ...(strictEoaCuratorMatch === true ? { strictEoaCuratorMatch: true } : {}),
      });
      return jsonResponse(res, 200, {
        registered: id,
        onChainId: result.onChainId,
        ...(result.txHash ? { txHash: result.txHash } : {}),
        hint: 'Context graph registered on-chain. You can now publish SWM to Verified Memory.',
      });
    } catch (err: any) {
      const msg = err?.message ?? '';
      const classified = classifyRegisterContextGraphError(msg);
      if (classified) {
        return jsonResponse(res, classified.status, classified.body ?? { error: msg });
      }
      return jsonResponse(res, 500, { error: msg });
    }
  }

  // POST /api/context-graph/invite — invite a peer to a context graph
  if (req.method === 'POST' && path === '/api/context-graph/invite') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const { contextGraphId, peerId: targetPeerId } = parsed;
    if (!contextGraphId || !targetPeerId) {
      return jsonResponse(res, 400, { error: 'Missing "contextGraphId" or "peerId"' });
    }
    if (!isValidContextGraphId(contextGraphId)) return jsonResponse(res, 400, { error: 'Invalid context graph id' });
    try {
      await agent.inviteToContextGraph(contextGraphId, targetPeerId, requestAgentAddress);
      return jsonResponse(res, 200, { invited: targetPeerId, contextGraphId });
    } catch (err: any) {
      const msg = err?.message ?? '';
      if (msg.includes('does not exist')) {
        return jsonResponse(res, 404, { error: msg });
      }
      if (msg.includes('no known creator')) {
        return jsonResponse(res, 503, { error: msg, hint: 'Creator not yet synced. Retry after sync completes.' });
      }
      if (msg.includes('Only the context graph creator')) {
        return jsonResponse(res, 403, { error: msg });
      }
      if (msg.includes('Invalid peer ID format')) {
        return jsonResponse(res, 400, { error: msg });
      }
      return jsonResponse(res, 500, { error: msg });
    }
  }

  // POST /api/sub-graph/create  { contextGraphId, subGraphName }
  if (req.method === "POST" && path === "/api/sub-graph/create") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const { contextGraphId, subGraphName } = parsed;
    if (!subGraphName)
      return jsonResponse(res, 400, { error: 'Missing "subGraphName"' });
    if (!validateRequiredContextGraphId(contextGraphId, res)) return;
    if (typeof subGraphName !== "string")
      return jsonResponse(res, 400, {
        error: '"subGraphName" must be a string',
      });
    const sgVal = validateSubGraphName(subGraphName);
    if (!sgVal.valid)
      return jsonResponse(res, 400, {
        error: `Invalid "subGraphName": ${sgVal.reason}`,
      });
    try {
      await agent.createSubGraph(contextGraphId, subGraphName);
      emitMemoryGraphChanged?.({
        contextGraphId,
        layers: [],
        subGraphName,
        operation: "sub_graph_created",
        source: "api",
      });
      return jsonResponse(res, 200, { created: subGraphName, contextGraphId });
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

  // GET /api/sub-graph/list?contextGraphId=...
  // Returns per-sub-graph metadata + entity/triple counts so UIs can render a
  // SubGraphBar without a second round-trip per sub-graph.
  if (req.method === "GET" && path === "/api/sub-graph/list") {
    const qs = new URL(req.url ?? "", "http://localhost").searchParams;
    const contextGraphId = qs.get("contextGraphId");
    if (!validateRequiredContextGraphId(contextGraphId, res)) return;
    try {
      const registered = await agent.listSubGraphs(contextGraphId!);
      // One pass enumerates *all* named graphs in the project + their
      // distinct-subject and triple counts. Sub-graph ownership is inferred
      // from the named-graph path segment after the context-graph id:
      //   did:dkg:context-graph:<cg>/<subGraph>/assertion/<author>/<name>
      //   did:dkg:context-graph:<cg>/<subGraph>   (committed sub-graph view)
      // This is one SPARQL round-trip regardless of how many sub-graphs exist.
      const counts = new Map<string, { entityCount: number; tripleCount: number }>();
      try {
        const sparql = `
          SELECT ?g (COUNT(DISTINCT ?s) AS ?entities) (COUNT(*) AS ?triples)
          WHERE { GRAPH ?g { ?s ?p ?o } }
          GROUP BY ?g
        `;
        const result = await agent.query(sparql, { contextGraphId: contextGraphId! });
        const prefix = `did:dkg:context-graph:${contextGraphId}/`;
        const parseCount = (v: any) => {
          if (v === undefined || v === null) return 0;
          const s = typeof v === 'string' ? v : (v && typeof v === 'object' && 'value' in v ? (v as any).value : '');
          const m = String(s).match(/^"?(\d+)/);
          return m ? Number(m[1]) : 0;
        };
        for (const row of (result?.bindings ?? []) as Array<Record<string, any>>) {
          const g = typeof row.g === 'string' ? row.g : (row.g && typeof row.g === 'object' && 'value' in row.g ? row.g.value : undefined);
          if (!g || !g.startsWith(prefix)) continue;
          const tail = g.slice(prefix.length);
          // tail starts with either "<subGraphName>/..." or "_meta" or "_shared_memory".
          // Only care about the first segment, but skip daemon-internal graphs.
          const firstSlash = tail.indexOf('/');
          const seg = firstSlash >= 0 ? tail.slice(0, firstSlash) : tail;
          if (!seg || seg.startsWith('_')) continue;
          const entry = counts.get(seg) ?? { entityCount: 0, tripleCount: 0 };
          entry.entityCount += parseCount(row.entities);
          entry.tripleCount += parseCount(row.triples);
          counts.set(seg, entry);
        }
      } catch {
        // Counts are best-effort — UI degrades to zeros on query failure.
      }
      const items = registered.map((sg) => ({
        name: sg.name,
        uri: sg.uri,
        description: sg.description,
        createdBy: sg.createdBy,
        createdAt: sg.createdAt,
        entityCount: counts.get(sg.name)?.entityCount ?? 0,
        tripleCount: counts.get(sg.name)?.tripleCount ?? 0,
      }));
      return jsonResponse(res, 200, { contextGraphId, subGraphs: items });
    } catch (err: any) {
      if (err.message?.includes("not found") || err.message?.includes("Invalid")) {
        return jsonResponse(res, 400, { error: err.message });
      }
      throw err;
    }
  }

  // POST /api/context-graph/{id}/add-participant
  const addParticipantMatch = path.match(/^\/api\/context-graph\/([^/]+)\/add-participant$/);
  if (req.method === "POST" && addParticipantMatch) {
    const contextGraphId = decodeURIComponent(addParticipantMatch[1]);
    const body = await readBody(req);
    const { agentAddress } = JSON.parse(body);
    if (!agentAddress || typeof agentAddress !== 'string') {
      return jsonResponse(res, 400, { error: 'agentAddress is required' });
    }
    try {
      await agent.inviteAgentToContextGraph(contextGraphId, agentAddress, requestAgentAddress);
      return jsonResponse(res, 200, { ok: true, contextGraphId, agentAddress });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse(res, 400, { error: msg });
    }
  }

  // POST /api/context-graph/{id}/remove-participant
  const removeParticipantMatch = path.match(/^\/api\/context-graph\/([^/]+)\/remove-participant$/);
  if (req.method === "POST" && removeParticipantMatch) {
    const contextGraphId = decodeURIComponent(removeParticipantMatch[1]);
    const body = await readBody(req);
    const { agentAddress } = JSON.parse(body);
    if (!agentAddress || typeof agentAddress !== 'string') {
      return jsonResponse(res, 400, { error: 'agentAddress is required' });
    }
    try {
      await agent.removeAgentFromContextGraph(contextGraphId, agentAddress, requestAgentAddress);
      return jsonResponse(res, 200, { ok: true, contextGraphId, agentAddress });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse(res, 400, { error: msg });
    }
  }

  // GET /api/context-graph/{id}/participants
  const listParticipantsMatch = path.match(/^\/api\/context-graph\/([^/]+)\/participants$/);
  if (req.method === "GET" && listParticipantsMatch) {
    const contextGraphId = decodeURIComponent(listParticipantsMatch[1]);
    try {
      const agents = await agent.getContextGraphAllowedAgents(contextGraphId);
      return jsonResponse(res, 200, { contextGraphId, allowedAgents: agents });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse(res, 400, { error: msg });
    }
  }

  // POST /api/context-graph/{id}/request-join — signed join request from an invitee
  // If local node is the curator (owns the CG), store locally.
  // Otherwise, forward via P2P to all connected peers so the curator receives it.
  const requestJoinMatch = path.match(/^\/api\/context-graph\/([^/]+)\/request-join$/);
  if (req.method === "POST" && requestJoinMatch) {
    const contextGraphId = decodeURIComponent(requestJoinMatch[1]);
    const body = await readBody(req);
    try {
      const parsed = JSON.parse(body);
      const { agentName, curatorPeerId, delegation } = parsed;
      if (!delegation || !delegation.agentAddress || !delegation.signature) {
        return jsonResponse(res, 400, {
          error: 'Missing signed delegation. Expected `delegation` field with agentAddress, signature, scope, issuedAtMs and at least one of delegateePeerId / delegateeOpKey.',
        });
      }
      agent.verifyJoinRequest(contextGraphId, delegation);

      const isCurator = await agent.isCuratorOf(contextGraphId);
      if (isCurator) {
        await agent.storePendingJoinRequest(contextGraphId, delegation, agentName);
        return jsonResponse(res, 200, { ok: true, status: 'pending', delivered: 'local' });
      }

      // V10 invites carry the curator's peer-id (`<cgId>\n<peerId>`).
      // Without it `forwardJoinRequest` can't authenticate the
      // returning approval/rejection notification — see that method
      // for details. Surface the error to the UI so the user sees a
      // clear "ask curator for an updated invite code" message
      // instead of a generic 502.
      if (!curatorPeerId) {
        return jsonResponse(res, 400, {
          error: 'Missing curatorPeerId. Invite codes must include the curator peer id (V10 format: "<cgId>\\n<peerId>"). Ask the curator to share an updated invite code.',
        });
      }
      const result = await agent.forwardJoinRequest(contextGraphId, delegation, agentName, curatorPeerId);
      if (result.delivered === 0) {
        // Surface per-peer errors so the joiner can see WHY (curator
        // rejected with a specific reason, transport timed out, etc.)
        // instead of a generic "no curator". Silent error swallowing here
        // hid bugs like protocol-format skew between curator and joiner
        // versions during PR #448 multi-laptop testing.
        return jsonResponse(res, 502, {
          error: 'Could not deliver join request to curator. No reachable curator found.',
          ...(result.errors.length > 0 ? { errors: result.errors } : {}),
        });
      }
      return jsonResponse(res, 200, {
        ok: true,
        status: result.alreadyMember ? 'already-member' : 'pending',
        delivered: result.delivered,
        ...(result.alreadyMember ? { alreadyMember: true } : {}),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse(res, 400, { error: msg });
    }
  }

  // GET /api/context-graph/{id}/join-requests — list pending join requests (curator view)
  const joinRequestsMatch = path.match(/^\/api\/context-graph\/([^/]+)\/join-requests$/);
  if (req.method === "GET" && joinRequestsMatch) {
    const contextGraphId = decodeURIComponent(joinRequestsMatch[1]);
    try {
      const requests = await agent.listPendingJoinRequests(contextGraphId);
      return jsonResponse(res, 200, { contextGraphId, requests });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse(res, 400, { error: msg });
    }
  }

  // POST /api/context-graph/{id}/approve-join — approve a pending request
  const approveJoinMatch = path.match(/^\/api\/context-graph\/([^/]+)\/approve-join$/);
  if (req.method === "POST" && approveJoinMatch) {
    const contextGraphId = decodeURIComponent(approveJoinMatch[1]);
    const body = await readBody(req);
    try {
      const { agentAddress } = JSON.parse(body);
      if (!agentAddress) return jsonResponse(res, 400, { error: 'Missing agentAddress' });
      await agent.approveJoinRequest(contextGraphId, agentAddress, requestAgentAddress);
      return jsonResponse(res, 200, { ok: true, status: 'approved', agentAddress });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse(res, 400, { error: msg });
    }
  }

  // POST /api/context-graph/{id}/redeliver-approval — re-fire a `join-approved`
  // P2P notification to a previously-approved agent. Companion to the
  // join-approval retry queue (`DKGAgent.redeliverJoinApproval`). Used when:
  //   * The transient transport reset that originally dropped the
  //     notification is too long-lived for the periodic retry tick to
  //     recover quickly enough,
  //   * The operator notices the invitee is reachable again and wants to
  //     re-poke immediately rather than wait for the next backoff window,
  //   * The chat-MCP agent on the curator side (PR-510) wants to re-poke
  //     after a peer agent reports their join is stuck.
  // Returns the delivery result so the caller can distinguish "delivered
  // now" (peer was reachable) from "still queued, attempt N" (will fire
  // again on the next tick / next reconnect).
  const redeliverApprovalMatch = path.match(/^\/api\/context-graph\/([^/]+)\/redeliver-approval$/);
  if (req.method === "POST" && redeliverApprovalMatch) {
    const contextGraphId = decodeURIComponent(redeliverApprovalMatch[1]);
    const body = await readBody(req);
    try {
      const parsed = body ? JSON.parse(body) : {};
      const { agentAddress } = parsed;
      if (!agentAddress) return jsonResponse(res, 400, { error: 'Missing agentAddress' });
      const result = await agent.redeliverJoinApproval(contextGraphId, agentAddress, requestAgentAddress);
      return jsonResponse(res, 200, {
        ok: true,
        contextGraphId,
        agentAddress,
        ...result,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Caller errors (no approval row, bad address) → 400. Anything else
      // (store failure, etc.) bubbles up as 500 from the surrounding
      // handler. The redeliver-approval code path itself catches transport
      // failures internally and treats them as "still queued" successes.
      return jsonResponse(res, 400, { error: msg });
    }
  }

  // GET /api/context-graphs/pending-redeliveries — operator diagnostic for
  // join-approvals currently stuck in the retry queue across all curated CGs.
  // Useful for "is anyone still waiting on an approval that failed to deliver?"
  // dashboards. Read-only; the actual retry firing happens via the periodic
  // tick + on-connect listener inside the agent.
  if (req.method === "GET" && path === '/api/context-graphs/pending-redeliveries') {
    try {
      const entries = agent.listPendingJoinApprovalRetries();
      return jsonResponse(res, 200, { pending: entries });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse(res, 500, { error: msg });
    }
  }

  // POST /api/context-graph/{id}/reject-join — reject a pending request
  const rejectJoinMatch = path.match(/^\/api\/context-graph\/([^/]+)\/reject-join$/);
  if (req.method === "POST" && rejectJoinMatch) {
    const contextGraphId = decodeURIComponent(rejectJoinMatch[1]);
    const body = await readBody(req);
    try {
      const { agentAddress } = JSON.parse(body);
      if (!agentAddress) return jsonResponse(res, 400, { error: 'Missing agentAddress' });
      await agent.rejectJoinRequest(contextGraphId, agentAddress);
      return jsonResponse(res, 200, { ok: true, status: 'rejected', agentAddress });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse(res, 400, { error: msg });
    }
  }

  // POST /api/context-graph/{id}/sign-join — sign a join-request delegation
  //
  // SIGN-ONLY. Returns the signed `SignedAgentDelegation` for the caller's
  // agent to whoever is asking. Does NOT forward over P2P — that is the
  // sole responsibility of `/api/context-graph/{id}/request-join`.
  //
  // Why split? PR #448 review (2026-05-11): an earlier revision of this
  // route also called `forwardJoinRequest` before returning, but the UI +
  // CLI then POST the same delegation to `/request-join`, which forwards
  // it again. Curators received the same join request twice (and emitted
  // two `JOIN_REQUEST_RECEIVED` notifications) on every single click.
  // Splitting sign vs forward also lets the CLI sign without a curator
  // peer id (sign locally, forward later) — the previous mandatory
  // `curatorPeerId` body param hard-broke `dkg context-graph request-join`.
  const signJoinMatch = path.match(/^\/api\/context-graph\/([^/]+)\/sign-join$/);
  if (req.method === "POST" && signJoinMatch) {
    const contextGraphId = decodeURIComponent(signJoinMatch[1]);
    try {
      const callerAddress = agent.resolveAgentAddress(
        extractBearerToken(req.headers.authorization),
      );
      // Body is intentionally ignored — sign-only. Drain it so a JSON body
      // sent by older clients doesn't sit on the socket.
      try { await readBody(req, SMALL_BODY_BYTES); } catch { /* ignored */ }
      const delegation = await agent.signJoinRequest(contextGraphId, callerAddress);
      return jsonResponse(res, 200, {
        ok: true,
        contextGraphId,
        delegation,
        // Back-compat surface for older HTTP clients reading the
        // top-level `agentAddress`. The full signed delegation lives
        // in `delegation`; callers that want delivery POST it (with
        // a `curatorPeerId`) to `/request-join`.
        agentAddress: delegation.agentAddress,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse(res, 400, { error: msg });
    }
  }

  // ── Phase 8: project-manifest publish + install (UI-driven) ───────
  //
  // These three routes power the CreateProjectModal (curator side,
  // /publish) and JoinProjectModal (joiner side, /plan-install +
  // /install) wire-workspace flow. They reuse the same publish /
  // fetch / plan / write helpers that scripts/import-manifest.mjs
  // and `dkg-mcp join` use, by constructing a self-pointing DkgClient
  // that talks back to this same daemon over HTTP.
  //
  // Why a self-client and not direct internal calls? Two reasons:
  // (1) keeps the manifest helpers framework-agnostic (one wire
  // format whether they're called from CLI, browser-via-daemon, or
  // anywhere else), (2) honours the same auth/rate-limit/audit path
  // any other client would go through.

  const manifestPublishMatch = path.match(/^\/api\/context-graph\/([^/]+)\/manifest\/publish$/);
  if (req.method === 'POST' && manifestPublishMatch) {
    const contextGraphId = decodeURIComponent(manifestPublishMatch[1]);
    let body: any = {};
    try { body = JSON.parse(await readBody(req, SMALL_BODY_BYTES) || '{}'); }
    catch { return jsonResponse(res, 400, { error: 'Invalid JSON body' }); }

    // Authorization gate (Codex tier-4g finding on 6921): publish
    // rewrites + promotes the project's onboarding templates into
    // Shared Working Memory. Without an owner-check, any participant
    // who reaches the daemon with a valid bearer token could overwrite
    // the manifest and poison every future install (malicious hook
    // URLs, swapped agent URIs, etc.). Only the CG's registered
    // curator/creator may publish.
    try {
      await agent.assertContextGraphOwner(contextGraphId, requestAgentAddress, 'publish a project manifest');
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      // Distinguish "not the owner" from "CG has no registered owner".
      const code = /has no registered owner/.test(msg) ? 400 : 403;
      return jsonResponse(res, code, { error: msg });
    }

    try {
      const requestedNetwork = typeof body.networkLabel === 'string' ? body.networkLabel : null;
      const networkLabel: 'testnet' | 'mainnet' | 'devnet' =
        requestedNetwork === 'testnet' || requestedNetwork === 'mainnet' || requestedNetwork === 'devnet'
          ? requestedNetwork
          : manifestNetworkLabel(network?.networkName);
      // Codex tier-4h finding N11: the prior `Array.isArray(...) && .length
      // ? filter : defaults` chain accepted the request when `body.supportedTools`
      // contained ONLY values the filter throws away (e.g. `['codex']`). The
      // filter would return `[]`, `publishManifestImpl` would happily publish
      // a manifest with zero supported tools, and then `fetchManifest()`'s Zod
      // schema would reject the manifest because it requires at least one —
      // so the project would be un-installable until someone republishes.
      // Fail fast at the route when the caller supplied a non-empty array
      // but nothing in it survives the filter; fall back to the default
      // ONLY when the caller didn't specify anything.
      let supportedTools: ('cursor' | 'claude-code')[];
      if (Array.isArray(body.supportedTools) && body.supportedTools.length) {
        supportedTools = body.supportedTools
          .filter((t: unknown): t is 'cursor' | 'claude-code' => t === 'cursor' || t === 'claude-code');
        if (supportedTools.length === 0) {
          return jsonResponse(res, 400, {
            error:
              `"supportedTools" contained none of the supported values. ` +
              `Pass one or more of ["cursor", "claude-code"], or omit the ` +
              `field entirely to publish the default set.`,
          });
        }
      } else {
        supportedTools = ['cursor', 'claude-code'];
      }
      // Always derive the publisher from the authenticated caller. Accepting
      // `publisherAgentUri` from the request body let any client forge
      // `prov:wasAttributedTo` on the manifest entities, impersonating another
      // agent's provenance on-chain. The server-side derivation below is the
      // only source of truth.
      const publisherAgentUri = manifestPublisherUri(requestAgentAddress);
      const requiresMcpDkgVersion = (body.requiresMcpDkgVersion as string) ?? '>=0.1.0';

      const repoRoot = manifestRepoRoot();
      let templates;
      try {
        templates = assembleStandardTemplates(repoRoot);
      } catch (assembleErr: unknown) {
        const msg = assembleErr instanceof Error ? assembleErr.message : String(assembleErr);
        return jsonResponse(res, 500, {
          error: `Could not assemble templates from repo root ${repoRoot}: ${msg}. ` +
            `The daemon must be started from a dkg-v9 checkout for manifest publish to work today.`,
        });
      }

      const ontologyUri = body.ontologyUri ?? `urn:dkg:project:${contextGraphId}:ontology`;
      const client = manifestSelfClient(apiHost, apiPortRef.value, requestToken);
      const result = await publishManifestImpl({
        contextGraphId,
        network: networkLabel,
        supportedTools,
        publisherAgentUri,
        ontologyUri,
        requiresMcpDkgVersion,
        templates,
        client,
      });
      return jsonResponse(res, 200, {
        ok: true,
        manifestUri: result.manifestUri,
        templateUris: result.templateUris,
        tripleCount: result.tripleCount,
        network: networkLabel,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse(res, 500, { error: `manifest publish failed: ${msg}` });
    }
  }

  const manifestPlanInstallMatch = path.match(/^\/api\/context-graph\/([^/]+)\/manifest\/plan-install$/);
  if (req.method === 'POST' && manifestPlanInstallMatch) {
    const contextGraphId = decodeURIComponent(manifestPlanInstallMatch[1]);
    let body: any = {};
    try { body = JSON.parse(await readBody(req, SMALL_BODY_BYTES) || '{}'); }
    catch { return jsonResponse(res, 400, { error: 'Invalid JSON body' }); }

    try {
      const ctx = buildManifestInstallContext(req, body, contextGraphId, requestToken, requestAgentAddress, apiHost, apiPortRef.value);
      if (!ctx.ok) return jsonResponse(res, 400, { error: ctx.error });
      const fetched = await fetchManifestImpl({ client: manifestSelfClient(apiHost, apiPortRef.value, requestToken), contextGraphId });
      // Strip supportedTools the operator didn't pick — planner uses
      // supportedTools to gate claude-code wiring, and we want the same
      // gating to apply for any tool the operator deselected.
      const filteredSupportedTools = fetched.supportedTools.filter((t) =>
        (ctx.context.tools as readonly string[]).includes(t));
      // Fail fast when the intersection of requested tools and the
      // manifest's supportedTools is empty (Codex tier-4k N28). Without
      // this, `plan-install` happily returns a "successful" plan that
      // writes AGENTS.md / config.yaml but no usable Cursor/Claude
      // wiring, because the planner gates each wiring block on
      // `supportedTools.includes(…)`. Operators then hit a confusing
      // "install succeeded but nothing works" state. Return 400 with
      // the actionable options so the UI can surface the choice.
      if (filteredSupportedTools.length === 0) {
        return jsonResponse(res, 400, {
          error:
            `None of the requested tools (${(ctx.context.tools as readonly string[]).join(', ') || 'none'}) ` +
            `are supported by this project's manifest. Supported tools are: ` +
            `[${fetched.supportedTools.join(', ')}]. Pass at least one of those in ` +
            `"tools", or ask the curator to republish the manifest with broader ` +
            `"supportedTools".`,
        });
      }
      // Enforce `requiresMcpDkgVersion` before planning (Codex tier-4k N30).
      // A manifest can declare the minimum mcp-dkg version its wiring needs
      // (e.g. new capture-hook format, new schema fields). Without this
      // check an operator on an older local @origintrail-official/dkg-mcp
      // gets a plan that looks fine but fails the moment Cursor/Claude
      // tries to invoke the bundled entry. We skip gating when the range
      // is absent OR when we can't read the local mcp-dkg version — the
      // latter is very rare (no resolution path) and erring-permissive
      // keeps existing deployments working.
      if (fetched.requiresMcpDkgVersion) {
        const installedVersion = readMcpDkgVersion();
        if (installedVersion && !versionSatisfiesRange(installedVersion, fetched.requiresMcpDkgVersion)) {
          return jsonResponse(res, 400, {
            error:
              `This project's manifest requires @origintrail-official/dkg-mcp ` +
              `"${fetched.requiresMcpDkgVersion}", but the local installation is ` +
              `v${installedVersion}. Upgrade mcp-dkg (e.g. \`pnpm add -g ` +
              `@origintrail-official/dkg-mcp@${fetched.requiresMcpDkgVersion}\`) ` +
              `before running install.`,
          });
        }
      }
      const manifest = {
        ...fetched,
        supportedTools: filteredSupportedTools,
      };
      const plan = planInstallImpl({ ...ctx.context, manifest });
      const markdown = buildReviewMarkdownImpl(manifest, plan);
      return jsonResponse(res, 200, {
        ok: true,
        manifest: {
          uri: manifest.uri,
          contextGraphId: manifest.contextGraphId,
          network: manifest.network,
          publishedBy: manifest.publishedBy,
          publishedAt: manifest.publishedAt,
          supportedTools: manifest.supportedTools,
          ontologyUri: manifest.ontologyUri,
        },
        plan: {
          files: plan.files.map((f) => ({
            field: f.field,
            absPath: f.absPath,
            exists: f.exists,
            merges: f.merges,
            bytes: f.bytes,
            encodingFormat: f.encodingFormat,
          })),
          warnings: plan.warnings,
          substitutionValues: plan.substitutionValues,
        },
        markdown,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse(res, 500, { error: `manifest plan-install failed: ${msg}` });
    }
  }

  const manifestInstallMatch = path.match(/^\/api\/context-graph\/([^/]+)\/manifest\/install$/);
  if (req.method === 'POST' && manifestInstallMatch) {
    const contextGraphId = decodeURIComponent(manifestInstallMatch[1]);
    let body: any = {};
    try { body = JSON.parse(await readBody(req, SMALL_BODY_BYTES) || '{}'); }
    catch { return jsonResponse(res, 400, { error: 'Invalid JSON body' }); }

    try {
      const ctx = buildManifestInstallContext(req, body, contextGraphId, requestToken, requestAgentAddress, apiHost, apiPortRef.value);
      if (!ctx.ok) return jsonResponse(res, 400, { error: ctx.error });
      const fetched = await fetchManifestImpl({ client: manifestSelfClient(apiHost, apiPortRef.value, requestToken), contextGraphId });
      const filteredSupportedTools = fetched.supportedTools.filter((t) =>
        (ctx.context.tools as readonly string[]).includes(t));
      // Same fail-fast as `/manifest/plan-install` (Codex N28): refuse to
      // run the install if the operator's selected tools don't intersect
      // what the manifest actually supports — otherwise we silently
      // write generic config without any of the editor wiring the user
      // asked for.
      if (filteredSupportedTools.length === 0) {
        return jsonResponse(res, 400, {
          error:
            `None of the requested tools (${(ctx.context.tools as readonly string[]).join(', ') || 'none'}) ` +
            `are supported by this project's manifest. Supported tools are: ` +
            `[${fetched.supportedTools.join(', ')}]. Pass at least one of those in ` +
            `"tools", or ask the curator to republish the manifest with broader ` +
            `"supportedTools".`,
        });
      }
      // Same `requiresMcpDkgVersion` gate as /manifest/plan-install
      // (Codex tier-4k N30). Blocking here prevents the writeInstallImpl
      // step from spraying incompatible wiring onto disk that the local
      // mcp-dkg can't actually service.
      if (fetched.requiresMcpDkgVersion) {
        const installedVersion = readMcpDkgVersion();
        if (installedVersion && !versionSatisfiesRange(installedVersion, fetched.requiresMcpDkgVersion)) {
          return jsonResponse(res, 400, {
            error:
              `This project's manifest requires @origintrail-official/dkg-mcp ` +
              `"${fetched.requiresMcpDkgVersion}", but the local installation is ` +
              `v${installedVersion}. Upgrade mcp-dkg (e.g. \`pnpm add -g ` +
              `@origintrail-official/dkg-mcp@${fetched.requiresMcpDkgVersion}\`) ` +
              `before running install.`,
          });
        }
      }
      const manifest = {
        ...fetched,
        supportedTools: filteredSupportedTools,
      };
      const plan = planInstallImpl({ ...ctx.context, manifest });
      const written = await writeInstallImpl(plan);
      const skipped: string[] = [];
      if (!(ctx.context.tools as readonly string[]).includes('claude-code')) {
        skipped.push('claudeHooksTemplate (claude-code not selected)');
      }
      if ((ctx.context.tools as readonly string[]).includes('codex')) {
        skipped.push('codex wiring is "coming soon" — no template entries shipped yet');
      }
      return jsonResponse(res, 200, {
        ok: true,
        written: written.map((w) => ({
          field: w.field,
          absPath: w.absPath,
          bytesWritten: w.bytesWritten,
          action: w.action,
        })),
        warnings: plan.warnings,
        skipped,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse(res, 500, { error: `manifest install failed: ${msg}` });
    }
  }

  // POST /api/context-graph/subscribe (V10) or /api/subscribe (legacy)
  if (
    req.method === "POST" &&
    (path === "/api/context-graph/subscribe" || path === "/api/subscribe")
  ) {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = JSON.parse(body);
    const { includeWorkspace, includeSharedMemory } = parsed;
    const contextGraphId = parsed.contextGraphId;
    if (!contextGraphId)
      return jsonResponse(res, 400, {
        error: 'Missing "contextGraphId"',
      });

    // For curated CGs, verify this node's agent is on the allowlist.
    // The allowlist may not be available locally yet (it lives on the
    // curator's node), so this is a best-effort early rejection —
    // the sync protocol enforces access on the remote side regardless.
    const localAllowed = await agent.getContextGraphAllowedAgents(contextGraphId).catch(() => [] as string[]);
    if (localAllowed.length > 0) {
      const callerAddr = requestAgentAddress ?? agent.getDefaultAgentAddress();
      const isEthAddress = callerAddr && /^0x[0-9a-fA-F]{40}$/.test(callerAddr);
      if (isEthAddress && !localAllowed.some((a: string) => a.toLowerCase() === callerAddr.toLowerCase())) {
        return jsonResponse(res, 403, {
          error: `Your agent (${callerAddr}) is not on the allowlist for this curated project. Ask the curator to invite you first.`,
        });
      }
    }

    const shouldSyncSharedMemory =
      (includeSharedMemory ?? includeWorkspace) !== false;

    const subMap = agent.getSubscribedContextGraphs();
    const existingSub = subMap?.get(contextGraphId);
    const existingJobId = catchupTracker.latestByContextGraph.get(contextGraphId);
    const existingJob = existingJobId ? catchupTracker.jobs.get(existingJobId) : undefined;

    if (existingSub?.subscribed) {
      if (existingJob && (existingJob.status === "queued" || existingJob.status === "running")) {
        return jsonResponse(res, 200, {
          subscribed: contextGraphId,
          catchup: {
            status: existingJob.status,
            includeWorkspace: existingJob.includeWorkspace,
            jobId: existingJob.jobId,
          },
        });
      }

      if (existingSub.synced && (!shouldSyncSharedMemory || existingSub.sharedMemorySynced)) {
        const jobId = existingJob?.jobId ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        if (!existingJob) {
          const syntheticJob: CatchupJob = {
            jobId,
            contextGraphId,
            includeWorkspace: shouldSyncSharedMemory,
            status: "done",
            queuedAt: Date.now(),
            startedAt: Date.now(),
            finishedAt: Date.now(),
          };
          catchupTracker.jobs.set(jobId, syntheticJob);
          catchupTracker.latestByContextGraph.set(contextGraphId, jobId);
        }
        return jsonResponse(res, 200, {
          subscribed: contextGraphId,
          catchup: {
            status: "done",
            includeWorkspace: shouldSyncSharedMemory,
            jobId,
          },
        });
      }
    }

    console.log(`[subscribe] contextGraph=${contextGraphId} includeSharedMemory=${shouldSyncSharedMemory}`);
    agent.subscribeToContextGraph(contextGraphId);

    const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const job: CatchupJob = {
      jobId,
      contextGraphId,
      includeWorkspace: shouldSyncSharedMemory,
      status: "queued",
      queuedAt: Date.now(),
    };
    catchupTracker.jobs.set(jobId, job);
    catchupTracker.latestByContextGraph.set(contextGraphId, jobId);

    while (catchupTracker.jobs.size > 100) {
      let oldestId: string | undefined;
      let oldestQueuedAt = Number.POSITIVE_INFINITY;
      for (const [id, entry] of catchupTracker.jobs.entries()) {
        if (entry.queuedAt < oldestQueuedAt) {
          oldestQueuedAt = entry.queuedAt;
          oldestId = id;
        }
      }
      if (!oldestId) break;
      const removed = catchupTracker.jobs.get(oldestId);
      catchupTracker.jobs.delete(oldestId);
      if (
        removed &&
        catchupTracker.latestByContextGraph.get(removed.contextGraphId) === oldestId
      ) {
        catchupTracker.latestByContextGraph.delete(removed.contextGraphId);
      }
    }

    void (async () => {
      job.status = "running";
      job.startedAt = Date.now();
      if (DEBUG_SYNC_TRACE) console.log(`[catchup] job=${jobId} contextGraph=${contextGraphId} started`);
      try {
        const result = await daemonState.catchupRunner!.run({
          contextGraphId: contextGraphId,
          includeSharedMemory: shouldSyncSharedMemory,
        });
        job.result = result;
        job.status = "done";

        const d = result.diagnostics?.durable;
        const s = result.diagnostics?.sharedMemory;
        const cleanResponse =
          result.dataSynced > 0 ||
          result.sharedMemorySynced > 0 ||
          (d?.emptyResponses ?? 0) > 0 ||
          (d?.metaOnlyResponses ?? 0) > 0 ||
          (s?.emptyResponses ?? 0) > 0;
        const servedByPeer =
          result.dataSynced > 0 ||
          result.sharedMemorySynced > 0 ||
          (d?.insertedMetaTriples ?? 0) > 0 ||
          (s?.insertedMetaTriples ?? 0) > 0 ||
          (d?.metaOnlyResponses ?? 0) > 0;
        if (result.denied && !servedByPeer) {
          job.status = "denied";
          job.error = result.deniedPeers > 1 ? `Sync denied by ${result.deniedPeers} remote peers` : "Sync denied by remote peer";
          if (DEBUG_SYNC_TRACE) console.log(`[catchup] job=${jobId} contextGraph=${contextGraphId} denied by remote peer(s): ${result.deniedPeers}`);
        }

        if (job.status === "done") {
          if (cleanResponse) {
            const hasContent = await agent.contextGraphHasLocalContent(contextGraphId).catch(() => false);
            agent.markContextGraphSubscriptionState(contextGraphId, {
              synced: true,
              ...(shouldSyncSharedMemory ? { sharedMemorySynced: true } : {}),
              ...(hasContent ? { metaSynced: true } : {}),
            });
          } else if (result.peersTried > 0 && result.peersSucceeded === 0) {
            // No peer answered within the run — curator likely offline
            // or no node currently holds this CG. Distinct from `denied`
            // so the UI can render "couldn't reach the curator" copy +
            // the signed-join-request CTA. The previous behaviour
            // collapsed this case into a generic `failed` whose message
            // ("all reachable peers failed") was easy to misread as a
            // local error. See `JoinProjectModal.tsx` `unreachable`
            // branch and `CatchupJobState`.
            job.status = "unreachable";
            job.error = "No peer could deliver this project's data — the curator may be offline, or no node currently holds the data. You can still send a signed join request; they will receive it next time they come online.";
          } else if (result.peersTried > 0) {
            job.status = "failed";
            job.error = "Sync did not complete — all reachable peers failed (timeouts or transport errors). Retry once the network is healthier.";
          } else if (result.connectedPeers > 0 && result.syncCapablePeers === 0) {
            // Connected to peers, but none speak the sync protocol —
            // i.e. all our connections are non-DKG / mismatched
            // versions. From the joiner's perspective this is the same
            // unreachable outcome ("nobody can answer my sync"), so
            // reuse the dedicated terminal status.
            job.status = "unreachable";
            job.error = "No sync-capable peers found for catch-up — the curator may be offline.";
          } else if (result.connectedPeers === 0) {
            // No peers connected at all → definitionally unreachable.
            job.status = "unreachable";
            job.error = "No peers connected — couldn't reach the curator. They may be offline, or your node hasn't bootstrapped to the network yet.";
          }

          if (DEBUG_SYNC_TRACE) {
            console.log(
              `[catchup] job=${jobId} contextGraph=${contextGraphId} status=${job.status} ` +
                `peers=${result.peersTried}/${result.syncCapablePeers} connected=${result.connectedPeers} ` +
                `data=${result.dataSynced} swm=${result.sharedMemorySynced} denied=${result.denied}`,
            );
          }
        }
      } catch (err) {
        job.error = err instanceof Error ? err.message : String(err);
        job.status = "failed";
        if (DEBUG_SYNC_TRACE) console.log(`[catchup] job=${jobId} contextGraph=${contextGraphId} threw: ${job.error}`);
      } finally {
        job.finishedAt = Date.now();
      }
    })();

    return jsonResponse(res, 200, {
      subscribed: contextGraphId,
      catchup: {
        status: "queued",
        includeWorkspace: shouldSyncSharedMemory,
        jobId,
      },
    });
  }

  // POST /api/context-graph/rename
  //
  // Updates the display name (schema:name) of an existing context graph
  // without touching any of its data. Delegates to `agent.renameContextGraph`
  // which (a) enforces owner-only authorization via `assertCallerIsOwner`
  // (same protection as add/remove-participant), (b) wipes old name triples
  // from both the ONTOLOGY graph and the CG `_meta` graph, and (c) writes
  // the new name into both so the rename is durable for open AND private
  // CGs (private curated graphs read their definition from `_meta`).
  if (req.method === "POST" && path === "/api/context-graph/rename") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const { id, name } = JSON.parse(body);
    if (!id || !name) {
      return jsonResponse(res, 400, { error: 'Missing "id" or "name"' });
    }
    try {
      await agent.renameContextGraph(id, String(name), requestAgentAddress);
      return jsonResponse(res, 200, { renamed: id, name });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (/Only the context graph creator/.test(msg)) {
        return jsonResponse(res, 403, { error: msg });
      }
      if (/does not exist|has no known creator|non-empty string/.test(msg)) {
        return jsonResponse(res, 400, { error: msg });
      }
      return jsonResponse(res, 500, {
        error: `Failed to rename context graph: ${msg}`,
      });
    }
  }

  // GET /api/context-graph/list
  if (req.method === "GET" && path === "/api/context-graph/list") {
    const contextGraphs = await agent.listContextGraphs({
      callerAgentAddress: requestAgentAddress ?? null,
    });
    return jsonResponse(res, 200, {
      contextGraphs,
    });
  }

  // GET /api/context-graph/exists
  if (req.method === "GET" && path === "/api/context-graph/exists") {
    const id = url.searchParams.get("id");
    if (!id)
      return jsonResponse(res, 400, { error: 'Missing "id" query param' });
    const exists = await agent.contextGraphExists(id);
    return jsonResponse(res, 200, { id, exists });
  }
}
