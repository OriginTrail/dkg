// daemon/routes/memory.ts
//
// Route handlers for shared-memory / workspace write + publish + conditional-write, memory turn/search.
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
import { computeNetworkId, createOperationContext, DKGEvent, Logger, PayloadTooLargeError, GET_VIEWS, TrustLevel, validateSubGraphName, validateAssertionName, validateContextGraphId, isSafeIri, assertSafeIri, assertSafeRdfTerm, sparqlIri, contextGraphSharedMemoryUri, contextGraphAssertionUri, contextGraphMetaUri, escapeDkgRdfLiteral } from '@origintrail-official/dkg-core';
import { findReservedSubjectPrefix, isSkolemizedUri, type PublishOptions } from '@origintrail-official/dkg-publisher';
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
 * RFC-001 §9.x — Phase C — pre-signed attestations are a finalize-time
 * concern. The publish layer no longer accepts them; they're consumed
 * here and stamped into the seal.
 */
type PreSignedAuthorAttestation = {
  address: string;
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
  return { address, signature: { r, vs } };
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
  } = ctx;


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
    if (!validateRequiredContextGraphId(contextGraphId, res)) return;

    const { quads } = parsed;
    if (!Array.isArray(quads) || quads.length === 0) {
      return jsonResponse(res, 400, {
        error: 'Missing or invalid "quads" (must be a non-empty array)',
      });
    }

    const graph = `did:dkg:context-graph:${contextGraphId}/meta/query-catalog`;
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

      await agent.store.insert(normalized);
      return jsonResponse(res, 200, {
        ok: true,
        contextGraphId,
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
  // OT-RFC-38 LU-7 — explicit SWMCatchupRequest endpoint. Pulls the
  // remote SWM state for one or more context graphs from connected
  // peers, applying everything authorized into the local triple store.
  //
  // Body: { contextGraphId: string | string[], peerId?: string }
  //   - peerId: optional. When set, sync only from this specific peer.
  //     When omitted, iterate ALL currently-connected libp2p peers and
  //     try each — first peer that authorises serves the request,
  //     subsequent peers' decisions are independent.
  //
  // Returns: per-peer outcome with inserted/fetched counters.
  //
  // Auth model (per SPEC_CG_HOSTING_MEMBERSHIP §5.6.4):
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
          'Missing "contextGraphId" — pass a single context graph id string or an array of ids',
      });
    }

    // OT-RFC-38 LU-7: SWMCatchupRequest is SWM-only. The durable
    // (knowledge-collection) layer has its own publish-time
    // commit→fanout→ACK protocol and a separate sync substrate; it's
    // out of scope for the catchup endpoint and would otherwise compound
    // the request budget (240s vs 120s). Opt-in via includeDurable=true
    // for callers that want the full data leg in the same call.
    const includeDurable = parsed.includeDurable === true;

    // Per-peer hard cap on the catchup duration. Keeps the endpoint
    // response within a single HTTP-level timeout even if the underlying
    // sync internals retry their way to completion. SWM-only path:
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

    // Discover candidate peers. The single-peer mode is opt-in; the
    // default fan-out mode mirrors what runSyncOnConnect does on every
    // peer:connect event, but caller-initiated rather than event-driven.
    //
    // Codex PR #609 R2 — route through `createCGHostEnumerator` so the
    // hosting-peer policy stays centralized. Today's Phase-A enumerator
    // returns all connected peers (minus self); when Phase B lands shard-
    // aware host selection in LU-6, this call site picks it up for free
    // instead of needing to be updated in lockstep.
    let candidatePeers: string[];
    if (peerIdParam) {
      candidatePeers = [peerIdParam];
    } else {
      const { createCGHostEnumerator } = await import('@origintrail-official/dkg-agent');
      const enumerator = createCGHostEnumerator({
        getConnectedPeers: () =>
          agent.node.libp2p.getConnections().map((c: any) => c.remotePeer.toString()),
        getSelfPeerId: () => agent.peerId,
      });
      // Per-CG enumeration unioned across all requested CGs — phase A's
      // enumerator returns the same connected-peers set for every cgId,
      // but unioning keeps us forward-compatible with phase B's per-CG
      // shard filtering.
      const unioned = new Set<string>();
      for (const cgId of cgIds) {
        for (const p of await enumerator.enumerate(cgId)) unioned.add(p);
      }
      candidatePeers = Array.from(unioned);
    }

    if (candidatePeers.length === 0) {
      return jsonResponse(res, 200, {
        contextGraphIds: cgIds,
        peersAttempted: 0,
        results: [],
        hint: 'No connected peers to catch up from. Wait for inbound connections or pass an explicit `peerId`.',
      });
    }

    // Per-CG × per-peer sync. The previous shape called
    // `syncSharedMemoryFromPeer(peer, cgIds)` ONCE per peer with the
    // full CG list, which only returned an aggregate count and made
    // a per-CG LU-6 fallback decision impossible (Codex PR #610 R1
    // comment 1: if one CG got triples from standard sync, fallback
    // for the others got skipped on the aggregate gate).
    //
    // Now: iterate CGs serially (keeps wire load bounded across many
    // peers × many CGs), and within each CG parallelize the per-peer
    // sync exactly like before. Per-peer dial+request is 5-20s on
    // devnet; serialising peers would compound to N×20s.
    type PerPeerLeg = {
      peerId: string;
      insertedTriples: number;
      durableInsertedTriples: number;
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
      const settled = await Promise.allSettled(
        candidatePeers.map(async (candidate) => {
          let swm = 0;
          let durable = 0;
          let swmError: string | undefined;
          let durableError: string | undefined;
          try {
            swm = await withTimeout(
              agent.syncSharedMemoryFromPeer(candidate, [cgId]),
              PER_PEER_SWM_BUDGET_MS,
              `SWM catchup from ${candidate} for ${cgId}`,
            );
          } catch (err: any) {
            swmError = err?.message ?? String(err);
          }
          if (includeDurable) {
            try {
              durable = await withTimeout(
                (agent as any).syncFromPeer?.(candidate, [cgId]) ?? Promise.resolve(0),
                PER_PEER_DURABLE_BUDGET_MS,
                `Durable catchup from ${candidate} for ${cgId}`,
              );
            } catch (err: any) {
              durableError = err?.message ?? String(err);
            }
          }
          return { peerId: candidate, insertedTriples: swm, durableInsertedTriples: durable, swmError, durableError } as PerPeerLeg;
        }),
      );
      const perPeer: PerPeerLeg[] = settled.map((s, idx) => {
        if (s.status === 'fulfilled') {
          return {
            peerId: candidatePeers[idx],
            insertedTriples: s.value.insertedTriples,
            durableInsertedTriples: s.value.durableInsertedTriples,
            ...(s.value.swmError ? { swmError: s.value.swmError } : {}),
            ...(s.value.durableError ? { durableError: s.value.durableError } : {}),
          };
        }
        return {
          peerId: candidatePeers[idx],
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

    // OT-RFC-38 LU-6 — per-CG host-catchup fallback. For each CG
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
    const hostCatchupOpted = parsed.hostCatchupFallback !== false;
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
      swmError?: string;
      durableError?: string;
      otherErrors?: string[];
    }>();
    for (const cg of perCgLegs) {
      for (const p of cg.perPeer) {
        const entry = perPeerAggregate.get(p.peerId) ?? { peerId: p.peerId, insertedTriples: 0, durableInsertedTriples: 0 };
        entry.insertedTriples += p.insertedTriples;
        entry.durableInsertedTriples += p.durableInsertedTriples;
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
      ...(r.swmError ? { swmError: r.swmError } : {}),
      ...(r.durableError ? { durableError: r.durableError } : {}),
      ...(r.otherErrors && r.otherErrors.length > 0 ? { errors: r.otherErrors } : {}),
    }));

    return jsonResponse(res, 200, {
      contextGraphIds: cgIds,
      peersAttempted: candidatePeers.length,
      includeDurable,
      totalInsertedTriples: totalInserted,
      totalDurableInsertedTriples: totalDurable,
      standardInsertedTriples: standardInserted,
      results,
      perContextGraph: perCgLegs.map((cg) => ({
        contextGraphId: cg.contextGraphId,
        insertedTriples: cg.insertedTriples,
        durableInsertedTriples: cg.durableInsertedTriples,
        perPeer: cg.perPeer,
      })),
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

  // OT-RFC-38 LU-6 — dedicated host-catchup endpoint.
  //
  // POST /api/shared-memory/host-catchup
  // Body: { contextGraphId: string, peerId?: string, sinceSeqno?: number, maxRounds?: number }
  //
  // Pulls opaque ciphertext envelopes from cores that have been
  // hosting the curated CG's SWM substrate and re-applies each
  // through the local agent so the existing Sender-Key decrypt
  // path runs verbatim. Distinct from the "fallback" leg embedded
  // in /catchup above — exposed so operators can debug host
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

  // OT-RFC-38 LU-6 — host-mode store diagnostics.
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

  // OT-RFC-38 LU-6 — explicit host-mode subscribe.
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

  // Tiny local helper — kept inline to avoid adding a new import for
  // a single use; the existing route module already has utilities
  // for hex/bytes interop scattered across the file but none are
  // strictly typed `bytes32`. 64-char hex (no 0x) → 32-byte buffer.
  function hexToBytes32(h: string): Uint8Array {
    const clean = h.startsWith('0x') ? h.slice(2) : h;
    if (clean.length !== 64) throw new Error('expected 32-byte hex');
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  // POST /api/shared-memory/verify-batch
  //
  // OT-RFC-38 LU-8 — Member post-decrypt batch verification.
  //
  // SPEC_CG_HOSTING_MEMBERSHIP §5.3.1: members re-derive the plaintext
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

  // POST /api/shared-memory/report-batch-rejection
  //
  // OT-RFC-38 LU-8 — when verifyBatch returns ok=false, the member
  // gossips a structured BatchRejection record so other members can
  // sanity-check and re-pull from a different host.
  //
  // Body: {
  //   contextGraphId: string,
  //   batchId?: string,
  //   verifyResult: { ok: false, expectedRoot, actualRoot, leafCount, reason },
  //   rejectedBy?: { agentAddress, peerId },    // defaults to local agent
  // }
  if (req.method === "POST" && path === "/api/shared-memory/report-batch-rejection") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const contextGraphId = parsed.contextGraphId;
    if (!validateRequiredContextGraphId(contextGraphId, res)) return;
    const verifyResult = parsed.verifyResult;
    if (!verifyResult || verifyResult.ok !== false) {
      return jsonResponse(res, 400, {
        error: 'verifyResult.ok must be false; nothing to report on an ok batch',
      });
    }

    const { buildBatchRejectionRecord } = await import('@origintrail-official/dkg-agent');
    const inferredAgentAddress =
      (agent as any).getAgentAddress?.() ??
      (agent as any).agentAddress ??
      (agent as any).config?.agentAddress ??
      (agent as any).wallet?.address ??
      requestAgentAddress ??
      'unknown';
    const rejectedBy = parsed.rejectedBy ?? {
      agentAddress: inferredAgentAddress,
      peerId: (agent as any).peerId,
    };

    let record;
    try {
      record = buildBatchRejectionRecord({
        contextGraphId,
        batchId: parsed.batchId,
        verifyResult,
        rejectedBy,
      });
    } catch (err: any) {
      return jsonResponse(res, 400, { error: err?.message ?? String(err) });
    }

    // Persist the record as SWM triples so it gossips via the
    // standard SWM substrate to other members. Reuses agent.share()
    // for the write — no new transport.
    //
    // Codex PR #609: every value that originates from HTTP body
    // (contextGraphId, batchId, peerId, reason, agentAddress) is
    // interpolated into an N-Quads literal. Without escaping, a value
    // containing `"`, newlines, or RDF syntax either breaks the
    // store insert outright or lets the caller smuggle malformed /
    // attacker-controlled triples through this endpoint. We pipe
    // every interpolated literal body through `escapeDkgRdfLiteral`
    // (defense in depth — even fields like rootHashes that are
    // structurally constrained to 0x-hex still get escaped, so a
    // future input-validation regression doesn't reopen the hole).
    const lit = (s: string) => `"${escapeDkgRdfLiteral(s)}"`;
    const subject = `did:dkg:batch-rejection:${record.digest}`;
    const NS = 'http://dkg.io/ontology/';
    const quads = [
      { subject, predicate: `${NS}rejectedContextGraphId`, object: lit(record.contextGraphId), graph: '' },
      { subject, predicate: `${NS}expectedMerkleRoot`, object: lit(record.expectedRoot), graph: '' },
      { subject, predicate: `${NS}actualMerkleRoot`, object: lit(record.actualRoot), graph: '' },
      { subject, predicate: `${NS}rejectionReason`, object: lit(record.reason ?? 'unknown'), graph: '' },
      { subject, predicate: `${NS}rejectedByAgent`, object: lit(record.rejectedBy.agentAddress), graph: '' },
      { subject, predicate: `${NS}rejectedByPeer`, object: lit(record.rejectedBy.peerId ?? ''), graph: '' },
      { subject, predicate: `${NS}rejectionReportedAt`, object: lit(record.reportedAt), graph: '' },
      ...(record.batchId !== undefined
        ? [{ subject, predicate: `${NS}rejectedBatchId`, object: lit(record.batchId), graph: '' }]
        : []),
    ];

    try {
      await agent.share(contextGraphId, quads, {
        operationCtx: createOperationContext('share'),
        callerAgentAddress: requestAgentAddress,
      });
    } catch (err: any) {
      // The record itself is the deliverable; gossip is best-effort.
      // Surface the error but still return the constructed record so
      // callers can persist it elsewhere.
      return jsonResponse(res, 200, {
        record,
        gossiped: false,
        gossipError: err?.message ?? String(err),
      });
    }

    return jsonResponse(res, 200, { record, gossiped: true });
  }

  // POST /api/attestation/mint
  //
  // OT-RFC-38 LU-9 — Member-attested verification token.
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
    const kavAddress = chain?.contracts?.knowledgeAssetsV10?.target?.toString()
      ?? chain?.kavAddress
      ?? parsed.kavAddress;
    const chainId = chain?.chainId ?? parsed.chainId ?? '31337';
    if (!kavAddress || !/^0x[0-9a-fA-F]{40}$/.test(String(kavAddress))) {
      return jsonResponse(res, 400, {
        error: 'cannot determine KAV10 address — pass `kavAddress` explicitly',
      });
    }

    // Resolve on-chain contextGraphId.
    //
    // Codex PR #609: previously fell back to `"0"` when local
    // subscription metadata couldn't resolve the on-chain id. That
    // silently minted an attestation token bound to ContextGraphId=0
    // (the sentinel for "no on-chain CG") even though a real KC for
    // this batch already exists on-chain — outsiders verifying the
    // token would see it pass cryptographic checks but reject as
    // wrong-domain, with no diagnostic linking back to the actual CG.
    // Three resolution layers, all fail-closed:
    //   1. Caller-supplied `onChainContextGraphId` (explicit override).
    //   2. Chain-truth via `chain.getKCContextGraphId(batchId)` —
    //      authoritative because the KC ↔ CG binding is on-chain.
    //   3. Local CG listing (last-resort, may be stale post-event-replay).
    // If none resolve, reject with 400 — minting against id=0 is never
    // correct.
    let onChainCgId: string | undefined;
    if (typeof parsed.onChainContextGraphId === 'string' && /^\d+$/.test(parsed.onChainContextGraphId)) {
      onChainCgId = parsed.onChainContextGraphId;
    } else {
      try {
        if (typeof chain?.getKCContextGraphId === 'function' && /^\d+$/.test(String(batchId))) {
          const chainCgId = await chain.getKCContextGraphId(BigInt(batchId)).catch(() => null);
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
          // Convert (r, vs) → compact 65-byte hex via ethers.Signature.
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
  // OT-RFC-38 LU-9 — outsider-side verification.
  //
  // Body: {
  //   attestation: MemberAttestation,
  //   candidateLeafHex?: string,        // optional 0x-prefixed bytes for leaf check
  //   chainCheckMembership?: boolean    // if true, the daemon attempts a chain-side
  //                                     // membership lookup (Phase B); currently
  //                                     // always returns "unknown" — surfaces the
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
    // Codex PR #609 R2 #3 — only supply a membership resolver when
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

  // POST /api/shared-memory/write
  //
  // Direct SWM write entry point. Writes loose triples to shared memory
  // without minting a named-assertion seal. Triples land in SWM as
  // ungrouped content; downstream selection-based publishes
  // (POST /api/shared-memory/publish with `selection`) seal them at
  // the publish boundary via the agent's selection bridge — see
  // `agent.publishFromSharedMemory` for the inline-seal logic.
  //
  // For seal-from-creation provenance, use the named-assertion
  // lifecycle instead: POST /api/assertion/create with `quads,
  // finalize: true, promote: true` followed by
  // POST /api/shared-memory/publish with `assertionName`.
  if (req.method === "POST" && path === "/api/shared-memory/write") {
    const body = await readBody(req);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const { quads, subGraphName } = parsed;
    const localOnly = parsed.localOnly === true;
    if (
      parsed.localOnly !== undefined &&
      typeof parsed.localOnly !== "boolean"
    ) {
      return jsonResponse(res, 400, { error: '"localOnly" must be a boolean' });
    }
    const contextGraphId = parsed.contextGraphId;
    if (!quads?.length)
      return jsonResponse(res, 400, { error: 'Missing "quads"' });
    if (!validateRequiredContextGraphId(contextGraphId, res)) return;
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    const ctx = createOperationContext("share");
    tracker.start(ctx, {
      contextGraphId: contextGraphId,
      details: { tripleCount: quads.length, source: "api", subGraphName },
    });
    try {
      await tracker.trackPhase(ctx, "validate", async () => {
        // validation happens inside share
      });
      const result = await tracker.trackPhase(ctx, "store", () =>
        agent.share(contextGraphId, quads, {
          subGraphName,
          localOnly,
          operationCtx: ctx,
          callerAgentAddress: requestAgentAddress,
        }),
      );
      tracker.complete(ctx, { tripleCount: quads.length });
      emitMemoryGraphChanged?.({
        contextGraphId,
        layers: ["swm"],
        subGraphName,
        operation: "shared_memory_written",
        source: localOnly ? "api-local" : "api",
        counts: { triples: quads.length },
      });
      return jsonResponse(res, 200, {
        shareOperationId: result?.shareOperationId,
        contextGraphId,
        graph: contextGraphSharedMemoryUri(contextGraphId, subGraphName),
        triplesWritten: quads.length,
      });
    } catch (err: any) {
      tracker.fail(ctx, err);
      if (
        typeof err?.message === "string" &&
        err.message.includes("has not been registered")
      ) {
        return jsonResponse(res, 400, { error: err.message });
      }
      throw err;
    }
  }

  // POST /api/shared-memory/publish
  //
  // Two operating modes (mutually exclusive):
  //
  //   1. `assertionName` body field — finalized-assertion fork. The seal
  //      lives in `_meta` (written by /api/assertion/:name/finalize).
  //      The agent reads it, threads it as `precomputedAttestation`,
  //      and the publisher forwards verbatim. No re-sign, no re-hash.
  //
  //   2. `selection` body field (or omitted, defaults to 'all') —
  //      selection-based fork. The agent loads the selected SWM quads,
  //      mints a precomputedAttestation inline at the selection
  //      boundary (RFC-001 §9.x sign-at-creation invariant — the seal
  //      exists before the publisher gets the payload), then publishes.
  //      `authorAgentAddress` / `preSignedAuthorAttestation` /
  //      bearer-token attribution all settle here.
  if (req.method === "POST" && path === "/api/shared-memory/publish") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const {
      selection,
      clearAfter,
      publishContextGraphId,
      subGraphName,
      publisherNodeIdentityIdOverride,
      authorAgentAddress: bodyAuthorAgentAddress,
      preSignedAuthorAttestation: bodyPreSignedAttestation,
      assertionName: bodyAssertionName,
    } = parsed;
    const contextGraphId = parsed.contextGraphId;
    if (!contextGraphId)
      return jsonResponse(res, 400, {
        error: 'Missing "contextGraphId"',
      });
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    if (subGraphName && publishContextGraphId) {
      return jsonResponse(res, 400, {
        error:
          '"subGraphName" and "publishContextGraphId" cannot be used together',
      });
    }
    let resolvedPublisherIdentityOverride: bigint | undefined;
    if (publisherNodeIdentityIdOverride !== undefined && publisherNodeIdentityIdOverride !== null) {
      const raw = String(publisherNodeIdentityIdOverride);
      if (!/^\d+$/.test(raw)) {
        return jsonResponse(res, 400, {
          error: '"publisherNodeIdentityIdOverride" must be a non-negative integer (string or number)',
        });
      }
      resolvedPublisherIdentityOverride = BigInt(raw);
    }

    // RFC-001 §4(b) Phase 4 — author attribution resolution.
    //
    // Three precedence-ordered sources, all optional. The publisher signs as
    // its own wallet (today's behaviour) when none are supplied:
    //
    //   1. `preSignedAuthorAttestation` in the request body — used when the
    //      author is a self-sovereign agent whose private key the daemon
    //      doesn't hold. Caller pre-signs the EIP-712 typed data.
    //
    //   2. `authorAgentAddress` in the request body — admin assertion. The
    //      node-level admin token can run as any registered local agent
    //      (matches the existing OpenClaw `agentAddress` pattern at
    //      packages/cli/src/daemon/routes/query.ts). Resolved to a custodial
    //      private key by `agent.publishFromSharedMemory`.
    //
    //   3. Agent-scoped bearer token — a `dkg_at_*` token registered to a
    //      specific agent automatically attributes authorship to that agent.
    //      Node-level admin tokens (resolveAgentByToken returns undefined)
    //      do NOT attribute by default, preserving today's "publisher signs
    //      as itself" semantics.
    const requestToken = extractBearerToken(req.headers.authorization);
    const tokenAgentAddress = requestToken
      ? agent.resolveAgentByToken(requestToken)
      : undefined;
    if (
      bodyAuthorAgentAddress != null &&
      bodyPreSignedAttestation != null
    ) {
      return jsonResponse(res, 400, {
        error:
          '"authorAgentAddress" and "preSignedAuthorAttestation" are mutually exclusive',
      });
    }
    let resolvedPreSignedAttestation: PreSignedAuthorAttestation | undefined;
    if (bodyPreSignedAttestation != null) {
      const validated = validatePreSignedAuthorAttestation(bodyPreSignedAttestation, res);
      if (validated === undefined) return;
      resolvedPreSignedAttestation = validated;
    }
    let resolvedAuthorAgentAddress: string | undefined;
    if (resolvedPreSignedAttestation == null) {
      // Pre-signed wins; otherwise body assertion wins; otherwise token.
      if (typeof bodyAuthorAgentAddress === 'string' && bodyAuthorAgentAddress.length > 0) {
        if (!/^0x[0-9a-fA-F]{40}$/.test(bodyAuthorAgentAddress)) {
          return jsonResponse(res, 400, {
            error: '"authorAgentAddress" must be a 0x-prefixed 20-byte EVM address',
          });
        }
        resolvedAuthorAgentAddress = bodyAuthorAgentAddress;
      } else if (tokenAgentAddress != null) {
        resolvedAuthorAgentAddress = tokenAgentAddress;
      }
    }

    // RFC-001 §9.x Phase 5 — finalized-assertion fork.
    //
    // When the body carries `assertionName`, the assertion was sealed at
    // a previous /api/assertion/:name/finalize step and the seal lives
    // in `_meta`. The agent route reads the seal, validates chain
    // identity, threads the seal as `precomputedAttestation`, and the
    // publisher forwards it verbatim — no re-sign, no re-hash. Other
    // body fields (`authorAgentAddress`, `preSignedAuthorAttestation`)
    // are illegal in this fork because the seal already encodes the
    // author. `selection` is forced to `'all'` because the seal is keyed
    // by the assertion's exact merkleRoot.
    if (typeof bodyAssertionName === 'string' && bodyAssertionName.length > 0) {
      const nameVal = validateAssertionName(bodyAssertionName);
      if (!nameVal.valid) {
        return jsonResponse(res, 400, {
          error: `Invalid "assertionName": ${nameVal.reason}`,
        });
      }
      if (
        bodyAuthorAgentAddress != null ||
        bodyPreSignedAttestation != null
      ) {
        return jsonResponse(res, 400, {
          error:
            '"authorAgentAddress" and "preSignedAuthorAttestation" cannot be combined with "assertionName" — the seal already encodes the author. Re-finalize the assertion if you need to change authorship.',
        });
      }
      if (selection !== undefined && selection !== 'all') {
        return jsonResponse(res, 400, {
          error:
            '"selection" must be omitted or "all" when "assertionName" is supplied — the seal commits to the entire assertion content.',
        });
      }
      const ctx2 = createOperationContext('publishFromSWM');
      tracker.start(ctx2, {
        contextGraphId,
        details: {
          source: 'api',
          assertionName: bodyAssertionName,
          subGraphName,
        },
      });
      try {
        const result = await tracker.trackPhase(
          ctx2,
          'read-shared-memory',
          () =>
            agent.publishFromFinalizedAssertion(contextGraphId, bodyAssertionName, {
              ...(subGraphName ? { subGraphName } : {}),
              operationCtx: ctx2,
              ...(resolvedPublisherIdentityOverride !== undefined
                ? { publisherNodeIdentityIdOverride: resolvedPublisherIdentityOverride }
                : {}),
              // Pass `clearAfter` straight through (incl. `undefined`) so the
              // publisher's own default — `false` — applies for the named
              // path. Forcing `?? true` here would silently drain every other
              // assertion's quads from SWM after publishing the named one,
              // since the publisher reads `clearSharedMemoryAfter === true`
              // as "also wipe the unpublished remainder". The named publish
              // already removes its own roots regardless.
              ...(clearAfter !== undefined ? { clearSharedMemoryAfter: clearAfter } : {}),
            }),
        );
        const chain = result.onChainResult;
        if (chain) {
          tracker.setCost(ctx2, {
            gasUsed: chain.gasUsed,
            gasPrice: chain.effectiveGasPrice,
          });
          const chainId = resolveChainConfig(config, network)?.chainId;
          tracker.setTxHash(
            ctx2,
            chain.txHash,
            chainId ? Number(chainId) : undefined,
          );
        }
        tracker.complete(ctx2, { tripleCount: result.kaManifest?.length ?? 0 });
        const httpStatus = result.contextGraphError ? 207 : 200;
        return jsonResponse(res, httpStatus, {
          kcId: String(result.kcId),
          status: result.status,
          assertionUri: result.assertionUri,
          authorAddress: result.seal.authorAddress,
          merkleRoot:
            '0x' +
            Array.from(result.seal.merkleRoot)
              .map((b) => b.toString(16).padStart(2, '0'))
              .join(''),
          kas: result.kaManifest.map((ka: any) => ({
            tokenId: String(ka.tokenId),
            rootEntity: ka.rootEntity,
          })),
          ...(chain && { txHash: chain.txHash, blockNumber: chain.blockNumber }),
          ...(result.contextGraphError
            ? { contextGraphError: result.contextGraphError }
            : {}),
        });
      } catch (err: any) {
        tracker.fail(ctx2, err);
        const message = err?.message ?? String(err);
        if (
          message.includes('not finalized') ||
          message.includes('seal binds chainId') ||
          message.includes('seal binds KAv10') ||
          message.includes('expectedMerkleRoot mismatch') ||
          message.includes('precomputedAttestation signer mismatch') ||
          message.includes('not registered on-chain') ||
          message.includes('signer mismatch')
        ) {
          return jsonResponse(res, 400, { error: message });
        }
        throw err;
      }
    }

    const ctx = createOperationContext("publishFromSWM");
    tracker.start(ctx, {
      contextGraphId: contextGraphId,
      details: { source: "api", publishContextGraphId, subGraphName },
    });
    try {
      // OT-RFC-38 LU-6 — transparent register-then-publish.
      //
      // Project creation is local-only by design (no chain
      // interaction, no gas) so that SWM works immediately. The
      // first time the user opts into VM publish IS the implicit
      // moment they accept the chain cost — we auto-register
      // here so the user experiences a single action (and a
      // single spinner) rather than having to remember a
      // separate `/api/context-graph/register` call first.
      //
      // Idempotent on the agent side: `registerContextGraph`
      // short-circuits when an on-chain id already exists, so
      // racing publishes / re-publishes don't double-mint.
      //
      // If the user already explicitly registered (e.g. from
      // project Settings to upgrade SWM host-mode quotas), this
      // is a cheap no-op probe.
      try {
        const existingOnChainId = await agent.getContextGraphOnChainId(contextGraphId);
        if (!existingOnChainId) {
          // OT-RFC-38 / LU-6 Phase B (Codex PR #610 round-2 #5):
          // cheap preflight BEFORE spending gas on registration. If
          // SWM is empty for this CG, the publish leg below would
          // fail with `no entities to publish` anyway — register
          // first and we'd burn gas on a doomed publish. Skip
          // preflight when caller passed a `rootEntities` selection
          // (the entity-presence check happens deeper in the publish
          // path) or supplied a `publishContextGraphId` override
          // (cross-CG attribution: SWM may live elsewhere).
          if (
            selection === undefined || selection === "all"
          ) {
            if (
              publishContextGraphId == null
              && !agent.hasPendingSharedMemoryWrites(contextGraphId)
            ) {
              tracker.fail(ctx, new Error('SWM empty for context graph'));
              return jsonResponse(res, 400, {
                error:
                  `Context graph "${contextGraphId}" has no pending shared-memory writes — `
                  + `nothing to publish to Verified Memory. Stage entities into SWM first, then retry publish.`,
              });
            }
          }
          // OT-RFC-38 / LU-6 Phase B (Codex PR #610 fd5b31f1 fix):
          // load create-time `publishPolicy` and
          // `publishAuthorityAccountId` so the deferred-registration
          // call preserves the user's intent end-to-end. Pre-fix, this
          // call forwarded only `callerAgentAddress` and silently
          // coerced the policy back to the access-policy default —
          // breaking curated-access + open-contribution and PCA-
          // curated registrations.
          const storedOpts = await agent.getStoredContextGraphRegistrationOptions(contextGraphId);
          await tracker.trackPhase(ctx, "register-on-chain", () =>
            agent.registerContextGraph(contextGraphId, {
              ...(resolvedAuthorAgentAddress != null
                ? { callerAgentAddress: resolvedAuthorAgentAddress }
                : {}),
              ...(storedOpts.publishPolicy !== undefined
                ? { publishPolicy: storedOpts.publishPolicy }
                : {}),
              ...(storedOpts.publishAuthorityAccountId !== undefined
                ? { publishAuthorityAccountId: storedOpts.publishAuthorityAccountId }
                : {}),
            }),
          );
        }
      } catch (regErr: any) {
        // Surface registration failures as a 400 with a clear
        // breadcrumb so the UI can show the actionable message
        // (insufficient TRAC, missing chain signer, etc.)
        // instead of a generic 500 from the publish leg later.
        tracker.fail(ctx, regErr);
        return jsonResponse(res, 400, {
          error:
            `Context graph "${contextGraphId}" could not be auto-registered on-chain before publish: ` +
            `${regErr?.message ?? String(regErr)}`,
        });
      }
      const sel: "all" | { rootEntities: string[] } = Array.isArray(selection)
        ? { rootEntities: selection }
        : selection || "all";
      let resolvedPublishContextGraphId: string | null = null;
      if (publishContextGraphId != null) {
        resolvedPublishContextGraphId = String(publishContextGraphId);
      }
      const result = await tracker.trackPhase(ctx, "read-shared-memory", () =>
        agent.publishFromSharedMemory(contextGraphId, sel, {
          clearSharedMemoryAfter: clearAfter ?? true,
          operationCtx: ctx,
          subGraphName,
          ...(resolvedPublishContextGraphId != null
            ? { contextGraphId: resolvedPublishContextGraphId }
            : {}),
          ...(resolvedPublisherIdentityOverride !== undefined
            ? { publisherNodeIdentityIdOverride: resolvedPublisherIdentityOverride }
            : {}),
          ...(resolvedAuthorAgentAddress != null
            ? { authorAgentAddress: resolvedAuthorAgentAddress }
            : {}),
          ...(resolvedPreSignedAttestation != null
            ? { preSignedAuthorAttestation: resolvedPreSignedAttestation }
            : {}),
        }),
      );
      const chain = result.onChainResult;
      if (chain) {
        tracker.setCost(ctx, {
          gasUsed: chain.gasUsed,
          gasPrice: chain.effectiveGasPrice,
        });
        const chainId = resolveChainConfig(config, network)?.chainId;
        tracker.setTxHash(
          ctx,
          chain.txHash,
          chainId ? Number(chainId) : undefined,
        );
      }
      const publicTripleCount = Array.isArray(result.publicQuads)
        ? result.publicQuads.length
        : undefined;
      const rootCount = Array.isArray(result.kaManifest)
        ? result.kaManifest.length
        : undefined;
      tracker.complete(ctx, { tripleCount: publicTripleCount ?? rootCount ?? 0 });
      const clearSharedMemoryAfter = clearAfter ?? true;
      const publishedSwmCleaned = result.status === "confirmed";
      emitMemoryGraphChanged?.({
        contextGraphId,
        layers: publishedSwmCleaned ? ["swm", "vm"] : ["vm"],
        subGraphName,
        operation: "shared_memory_published",
        source: "api",
        clearSharedMemoryAfter,
        status: typeof result.status === "string" ? result.status : undefined,
        counts: {
          roots: rootCount,
          triples: publicTripleCount,
        },
      });
      const httpStatus = result.contextGraphError ? 207 : 200;
      return jsonResponse(res, httpStatus, {
        kcId: String(result.kcId),
        status: result.status,
        kas: result.kaManifest.map((ka: any) => ({ tokenId: String(ka.tokenId), rootEntity: ka.rootEntity })),
        ...(chain && { txHash: chain.txHash, blockNumber: chain.blockNumber }),
        ...(resolvedPublishContextGraphId != null
          ? { publishContextGraphId: String(resolvedPublishContextGraphId) }
          : {}),
        ...(result.contextGraphError
          ? { contextGraphError: result.contextGraphError }
          : {}),
      });
    } catch (err) {
      tracker.fail(ctx, err);
      throw err;
    }
  }

  // POST /api/shared-memory/conditional-write  { contextGraphId, quads, conditions, subGraphName? }
  if (
    req.method === "POST" &&
    path === "/api/shared-memory/conditional-write"
  ) {
    const body = await readBody(req);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const { quads, conditions, subGraphName } = parsed;
    const contextGraphId = parsed.contextGraphId;
    if (!quads?.length)
      return jsonResponse(res, 400, { error: 'Missing "quads"' });
    if (!validateRequiredContextGraphId(contextGraphId, res)) return;
    if (!validateConditions(conditions, res)) return;
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    const ctx = createOperationContext("share");
    tracker.start(ctx, {
      contextGraphId: contextGraphId,
      details: { tripleCount: quads.length, source: "api-cas", subGraphName },
    });
    try {
      const result = await agent.conditionalShare(
        contextGraphId,
        quads,
        conditions,
        { subGraphName, operationCtx: ctx, callerAgentAddress: requestAgentAddress },
      );
      tracker.complete(ctx, { tripleCount: quads.length });
      emitMemoryGraphChanged?.({
        contextGraphId,
        layers: ["swm"],
        subGraphName,
        operation: "shared_memory_conditional_written",
        source: "api-cas",
        counts: { triples: quads.length },
      });
      return jsonResponse(res, 200, {
        ok: true,
        shareOperationId: result?.shareOperationId,
      });
    } catch (err: any) {
      tracker.fail(ctx, err);
      if (
        err.name === "StaleWriteError" ||
        err.message?.includes("stale") ||
        err.message?.includes("CAS condition failed")
      ) {
        return jsonResponse(res, 409, { error: err.message });
      }
      throw err;
    }
  }

  // POST /api/memory/turn — ingest a conversation turn as a tri-modal Knowledge Asset.
  //
  // Streamlined path for agent memory: accepts a markdown conversation turn,
  // stores it in the file store, runs structural + optional semantic extraction,
  // and writes the resulting triples to SWM (or WM if layer=wm).
  //
  // Spec: 21_TRI_MODAL_MEMORY.md §8
  if (req.method === 'POST' && path === '/api/memory/turn') {
    const body = await readBody(req);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;

    const { markdown, contextGraphId, sessionUri, layer, subGraphName } = parsed;
    if (!markdown || typeof markdown !== 'string') {
      return jsonResponse(res, 400, { error: 'Missing or invalid "markdown" field (string)' });
    }
    if (!validateRequiredContextGraphId(contextGraphId, res)) return;
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    if (sessionUri !== undefined) {
      if (typeof sessionUri !== 'string' || !isSafeIri(sessionUri)) {
        return jsonResponse(res, 400, { error: 'Invalid "sessionUri": must be a safe IRI' });
      }
    }

    const targetLayer = layer === 'wm' ? 'wm' : 'swm';
    const agentDid = `did:dkg:agent:${agent.peerId}`;
    const now = new Date().toISOString();

    // 1. Store markdown in the file store
    const mdBytes = Buffer.from(markdown, 'utf-8');
    let fileEntry;
    try {
      fileEntry = await fileStore.put(mdBytes, 'text/markdown');
    } catch (err: any) {
      return jsonResponse(res, 500, { error: `Failed to store turn markdown: ${err.message}` });
    }
    const fileUri = `urn:dkg:file:${fileEntry.keccak256}`;

    // Derive turn URI from agent address + timestamp for collision avoidance
    const turnUri = `did:dkg:context-graph:${contextGraphId}/turn/${agent.peerId}-${now}`;

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
        // Semantic extraction is best-effort — structural extraction alone is sufficient
      }
    }

    // 4. Build quads for the target graph
    const targetGraph = targetLayer === 'swm'
      ? contextGraphSharedMemoryUri(contextGraphId, subGraphName)
      : contextGraphAssertionUri(contextGraphId, requestAgentAddress, `turn-${now}`, subGraphName);

    const quads: Array<{ subject: string; predicate: string; object: string; graph: string }> = [];

    // Content triples from structural extraction
    for (const t of extractResult.triples) {
      quads.push({ ...t, graph: targetGraph });
    }
    // Source-file linkage from extractor (rows 1 + 3)
    for (const t of extractResult.sourceFileLinkage) {
      quads.push({ ...t, graph: targetGraph });
    }
    // Semantic triples (if any)
    for (const t of semanticTriples) {
      quads.push({ ...t, graph: targetGraph });
    }

    // Ensure the turn is typed as a ConversationTurn
    quads.push({
      subject: turnUri,
      predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
      object: 'http://schema.org/ConversationTurn',
      graph: targetGraph,
    });
    // Persist the markdown body so the UI can display turn content
    // without fetching the source file separately
    const truncatedBody = markdown.length > 2000 ? markdown.slice(0, 2000) + '…' : markdown;
    quads.push({
      subject: turnUri,
      predicate: 'http://schema.org/description',
      object: JSON.stringify(truncatedBody),
      graph: targetGraph,
    });
    // Source content type
    quads.push({
      subject: turnUri,
      predicate: 'http://dkg.io/ontology/sourceContentType',
      object: JSON.stringify('text/markdown'),
      graph: targetGraph,
    });
    // Agent attribution
    quads.push({
      subject: turnUri,
      predicate: 'http://schema.org/agent',
      object: agentDid,
      graph: targetGraph,
    });
    // Timestamp
    quads.push({
      subject: turnUri,
      predicate: 'http://schema.org/dateCreated',
      object: `"${now}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`,
      graph: targetGraph,
    });

    // Session linking (if session URI provided)
    if (sessionUri && typeof sessionUri === 'string') {
      quads.push({
        subject: turnUri,
        predicate: 'http://schema.org/isPartOf',
        object: sessionUri,
        graph: targetGraph,
      });
      quads.push({
        subject: sessionUri,
        predicate: 'http://schema.org/hasPart',
        object: turnUri,
        graph: targetGraph,
      });
    }

    // 5. Write to target layer
    try {
      if (targetLayer === 'swm') {
        // agent.share sets the graph field itself — pass quads with empty graph
        const shareQuads = quads.map(({ subject, predicate, object }) => ({ subject, predicate, object, graph: '' }));
        const ctx = createOperationContext('share');
        tracker.start(ctx, { contextGraphId, details: { tripleCount: shareQuads.length, source: 'memory-turn', subGraphName } });
        try {
          await tracker.trackPhase(ctx, 'store', () =>
            agent.share(contextGraphId, shareQuads, {
              subGraphName,
              localOnly: false,
              operationCtx: ctx,
              callerAgentAddress: requestAgentAddress,
            }),
          );
          tracker.complete(ctx, { tripleCount: shareQuads.length });
        } catch (err: any) {
          tracker.fail(ctx, err);
          throw err;
        }
      } else {
        await agent.store.insert(quads);
      }
    } catch (err: any) {
      return jsonResponse(res, 500, { error: `Failed to write turn to ${targetLayer}: ${err.message}` });
    }
    emitMemoryGraphChanged?.({
      contextGraphId,
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
          contextGraphId,
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
      fileHash: fileEntry.keccak256,
      layer: targetLayer,
      graph: targetGraph,
      structuralTripleCount: extractResult.triples.length,
      semanticTripleCount: semanticTriples.length,
      totalQuads: quads.length,
      embeddingId,
      sessionUri: sessionUri ?? null,
    });
  }

  // POST /api/memory/search — tri-modal search across text, graph, and vector stores.
  //
  // Fans out the query to SPARQL (triple store), text search (file store),
  // and vector similarity (vector store), then merges and deduplicates results.
  //
  // Spec: 21_TRI_MODAL_MEMORY.md §7
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
    const memoryLayers: Array<'swm' | 'vm'> = parsed.memoryLayers ?? ['swm', 'vm'];

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

    // Fan-out 2: SPARQL text search (scoped to the requested CG + layers)
    const escapedQuery = query.replace(/"/g, '\\"').toLowerCase();
    const cgUri = `did:dkg:context-graph:${contextGraphId}`;
    const graphFilters = memoryLayers.map((l: string) => {
      if (l === 'swm') return `STRSTARTS(STR(?g), "${cgUri}/_shared_memory")`;
      if (l === 'vm') return `STRSTARTS(STR(?g), "${cgUri}/_verified")`;
      return `STRSTARTS(STR(?g), "${cgUri}/")`;
    }).join(' || ');
    try {
      const sparqlResult = await agent.store.query(`
        SELECT DISTINCT ?entity ?name ?desc WHERE {
          GRAPH ?g {
            ?entity <http://schema.org/name>|<http://www.w3.org/2000/01/rdf-schema#label> ?name .
            OPTIONAL { ?entity <http://schema.org/description> ?desc }
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
