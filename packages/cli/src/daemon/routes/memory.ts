// daemon/routes/memory.ts
//
// Route handlers for shared-memory / workspace write + publish + conditional-write, memory turn/search.
//
// Extracted verbatim from the legacy monolithic `handleRequest` --
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
// OpenClaw config helper (~line 2535) uses a bare `homedir()` -- aliased
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
import {
  DKGAgent,
  classifySwmCatchupPeerOutcome,
  createSwmCatchupPeerSelector,
  loadOpWallets,
} from '@origintrail-official/dkg-agent';
import { computeNetworkId, createOperationContext, DKGEvent, Logger, PayloadTooLargeError, GET_VIEWS, TrustLevel, validateSubGraphName, validateContextGraphId, isSafeIri, assertSafeIri, assertSafeRdfTerm, contextGraphSharedMemoryUri, contextGraphMetaUri, escapeSparqlLiteral, PROTOCOL_SYNC } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { buildAutoRegisterFailureBody } from "./shared-assertion-helpers.js";
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
import {
  classifyDurableCatchupRequest,
  createCatchupRunner,
  formatDurableCatchupFailure,
  runDurableCatchupLeg,
  type CatchupJobResult,
  type CatchupRunner,
  type DurableCatchupFailureReason,
  type DurableCatchupLegState,
  type DurableLegDiagnostics,
} from '../../catchup-runner.js';
import { loadTokens, httpAuthGuard } from '../../auth.js';
import { recordAssertionActivity } from '../activity-notification.js';
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
// Phase 8 -- project-manifest publish + install (UI-driven onboarding flow).
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

// Daemon sub-module imports -- every public symbol from sibling
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
  isWritableQuad,
  validateQuadObjectTerms,
  validateWritableQuadLiteralSizes,
  oversizedRdfLiteralResponseBody,
  jsonResponse,
  safeDecodeURIComponent,
  safeParseJson,
  validateOptionalSubGraphName,
  validateRequiredContextGraphId,
  resolveRequiredWriteContextGraphId,
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
import { authorizeAgentScopedAuthorClaim, isSameAgentAddress } from './shared-assertion-helpers.js';

/**
 * Validate a `preSignedAuthorAttestation` payload from a finalize request.
 *
 * Shape:
 *   { address: "0x...", signature: { r: "0x..." | number[], vs: "0x..." | number[] } }
 *
 * Returns the normalised value with byte arrays (Uint8Array) ready to forward
 * into `agent.assertion.finalize`. Returns `undefined` and writes an
 * appropriate 400 response when the payload is malformed.
 *
 * The on-chain signature check happens later inside the agent's finalize
 * path (it recovers the address from the EIP-712 digest and fails closed
 * if the recovered signer doesn't match the claimed address).
 *
 * RFC-001 Section 9.x -- Phase C -- pre-signed attestations are a finalize-time
 * concern. The publish layer no longer accepts them; they're consumed
 * here and stamped into the seal.
 */
type PreSignedAuthorAttestation = {
  address: string;
  // OT-RFC-43 Section F2 -- the packed reservedKaId the author signed over. Required so
  // the daemon honours the author's reserved slot (the digest binds it) rather
  // than re-allocating; threaded into agent.assertion.finalize.
  reservedKaId: bigint;
  signature: { r: Uint8Array; vs: Uint8Array };
};


export function validatePreSignedAuthorAttestation(
  raw: unknown,
  res: ServerResponse,
): PreSignedAuthorAttestation | undefined {
  if (raw == null || typeof raw !== 'object') {
    jsonResponse(res, 400, {
      error: '"preSignedAuthorAttestation" must be an object',
    });
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const address = typeof obj.address === 'string' ? obj.address : undefined;
  const signature = obj.signature && typeof obj.signature === 'object'
    ? (obj.signature as Record<string, unknown>)
    : undefined;
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address) || !signature) {
    jsonResponse(res, 400, {
      error: '"preSignedAuthorAttestation" requires { address: 0x..., signature: { r, vs } }',
    });
    return undefined;
  }
  const decode = (label: string, val: unknown): Uint8Array | undefined => {
    if (typeof val === 'string') {
      const stripped = val.startsWith('0x') ? val.slice(2) : val;
      if (stripped.length !== 64 || !/^[0-9a-fA-F]+$/.test(stripped)) return undefined;
      return Uint8Array.from(Buffer.from(stripped, 'hex'));
    }
    if (Array.isArray(val) && val.length === 32 && val.every((b) => typeof b === 'number' && b >= 0 && b <= 255)) {
      return Uint8Array.from(val as number[]);
    }
    void label;
    return undefined;
  };
  const r = decode('r', signature.r);
  const vs = decode('vs', signature.vs);
  if (!r || !vs) {
    jsonResponse(res, 400, {
      error: '"preSignedAuthorAttestation.signature.r" and ".vs" must each be 32-byte hex strings or 32-element byte arrays',
    });
    return undefined;
  }
  // OT-RFC-43 Section F2 -- the AuthorAttestation digest binds the packed reservedKaId,
  // so the caller MUST forward the exact id they signed over. It travels as a
  // decimal string (uint256-safe over JSON); accept an integer number too.
  const reservedKaId = decodeReservedKaId(obj.reservedKaId);
  if (reservedKaId === undefined) {
    jsonResponse(res, 400, {
      error: '"preSignedAuthorAttestation.reservedKaId" must be the packed KA id the author signed over, as a non-negative decimal string (OT-RFC-43 Section F2)',
    });
    return undefined;
  }
  return { address, reservedKaId, signature: { r, vs } };
}

const MAX_UINT256 = (1n << 256n) - 1n;
function decodeReservedKaId(val: unknown): bigint | undefined {
  let s: string;
  if (typeof val === 'string') s = val.trim();
  else if (typeof val === 'number' && Number.isInteger(val) && val >= 0) s = String(val);
  else return undefined;
  if (!/^[0-9]+$/.test(s)) return undefined;
  const n = BigInt(s);
  if (n < 0n || n > MAX_UINT256) return undefined;
  return n;
}

const swmCatchupPeerSelector = createSwmCatchupPeerSelector();

type SwmCatchupDetailedResult = {
  insertedTriples: number;
  fetchedDataTriples?: number;
  fetchedMetaTriples?: number;
  deniedPhases?: number;
  failedPeers?: number;
  failedPhases?: number;
  timedOutPhases?: number;
  backoffWorthyFailures?: number;
};

function swmCatchupResultFromInserted(insertedTriples: number): SwmCatchupDetailedResult {
  return { insertedTriples };
}

function swmCatchupOutcomeInput(result: SwmCatchupDetailedResult, errorMessage?: string) {
  return {
    insertedTriples: result.insertedTriples,
    fetchedDataTriples: result.fetchedDataTriples,
    fetchedMetaTriples: result.fetchedMetaTriples,
    deniedPhases: result.deniedPhases,
    failedPeers: result.failedPeers,
    failedPhases: result.failedPhases,
    timedOutPhases: result.timedOutPhases,
    backoffWorthyFailures: result.backoffWorthyFailures,
    errorMessage,
  };
}

function uniquePeerIds(peerIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const peerId of peerIds) {
    if (!peerId || seen.has(peerId)) continue;
    seen.add(peerId);
    out.push(peerId);
  }
  return out;
}

