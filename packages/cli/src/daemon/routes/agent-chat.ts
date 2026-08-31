// daemon/routes/agent-chat.ts
//
// Route handlers for agent registration/identity/listing, skills, chat, messages, connect, update.
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
import {
  DKGAgent,
  isRootlessUpdateError,
  loadOpWallets,
  type RootlessUpdateErrorCode,
} from '@origintrail-official/dkg-agent';
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

const ROOTLESS_UPDATE_HTTP_STATUS = {
  ROOTLESS_UPDATE_INVALID_KA_ID: 422,
  ROOTLESS_KA_NOT_MATERIALIZED: 422,
  ROOTLESS_UPDATE_TARGET_CORRUPT: 422,
  ROOTLESS_UPDATE_TARGET_NOT_CONFIRMED: 422,
} as const satisfies Record<RootlessUpdateErrorCode, number>;
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
  jsonResponse,
  oversizedRdfLiteralResponseBody,
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

import { authorizeAgentScopedAuthorClaim } from './shared-assertion-helpers.js';
import { classifyAgentConnectError } from './agent-connect-error.js';
import type { RequestContext } from './context.js';
import { handleAgentsListRoute } from './agents-list.js';
import type { PublishOptions } from '@origintrail-official/dkg-publisher';

function parsePrecomputedUpdateAttestation(
  raw: unknown,
  res: ServerResponse,
): PublishOptions['precomputedUpdateAttestation'] | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object') {
    jsonResponse(res, 400, {
      error: '"precomputedUpdateAttestation" must be an object',
    });
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const authorAddress =
    typeof obj.authorAddress === 'string' ? obj.authorAddress : undefined;
  const expectedHex =
    typeof obj.expectedNewMerkleRoot === 'string'
      ? obj.expectedNewMerkleRoot
      : undefined;
  const schemeVersion =
    typeof obj.schemeVersion === 'number' ? obj.schemeVersion : 1;
  const signature =
    obj.signature && typeof obj.signature === 'object'
      ? (obj.signature as Record<string, unknown>)
      : undefined;
  if (
    !authorAddress ||
    !/^0x[0-9a-fA-F]{40}$/.test(authorAddress) ||
    !expectedHex ||
    !signature
  ) {
    jsonResponse(res, 400, {
      error:
        '"precomputedUpdateAttestation" requires { authorAddress, expectedNewMerkleRoot: 0x<32 bytes>, signature: { r, vs }, schemeVersion? }',
    });
    return undefined;
  }
  const stripped = expectedHex.startsWith('0x')
    ? expectedHex.slice(2)
    : expectedHex;
  if (stripped.length !== 64 || !/^[0-9a-fA-F]+$/.test(stripped)) {
    jsonResponse(res, 400, {
      error: '"precomputedUpdateAttestation.expectedNewMerkleRoot" must be 32-byte hex',
    });
    return undefined;
  }
  const decode = (val: unknown): Uint8Array | undefined => {
    if (typeof val === 'string') {
      const h = val.startsWith('0x') ? val.slice(2) : val;
      if (h.length !== 64 || !/^[0-9a-fA-F]+$/.test(h)) return undefined;
      return Uint8Array.from(Buffer.from(h, 'hex'));
    }
    if (
      Array.isArray(val) &&
      val.length === 32 &&
      val.every((b) => typeof b === 'number' && b >= 0 && b <= 255)
    ) {
      return Uint8Array.from(val as number[]);
    }
    return undefined;
  };
  const r = decode(signature.r);
  const vs = decode(signature.vs);
  if (!r || !vs) {
    jsonResponse(res, 400, {
      error:
        '"precomputedUpdateAttestation.signature.r" and ".vs" must each be 32-byte hex strings or 32-element byte arrays',
    });
    return undefined;
  }
  return {
    expectedNewMerkleRoot: Uint8Array.from(Buffer.from(stripped, 'hex')),
    authorAddress,
    signature: { r, vs },
    schemeVersion,
  };
}

