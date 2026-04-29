// daemon/routes/query.ts
//
// Route handlers for SPARQL query, GenUI render, catchup-status, verify, endorse, CCL policy + eval.
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
  classifyClientError,
  sanitizeRevertMessage,
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


export async function handleQueryRoutes(ctx: RequestContext): Promise<void> {
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


  // POST /api/query  { sparql: "...", paranetId?: "...", graphSuffix?: "_shared_memory", includeWorkspace?: bool }
  if (req.method === "POST" && path === "/api/query") {
    const serverT0 = Date.now();
    const body = await readBody(req);
    const parsed = JSON.parse(body);
    const sparql = parsed.sparql;
    const contextGraphId = parsed.contextGraphId ?? parsed.paranetId;
    const graphSuffix = parsed.graphSuffix;
    const includeSharedMemory =
      parsed.includeSharedMemory ?? parsed.includeWorkspace;
    const view = parsed.view;
    const agentAddress = parsed.agentAddress;
    // the
    // RFC-29 multi-agent WM isolation gate is fail-closed by default.
    // For cross-agent `view: 'working-memory'` reads on nodes with
    // more than one local agent, the caller MUST supply
    // `agentAuthSignature` (a signature over a canonical challenge
    // proving ownership of the agent's private key). Before this the
    // daemon's `/api/query` endpoint only forwarded `agentAddress`,
    // so any multi-agent caller got `[]` back from a strict-default
    // node — effectively downgrading every /api/query hit to
    // "denied". Plumb the signature through so clients that DO sign
    // (mcp_auth / OpenClaw adapters after r22-1) can pass the gate.
    const agentAuthSignature = parsed.agentAuthSignature;
    const verifiedGraph = parsed.verifiedGraph;
    const assertionName = parsed.assertionName;
    const subGraphName = parsed.subGraphName;
    // P-13: accept `minTrust` as a string ("SelfAttested"|"Endorsed"|
    // "PartiallyVerified"|"ConsensusVerified") or the matching integer
    // (0..3). Unrecognised values fail closed with a 400 rather than
    // silently dropping the filter, because a dropped filter leaks
    // low-trust data into a query that asked for high-trust only.
    const TRUST_LEVELS: Record<string, number> = {
      selfattested: 0,
      endorsed: 1,
      partiallyverified: 2,
      consensusverified: 3,
    };
    // PR #239 Codex iter-5: also accept the legacy `_minTrust` underscore
    // form as a deprecation-window alias, so SDK consumers that adopted
    // the underscore shape before the rename get the same trust gate the
    // canonical `minTrust` does. `minTrust` wins if both are present.
    const rawMinTrust = parsed.minTrust ?? parsed._minTrust;
    const minTrustSrcField = parsed.minTrust !== undefined && parsed.minTrust !== null
      ? 'minTrust'
      : '_minTrust';
    if (!sparql || !String(sparql).trim())
      return jsonResponse(res, 400, { error: 'Missing "sparql"' });
    if (view && !(GET_VIEWS as readonly string[]).includes(view)) {
      return jsonResponse(res, 400, {
        error: `Invalid view "${view}". Supported: ${GET_VIEWS.join(", ")}`,
      });
    }
    // PR #239 Codex iter-7: gate minTrust normalization/validation behind
    // view === 'verified-memory'. Upstream `resolveViewGraphs()` already
    // ignores `minTrust` outside VM, so the HTTP layer must match that —
    // otherwise a reused options object like
    //   { view: "working-memory", minTrust: 99 }
    // would 400 on a request where the field is semantically irrelevant.
    // Keep view === undefined NOT rejecting either: resolveViewGraphs
    // treats "no view" as implicit working-memory semantics.
    let minTrust: number | undefined;
    if (view === 'verified-memory' && rawMinTrust !== undefined && rawMinTrust !== null) {
      if (typeof rawMinTrust === 'number' && Number.isInteger(rawMinTrust) && rawMinTrust >= 0 && rawMinTrust <= 3) {
        minTrust = rawMinTrust;
      } else if (typeof rawMinTrust === 'string') {
        const canon = rawMinTrust.toLowerCase().replace(/[_-]/g, '');
        if (canon in TRUST_LEVELS) minTrust = TRUST_LEVELS[canon];
      }
      if (minTrust === undefined) {
        return jsonResponse(res, 400, {
          error: `Invalid ${minTrustSrcField} "${rawMinTrust}". Expected one of: SelfAttested, Endorsed, PartiallyVerified, ConsensusVerified (or integer 0..3).`,
        });
      }
    }
    const ctx = createOperationContext("query");
    tracker.start(ctx, {
      contextGraphId,
      details: { sparql: sparql.slice(0, 200) },
    });
    tracker.startPhase(ctx, "parse");
    try {
      tracker.completePhase(ctx, "parse");
      tracker.startPhase(ctx, "execute");
      const execT0 = Date.now();
      // A-1 review: `callerAgentAddress` must come from an
      // *agent-scoped* bearer token, not the node-level default.
      // `resolveAgentAddress(token)` silently falls back to
      // `defaultAgentAddress` / `peerId` for node-level tokens, which
      // would make every node-level `/api/query` look like an
      // agent-scoped WM read and deny legitimate cross-agent reads
      // (e.g. OpenClaw sessions authenticating with
      // `~/.dkg/auth.token` and supplying a different `agentAddress`
      // in the body). `resolveAgentByToken` returns `undefined` for
      // node-level tokens, so only genuine agent-scoped identities
      // ever reach the A-1 guard.
      const callerAgentAddress = requestToken
        ? agent.resolveAgentByToken(requestToken)
        : undefined;
      // A-1 follow-up review (iteration 2): close the auth-disabled WM
      // hole WITHOUT regressing existing node-token clients.
      //
      // When we reach this line with `callerAgentAddress === undefined`,
      // the caller is one of:
      //
      //   (a) node-level admin (`~/.dkg/auth.token`, a token present in
      //       `validTokens`). Admin is already trusted to run as any
      //       local agent — `packages/adapter-openclaw` relies on this
      //       by passing a session-specific `agentAddress` alongside the
      //       admin token. Keep the legacy "skip the A-1 guard" here.
      //
      //   (b) unauthenticated (auth disabled at daemon level, OR no
      //       Authorization header, OR a bogus / mismatched bearer that
      //       the auth middleware never validated because `authEnabled`
      //       is false). This is the hole Codex flagged: a raw
      //       `Authorization: Bearer junk` used to set `requestToken`
      //       truthy, sliding past a `!requestToken` check and letting
      //       foreign WM reads through.
      //
      //   (c) auth-enabled + rejected — we never reach this line
      //       because `httpAuthGuard` has already 401'd the request.
      //
      // Gate the 403 on "not a known admin token" (i.e. the caller is
      // not in `validTokens`), which fails closed for (b) regardless of
      // what garbage they put in the header, and leaves (a) alone.
      //
      // Codex PR #242 iter-8: `validTokens` contains BOTH the
      // node-level admin token (`~/.dkg/auth.token`) AND any
      // per-agent tokens the node has issued. Treating every
      // validToken as "admin" means an authenticated agent could
      // use its OWN token to skip the A-1 guard and read another
      // local agent's WM via `agentAddress`. Restrict the admin
      // bypass to tokens that are NOT bound to a specific agent
      // (`resolveAgentByToken(token) === undefined`), which is the
      // current signal for "node-level / admin-scoped".
      //
      // Codex PR #242 iter-8 re-review: the A-1 fallback 403 must
      // also NOT fire for authenticated agent callers. An agent
      // querying its OWN WM (`callerAgentAddress === agentAddress`)
      // was previously being rejected here unless the target happened
      // to be the node default / peerId alias, and genuine cross-agent
      // reads were surfacing as a 403 (leaking existence) instead of
      // the intended silent empty-per-kind result from
      // `DKGAgent.query`. Only gate the self-alias fallback when the
      // caller has no recognised identity at all — neither a
      // node-level admin token nor an agent-scoped bearer. Authenticated
      // agent callers flow straight into `agent.query()` below, which
      // enforces the isolation invariant by returning an empty-per-kind
      // result for any target that is not `callerAgentAddress`.
      const isAdminToken =
        !!requestToken
        && validTokens.has(requestToken)
        && callerAgentAddress === undefined;
      const hasRecognisedIdentity = isAdminToken || callerAgentAddress !== undefined;
      if (
        !hasRecognisedIdentity &&
        view === 'working-memory' &&
        typeof agentAddress === 'string'
      ) {
        // Codex (iteration 4): the daemon's canonical "own WM" identity is
        // whatever `agent.resolveAgentAddress(undefined)` returns — i.e.
        // `defaultAgentAddress ?? peerId`. Several in-repo paths still
        // authenticate under the legacy peerId alias (node-level tokens,
        // auth-disabled self-reads before a default agent was configured),
        // so we must accept both the default agent address *and* the bare
        // peerId as self, otherwise an auth-disabled self-read via the
        // legacy alias now 403s where it used to return the node's own WM.
        const targetLower = agentAddress.toLowerCase();
        const selfAliasesLower = new Set<string>();
        const defaultAgent = agent.getDefaultAgentAddress();
        if (defaultAgent) selfAliasesLower.add(defaultAgent.toLowerCase());
        if (agent.peerId) selfAliasesLower.add(agent.peerId.toLowerCase());
        if (selfAliasesLower.size === 0 || !selfAliasesLower.has(targetLower)) {
          return jsonResponse(res, 403, {
            error:
              `working-memory reads for agentAddress=${agentAddress} require authentication. ` +
              `An unauthenticated / auth-disabled caller may only read the node-default agent's WM ` +
              `(accepted self-aliases: defaultAgentAddress and the node's peerId).`,
          });
        }
      }
      const result = await agent.query(sparql, {
        contextGraphId,
        graphSuffix,
        includeSharedMemory,
        view,
        agentAddress,
        agentAuthSignature,
        verifiedGraph,
        assertionName,
        subGraphName,
        callerAgentAddress,
        // the daemon admin
        // token is the authorisation anchor for cross-agent WM reads
        // (adapter-openclaw and the CLI rely on this). Pass it through
        // so DKGAgent.query knows to skip the multi-agent signed-proof
        // gate. Per-agent tokens still go through the regular caller-
        // matches-target invariant inside DKGAgent.query.
        adminAuthenticated: isAdminToken,
        minTrust: minTrust as TrustLevel | undefined,
        operationCtx: ctx,
      });
      const execDur = Date.now() - execT0;
      tracker.completePhase(ctx, "execute");
      tracker.complete(ctx, { tripleCount: result?.bindings?.length ?? 0 });
      return jsonResponse(res, 200, {
        result,
        phases: { execute: execDur, serverTotal: Date.now() - serverT0 },
      });
    } catch (err: any) {
      tracker.fail(ctx, err);
      const msg = err?.message ?? "";
      if (
        msg.startsWith("SPARQL rejected:") ||
        msg.startsWith("Parse error") ||
        /must start with (SELECT|CONSTRUCT|ASK|DESCRIBE)/i.test(msg) ||
        msg.includes("was removed in V10") ||
        msg.includes("agentAddress is required") ||
        msg.includes("requires a contextGraphId") ||
        msg.includes("cannot be combined with") ||
        // A-1 review: DKGAgent.query throws these when the caller sends
        // a non-string `agentAddress` / `callerAgentAddress` in the
        // body. Classify as 400 so malformed input is a clean client
        // error instead of a 500.
        msg.startsWith("query: 'agentAddress' must be a string") ||
        msg.startsWith("query: 'callerAgentAddress' must be a string") ||
        // P-13 review: `resolveViewGraphs` validates `minTrust` now,
        // so direct callers that forward a string / out-of-range
        // value get a 400 instead of a 500.
        msg.startsWith("Invalid minTrust")
      ) {
        return jsonResponse(res, 400, { error: msg });
      }
      throw err;
    }
  }

  // POST /api/genui/render  { contextGraphId, entityUri, libraryPrompt }
  //
  // Streams OpenUI Lang deltas over Server-Sent Events. The UI registers
  // the component library client-side with @openuidev/react-lang and
  // passes its `library.prompt()` text up; the daemon does the heavy
  // lifting — resolving triples, reading the profile hint for the entity's
  // rdf:type, composing the messages, and piping LlmClient stream events.
  if (req.method === "POST" && path === "/api/genui/render") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const { contextGraphId, entityUri, libraryPrompt } = parsed;
    if (!validateRequiredContextGraphId(contextGraphId, res)) return;
    if (typeof entityUri !== "string" || !entityUri.trim()) {
      return jsonResponse(res, 400, { error: 'Missing "entityUri"' });
    }
    if (typeof libraryPrompt !== "string" || !libraryPrompt.trim()) {
      return jsonResponse(res, 400, { error: 'Missing "libraryPrompt"' });
    }
    if (!config.llm?.apiKey) {
      return jsonResponse(res, 503, {
        error: 'LLM not configured. Set an API key in Settings to enable GenUI.',
      });
    }

    // Fetch entity triples.
    // The entity's data lives in the sub-graph's named assertion graph, so
    // we must wrap the pattern in GRAPH ?g — otherwise we'd only see the
    // default graph, which is empty for these imports. DISTINCT because
    // promoted triples can appear under both WM and SWM/VM named graphs
    // for the same sub-graph.
    let triples: Array<{ p: string; o: string }> = [];
    let entityRdfType: string | null = null;
    try {
      // Stripping angle brackets is only ergonomic ("accept <uri> or uri"),
      // not sanitisation — a crafted input containing `>` or whitespace can
      // still break out of the interpolated `<…>`. `sparqlIri` runs
      // `assertSafeIri` before wrapping.
      const entityIri = entityUri.replace(/^<|>$/g, '');
      let safeEntityIri: string;
      try {
        safeEntityIri = sparqlIri(entityIri);
      } catch {
        return jsonResponse(res, 400, {
          error: `Unsafe entityUri: ${entityUri}`,
        });
      }
      const triplesResult = await agent.query(
        `SELECT DISTINCT ?p ?o WHERE { GRAPH ?g { ${safeEntityIri} ?p ?o } } LIMIT 200`,
        { contextGraphId },
      );
      // `agent.query()` can return bindings as SPARQL-JSON objects
      // (`{value, type, …}`) once the result has passed through the
      // normaliser — stringifying them directly produces "[object Object]"
      // and wrecks the downstream rdf:type lookup / LLM prompt. See
      // `bindingValue` near the top of this file.
      triples = (triplesResult?.bindings ?? []).map((row: any) => ({
        p: bindingValue(row.p),
        o: bindingValue(row.o),
      }));
      const typeT = triples.find(
        (t) => t.p === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
      );
      if (typeT) entityRdfType = typeT.o;
    } catch (err: any) {
      return jsonResponse(res, 500, {
        error: `Failed to fetch entity triples: ${err.message}`,
      });
    }

    if (triples.length === 0) {
      return jsonResponse(res, 404, {
        error: `No triples found for <${entityUri}> in ${contextGraphId}`,
      });
    }

    // Fetch the profile's detailHint for this type from the `meta` sub-graph.
    // Same GRAPH ?g reasoning as above — the profile lives in a named
    // assertion graph under `.../meta/assertion/...`, not in the default.
    let detailHint: string | null = null;
    let entityTypeLabel: string | null = null;
    if (entityRdfType) {
      // `entityRdfType` came from the quadstore as the value of `rdf:type`,
      // so it's normally a safe IRI — but crafted imported data could in
      // principle smuggle unsafe chars through. Validate before interpolating.
      let safeTypeIri: string | null = null;
      try {
        safeTypeIri = sparqlIri(entityRdfType);
      } catch {
        safeTypeIri = null;
      }
      if (safeTypeIri) {
        try {
          const hintResult = await agent.query(
            `
              SELECT ?hint ?label WHERE {
                GRAPH ?g {
                  ?binding <http://dkg.io/ontology/profile/forType> ${safeTypeIri} ;
                           <http://dkg.io/ontology/profile/detailHint> ?hint .
                  OPTIONAL { ?binding <http://dkg.io/ontology/profile/label> ?label }
                }
              } LIMIT 1
            `,
            { contextGraphId, subGraphName: 'meta' },
          );
          const row = hintResult?.bindings?.[0];
          if (row) {
            const hintRaw = bindingValue(row.hint);
            detailHint = hintRaw.replace(/^"|"$/g, '').replace(/^"(.+)"(?:@\w+|\^\^.+)?$/, '$1');
            if (row.label) {
              const labelRaw = bindingValue(row.label);
              entityTypeLabel = labelRaw.replace(/^"|"$/g, '').replace(/^"(.+)"(?:@\w+|\^\^.+)?$/, '$1');
            }
          }
        } catch {
          // meta sub-graph may be missing — fall through, LLM still has triples.
        }
      }
    }

    // Compose the prompt
    const systemPrompt =
      libraryPrompt +
      `\n\n# Task\n` +
      `You will be given an RDF entity from a DKG context graph, described by its triples (predicate -> object). ` +
      `Compose a single OpenUI Lang response that renders a rich, domain-appropriate detail view of this entity ` +
      `using only components from the library above.\n` +
      `\n## Rules\n` +
      `- Output OpenUI Lang only. No prose, no markdown fences, no commentary.\n` +
      `- Use the EntityDetail root if the library declares one; otherwise start with whatever the library's root wants.\n` +
      `- Extract display values from the literal objects (strip XSD datatype suffixes).\n` +
      `- If URI objects look like "urn:dkg:...", treat them as links to other entities.\n` +
      `- Prefer grouping: header card -> stats grid -> related lists.\n` +
      `- Keep it compact — no more than ~12 child blocks.\n`;

    const userMessage = [
      `Entity URI: ${entityUri}`,
      entityRdfType ? `rdf:type: ${entityRdfType}${entityTypeLabel ? ` (${entityTypeLabel})` : ''}` : '',
      detailHint ? `\nProfile hint for this type:\n${detailHint}` : '',
      `\nTriples (${triples.length}):\n` + triples.slice(0, 120).map(t => `  ${t.p}  ${t.o}`).join('\n'),
      triples.length > 120 ? `  … (${triples.length - 120} more triples truncated)` : '',
    ].filter(Boolean).join('\n');

    // Start SSE stream
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const client = new LlmClient();
    const sendEvent = (type: string, data: unknown) => {
      res.write(`event: ${type}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    sendEvent('start', { entityUri, entityRdfType, entityTypeLabel });
    try {
      const events = client.stream({
        config: config.llm!,
        request: {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          stream: true,
          temperature: 0.3,
          maxTokens: 1500,
        },
      });
      for await (const ev of events) {
        if (ev.type === 'text_delta') {
          sendEvent('delta', { text: ev.delta });
        } else if (ev.type === 'final') {
          sendEvent('final', { content: ev.message.content ?? '' });
        } else if (ev.type === 'error') {
          sendEvent('error', { error: ev.error });
        }
      }
      sendEvent('done', {});
    } catch (err: any) {
      sendEvent('error', { error: err?.message ?? String(err) });
    } finally {
      res.end();
    }
    return;
  }

  // POST /api/query-remote  { peerId, lookupType, paranetId?, ual?, entityUri?, rdfType?, sparql?, limit?, timeout? }
  if (req.method === "POST" && path === "/api/query-remote") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const {
      peerId: rawPeerId,
      lookupType,
      paranetId,
      ual,
      entityUri,
      rdfType,
      sparql,
      limit,
      timeout,
    } = JSON.parse(body);
    if (!rawPeerId)
      return jsonResponse(res, 400, { error: 'Missing "peerId"' });
    if (!lookupType)
      return jsonResponse(res, 400, { error: 'Missing "lookupType"' });
    const ctx = createOperationContext("query");
    tracker.start(ctx, {
      contextGraphId: paranetId,
      details: { lookupType, remotePeer: rawPeerId, source: "api-remote" },
    });
    try {
      const peerId = await tracker.trackPhase(ctx, "resolve", () =>
        resolveNameToPeerId(agent, rawPeerId),
      );
      if (!peerId) {
        tracker.fail(ctx, new Error(`Agent "${rawPeerId}" not found`));
        return jsonResponse(res, 404, {
          error: `Agent "${rawPeerId}" not found`,
        });
      }
      const response = await tracker.trackPhase(ctx, "execute", () =>
        agent.queryRemote(peerId, {
          lookupType,
          paranetId,
          ual,
          entityUri,
          rdfType,
          sparql,
          limit,
          timeout,
        }),
      );
      tracker.complete(ctx, { details: { lookupType, remotePeer: rawPeerId } });
      return jsonResponse(res, 200, response);
    } catch (err) {
      tracker.fail(ctx, err);
      // CLI-7 (
      // to re-throw and let the global catch emit a 500 with the raw
      // libp2p / agent message. That conflates "I couldn't reach the
      // peer" with "the daemon crashed", which the audit flagged as a
      // false-positive 5xx. We now translate well-known
      // peer-resolution / unreachable / dial-timeout errors to 404/400
      // so callers can distinguish operator error from server bugs.
      // Anything that doesn't match the conservative client-error
      // vocabulary still falls through to the top-level 500 handler.
      const msg = err instanceof Error ? err.message : String(err);
      const classified = classifyClientError(msg);
      if (classified) {
        return jsonResponse(res, classified.status, {
          error: classified.sanitized,
        });
      }
      throw err;
    }
  }

  // GET /api/sync/catchup-status?contextGraphId=<id> | ?paranetId=<id> | ?jobId=<id>
  if (req.method === "GET" && path === "/api/sync/catchup-status") {
    const paranetId =
      url.searchParams.get("contextGraphId") ??
      url.searchParams.get("paranetId");
    const jobIdParam = url.searchParams.get("jobId");
    if (!paranetId && !jobIdParam) {
      return jsonResponse(res, 400, {
        error:
          'Missing "contextGraphId" (or "paranetId") or "jobId" query param',
      });
    }

    const jobId =
      jobIdParam ??
      (paranetId ? catchupTracker.latestByParanet.get(paranetId) : undefined);
    if (!jobId) {
      return jsonResponse(res, 404, { error: "No catch-up job found" });
    }
    const job = catchupTracker.jobs.get(jobId);
    if (!job) {
      return jsonResponse(res, 404, {
        error: `Catch-up job "${jobId}" not found`,
      });
    }

    return jsonResponse(res, 200, toCatchupStatusResponse(job));
  }

  // POST /api/verify
  if (req.method === "POST" && path === "/api/verify") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const {
      contextGraphId,
      verifiedMemoryId,
      batchId,
      timeoutMs,
      requiredSignatures,
    } = JSON.parse(body);
    if (!contextGraphId || !verifiedMemoryId || !batchId) {
      return jsonResponse(res, 400, {
        error: "Missing contextGraphId, verifiedMemoryId, or batchId",
      });
    }
    const parsedSigs = parseRequiredSignatures(requiredSignatures);
    if ("error" in parsedSigs) {
      return jsonResponse(res, 400, { error: parsedSigs.error });
    }
    const validatedRequiredSigs = parsedSigs.value || undefined;

    // CLI-9 (
    // unparseable value used to throw `SyntaxError: Cannot convert ...
    // to a BigInt` deep inside `BigInt()` and bubble up as a 500 with
    // a stack trace. Pre-validate so the operator gets a crisp 400.
    let parsedBatchId: bigint;
    try {
      parsedBatchId = BigInt(batchId);
    } catch {
      return jsonResponse(res, 400, {
        error: `Invalid batchId — must be an integer string, got ${JSON.stringify(batchId)}`,
      });
    }

    try {
      const result = await agent.verify({
        contextGraphId,
        verifiedMemoryId,
        batchId: parsedBatchId,
        timeoutMs: timeoutMs ? Number(timeoutMs) : undefined,
        requiredSignatures: validatedRequiredSigs,
      });
      return jsonResponse(res, 200, { ...result, batchId: String(batchId) });
    } catch (err) {
      // CLI-9 dup #158 #159: a non-existent (cgId, vmId, batchId)
      // tuple used to bubble up a chain custom-error revert as a
      // generic 500 with the raw `data="0x…"` payload in the body.
      // Map "not found / does not exist" to 404 and other client-shape
      // errors to 400. Sanitize the message either way so we never
      // leak the raw revert hex (#159 specifically). Unknown errors
      // still fall through to the global 500 handler (with the same
      // sanitization applied below) so genuine internal failures
      // remain visible.
      const msg = err instanceof Error ? err.message : String(err);
      const classified = classifyClientError(msg);
      if (classified) {
        return jsonResponse(res, classified.status, {
          error: classified.sanitized,
        });
      }
      // Re-throw as a sanitized error so the global catch's 500 body
      // does not include the raw chain payload either.
      const sanitized = sanitizeRevertMessage(msg);
      throw err instanceof Error
        ? Object.assign(new Error(sanitized), { cause: err })
        : new Error(sanitized);
    }
  }

  // POST /api/endorse
  if (req.method === "POST" && path === "/api/endorse") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = JSON.parse(body);
    const { contextGraphId, ual } = parsed;
    if (!contextGraphId || !ual) {
      return jsonResponse(res, 400, {
        error: "Missing contextGraphId or ual",
      });
    }
    // A-12 review: the endorser MUST come from the authenticated bearer
    // token, not from the request body. Trusting body.agentAddress let
    // any caller with node access publish endorsements as an arbitrary
    // `did:dkg:agent:0x...`, forging provenance. `requestAgentAddress`
    // is the token-resolved identity. If the body also includes
    // `agentAddress`, it must match or we reject with 403. The
    // registered-local-agent check is implicit: resolveAgentAddress
    // returns either the token's agent (if it's an agent-scoped
    // token) or `defaultAgentAddress` (the node's own auto-registered
    // agent). Both are owned by this node by construction.
    // Defence in depth: an unauthenticated caller has no agent identity
    // to attribute an endorsement to. Early return 401 rather than
    // attempting `.toLowerCase()` on a null/undefined address.
    if (!requestAgentAddress) {
      return jsonResponse(res, 401, {
        error:
          "Endorsement requires an authenticated agent. Provide a bearer token tied to a registered agent.",
      });
    }
    const bodyAgentAddress = typeof parsed.agentAddress === 'string' ? parsed.agentAddress : undefined;
    if (
      bodyAgentAddress &&
      bodyAgentAddress.toLowerCase() !== requestAgentAddress.toLowerCase()
    ) {
      return jsonResponse(res, 403, {
        error:
          `Endorser mismatch: authenticated as ${requestAgentAddress} but request body claims ${bodyAgentAddress}. ` +
          `The endorser is resolved from the bearer token; omit body.agentAddress or use the matching agent's token.`,
      });
    }
    const result = await agent.endorse({
      contextGraphId,
      knowledgeAssetUal: ual,
      agentAddress: requestAgentAddress,
    });
    return jsonResponse(res, 200, {
      endorsed: true,
      endorserAddress: requestAgentAddress,
      ...result,
    });
  }

  // POST /api/ccl/policy/publish
  if (req.method === "POST" && path === "/api/ccl/policy/publish") {
    const body = await readBody(req, SMALL_BODY_BYTES * 4);
    const {
      paranetId,
      name,
      version,
      content,
      description,
      contextType,
      language,
      format,
    } = JSON.parse(body);
    if (!paranetId || !name || !version || !content) {
      return jsonResponse(res, 400, {
        error: "Missing required fields: paranetId, name, version, content",
      });
    }
    const result = await agent.publishCclPolicy({
      paranetId,
      name,
      version,
      content,
      description,
      contextType,
      language,
      format,
    });
    return jsonResponse(res, 200, result);
  }

  // POST /api/ccl/policy/approve
  if (req.method === "POST" && path === "/api/ccl/policy/approve") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const { paranetId, policyUri, contextType } = JSON.parse(body);
    if (!paranetId || !policyUri) {
      return jsonResponse(res, 400, {
        error: "Missing required fields: paranetId, policyUri",
      });
    }
    try {
      const result = await agent.approveCclPolicy({
        paranetId,
        policyUri,
        contextType,
        callerAgentAddress: requestAgentAddress,
      });
      return jsonResponse(res, 200, result);
    } catch (err: any) {
      const msg = err?.message ?? "";
      if (/Only the paranet owner can manage policies/.test(msg)) {
        return jsonResponse(res, 403, { error: msg });
      }
      throw err;
    }
  }

  // POST /api/ccl/policy/revoke
  if (req.method === "POST" && path === "/api/ccl/policy/revoke") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const { paranetId, policyUri, contextType } = JSON.parse(body);
    if (!paranetId || !policyUri) {
      return jsonResponse(res, 400, {
        error: "Missing required fields: paranetId, policyUri",
      });
    }
    try {
      const result = await agent.revokeCclPolicy({
        paranetId,
        policyUri,
        contextType,
        callerAgentAddress: requestAgentAddress,
      });
      return jsonResponse(res, 200, result);
    } catch (err: any) {
      const msg = err?.message ?? "";
      if (/Only the paranet owner can manage policies/.test(msg)) {
        return jsonResponse(res, 403, { error: msg });
      }
      throw err;
    }
  }

  // GET /api/ccl/policy/list
  if (req.method === "GET" && path === "/api/ccl/policy/list") {
    const policies = await agent.listCclPolicies({
      paranetId: url.searchParams.get("paranetId") ?? undefined,
      name: url.searchParams.get("name") ?? undefined,
      contextType: url.searchParams.get("contextType") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      includeBody: url.searchParams.get("includeBody") === "true",
    });
    return jsonResponse(res, 200, { policies });
  }

  // GET /api/ccl/policy/resolve?paranetId=&name=&contextType=
  if (req.method === "GET" && path === "/api/ccl/policy/resolve") {
    const paranetId = url.searchParams.get("paranetId");
    const name = url.searchParams.get("name");
    if (!paranetId || !name) {
      return jsonResponse(res, 400, {
        error: "Missing required query params: paranetId, name",
      });
    }
    const policy = await agent.resolveCclPolicy({
      paranetId,
      name,
      contextType: url.searchParams.get("contextType") ?? undefined,
      includeBody: url.searchParams.get("includeBody") === "true",
    });
    return jsonResponse(res, 200, { policy });
  }

  // POST /api/ccl/eval
  if (req.method === "POST" && path === "/api/ccl/eval") {
    const body = await readBody(req, SMALL_BODY_BYTES * 8);
    const {
      paranetId,
      name,
      facts,
      contextType,
      view,
      snapshotId,
      scopeUal,
      publishResult,
    } = JSON.parse(body);
    if (!paranetId || !name) {
      return jsonResponse(res, 400, {
        error: "Missing required fields: paranetId, name",
      });
    }
    if (facts != null && !Array.isArray(facts)) {
      return jsonResponse(res, 400, {
        error: "facts must be an array when provided",
      });
    }
    const result = publishResult
      ? await agent.evaluateAndPublishCclPolicy({
          paranetId,
          name,
          facts,
          contextType,
          view,
          snapshotId,
          scopeUal,
        })
      : await agent.evaluateCclPolicy({
          paranetId,
          name,
          facts,
          contextType,
          view,
          snapshotId,
          scopeUal,
        });
    return jsonResponse(res, 200, result);
  }

  // GET /api/ccl/results?paranetId=&...
  if (req.method === "GET" && path === "/api/ccl/results") {
    const paranetId = url.searchParams.get("paranetId");
    if (!paranetId) {
      return jsonResponse(res, 400, {
        error: "Missing required query param: paranetId",
      });
    }
    const evaluations = await agent.listCclEvaluations({
      paranetId,
      policyUri: url.searchParams.get("policyUri") ?? undefined,
      snapshotId: url.searchParams.get("snapshotId") ?? undefined,
      view: url.searchParams.get("view") ?? undefined,
      contextType: url.searchParams.get("contextType") ?? undefined,
      resultKind:
        (url.searchParams.get("resultKind") as "derived" | "decision" | null) ??
        undefined,
      resultName: url.searchParams.get("resultName") ?? undefined,
    });
    return jsonResponse(res, 200, { evaluations });
  }
}