export async function handleMemoryRoutes(ctx: RequestContext): Promise<void> {
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
    emitNotification,
  } = ctx;
  const writePreflightCallerAgentAddress = requestToken
    ? agent.resolveAgentByToken(requestToken)
    : undefined;
  const writePreflightContextGraphOpts = {
    callerAgentAddress: writePreflightCallerAgentAddress,
    allowLocalExactFallback: !writePreflightCallerAgentAddress,
  };


  // POST /api/profile/query-catalog/write
  //
  // UI profile metadata intentionally lives in unregistered `.../meta/...`
  // graphs. Do not route this through shared-memory sub-graph writes: that
  // path correctly enforces registered sub-graphs, which is wrong for this
  // local profile/catalog namespace.
  if (req.method === "POST" && path === "/api/profile/query-catalog/write") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;

    const contextGraphId = parsed.contextGraphId;
    const resolvedContextGraphId = await resolveRequiredWriteContextGraphId(
      agent,
      contextGraphId,
      res,
      writePreflightContextGraphOpts,
    );
    if (!resolvedContextGraphId) return;

    const { quads } = parsed;
    if (!Array.isArray(quads) || quads.length === 0) {
      return jsonResponse(res, 400, {
        error: 'Missing or invalid "quads" (must be a non-empty array)',
      });
    }

    const graph = `did:dkg:context-graph:${resolvedContextGraphId}/meta/query-catalog`;
    try {
      assertSafeIri(graph);
      const normalized = quads.map((quad: unknown, index: number) => {
        if (!quad || typeof quad !== "object" || Array.isArray(quad)) {
          throw new Error(`quads[${index}] must be an object`);
        }
        const q = quad as Record<string, unknown>;
        if (typeof q.subject !== "string" || q.subject.length === 0) {
          throw new Error(`quads[${index}].subject must be a non-empty string`);
        }
        if (typeof q.predicate !== "string" || q.predicate.length === 0) {
          throw new Error(`quads[${index}].predicate must be a non-empty string`);
        }
        if (typeof q.object !== "string" || q.object.length === 0) {
          throw new Error(`quads[${index}].object must be a non-empty string`);
        }

        assertSafeIri(q.subject);
        assertSafeIri(q.predicate);
        if (q.object.startsWith('"')) {
          assertSafeRdfTerm(q.object);
        } else {
          assertSafeIri(q.object);
        }

        return {
          subject: q.subject,
          predicate: q.predicate,
          object: q.object,
          graph,
        };
      });

      const literalSize = validateWritableQuadLiteralSizes("quads", normalized);
      if (!literalSize.ok) return jsonResponse(res, 400, literalSize.body);
      await agent.store.insert(normalized);
      return jsonResponse(res, 200, {
        ok: true,
        contextGraphId: resolvedContextGraphId,
        graph,
        triplesWritten: normalized.length,
      });
    } catch (err: any) {
      return jsonResponse(res, 400, {
        error: err?.message ?? "Invalid query catalog write",
      });
    }
  }

  // POST /api/profile/query-catalog/read { contextGraphId }
  if (req.method === "POST" && path === "/api/profile/query-catalog/read") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;

    const contextGraphId = parsed.contextGraphId;
    if (!validateRequiredContextGraphId(contextGraphId, res)) return;

    const graph = `did:dkg:context-graph:${contextGraphId}/meta/query-catalog`;
    const query = `PREFIX prof: <http://dkg.io/ontology/profile/>
PREFIX schema: <http://schema.org/>
SELECT ?q ?subGraph ?catalog ?name ?description ?sparql ?resultColumn ?rank ?catalogName ?catalogDescription ?catalogRank
WHERE {
  GRAPH <${graph}> {
    ?q a prof:SavedQuery ;
       prof:forSubGraph ?subGraph ;
       prof:sparqlQuery ?sparql .
    OPTIONAL { ?q prof:inCatalog ?catalog }
    OPTIONAL { ?q prof:displayName ?name }
    OPTIONAL { ?q schema:description ?description }
    OPTIONAL { ?q prof:resultColumn ?resultColumn }
    OPTIONAL { ?q prof:rank ?rank }
    OPTIONAL { ?catalog prof:displayName ?catalogName }
    OPTIONAL { ?catalog schema:description ?catalogDescription }
    OPTIONAL { ?catalog prof:rank ?catalogRank }
  }
}`;

    try {
      const result = await agent.store.query(query);
      const bindings = result.type === "bindings" ? result.bindings : [];
      return jsonResponse(res, 200, {
        contextGraphId,
        graph,
        result: {
          type: "bindings",
          bindings,
        },
      });
    } catch (err: any) {
      return jsonResponse(res, 400, {
        error: err?.message ?? "Query catalog read failed",
      });
    }
  }

  // POST /api/shared-memory/catchup
  //
  // OT-RFC-38 LU-7 -- explicit SWMCatchupRequest endpoint. Pulls the
  // remote SWM state for one or more context graphs from connected
  // peers, applying everything authorized into the local triple store.
  //
  // Body: { contextGraphId: string | string[], peerId?: string }
  //   - peerId: optional. When set, sync only from this specific peer.
  //     When omitted, iterate ALL currently-connected libp2p peers and
  //     try each -- first peer that authorises serves the request,
  //     subsequent peers' decisions are independent.
  //
  // Returns: per-peer outcome with inserted/fetched counters.
  //
  // Auth model (per SPEC_CG_HOSTING_MEMBERSHIP Section 5.6.4):
  //   - Public CGs (accessPolicy == 0): the responder's sync handler
  //     accepts anonymous catchup (no `authorizePrivateSyncRequest`
  //     gate). Any reachable peer can backfill SWM.
  //   - Curated CGs (accessPolicy == 1): the responder's sync handler
  //     runs `authorizePrivateSyncRequest`, which verifies the
  //     requester's signed envelope against the CG's
  //     `agentGateAddresses` / `allowedPeers` set. Members get
  //     served; outsiders get a `syncDeniedResponse`.
  //   - Token-bearer (outsider-with-curator-issued-bearer): not yet
  //     implemented; tracked under LU-9 member-attestation work.
  if (req.method === "POST" && path === "/api/shared-memory/catchup") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const peerIdParam = typeof parsed.peerId === 'string' ? parsed.peerId.trim() : undefined;
    const cgIdsInput = Array.isArray(parsed.contextGraphId)
      ? parsed.contextGraphId
      : parsed.contextGraphId !== undefined
        ? [parsed.contextGraphId]
        : [];
    const cgIds: string[] = [];
    for (const id of cgIdsInput) {
      if (typeof id !== 'string' || !validateRequiredContextGraphId(id, res)) return;
      cgIds.push(id);
    }
    if (cgIds.length === 0) {
      return jsonResponse(res, 400, {
        error:
          'Missing "contextGraphId" -- pass a single context graph id string or an array of ids',
      });
    }

    // OT-RFC-38 LU-7: SWMCatchupRequest is SWM-only by default. The durable
    // (knowledge-collection) layer has its own publish-time
    // commit->fanout->ACK protocol and a separate sync substrate; it's
    // out of scope for the catchup endpoint and would otherwise compound
    // the request budget (240s vs 120s). Opt-in via includeDurable=true
    // for callers that want the full data leg in the same call. Recovery
    // operators may additionally pass includeSharedMemory=false to resume
    // only the durable leg without replaying an already-complete SWM
    // snapshot first.
    const includeSharedMemory = parsed.includeSharedMemory !== false;
    const includeDurable = parsed.includeDurable === true;

    // Per-peer operation deadline. Signal-aware work stops accepting new
    // fetch/authentication/materialization work at this bound. If an atomic
    // store commit already crossed its non-cancellable dispatch boundary, the
    // route awaits settlement so its response reports the real commit outcome
    // instead of returning a false zero-insert failure. SWM-only path:
    // ~45s/page * a couple of pages worst-case; under heavy gossip
    // load (the integration suite) backed-off retries can stretch this
    // out further. Underlying SYNC_TOTAL_TIMEOUT_MS in dkg-agent is
    // 120s, so use 110s by default and let callers override via the
    // request body for slow or congested networks.
    const DEFAULT_PER_PEER_SWM_BUDGET_MS = 110_000;
    const DEFAULT_PER_PEER_DURABLE_BUDGET_MS = 110_000;
    // Explicit integer-floor + range-check pattern: lets CodeQL's taint
    // analysis prove the timer duration is bounded to [1_000, 300_000]ms
    // even when the input arrives via untrusted JSON. Math.min alone reads
    // as "user-controlled" to the resource-exhaustion rule.
    const MIN_BUDGET_MS = 1_000;
    const MAX_BUDGET_MS = 300_000;
    const boundedBudget = (raw: unknown, fallback: number): number => {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
      const n = Math.floor(raw);
      if (n < MIN_BUDGET_MS || n > MAX_BUDGET_MS) return fallback;
      return n;
    };
    const PER_PEER_SWM_BUDGET_MS = boundedBudget(parsed.perPeerBudgetMs, DEFAULT_PER_PEER_SWM_BUDGET_MS);
    const PER_PEER_DURABLE_BUDGET_MS = boundedBudget(parsed.perPeerDurableBudgetMs, DEFAULT_PER_PEER_DURABLE_BUDGET_MS);
    const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        p.then(
          (v) => { clearTimeout(t); resolve(v); },
          (e) => { clearTimeout(t); reject(e); },
        );
      });

    // Discover candidate peers per CG. The single-peer mode is opt-in; the
    // default path still starts from the Phase-A host enumerator, then applies
    // requester-side narrowing: protocol support, private-curator scope, and
    // recent SWM outcome cache. Unknown state still gets a bounded probe so
    // cold catchup can discover a new useful peer.
    const { createCGHostEnumerator } = await import('@origintrail-official/dkg-agent');
    const connectedPeerIds = () => agent.node.libp2p.getConnections().map((c: any) => c.remotePeer.toString());
    const enumerator = createCGHostEnumerator({
      getConnectedPeers: connectedPeerIds,
      getSelfPeerId: () => agent.peerId,
    });
    const protocolChecks = new Map<string, Promise<boolean | undefined>>();
    const hasCurrentSyncProtocol = (peerId: string): Promise<boolean | undefined> => {
      let check = protocolChecks.get(peerId);
      if (!check) {
        check = Promise.resolve()
          .then(() => agent.getPeerProtocols(peerId))
          .then((protocols) => protocols.includes(PROTOCOL_SYNC))
          .catch(() => undefined);
        protocolChecks.set(peerId, check);
      }
      return check;
    };
    const candidatePeersForContextGraph = async (cgId: string): Promise<string[]> =>
      peerIdParam ? [peerIdParam] : enumerator.enumerate(cgId);
    const canUseSharedMemoryForContextGraph = async (cgId: string): Promise<boolean> => {
      try {
        return await agent.canUseSharedMemoryForContextGraph(cgId);
      } catch {
        return true;
      }
    };
    const unsupportedPeersForContextGraph = async (cgId: string, peers: readonly string[]): Promise<Set<string>> => {
      const unsupported = new Set<string>();
      await Promise.all(peers.map(async (peerId) => {
        const supported = await hasCurrentSyncProtocol(peerId);
        if (supported === false) {
          unsupported.add(peerId);
          swmCatchupPeerSelector.record(cgId, peerId, 'unsupported');
        }
      }));
      return unsupported;
    };
    const privateCuratorPeersForContextGraph = async (cgId: string): Promise<string[] | undefined> => {
      let isPrivate = false;
      try {
        isPrivate = await agent.isPrivateContextGraph(cgId);
      } catch {
        return undefined;
      }
      if (!isPrivate) return undefined;
      try {
        const resolved = await agent.resolveCuratorPeerIdsForCg(cgId);
        if (resolved.curatorIsLocal) return [];
        return resolved.peerIds.length > 0 ? resolved.peerIds : undefined;
      } catch {
        return undefined;
      }
    };

    if (
      !peerIdParam
      && connectedPeerIds().length === 0
      && !(includeDurable && !includeSharedMemory)
    ) {
      return jsonResponse(res, 200, {
        contextGraphIds: cgIds,
        peersAttempted: 0,
        results: [],
        hint: 'No connected peers to catch up from. Wait for inbound connections or pass an explicit `peerId`.',
      });
    }

    // Per-CG Ã— per-peer sync. The previous shape called
    // `syncSharedMemoryFromPeer(peer, cgIds)` ONCE per peer with the
    // full CG list, which only returned an aggregate count and made
    // a per-CG LU-6 fallback decision impossible (Codex PR #610 R1
    // comment 1: if one CG got triples from standard sync, fallback
    // for the others got skipped on the aggregate gate).
    //
    // Now: iterate CGs serially (keeps wire load bounded across many
    // peers Ã— many CGs), select a narrowed per-CG peer set, and parallelize
    // only that set. Per-peer dial+request is 5-20s on devnet; serialising
    // the selected peers would compound to NÃ—20s.
    type PerPeerLeg = {
      peerId: string;
      insertedTriples: number;
      durableInsertedTriples: number;
      /** Typed internal outcome; omitted from the legacy HTTP response shape. */
      durableState?: DurableCatchupLegState;
      /** Present when the agent supports detailed durable-sync outcomes. */
      durableComplete?: boolean;
      durableDiagnostics?: DurableLegDiagnostics;
      swmError?: string;
      durableError?: string;
      error?: string;
    };
    type PerCgLeg = {
      contextGraphId: string;
      perPeer: PerPeerLeg[];
      insertedTriples: number;
      durableInsertedTriples: number;
    };
    const perCgLegs: PerCgLeg[] = [];
    for (const cgId of cgIds) {
      const canUseSharedMemory = includeSharedMemory
        && await canUseSharedMemoryForContextGraph(cgId);
      if (!canUseSharedMemory && !includeDurable) {
        perCgLegs.push({
          contextGraphId: cgId,
          perPeer: [],
          insertedTriples: 0,
          durableInsertedTriples: 0,
        });
        continue;
      }
      const baseCandidatePeers = await candidatePeersForContextGraph(cgId);
      // An explicit peerId is an operator-directed bounded probe. libp2p's
      // identify-backed peerStore can lag a live connection, so an absent
      // protocol advertisement must not suppress the wire negotiation the
      // operator requested. Default peer enumeration remains conservative and
      // filters peers that are known not to advertise the current sync wire.
      const unsupportedPeers = peerIdParam
        ? new Set<string>()
        : await unsupportedPeersForContextGraph(cgId, baseCandidatePeers);
      const privateCuratorPeerIds = await privateCuratorPeersForContextGraph(cgId);
      const swmSelectedPeers = canUseSharedMemory
        ? swmCatchupPeerSelector.select({
            contextGraphId: cgId,
            candidatePeers: baseCandidatePeers,
            unsupportedPeers,
            privateCuratorPeerIds,
          }).selectedPeers
        : [];
      const durableSelectedPeers = includeDurable
        ? uniquePeerIds(baseCandidatePeers).filter((peerId) => !unsupportedPeers.has(peerId))
        : [];
      const swmSelected = new Set(swmSelectedPeers);
      const durableSelected = new Set(durableSelectedPeers);
      const selectedPeers = uniquePeerIds([...swmSelectedPeers, ...durableSelectedPeers]);
      const settled = await Promise.allSettled(
        selectedPeers.map(async (candidate) => {
          let swm = 0;
          let durable = 0;
          let durableState: DurableCatchupLegState | undefined;
          let durableComplete: boolean | undefined;
          let durableDiagnostics: DurableLegDiagnostics | undefined;
          let durableFailureReasons: DurableCatchupFailureReason[] | undefined;
          let swmError: string | undefined;
          let durableError: string | undefined;
          if (swmSelected.has(candidate)) {
            try {
              const syncResult = await withTimeout(
                typeof (agent as any).syncSharedMemoryFromPeerDetailed === 'function'
                  ? (agent as any).syncSharedMemoryFromPeerDetailed(candidate, [cgId])
                  : agent.syncSharedMemoryFromPeer(candidate, [cgId]).then(swmCatchupResultFromInserted),
                PER_PEER_SWM_BUDGET_MS,
                `SWM catchup from ${candidate} for ${cgId}`,
              ) as SwmCatchupDetailedResult;
              swm = Number(syncResult.insertedTriples ?? 0);
              swmCatchupPeerSelector.record(
                cgId,
                candidate,
                classifySwmCatchupPeerOutcome(swmCatchupOutcomeInput({ ...syncResult, insertedTriples: swm })),
              );
            } catch (err: any) {
              swmError = err?.message ?? String(err);
              swmCatchupPeerSelector.record(
                cgId,
                candidate,
                classifySwmCatchupPeerOutcome(swmCatchupOutcomeInput({ insertedTriples: 0 }, swmError)),
              );
            }
          }
          if (durableSelected.has(candidate)) {
            // The helper owns one outer deadline for fetch, verification, and
            // authentication. Its AbortSignal prevents entry into later commit
            // boundaries; an already-started atomic commit is awaited so the
            // response remains consistent with the store.
            const durableLeg = await runDurableCatchupLeg(
              agent,
              candidate,
              cgId,
              PER_PEER_DURABLE_BUDGET_MS,
            );
            durable = durableLeg.insertedTriples;
            durableState = durableLeg.state;
            durableDiagnostics = durableLeg.diagnostics;
            durableComplete = durableLeg.complete;
            durableFailureReasons = durableLeg.failureReasons;
            durableError = formatDurableCatchupFailure(durableFailureReasons);
          }
          return {
            peerId: candidate,
            insertedTriples: swm,
            durableInsertedTriples: durable,
            durableState,
            durableComplete,
            durableDiagnostics,
            swmError,
            durableError,
          } as PerPeerLeg;
        }),
      );
      const perPeer: PerPeerLeg[] = settled.map((s, idx) => {
        if (s.status === 'fulfilled') {
          return {
            peerId: selectedPeers[idx],
            insertedTriples: s.value.insertedTriples,
            durableInsertedTriples: s.value.durableInsertedTriples,
            ...(s.value.durableState ? { durableState: s.value.durableState } : {}),
            ...(s.value.durableComplete !== undefined ? { durableComplete: s.value.durableComplete } : {}),
            ...(s.value.durableDiagnostics ? { durableDiagnostics: s.value.durableDiagnostics } : {}),
            ...(s.value.swmError ? { swmError: s.value.swmError } : {}),
            ...(s.value.durableError ? { durableError: s.value.durableError } : {}),
          };
        }
        return {
          peerId: selectedPeers[idx],
          insertedTriples: 0,
          durableInsertedTriples: 0,
          error: s.reason?.message ?? String(s.reason),
        };
      });
      perCgLegs.push({
        contextGraphId: cgId,
        perPeer,
        insertedTriples: perPeer.reduce((sum, p) => sum + p.insertedTriples, 0),
        durableInsertedTriples: perPeer.reduce((sum, p) => sum + (p.durableInsertedTriples ?? 0), 0),
      });
    }

    // OT-RFC-38 LU-6 -- per-CG host-catchup fallback. For each CG
    // whose standard sync inserted 0 triples, fall back to fetching
    // opaque ciphertext envelopes from connected core hosts and
    // re-applying them through the local sender-key decryptor.
    // This is the "every member is offline; only cores still hold
    // the substrate" recovery path.
    //
    // Behaviour:
    //  - Default ON; opt out via { hostCatchupFallback: false }.
    //  - Decision is per-CG: a multi-CG catchup where some CGs got
    //    triples from standard sync and others didn't will still run
    //    fallback for the empty ones (Codex PR #610 R1 fix).
    //  - The host-catchup leg has its own internal time budget
    //    (sendReliable + a few rounds per peer); CGs are processed
    //    serially to keep wire load low.
    const hostCatchupOpted = includeSharedMemory && parsed.hostCatchupFallback !== false;
    const hostCatchupSupported = typeof (agent as any).catchupSwmFromConnectedHosts === 'function';
    type HostCatchupLeg = {
      contextGraphId: string;
      peers: Awaited<ReturnType<typeof agent.catchupSwmFromConnectedHosts>>;
      /** Envelope-level counter from the replay path. NOT a triples count. */
      appliedEnvelopes: number;
      /** Triples (N-Quads) inserted by successful replays. Maps to the public `appliedTotal`. */
      appliedTotal: number;
      error?: string;
    };
    const hostCatchup: HostCatchupLeg[] = [];
    if (hostCatchupOpted && hostCatchupSupported) {
      for (const cg of perCgLegs) {
        if (cg.insertedTriples > 0) continue;
        try {
          const peerResults = await (agent as any).catchupSwmFromConnectedHosts(cg.contextGraphId, {
            peers: peerIdParam ? [peerIdParam] : undefined,
            maxRounds: 8,
          });
          // Codex PR #610 R2: `r.applied` is the count of replayed
          // envelopes (booleans), NOT inserted triples. One envelope
          // can carry many quads, so summing `r.applied` here would
          // undercount whenever a publisher batched > 1 triple per
          // share. Use `r.appliedTriples` (threaded through
          // `catchupSwmFromHost` / `SharedMemoryApplyOutcome`) for
          // the triples total surfaced as `appliedTotal` and rolled
          // into the top-level `totalInsertedTriples`.
          const appliedTotal = peerResults.reduce((sum: number, r: any) => sum + (r.appliedTriples ?? 0), 0);
          const appliedEnvelopes = peerResults.reduce((sum: number, r: any) => sum + (r.applied ?? 0), 0);
          hostCatchup.push({ contextGraphId: cg.contextGraphId, peers: peerResults, appliedEnvelopes, appliedTotal });
        } catch (err: any) {
          hostCatchup.push({
            contextGraphId: cg.contextGraphId,
            peers: [],
            appliedEnvelopes: 0,
            appliedTotal: 0,
            error: err?.message ?? String(err),
          });
        }
      }
    }
    const hostCatchupAppliedTotal = hostCatchup.reduce((sum, h) => sum + h.appliedTotal, 0);
    const hostCatchupEnvelopesTotal = hostCatchup.reduce((sum, h) => sum + h.appliedEnvelopes, 0);

    // Codex PR #610 R1 comment 2: `totalInsertedTriples` must cover
    // BOTH the standard sync leg and the LU-6 host-catchup leg so
    // callers that read just this top-level field don't mistake a
    // successful host-catchup recovery for a no-op.
    const standardInserted = perCgLegs.reduce((sum, c) => sum + c.insertedTriples, 0);
    const totalInserted = standardInserted + hostCatchupAppliedTotal;
    const totalDurable = perCgLegs.reduce((sum, c) => sum + c.durableInsertedTriples, 0);

    // Flatten per-peer into a `results` array for callers that
    // only care about the aggregate peer view. The richer per-CG
    // breakdown lives in `perContextGraph`.
    //
    // Codex PR #610 R4: preserve `swmError` and `durableError` as
    // SEPARATE fields (legacy shape) instead of collapsing them
    // into a single `errors[]` array. The two errors come from
    // distinct legs of the catchup pipeline (live sync vs durable
    // VM reconstruction) and operators / dashboards have always
    // distinguished them. The first non-empty value per peer wins
    // (multiple CGs against the same peer are rare and the leg
    // identity is what matters, not which CG produced the
    // specific message).
    const perPeerAggregate = new Map<string, {
      peerId: string;
      insertedTriples: number;
      durableInsertedTriples: number;
      durableComplete?: boolean;
      swmError?: string;
      durableError?: string;
      otherErrors?: string[];
    }>();
    for (const cg of perCgLegs) {
      for (const p of cg.perPeer) {
        const entry = perPeerAggregate.get(p.peerId) ?? { peerId: p.peerId, insertedTriples: 0, durableInsertedTriples: 0 };
        entry.insertedTriples += p.insertedTriples;
        entry.durableInsertedTriples += p.durableInsertedTriples;
        if (p.durableComplete !== undefined) {
          entry.durableComplete = entry.durableComplete === undefined
            ? p.durableComplete
            : entry.durableComplete && p.durableComplete;
        }
        if (p.swmError && !entry.swmError) entry.swmError = p.swmError;
        if (p.durableError && !entry.durableError) entry.durableError = p.durableError;
        if (p.error) entry.otherErrors = [...(entry.otherErrors ?? []), p.error];
        perPeerAggregate.set(p.peerId, entry);
      }
    }
    const results = [...perPeerAggregate.values()].map((r) => ({
      peerId: r.peerId,
      insertedTriples: r.insertedTriples,
      durableInsertedTriples: r.durableInsertedTriples,
      ...(r.durableComplete !== undefined ? { durableComplete: r.durableComplete } : {}),
      ...(r.swmError ? { swmError: r.swmError } : {}),
      ...(r.durableError ? { durableError: r.durableError } : {}),
      ...(r.otherErrors && r.otherErrors.length > 0 ? { errors: r.otherErrors } : {}),
    }));

    // A durable-only operator request must not look successful until every
    // detailed attempt reaches a terminal sync result. Preserve HTTP 200 for
    // safely committed/checkpointed prefixes, but make the body explicitly
    // retryable and `ok:false`; callers that only inspect `ok` must not confuse
    // useful partial progress with completed catch-up. Keep mixed SWM+durable
    // responses backward-compatible, and reserve 503 for the unambiguous case
    // where every durable-only attempt failed without a usable result.
    const durableOutcome = classifyDurableCatchupRequest(
      perCgLegs.map((cg) => cg.perPeer),
      includeDurable,
      includeSharedMemory,
    );

    return jsonResponse(res, durableOutcome.responseStatus, {
      ok: !durableOutcome.allPeersFailed && !durableOutcome.incomplete,
      ...(durableOutcome.errorBody ?? {}),
      contextGraphIds: cgIds,
      peersAttempted: perPeerAggregate.size,
      includeSharedMemory,
      includeDurable,
      ...(durableOutcome.complete !== undefined ? { durableComplete: durableOutcome.complete } : {}),
      totalInsertedTriples: totalInserted,
      totalDurableInsertedTriples: totalDurable,
      standardInsertedTriples: standardInserted,
      results,
      perContextGraph: perCgLegs.map((cg, index) => {
        const durableComplete = durableOutcome.perContextGraphCompletion[index];
        return {
          contextGraphId: cg.contextGraphId,
          insertedTriples: cg.insertedTriples,
          durableInsertedTriples: cg.durableInsertedTriples,
          ...(durableComplete !== undefined ? { durableComplete } : {}),
          perPeer: cg.perPeer.map(({ durableState: _durableState, ...peer }) => peer),
        };
      }),
      hostCatchup: hostCatchupOpted ? {
        ranFallback: hostCatchup.length > 0,
        triggeredForContextGraphIds: hostCatchup.map((h) => h.contextGraphId),
        // `appliedTotal` is triples (the user-facing unit); the
        // separate `appliedEnvelopes` is exposed for operators who
        // want to know how many discrete shares were replayed.
        appliedTotal: hostCatchupAppliedTotal,
        appliedEnvelopes: hostCatchupEnvelopesTotal,
        perContextGraph: hostCatchup,
      } : { ranFallback: false, triggeredForContextGraphIds: [], appliedTotal: 0, appliedEnvelopes: 0, perContextGraph: [] },
    });
  }

  // OT-RFC-38 LU-6 -- dedicated host-catchup endpoint.
  //
  // POST /api/shared-memory/host-catchup
  // Body: { contextGraphId: string, peerId?: string, sinceSeqno?: number, maxRounds?: number }
  //
  // Pulls opaque ciphertext envelopes from cores that have been
  // hosting the curated CG's SWM substrate and re-applies each
  // through the local agent so the existing Sender-Key decrypt
  // path runs verbatim. Distinct from the "fallback" leg embedded
  // in /catchup above -- exposed so operators can debug host
  // hosting independently (e.g. to confirm a specific core has
  // stored ciphertext for a CG).
  if (req.method === 'POST' && path === '/api/shared-memory/host-catchup') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    if (typeof parsed.contextGraphId !== 'string' || !parsed.contextGraphId.trim()) {
      return jsonResponse(res, 400, { error: 'Missing or invalid "contextGraphId"' });
    }
    const cgId = parsed.contextGraphId.trim();
    const peerIdParam = typeof parsed.peerId === 'string' ? parsed.peerId.trim() : undefined;
    const sinceSeqno = typeof parsed.sinceSeqno === 'number' && parsed.sinceSeqno >= 0 ? Math.floor(parsed.sinceSeqno) : 0;
    const maxRounds = typeof parsed.maxRounds === 'number' && parsed.maxRounds > 0 ? Math.min(64, Math.floor(parsed.maxRounds)) : 8;
    if (typeof (agent as any).catchupSwmFromConnectedHosts !== 'function') {
      return jsonResponse(res, 501, { error: 'Host-catchup is not supported on this agent build' });
    }
    try {
      const peerResults = await (agent as any).catchupSwmFromConnectedHosts(cgId, {
        peers: peerIdParam ? [peerIdParam] : undefined,
        sinceSeqno,
        maxRounds,
      });
      // Codex PR #610 R2: report triples (`appliedTriples`) as the
      // user-facing total; keep envelope count alongside as
      // `appliedEnvelopes` for diagnostics. Same fix as the
      // `/catchup` fallback leg above.
      const appliedTotal = peerResults.reduce((sum: number, r: any) => sum + (r.appliedTriples ?? 0), 0);
      const appliedEnvelopes = peerResults.reduce((sum: number, r: any) => sum + (r.applied ?? 0), 0);
      const fetchedTotal = peerResults.reduce((sum: number, r: any) => sum + (r.fetched ?? 0), 0);
      return jsonResponse(res, 200, {
        contextGraphId: cgId,
        peers: peerResults,
        appliedTotal,
        appliedEnvelopes,
        fetchedTotal,
      });
    } catch (err: any) {
      return jsonResponse(res, 500, { error: err?.message ?? String(err) });
    }
  }

  // OT-RFC-38 LU-6 -- host-mode store diagnostics.
  // GET /api/shared-memory/host-mode/stats
  // Returns { enabled, cgCount, totalBytes, totalEntries, subscribedCgIds }.
  if (req.method === 'GET' && path === '/api/shared-memory/host-mode/stats') {
    if (typeof (agent as any).getSwmHostModeStats !== 'function') {
      return jsonResponse(res, 501, { error: 'Host-mode store is not supported on this agent build' });
    }
    try {
      const stats = await (agent as any).getSwmHostModeStats();
      return jsonResponse(res, 200, stats ?? { enabled: false });
    } catch (err: any) {
      return jsonResponse(res, 500, { error: err?.message ?? String(err) });
    }
  }

  // OT-RFC-38 LU-6 -- explicit host-mode subscribe.
  // POST /api/shared-memory/host-mode/subscribe { contextGraphId }
  // Tells a core to start hosting the curated CG's encrypted SWM
  // substrate WITHOUT requiring the core to become a CG member.
  // Used by operators in Phase A to designate per-core hosting
  // assignments while the sharding-table-based auto-discovery
  // matures. No-op on edges (host mode disabled).
  if (req.method === 'POST' && path === '/api/shared-memory/host-mode/subscribe') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    if (typeof parsed.contextGraphId !== 'string' || !parsed.contextGraphId.trim()) {
      return jsonResponse(res, 400, { error: 'Missing or invalid "contextGraphId"' });
    }
    if (typeof (agent as any).enableSwmHostModeFor !== 'function') {
      return jsonResponse(res, 501, { error: 'Host-mode subscribe is not supported on this agent build' });
    }
    try {
      const result = await (agent as any).enableSwmHostModeFor(parsed.contextGraphId.trim());
      return jsonResponse(res, 200, { contextGraphId: parsed.contextGraphId.trim(), ...result });
    } catch (err: any) {
      return jsonResponse(res, 500, { error: err?.message ?? String(err) });
    }
  }

  // Tiny local helper -- kept inline to avoid adding a new import for
  // a single use; the existing route module already has utilities
  // for hex/bytes interop scattered across the file but none are
  // strictly typed `bytes32`. 64-char hex (no 0x) -> 32-byte buffer.
  function hexToBytes32(h: string): Uint8Array {
    const clean = h.startsWith('0x') ? h.slice(2) : h;
    if (clean.length !== 64) throw new Error('expected 32-byte hex');
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  // POST /api/shared-memory/verify-batch
  //
  // OT-RFC-38 LU-8 -- Member post-decrypt batch verification.
  //
  // SPEC_CG_HOSTING_MEMBERSHIP Section 5.3.1: members re-derive the plaintext
  // merkle root from a reconstructed batch and compare to the on-chain
  // anchor. This endpoint exposes the recompute step.
  //
  // Body: {
  //   contextGraphId: string,
  //   expectedMerkleRoot: hex32 string ("0x" + 64 hex chars),
  //   quads: Quad[],             // exact plaintext quads for this batch
  //   subGraphName?: string,
  //   privateRoots?: hex32[],    // optional per-KA private sub-roots
  //   batchId?: string,          // round-tripped into rejection record
  // }
  //
  // Returns: { ok, expectedRoot, actualRoot, leafCount, reason? }
  if (req.method === "POST" && path === "/api/shared-memory/verify-batch") {
    // `quads` is now mandatory so the caller supplies the exact plaintext
    // batch. Use the data-heavy endpoint limit rather than the small settings
    // limit; otherwise valid batches over 256 KB cannot be verified.
    const body = await readBody(req, MAX_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const contextGraphId = parsed.contextGraphId;
    if (!validateRequiredContextGraphId(contextGraphId, res)) return;
    const subGraphName = parsed.subGraphName;
    if (subGraphName !== undefined && !validateOptionalSubGraphName(subGraphName, res)) return;
    const expectedHex = String(parsed.expectedMerkleRoot ?? '');
    if (!/^0x[0-9a-fA-F]{64}$/.test(expectedHex)) {
      return jsonResponse(res, 400, {
        error: 'expectedMerkleRoot must be a 0x-prefixed 32-byte hex string',
      });
    }
    const expectedRoot = hexToBytes32(expectedHex);
    const privateRootsHex = Array.isArray(parsed.privateRoots) ? parsed.privateRoots : [];
    const privateRoots: Uint8Array[] = [];
    for (const ph of privateRootsHex) {
      if (typeof ph !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(ph)) {
        return jsonResponse(res, 400, {
          error: 'privateRoots[*] must be 0x-prefixed 32-byte hex strings',
        });
      }
      privateRoots.push(hexToBytes32(ph));
    }
    if (!Array.isArray(parsed.quads)) {
      return jsonResponse(res, 400, {
        error:
          `verify-batch requires explicit \`quads\` in the request body. ` +
          `The daemon cannot safely reconstruct a single batch from the local ` +
          `SWM/data graph because that graph can contain triples from other ` +
          `batches in the same context graph.`,
      });
    }

    const quads: Array<{ subject: string; predicate: string; object: string; graph: string }> = parsed.quads.map(
      (q: any) => ({
        subject: String(q.subject),
        predicate: String(q.predicate),
        object: String(q.object),
        graph: String(q.graph ?? ''),
      }),
    );

    const { verifyBatch } = await import('@origintrail-official/dkg-agent');
    const verifyResult = verifyBatch({ quads, privateRoots, expectedRoot });
    return jsonResponse(res, 200, {
      contextGraphId,
      ...(parsed.batchId !== undefined ? { batchId: parsed.batchId } : {}),
      quadsConsidered: quads.length,
      ...verifyResult,
    });
  }

  // POST /api/attestation/mint
  //
  // OT-RFC-38 LU-9 -- Member-attested verification token.
  //
  // Body: {
  //   contextGraphId: string,            // local CG id (numeric on-chain id resolved server-side)
  //   batchId: string,                   // typically the KC id
  //   merkleRoot: hex32,
  //   plaintextLeafHash: hex32,          // keccak256 over the canonical leaf
  // }
  // The daemon signs the attestation using the node's wallet
  // (`chain.signMessage`). The returned token is self-contained and can
  // be handed to any outsider for verification.
  if (req.method === "POST" && path === "/api/attestation/mint") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const contextGraphId = parsed.contextGraphId;
    if (!validateRequiredContextGraphId(contextGraphId, res)) return;
    const { batchId, merkleRoot, plaintextLeafHash } = parsed;
    if (!batchId || typeof batchId !== 'string') {
      return jsonResponse(res, 400, { error: 'batchId is required' });
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(merkleRoot ?? ''))) {
      return jsonResponse(res, 400, { error: 'merkleRoot must be 0x + 64 hex chars' });
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(plaintextLeafHash ?? ''))) {
      return jsonResponse(res, 400, { error: 'plaintextLeafHash must be 0x + 64 hex chars' });
    }

    const chain: any = (agent as any).chain ?? (agent as any).chainAdapter;
    const kavAddress = chain?.contracts?.knowledgeAssetsLifecycle?.target?.toString()
      ?? chain?.kavAddress
      ?? parsed.kavAddress;
    const chainId = chain?.chainId ?? parsed.chainId ?? '31337';
    if (!kavAddress || !/^0x[0-9a-fA-F]{40}$/.test(String(kavAddress))) {
      return jsonResponse(res, 400, {
        error: 'cannot determine KAV10 address -- pass `kavAddress` explicitly',
      });
    }

    // Resolve on-chain contextGraphId.
    //
    // Codex PR #609: previously fell back to `"0"` when local
    // subscription metadata couldn't resolve the on-chain id. That
    // silently minted an attestation token bound to ContextGraphId=0
    // (the sentinel for "no on-chain CG") even though a real KC for
    // this batch already exists on-chain -- outsiders verifying the
    // token would see it pass cryptographic checks but reject as
    // wrong-domain, with no diagnostic linking back to the actual CG.
    // Three resolution layers, all fail-closed:
    //   1. Caller-supplied `onChainContextGraphId` (explicit override).
    //   2. Chain-truth via `chain.getKAContextGraphId(batchId)` --
    //      authoritative because the KC <-> CG binding is on-chain.
    //   3. Local CG listing (last-resort, may be stale post-event-replay).
    // If none resolve, reject with 400 -- minting against id=0 is never
    // correct.
    let onChainCgId: string | undefined;
    if (typeof parsed.onChainContextGraphId === 'string' && /^\d+$/.test(parsed.onChainContextGraphId)) {
      onChainCgId = parsed.onChainContextGraphId;
    } else {
      try {
        if (typeof chain?.getKAContextGraphId === 'function' && /^\d+$/.test(String(batchId))) {
          const chainCgId = await chain.getKAContextGraphId(BigInt(batchId)).catch(() => null);
          if (chainCgId != null && chainCgId !== 0n) {
            onChainCgId = chainCgId.toString();
          }
        }
      } catch { /* fall through to local lookup */ }
      if (!onChainCgId) {
        try {
          const cgList = await (agent as any).listContextGraphs?.();
          const match = (cgList ?? []).find((cg: any) => cg.id === contextGraphId);
          if (match?.onChainId && /^\d+$/.test(String(match.onChainId)) && match.onChainId !== '0') {
            onChainCgId = String(match.onChainId);
          }
        } catch { /* exhausted */ }
      }
    }
    if (!onChainCgId) {
      return jsonResponse(res, 400, {
        error:
          `Cannot mint attestation: unable to resolve on-chain contextGraphId for ` +
          `cg="${contextGraphId}" batch=${batchId}. The KC for this batch may not be ` +
          `published yet, or the local CG metadata is stale. Pass ` +
          `\`onChainContextGraphId\` explicitly to bypass auto-resolution.`,
      });
    }

    const attesterAddress =
      (agent as any).getAgentAddress?.() ??
      (agent as any).agentAddress ??
      requestAgentAddress ??
      '';
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(attesterAddress))) {
      return jsonResponse(res, 500, { error: 'cannot resolve local agent address' });
    }

    const { mintMemberAttestation } = await import('@origintrail-official/dkg-agent');
    try {
      const attestation = await mintMemberAttestation({
        payload: {
          chainId: String(typeof chainId === 'string' ? chainId.replace(/^evm:/, '') : chainId),
          kavAddress: String(kavAddress).toLowerCase(),
          contextGraphId: onChainCgId,
          batchId: String(batchId),
          merkleRoot: String(merkleRoot),
          plaintextLeafHash: String(plaintextLeafHash),
          attesterAddress: String(attesterAddress),
          attestedAt: Math.floor(Date.now() / 1000),
        },
        sign: async (digest) => {
          // Convert (r, vs) -> compact 65-byte hex via ethers.Signature.
          const sigParts = await chain.signMessage(digest);
          const r = '0x' + Array.from(sigParts.r as Uint8Array).map((b: number) => b.toString(16).padStart(2, '0')).join('');
          const vs = '0x' + Array.from(sigParts.vs as Uint8Array).map((b: number) => b.toString(16).padStart(2, '0')).join('');
          const ethersMod = await import('ethers');
          const sig = ethersMod.Signature.from({ r, yParityAndS: vs });
          return sig.serialized;
        },
      });
      return jsonResponse(res, 200, { attestation });
    } catch (err: any) {
      return jsonResponse(res, 400, { error: err?.message ?? String(err) });
    }
  }

  // POST /api/attestation/verify
  //
  // OT-RFC-38 LU-9 -- outsider-side verification.
  //
  // Body: {
  //   attestation: MemberAttestation,
  //   candidateLeafHex?: string,        // optional 0x-prefixed bytes for leaf check
  //   chainCheckMembership?: boolean    // if true, the daemon attempts a chain-side
  //                                     // membership lookup (Phase B); currently
  //                                     // always returns "unknown" -- surfaces the
  //                                     // gap honestly.
  // }
  if (req.method === "POST" && path === "/api/attestation/verify") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    if (!parsed.attestation?.payload || !parsed.attestation?.signature) {
      return jsonResponse(res, 400, { error: 'attestation.payload and attestation.signature are required' });
    }
    let candidateLeaf: Uint8Array | undefined;
    if (parsed.candidateLeafHex && typeof parsed.candidateLeafHex === 'string') {
      const clean = parsed.candidateLeafHex.replace(/^0x/, '');
      if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2 !== 0) {
        return jsonResponse(res, 400, { error: 'candidateLeafHex must be 0x-prefixed even-length hex' });
      }
      candidateLeaf = new Uint8Array(clean.length / 2);
      for (let i = 0; i < candidateLeaf.length; i++) {
        candidateLeaf[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
      }
    }

    const { verifyMemberAttestation } = await import('@origintrail-official/dkg-agent');
    // Codex PR #609 R2 #3 -- only supply a membership resolver when
    // the caller explicitly opted into `chainCheckMembership`.
    // Previously we always passed a stub, which made every response
    // carry `membership: "unknown"` and erased the distinction
    // between "not checked" (caller didn't ask) and "checked but
    // unavailable" (Phase B chain-side resolver missing). With the
    // gate, omitting the flag returns no `membership` field (route
    // contract preserved); passing `true` returns `unknown` until
    // the Phase B resolver lands.
    const chainCheckMembership = parsed.chainCheckMembership === true;
    const result = await verifyMemberAttestation({
      attestation: parsed.attestation,
      candidateLeaf,
      ...(chainCheckMembership
        ? { membershipResolver: async () => undefined }
        : {}),
    });
    return jsonResponse(res, 200, result);
  }

  // POST /api/memory/turn -- ingest a conversation turn as a tri-modal Knowledge Asset.
  //
  // Streamlined path for agent memory: accepts a markdown conversation turn,
  // stores it in the file store, runs structural + optional semantic extraction,
  // and writes the resulting triples to WM. Use the knowledge asset lifecycle
  // routes to share or publish turns.
  //
  // Spec: 21_TRI_MODAL_MEMORY.md Section 8
  if (req.method === 'POST' && path === '/api/memory/turn') {
    const body = await readBody(req);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;

    const { markdown, contextGraphId, sessionUri, layer, subGraphName, turnId } = parsed;
    if (!markdown || typeof markdown !== 'string') {
      return jsonResponse(res, 400, { error: 'Missing or invalid "markdown" field (string)' });
    }
    const resolvedContextGraphId = await resolveRequiredWriteContextGraphId(
      agent,
      contextGraphId,
      res,
      writePreflightContextGraphOpts,
    );
    if (!resolvedContextGraphId) return;
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    if (sessionUri !== undefined) {
      if (typeof sessionUri !== 'string' || !isSafeIri(sessionUri)) {
        return jsonResponse(res, 400, { error: 'Invalid "sessionUri": must be a safe IRI' });
      }
    }

    if (layer !== undefined && layer !== 'wm') {
      return jsonResponse(res, 400, {
        error: '/api/memory/turn only supports layer:"wm"; use the knowledge asset lifecycle to share or publish turns.',
      });
    }
    const targetLayer = 'wm' as const;
    const agentDid = `did:dkg:agent:${agent.peerId}`;
    const now = new Date().toISOString();
    if (turnId !== undefined && (typeof turnId !== 'string' || turnId.trim().length === 0)) {
      return jsonResponse(res, 400, { error: 'Invalid "turnId": must be a non-empty string when supplied' });
    }
    const normalizedTurnId = typeof turnId === 'string' ? turnId.trim() : undefined;
    const effectiveTurnId = normalizedTurnId ?? randomUUID();

    // 1. Store markdown in the file store
    const mdBytes = Buffer.from(markdown, 'utf-8');
    let fileEntry;
    try {
      fileEntry = await fileStore.put(mdBytes, 'text/markdown');
    } catch (err: any) {
      return jsonResponse(res, 500, { error: `Failed to store turn markdown: ${err.message}` });
    }
    const fileUri = `urn:dkg:file:${fileEntry.keccak256}`;

    const turnIdentity = {
      contextGraphId: resolvedContextGraphId,
      subGraphName: subGraphName ?? null,
      sessionUri: sessionUri ?? null,
      turnId: effectiveTurnId,
      fileHash: fileEntry.keccak256,
      agent: requestAgentAddress,
    };
    const turnDigest = createHash('sha256').update(JSON.stringify(turnIdentity)).digest('hex');
    const assertionName = `turn-${turnDigest.slice(0, 32)}`;
    const turnUri = `did:dkg:context-graph:${resolvedContextGraphId}/turn/${assertionName}`;

    // 2. Run structural extraction
    let extractResult;
    try {
      extractResult = extractFromMarkdown({
        markdown,
        agentDid,
        documentIri: turnUri,
        sourceFileIri: fileUri,
      });
    } catch (err: any) {
      return jsonResponse(res, 500, { error: `Structural extraction failed: ${err.message}` });
    }

    // 3. Run semantic extraction (optional, best-effort)
    let semanticTriples: Array<{ subject: string; predicate: string; object: string }> = [];
    if (config.llm?.apiKey) {
      try {
        const llmResult = await extractWithLlm(
          { markdown, agentDid, documentIri: turnUri },
          config.llm,
        );
        semanticTriples = llmResult.triples;
      } catch {
        // Semantic extraction is best-effort -- structural extraction alone is sufficient
      }
    }

    // 4. Build assertion quads. assertion.write stamps the lifecycle WM graph.
    const assertionGraphPlaceholder = '';
    const quads: Array<{ subject: string; predicate: string; object: string; graph: string }> = [];

    // Content triples from structural extraction
    for (const t of extractResult.triples) {
      quads.push({ ...t, graph: assertionGraphPlaceholder });
    }
    // Source-file linkage from extractor (rows 1 + 3)
    for (const t of extractResult.sourceFileLinkage) {
      quads.push({ ...t, graph: assertionGraphPlaceholder });
    }
    // Semantic triples (if any)
    for (const t of semanticTriples) {
      quads.push({ ...t, graph: assertionGraphPlaceholder });
    }

    // Ensure the turn is typed as a ConversationTurn
    quads.push({
      subject: turnUri,
      predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
      object: 'http://schema.org/ConversationTurn',
      graph: assertionGraphPlaceholder,
    });
    quads.push({
      subject: turnUri,
      predicate: 'http://schema.org/name',
      object: JSON.stringify(`Conversation turn ${effectiveTurnId}`),
      graph: assertionGraphPlaceholder,
    });
    // Persist the markdown body so the UI can display turn content
    // without fetching the source file separately
    const truncatedBody = markdown.length > 2000 ? markdown.slice(0, 2000) + '...' : markdown;
    quads.push({
      subject: turnUri,
      predicate: 'http://schema.org/description',
      object: JSON.stringify(truncatedBody),
      graph: assertionGraphPlaceholder,
    });
    // Source content type
    quads.push({
      subject: turnUri,
      predicate: 'http://dkg.io/ontology/sourceContentType',
      object: JSON.stringify('text/markdown'),
      graph: assertionGraphPlaceholder,
    });
    // Agent attribution
    quads.push({
      subject: turnUri,
      predicate: 'http://schema.org/agent',
      object: agentDid,
      graph: assertionGraphPlaceholder,
    });
    // Timestamp
    quads.push({
      subject: turnUri,
      predicate: 'http://schema.org/dateCreated',
      object: `"${now}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`,
      graph: assertionGraphPlaceholder,
    });

    // Session linking (if session URI provided)
    if (sessionUri && typeof sessionUri === 'string') {
      quads.push({
        subject: turnUri,
        predicate: 'http://schema.org/isPartOf',
        object: sessionUri,
        graph: assertionGraphPlaceholder,
      });
      quads.push({
        subject: sessionUri,
        predicate: 'http://schema.org/hasPart',
        object: turnUri,
        graph: assertionGraphPlaceholder,
      });
    }

    const literalSize = validateWritableQuadLiteralSizes("quads", quads);
    if (!literalSize.ok) return jsonResponse(res, 400, literalSize.body);

    // 5. Write to WM through the named knowledge asset lifecycle.
    let targetGraph: string;
    const assertionWriteOptions = {
      ...(subGraphName ? { subGraphName } : {}),
      ...(writePreflightCallerAgentAddress ? { agentAddress: writePreflightCallerAgentAddress } : {}),
    };
    try {
      targetGraph = await agent.assertion.create(
        resolvedContextGraphId,
        assertionName,
        Object.keys(assertionWriteOptions).length > 0 ? assertionWriteOptions : undefined,
      );
      await agent.assertion.write(
        resolvedContextGraphId,
        assertionName,
        quads,
        Object.keys(assertionWriteOptions).length > 0 ? assertionWriteOptions : undefined,
      );
    } catch (err: any) {
      if (err?.code === "OVERSIZED_RDF_LITERAL") {
        return jsonResponse(res, 400, oversizedRdfLiteralResponseBody(err));
      }
      return jsonResponse(res, 500, { error: `Failed to write turn to ${targetLayer}: ${err.message}` });
    }
    emitMemoryGraphChanged?.({
      contextGraphId: resolvedContextGraphId,
      layers: [targetLayer],
      subGraphName,
      operation: "memory_turn_written",
      source: "memory-turn",
      counts: { triples: quads.length },
    });

    // 6. Generate embedding (best-effort, non-blocking for response)
    let embeddingId: string | null = null;
    if (embeddingProvider) {
      try {
        const snippet = markdown.length > 500 ? markdown.slice(0, 500) + '...' : markdown;
        const embedding = await embeddingProvider.embed(markdown);
        embeddingId = await vectorStore.insert({
          embedding,
          sourceUri: fileUri,
          entityUri: turnUri,
          contextGraphId: resolvedContextGraphId,
          memoryLayer: targetLayer,
          model: embeddingProvider.model,
          snippet,
          label: extractResult.subjectIri,
        });
      } catch {
        // Embedding generation is best-effort
      }
    }

    return jsonResponse(res, 200, {
      turnUri,
      assertionName,
      fileHash: fileEntry.keccak256,
      layer: targetLayer,
      graph: targetGraph,
      structuralTripleCount: extractResult.triples.length,
      semanticTripleCount: semanticTriples.length,
      totalQuads: quads.length,
      embeddingId,
      sessionUri: sessionUri ?? null,
      turnId: effectiveTurnId,
    });
  }

  // POST /api/memory/search -- tri-modal search across text, graph, and vector stores.
  //
  // Fans out the query to SPARQL (triple store), text search (file store),
  // and vector similarity (vector store), then merges and deduplicates results.
  //
  // Spec: 21_TRI_MODAL_MEMORY.md Section 7
  if (req.method === 'POST' && path === '/api/memory/search') {
    const body = await readBody(req);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;

    const { query, contextGraphId, limit: rawLimit } = parsed;
    if (!query || typeof query !== 'string') {
      return jsonResponse(res, 400, { error: 'Missing or invalid "query" field (string)' });
    }
    if (!validateRequiredContextGraphId(contextGraphId, res)) return;

    const resultLimit = typeof rawLimit === 'number' && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
    const requestedLayers = Array.isArray(parsed.memoryLayers)
      ? parsed.memoryLayers
      : ['wm', 'swm', 'vm'];
    const invalidLayers = requestedLayers.filter((layer: unknown) => layer !== 'wm' && layer !== 'swm' && layer !== 'vm');
    if (invalidLayers.length > 0) {
      return jsonResponse(res, 400, { error: 'memoryLayers must contain only "wm", "swm", or "vm"' });
    }
    const memoryLayers = [...new Set(requestedLayers)] as Array<'wm' | 'swm' | 'vm'>;

    const results: Array<{
      entityUri: string;
      label: string | null;
      sources: string[];
      similarity: number | null;
      sourceFile: string | null;
      snippet: string | null;
      memoryLayer: string | null;
    }> = [];
    const seen = new Map<string, number>();

    // Fan-out 1: Vector search
    if (embeddingProvider) {
      try {
        const queryEmbedding = await embeddingProvider.embed(query);
        const vectorResults = await vectorStore.search(queryEmbedding, {
          contextGraphId,
          memoryLayers,
          limit: resultLimit,
          minSimilarity: 0.3,
        });
        for (const vr of vectorResults) {
          const idx = results.length;
          seen.set(vr.entityUri, idx);
          results.push({
            entityUri: vr.entityUri,
            label: vr.label,
            sources: ['vector'],
            similarity: Math.round(vr.similarity * 1000) / 1000,
            sourceFile: vr.sourceUri,
            snippet: vr.snippet,
            memoryLayer: vr.memoryLayer,
          });
        }
      } catch {
        // Vector search failure is non-fatal
      }
    }

    // Fan-out 2: SPARQL text search (scoped to the requested CG + layers).
    // escapeSparqlLiteral escapes backslashes, quotes, and CR/LF/TAB per the
    // SPARQL STRING_LITERAL2 grammar -- a simple `replace(/"/g, '\\"')` would
    // still allow `\` to escape the closing quote and break out of the literal.
    const escapedQuery = escapeSparqlLiteral(query.toLowerCase());
    const cgUri = `did:dkg:context-graph:${contextGraphId}`;
    const graphFilters = memoryLayers.map((l) => {
      if (l === 'wm') {
        return `(STRSTARTS(STR(?g), "${cgUri}/_working_memory") || STRSTARTS(STR(?g), "${cgUri}/assertion/"))`;
      }
      if (l === 'swm') return `STRSTARTS(STR(?g), "${cgUri}/_shared_memory")`;
      // #1096: VM graphs live under `/_verifiable_memory/<id>` (see
      // contextGraphVerifiableMemoryUri in dkg-core). The pre-rc.16
      // "_verified" prefix matched nothing, so memory layer "vm" could
      // never return SPARQL hits.
      return `STRSTARTS(STR(?g), "${cgUri}/_verifiable_memory")`;
    }).join(' || ') || 'false';
    try {
      // #1096: accept both http:// and https:// schema.org forms -- real
      // payloads overwhelmingly use https://schema.org, which the previous
      // http-only property path silently excluded.
      const sparqlResult = await agent.store.query(`
        SELECT DISTINCT ?entity ?name ?desc WHERE {
          GRAPH ?g {
            ?entity <http://schema.org/name>|<https://schema.org/name>|<http://www.w3.org/2000/01/rdf-schema#label> ?name .
            OPTIONAL { ?entity <http://schema.org/description>|<https://schema.org/description> ?desc }
          }
          FILTER(${graphFilters})
          FILTER(
            CONTAINS(LCASE(STR(?name)), "${escapedQuery}")
            || (BOUND(?desc) && CONTAINS(LCASE(STR(?desc)), "${escapedQuery}"))
          )
        }
        LIMIT ${resultLimit}
      `);
      if (sparqlResult.type === 'bindings') {
        for (const binding of sparqlResult.bindings) {
          const uri = binding.entity;
          const label = binding.name ?? null;
          const snippet = binding.desc ?? null;
          if (seen.has(uri)) {
            const idx = seen.get(uri)!;
            if (!results[idx].sources.includes('sparql')) {
              results[idx].sources.push('sparql');
            }
          } else {
            const idx = results.length;
            seen.set(uri, idx);
            results.push({
              entityUri: uri,
              label,
              sources: ['sparql'],
              similarity: null,
              sourceFile: null,
              snippet,
              memoryLayer: null,
            });
          }
        }
      }
    } catch {
      // SPARQL search failure is non-fatal
    }

    // Sort: vector-matched results first (by similarity), then SPARQL-only
    results.sort((a, b) => {
      if (a.similarity !== null && b.similarity !== null) return b.similarity - a.similarity;
      if (a.similarity !== null) return -1;
      if (b.similarity !== null) return 1;
      return 0;
    });

    return jsonResponse(res, 200, {
      query,
      contextGraphId,
      resultCount: results.length,
      results: results.slice(0, resultLimit),
    });
  }

}