export async function handleAgentChatRoutes(ctx: RequestContext): Promise<void> {
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


  // POST /api/agent/register — register a new agent on this node
  if (req.method === "POST" && path === "/api/agent/register") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = JSON.parse(body);
    const { name, publicKey, peerIdProof, framework } = parsed;
    if (!name || typeof name !== "string") {
      return jsonResponse(res, 400, { error: 'Missing required field "name"' });
    }
    try {
      const record = await agent.registerAgent(name, { publicKey, peerIdProof, framework });
      validTokens.add(record.authToken);
      const response: Record<string, unknown> = {
        agentAddress: record.agentAddress,
        authToken: record.authToken,
        mode: record.mode,
      };
      if (record.mode === "custodial") {
        response.publicKey = record.publicKey;
        response.privateKey = record.privateKey;
      }
      return jsonResponse(res, 200, response);
    } catch (err: any) {
      return jsonResponse(res, 400, { error: err.message });
    }
  }

  // Authorize the new key-management routes: an agent-scoped token may
  // only act on its own agent. Node-admin tokens (no specific agent
  // bound) are the operator override and may act on any local agent.
  // `agent.resolveAgentByToken` returns the agent address for an
  // agent-scoped token, `undefined` for the node-admin token (which
  // isn't registered in the per-agent index). Same pattern other
  // routes (e.g. memory.ts, query.ts) already use for caller-vs-target
  // gating.
  function authorizeKeyManagementOnAddress(targetAddress: string): { ok: true } | { ok: false; status: number; body: Record<string, unknown> } {
    const tokenAgentAddress = requestToken ? agent.resolveAgentByToken(requestToken) : undefined;
    if (!tokenAgentAddress) return { ok: true };
    if (tokenAgentAddress.toLowerCase() === targetAddress.toLowerCase()) return { ok: true };
    return {
      ok: false,
      status: 403,
      body: {
        error: `Agent token for ${tokenAgentAddress} cannot manage encryption keys for ${targetAddress}. ` +
          'Use a node-level admin token (~/.dkg/auth.token) to manage other agents on this node.',
      },
    };
  }

  // POST /api/agent/:address/rotate-encryption-key — mint a fresh workspace
  // encryption key for a custodial local agent. Body: `{ "retireOld": boolean }`.
  // When `retireOld` is true, the previous default key is also revoked in the
  // same operation (use only after propagation has settled, or for urgent
  // compromise scenarios). The new key is appended to the keystore, RDF
  // triples are emitted in the local agent registry, and the agent's profile
  // is re-published so peers update their resolver state.
  if (
    req.method === "POST"
    && path.startsWith("/api/agent/")
    && path.endsWith("/rotate-encryption-key")
  ) {
    const address = decodeURIComponent(path.slice("/api/agent/".length, -"/rotate-encryption-key".length));
    if (!address) return jsonResponse(res, 404, { error: "Agent address required in path" });
    const authz = authorizeKeyManagementOnAddress(address);
    if (!authz.ok) return jsonResponse(res, authz.status, authz.body);
    let parsed: { retireOld?: unknown } = {};
    const body = (await readBody(req, SMALL_BODY_BYTES)).trim();
    if (body) {
      try { parsed = JSON.parse(body); }
      catch { return jsonResponse(res, 400, { error: "Invalid JSON body" }); }
    }
    const retireOld = parsed.retireOld === true;
    try {
      const result = await agent.rotateWorkspaceEncryptionKey(address, { retireOld });
      return jsonResponse(res, 200, { ok: true, ...result });
    } catch (err: any) {
      return jsonResponse(res, 400, { error: err?.message ?? "Encryption key rotation failed" });
    }
  }

  // POST /api/agent/:address/revoke-encryption-key — wallet-sign and publish a
  // revocation for a specific encryption key. Body: `{ "keyId": "did:dkg:agent:..." }`.
  // Refuses to revoke the agent's last active key (would brick SWM); callers
  // must rotate first in that case. Idempotent: revoking an already-revoked
  // key returns the existing revocation timestamp without re-signing.
  if (
    req.method === "POST"
    && path.startsWith("/api/agent/")
    && path.endsWith("/revoke-encryption-key")
  ) {
    const address = decodeURIComponent(path.slice("/api/agent/".length, -"/revoke-encryption-key".length));
    if (!address) return jsonResponse(res, 404, { error: "Agent address required in path" });
    const authz = authorizeKeyManagementOnAddress(address);
    if (!authz.ok) return jsonResponse(res, authz.status, authz.body);
    const body = (await readBody(req, SMALL_BODY_BYTES)).trim();
    if (!body) return jsonResponse(res, 400, { error: 'Body required: { "keyId": "..." }' });
    let parsed: { keyId?: unknown };
    try { parsed = JSON.parse(body); }
    catch { return jsonResponse(res, 400, { error: "Invalid JSON body" }); }
    if (typeof parsed.keyId !== "string" || !parsed.keyId) {
      return jsonResponse(res, 400, { error: 'Missing required field "keyId"' });
    }
    try {
      const result = await agent.revokeWorkspaceEncryptionKey(address, parsed.keyId);
      return jsonResponse(res, 200, { ok: true, ...result });
    } catch (err: any) {
      return jsonResponse(res, 400, { error: err?.message ?? "Encryption key revocation failed" });
    }
  }

  // GET /api/agent/:address/encryption-keys — list a local agent's workspace
  // encryption keys (active + retired) for display before a rotate/revoke.
  // PUBLIC fields only — private key material (privateEncryptionKey) is NEVER
  // serialized, even though listLocalAgents() carries it in memory. Same
  // caller-vs-target gate as rotate/revoke.
  if (
    req.method === "GET"
    && path.startsWith("/api/agent/")
    && path.endsWith("/encryption-keys")
  ) {
    const address = decodeURIComponent(path.slice("/api/agent/".length, -"/encryption-keys".length));
    if (!address) return jsonResponse(res, 404, { error: "Agent address required in path" });
    const authz = authorizeKeyManagementOnAddress(address);
    if (!authz.ok) return jsonResponse(res, authz.status, authz.body);
    const localAgents = agent.listLocalAgents();
    const current = localAgents.find((a) => a.agentAddress.toLowerCase() === address.toLowerCase());
    if (!current) {
      return jsonResponse(res, 404, { error: `No local agent for address ${address}` });
    }
    const keys = (current.workspaceEncryptionKeys ?? []).map((k) => ({
      encryptionKeyId: k.encryptionKeyId,
      encryptionKeyAlgorithm: k.encryptionKeyAlgorithm,
      publicEncryptionKey: k.publicEncryptionKey,
      encryptionKeyProof: k.encryptionKeyProof,
      createdAt: k.createdAt,
      revokedAt: k.revokedAt ?? null,
      status: k.revokedAt ? "revoked" : "active",
    }));
    return jsonResponse(res, 200, {
      agentAddress: current.agentAddress,
      agentDid: `did:dkg:agent:${current.agentAddress}`,
      keys,
    });
  }

  // POST /api/agent/publish-profile — re-broadcast the daemon's default
  // agent profile. The rotate/revoke flows above call this implicitly on
  // success; this endpoint exists for the partial-failure path where
  // local persistence succeeded but the implicit republish errored
  // (returned `profilePublished: false` + `profilePublishError`). The
  // operator retries here once whatever blocked the publish (chain RPC,
  // libp2p dial, etc.) has recovered. Node-admin only — there is no
  // per-agent profile in the current architecture, only the default
  // agent's; gating to admin avoids a non-default-agent token tricking
  // the daemon into republishing on demand for spam.
  if (req.method === "POST" && path === "/api/agent/publish-profile") {
    const tokenAgentAddress = requestToken ? agent.resolveAgentByToken(requestToken) : undefined;
    if (tokenAgentAddress) {
      return jsonResponse(res, 403, {
        error: 'POST /api/agent/publish-profile requires a node-level admin token; agent-scoped tokens cannot trigger a profile republish.',
      });
    }
    try {
      const result = await agent.publishProfile();
      return jsonResponse(res, 200, { ok: true, ual: (result as any)?.ual ?? null });
    } catch (err: any) {
      return jsonResponse(res, 502, { error: err?.message ?? "Profile publish failed" });
    }
  }

  // GET /api/agent/identity — current agent identity for the requesting token
  if (req.method === "GET" && path === "/api/agent/identity") {
    const token = extractBearerToken(req.headers.authorization);
    const agentAddress = agent.resolveAgentAddress(token);
    const localAgents = agent.listLocalAgents();
    const current = localAgents.find((a) => a.agentAddress === agentAddress);
    return jsonResponse(res, 200, {
      agentAddress,
      agentDid: `did:dkg:agent:${agentAddress}`,
      name: current?.name ?? agent.nodeName,
      framework: current?.framework ?? agent.nodeFramework,
      peerId: agent.peerId,
      nodeIdentityId: String(agent.publisher.getIdentityId()),
    });
  }

  // GET /api/agents — enriched with live connection health
  // Optional query params: ?framework=X &skill_type=X &connectionStatus=X
  //                        &local=true|false &limit=N &cursor=X   (GH#310)
  if (req.method === "GET" && path === "/api/agents") {
    return handleAgentsListRoute(ctx);
  }

  // GET /api/peer-info?peerId=<id>
  //
  // Returns the {@link PeerDiagnostics} snapshot from
  // `agent.getPeerDiagnostics()`. The legacy flat fields
  // (`connectionCount`, `transports`, `directions`, `remoteAddrs`,
  // `lastSeen`, `latencyMs`) are preserved alongside the richer
  // `connections` array + `getConnectionsReturnsForPeer` + `peerStore`
  // + `outbox` blocks so any existing consumer that grew up on the
  // pre-diagnostic shape still works.
  if (req.method === "GET" && path === "/api/peer-info") {
    const peerId = url.searchParams.get("peerId");
    if (!peerId) {
      return jsonResponse(res, 400, { error: 'Missing "peerId" query param' });
    }

    const diag = await agent.getPeerDiagnostics(peerId);
    return jsonResponse(res, 200, {
      peerId,
      connected: diag.connected,
      // Legacy flat fields kept for back-compat with pre-PR callers.
      connectionCount: diag.rawConnectionCount,
      transports: diag.connections.map((c) => c.transport),
      directions: diag.connections.map((c) => c.direction),
      remoteAddrs: diag.connections.map((c) => c.remoteAddr),
      // New diagnostic surface.
      rawConnectionCount: diag.rawConnectionCount,
      getConnectionsReturnsForPeer: diag.getConnectionsReturnsForPeer,
      connections: diag.connections,
      peerStore: diag.peerStore,
      outbox: diag.outbox,
      // Existing health fields, kept flat and ALSO available under
      // `health` for callers that want the typed snapshot.
      protocols: diag.protocols,
      syncCapable: diag.syncCapable,
      syncStatus: diag.syncStatus,
      lastSeen: diag.health?.lastSeen ?? null,
      latencyMs: diag.health?.latencyMs ?? null,
      health: diag.health,
    });
  }

  // GET /api/slo
  //
  // rc.9 PR-12. Per-protocol Universal Messenger SLO snapshot:
  // p50/p95/p99 latency over the last ~1000 deliveries plus the
  // monotonic delivered / queued counters. Source of truth for the
  // ship-gate overnight soak.
  //
  // rc.9 PR-A (SWM reliable fan-out plan, Step 0) extended the
  // response shape with two new top-level sections — `gossip` for
  // SWM gossip publish failures (pre-rc.9 silently swallowed) and
  // `swm` for receiver-side redundant-apply measurement (informs
  // rc10 Concern-2 dedup decision). Both are additive; existing
  // consumers that parse `protocols` keep working.
  //
  // SECURITY: this endpoint is reachable only from localhost via the
  // daemon's bind address (the daemon binds /api/* to 127.0.0.1 by
  // default — see packages/cli/src/daemon/lifecycle.ts). Per-protocol
  // traffic patterns + latency distributions are operationally
  // sensitive metadata (traffic rates leak peer activity); default-
  // public would be an info-leak regression. Operators who want
  // remote visibility should put their own reverse proxy with auth
  // in front. The agent.getMessengerSloStats() call itself is cheap
  // (≤ 8 protocols × ≤ 1k samples sort) so no rate limit is needed.
  if (req.method === "GET" && path === "/api/slo") {
    return jsonResponse(res, 200, buildSloPayload(agent));
  }

  // GET /api/skills
  // Optional query params: ?skillType=X
  if (req.method === "GET" && path === "/api/skills") {
    const skillTypeFilter = url.searchParams.get("skillType") || undefined;
    const skills = await agent.findSkills(
      skillTypeFilter ? { skillType: skillTypeFilter } : undefined,
    );
    return jsonResponse(res, 200, { skills });
  }

  // POST /api/invoke-skill  { peerId: "...", skillUri: "...", input: "..." }
  if (req.method === "POST" && path === "/api/invoke-skill") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body);
    } catch {
      return jsonResponse(res, 400, { error: "Invalid JSON body" });
    }
    const rawPeerId = parsed.peerId ? String(parsed.peerId) : "";
    const skillUri = parsed.skillUri ? String(parsed.skillUri) : "";
    const input = parsed.input != null ? String(parsed.input) : "";
    if (!rawPeerId || !skillUri)
      return jsonResponse(res, 400, {
        error: 'Missing "peerId" or "skillUri"',
      });

    // Resolve name → peerId
    const peerId = await resolveNameToPeerId(agent, rawPeerId);
    if (!peerId)
      return jsonResponse(res, 404, {
        error: `Agent "${rawPeerId}" not found`,
      });

    try {
      const inputData = new TextEncoder().encode(input);
      const response = await agent.invokeSkill(peerId, skillUri, inputData);
      return jsonResponse(res, 200, {
        success: response.success,
        output: response.outputData
          ? new TextDecoder().decode(response.outputData)
          : undefined,
        error: response.error,
        executionTimeMs: response.executionTimeMs,
      });
    } catch (err: any) {
      return jsonResponse(res, 502, { error: err.message });
    }
  }

  // POST /api/chat  { to: "name-or-peerId", text: "...", contextGraphId?: "..." }
  //
  // Optional `contextGraphId` is embedded in the encrypted payload so a
  // scoped receiver can validate that the sender is talking on behalf of
  // a context graph both sides recognise. Callers must opt in
  // EXPLICITLY by passing `contextGraphId` on the request; we do NOT
  // auto-fill from `config.chat.acl.contextGraphId`. Codex PR #510
  // round 3 caught that conflating the INBOUND ACL config with the
  // OUTBOUND wire claim broke back-compat: a node configured to
  // ACL-scope inbound chats to graph X would suddenly stamp every
  // outgoing chat with the X claim, causing receivers that scope to a
  // DIFFERENT graph (or to `shared-context-graph` mode) to reject
  // messages that previously succeeded. ACL config and outbound
  // claim are distinct concerns — if a future requirement needs a
  // "default outbound CG" it should be a separate explicit config
  // field, not overloaded on the ACL one.
  if (req.method === "POST" && path === "/api/chat") {
    const serverT0 = Date.now();
    const body = await readBody(req, SMALL_BODY_BYTES);
    const chatParsed = JSON.parse(body) as {
      to?: string;
      text?: string;
      peerId?: string;
      message?: string;
      contextGraphId?: string;
    };
    // #1106 (1): accept the intuitive `peerId`/`message` aliases for
    // `to`/`text` — callers integrating from the tool tables repeatedly
    // guessed this shape and got an unexplained 400.
    const to = chatParsed.to ?? chatParsed.peerId;
    const text = chatParsed.text ?? chatParsed.message;
    const contextGraphId = chatParsed.contextGraphId;
    if (!to || !text)
      return jsonResponse(res, 400, { error: 'Missing "to" or "text" (aliases: "peerId" / "message")' });

    const resolveT0 = Date.now();
    const peerId = await resolveNameToPeerId(agent, to);
    const resolveDur = Date.now() - resolveT0;
    if (!peerId)
      return jsonResponse(res, 404, { error: `Agent "${to}" not found` });

    const sendT0 = Date.now();
    const result = await Promise.race([
      agent.sendChat(peerId, text, contextGraphId ? { contextGraphId } : {}),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("sendChat timeout (30s)")), 30_000),
      ),
    ]);
    const sendDur = Date.now() - sendT0;
    try {
      // Store the sender-assigned `messageId` so an operator who
      // refreshes the chat panel during an outbox-retry sequence
      // doesn't see N copies of the same logical outbound message —
      // each retry attempt reuses the same `messageId` (see
      // `DKGAgent.sendChat` / `retryOutboxEntry`), so the dedup
      // index suppresses the duplicate inserts.
      dashDb.insertChatMessage({
        ts: Date.now(),
        direction: "out",
        peer: peerId,
        text,
        delivered: result.delivered,
        messageId: result.messageId,
      });
    } catch {
      /* never crash */
    }
    return jsonResponse(res, 200, {
      ...result,
      phases: {
        resolve: resolveDur,
        send: sendDur,
        serverTotal: Date.now() - serverT0,
      },
    });
  }

  // GET /api/messages
  //   ?peer=<name-or-id>
  //   &limit=N
  //   &since=<ts>
  //   &sinceId=<id>          ← lossless compound cursor (Codex PR #510 round 2)
  //   &direction=in|out
  //   &order=asc|desc
  //
  // `direction` is a server-side filter applied BEFORE `limit`. Inbox
  // readers (the `dkg_check_inbox` MCP tool, the `inject-inbox` hook)
  // pass `direction=in` so a burst of outbound replies in the newest
  // page cannot push older unread inbound messages off the bottom and
  // cause the inbox watermark to skip them.
  //
  // `sinceId` enables compound-cursor pagination — when paired with
  // `since`, the predicate is `(ts > since) OR (ts = since AND id >
  // sinceId)`. Without this, rows sharing the same millisecond `ts`
  // would be silently dropped on the next page (chat bursts can easily
  // produce duplicate `Date.now()` values).
  //
  // `order` defaults to `desc` (history view). Inbox readers pass
  // `asc` for forward pagination so the watermark only advances past
  // rows we have actually returned. We surface row `id` in the
  // response so clients can build the next compound cursor.
  if (req.method === "GET" && path === "/api/messages") {
    const peerFilter = url.searchParams.get("peer");
    const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
    const since = parseInt(url.searchParams.get("since") ?? "0", 10);
    const sinceIdRaw = url.searchParams.get("sinceId");
    const sinceId = sinceIdRaw != null && /^\d+$/.test(sinceIdRaw)
      ? parseInt(sinceIdRaw, 10)
      : undefined;
    const directionRaw = url.searchParams.get("direction");
    const direction: "in" | "out" | undefined =
      directionRaw === "in" || directionRaw === "out" ? directionRaw : undefined;
    const orderRaw = url.searchParams.get("order");
    const order: "asc" | "desc" | undefined =
      orderRaw === "asc" || orderRaw === "desc" ? orderRaw : undefined;

    let peer: string | undefined;
    if (peerFilter) {
      peer = (await resolveNameToPeerId(agent, peerFilter)) ?? undefined;
    }
    const rows = dashDb.getChatMessages({
      peer,
      since: since || undefined,
      sinceId,
      limit,
      direction,
      order,
    });
    const msgs = rows.map((r: any) => ({
      id: r.id,
      ts: r.ts,
      direction: r.direction,
      peer: r.peer,
      peerName: r.peer_name ?? undefined,
      text: r.text,
      delivered: r.delivered == null ? undefined : r.delivered === 1,
    }));
    return jsonResponse(res, 200, { messages: msgs });
  }

  // POST /api/connect — accepts either:
  //   { multiaddr: "/ip4/.../p2p/<id>" }    legacy direct dial
  //   { peerId:   "12D3KooW..." }           V10 DHT lookup + dial
  // The peerId form is preferred for invites: the daemon resolves the
  // peer's current multiaddrs via libp2p Kademlia (`peerRouting.findPeer`)
  // and dials them, so the invite survives the curator's relay rotations
  // / public-IP changes.
  if (req.method === "POST" && path === "/api/connect") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = JSON.parse(body);
    const { multiaddr: addr, peerId } = parsed;
    if (!addr && !peerId) return jsonResponse(res, 400, { error: 'Missing "multiaddr" or "peerId"' });
    try {
      if (peerId) {
        await agent.connectToPeerId(peerId);
      } else {
        await agent.connectTo(addr);
      }
    } catch (err: any) {
      const classified = classifyAgentConnectError(err);
      return jsonResponse(res, classified.status, classified.body);
    }
    return jsonResponse(res, 200, { connected: true });
  }

  // POST /api/update  { kaId, contextGraphId, quads?, privateQuads?, precomputedUpdateAttestation? }
  if (req.method === "POST" && path === "/api/update") {
    const body = await readBody(req);
    const parsed = JSON.parse(body);
    const { kaId } = parsed;
    if (parsed.quads !== undefined && !Array.isArray(parsed.quads)) {
      return jsonResponse(res, 400, { error: '"quads" must be an array when provided' });
    }
    if (parsed.privateQuads !== undefined && !Array.isArray(parsed.privateQuads)) {
      return jsonResponse(res, 400, { error: '"privateQuads" must be an array when provided' });
    }
    const quads = Array.isArray(parsed.quads) ? parsed.quads : [];
    const privateQuads = Array.isArray(parsed.privateQuads) ? parsed.privateQuads : [];
    const contextGraphId = parsed.contextGraphId;
    const precomputedUpdateAttestation = parsePrecomputedUpdateAttestation(
      parsed.precomputedUpdateAttestation,
      res,
    );
    if (parsed.precomputedUpdateAttestation !== undefined && !precomputedUpdateAttestation) {
      return;
    }
    const tokenAgentAddress = requestToken ? agent.resolveAgentByToken(requestToken) : undefined;
    if (!authorizeAgentScopedAuthorClaim(
      res,
      tokenAgentAddress,
      precomputedUpdateAttestation?.authorAddress,
      "precomputedUpdateAttestation.authorAddress",
    )) {
      return;
    }
    if (!kaId || !contextGraphId || (quads.length === 0 && privateQuads.length === 0)) {
      return jsonResponse(res, 400, {
        error: 'Missing "kaId", "contextGraphId", or update content in "quads"/"privateQuads"',
      });
    }
    let kcIdBigInt: bigint;
    try {
      kcIdBigInt = BigInt(kaId);
    } catch {
      return jsonResponse(res, 400, {
        error: `Invalid "kaId": ${String(kaId).slice(0, 50)}`,
      });
    }
    // A Knowledge Asset id is a positive token id. `BigInt("0")` and
    // `BigInt("-1")` parse fine and the truthy-string `"0"` slips past the
    // `!kaId` check above, so a corrupt `"0"`/negative id would otherwise be
    // forwarded to `agent.update` (and only fail with a cryptic on-chain
    // revert). Fail loud at the boundary instead — mirrors the
    // `contextGraphId <= 0n` guard in the chain adapter.
    if (kcIdBigInt <= 0n) {
      return jsonResponse(res, 400, {
        error: `Invalid "kaId": ${String(kaId).slice(0, 50)} — must be a positive integer`,
      });
    }
    const ctx = createOperationContext("update");
    tracker.start(ctx, {
      contextGraphId: contextGraphId,
      details: { kaId: String(kaId), tripleCount: quads.length, source: "api" },
    });
    try {
      const result = await agent.update(
        kcIdBigInt,
        contextGraphId,
        quads,
        privateQuads,
        {
          operationCtx: ctx,
          onPhase: tracker.phaseCallback(ctx),
          precomputedUpdateAttestation,
        },
      );
      const chain = result.onChainResult;
      if (chain) {
        tracker.setCost(ctx, {
          gasUsed: chain.gasUsed,
          gasPrice: chain.effectiveGasPrice,
          gasCost: chain.gasCostWei,
          tracCost: chain.tokenAmount,
        });
        const chainId = resolveChainConfig(config, network)?.chainId;
        tracker.setTxHash(
          ctx,
          chain.txHash,
          chainId ? Number(chainId) : undefined,
        );
      }
      if (result.status === "failed") {
        tracker.fail(ctx, new Error(`Update failed on-chain (kaId=${kaId})`));
      } else {
        tracker.complete(ctx, {
          tripleCount: quads.length,
          details: { kaId: String(result.kaId), status: result.status },
        });
      }
      const opDetail = dashDb.getOperation(ctx.operationId);
      return jsonResponse(res, 200, {
        kaId: String(result.kaId),
        status: result.status,
        kas: result.kaManifest.map((ka) => ({
          tokenId: String(ka.tokenId),
          rootEntity: ka.rootEntity,
        })),
        ...(chain && { txHash: chain.txHash, blockNumber: chain.blockNumber }),
        phases: opDetail.phases,
      });
    } catch (err) {
      tracker.fail(ctx, err);
      // F1: a missing/invalid off-band update attestation
      // (`precomputedUpdateAttestation`) is a caller precondition failure,
      // not a server fault. The publisher throws a plain Error for it; map
      // those to 422 (Unprocessable Entity) so the API surfaces a proper 4xx
      // instead of letting it bubble to the generic 500 handler.
      const message = err instanceof Error ? err.message : String(err);
      const errorCode = typeof err === 'object' && err !== null
        ? Reflect.get(err, 'code')
        : undefined;
      if (errorCode === "OVERSIZED_RDF_LITERAL") {
        return jsonResponse(res, 400, oversizedRdfLiteralResponseBody(err));
      }
      if (errorCode === "KA_NAMED_GRAPH_SHARE_UNSUPPORTED") {
        return jsonResponse(res, 400, { error: message });
      }
      if (errorCode === "KA_UPDATE_AUTHOR_NOT_OWNER") {
        return jsonResponse(res, 403, { error: message, code: "KA_UPDATE_AUTHOR_NOT_OWNER" });
      }
      if (errorCode === "LEGACY_KA_READ_ONLY") {
        return jsonResponse(res, 409, { error: message, code: "LEGACY_KA_READ_ONLY" });
      }
      if (isRootlessUpdateError(err)) {
        return jsonResponse(res, ROOTLESS_UPDATE_HTTP_STATUS[err.code], {
          error: message,
          code: err.code,
        });
      }
      if (message.includes('precomputedUpdateAttestation')) {
        return jsonResponse(res, 422, { error: message });
      }
      throw err;
    }
  }
}

