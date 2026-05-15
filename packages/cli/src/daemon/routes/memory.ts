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
import { computeNetworkId, createOperationContext, DKGEvent, Logger, PayloadTooLargeError, GET_VIEWS, TrustLevel, validateSubGraphName, validateAssertionName, validateContextGraphId, isSafeIri, assertSafeIri, assertSafeRdfTerm, sparqlIri, contextGraphSharedMemoryUri, contextGraphAssertionUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
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
SELECT ?q ?subGraph ?catalog ?name ?description ?sparql ?rank ?catalogName ?catalogDescription ?catalogRank
WHERE {
  GRAPH <${graph}> {
    ?q a prof:SavedQuery ;
       prof:forSubGraph ?subGraph ;
       prof:sparqlQuery ?sparql .
    OPTIONAL { ?q prof:inCatalog ?catalog }
    OPTIONAL { ?q prof:displayName ?name }
    OPTIONAL { ?q schema:description ?description }
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