/**
 * Build the `/api/slo` response payload. Extracted out of the inline
 * route block so the public wire shape is testable in isolation
 * (rc.9 PR-A / Codex PR #570 R10) — production route + regression
 * test share the exact same code path, so a future drift in any
 * field name / nesting can't slip past CI.
 *
 * Cold-start safety: when `sharedMemoryHandler` has never been
 * instantiated (no SWM share has ever been received), the agent's
 * `getSwmHandlerStats()` returns its pristine snapshot rather than
 * throwing — `buildSloPayload` is safe to call against a fresh
 * daemon.
 */
export function buildSloPayload(agent: {
  getMessengerSloStats: () => Record<string, unknown>;
  getSwmGossipStats: () => {
    publishFailures: Record<string, number>;
    publishFailuresOverflow: number;
    publishFailuresTruncated: boolean;
  };
  getSwmHandlerStats: () => {
    redundantApplies: Record<string, number>;
    redundantAppliesLowerBound: boolean;
    redundantAppliesOverflow: number;
    redundantAppliesTruncated: boolean;
  };
  /**
   * rc.9 PR-C addition. Optional on the interface so a hypothetical
   * test double that only exercises the gossip + receiver sides
   * doesn't have to stub it. Implementations that omit it simply
   * leave `swm.substrateFanout` off the response — soak scripts
   * check for its presence before referencing fields.
   */
  getSwmSubstrateFanoutStats?: () => {
    delivered: Record<string, number>;
    rejected: Record<string, number>;
    /**
     * rc.9 PR-D (codex follow-up from PR-G #G1): transient
     * receiver-side rejections. Optional on the interface for
     * back-compat with pre-PR-D test doubles.
     */
    retryable?: Record<string, number>;
    queued: Record<string, number>;
    inFlight: Record<string, number>;
    failed: Record<string, number>;
    overflow: {
      delivered: number;
      rejected: number;
      retryable?: number;
      queued: number;
      inFlight: number;
      failed: number;
    };
    truncated: boolean;
  };
  /**
   * rc.9 PR-D addition. Optional for the same reason
   * getSwmSubstrateFanoutStats is — test doubles don't need to
   * stub a tracker they aren't exercising.
   */
  getSwmAckQuorumStats?: () => {
    tracked: number;
    completed: number;
    watchdogFired: number;
    deadlineExpired: number;
    pending: number;
  };
}): {
  protocols: Record<string, unknown>;
  gossip: {
    publishFailures: Record<string, number>;
    publishFailuresOverflow: number;
    publishFailuresTruncated: boolean;
  };
  swm: {
    redundantApplies: Record<string, number>;
    redundantAppliesLowerBound: boolean;
    redundantAppliesOverflow: number;
    redundantAppliesTruncated: boolean;
    /**
     * rc.9 PR-C: substrate fan-out per-outcome counters. Present
     * iff the agent exposes `getSwmSubstrateFanoutStats()` (every
     * production agent does; opt-out is for test doubles).
     */
    substrateFanout?: {
      delivered: Record<string, number>;
      rejected: Record<string, number>;
      retryable?: Record<string, number>;
      queued: Record<string, number>;
      inFlight: Record<string, number>;
      failed: Record<string, number>;
      overflow: {
        delivered: number;
        rejected: number;
        retryable?: number;
        queued: number;
        inFlight: number;
        failed: number;
      };
      truncated: boolean;
    };
    /**
     * rc.9 PR-D: ack-quorum overlay counters. Same opt-out
     * mechanic as `substrateFanout` — present iff the agent
     * exposes `getSwmAckQuorumStats()`.
     */
    shareAckQuorum?: {
      tracked: number;
      completed: number;
      watchdogFired: number;
      deadlineExpired: number;
      pending: number;
    };
  };
} {
  const swmHandler = agent.getSwmHandlerStats();
  const substrateFanout = agent.getSwmSubstrateFanoutStats?.();
  const shareAckQuorum = agent.getSwmAckQuorumStats?.();
  return {
    protocols: agent.getMessengerSloStats(),
    gossip: agent.getSwmGossipStats(),
    swm: {
      ...swmHandler,
      ...(substrateFanout !== undefined ? { substrateFanout } : {}),
      ...(shareAckQuorum !== undefined ? { shareAckQuorum } : {}),
    },
  };
}
