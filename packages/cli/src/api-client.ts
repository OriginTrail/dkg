import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type {
  ContextGraphReconcileResult,
  RandomSamplingDisabledReason,
} from '@origintrail-official/dkg-agent';
import { LegacyKnowledgeAssetReadOnlyError } from '@origintrail-official/dkg-core';
import { readApiPort, readPid, isProcessRunning, configExists, loadConfig } from './config.js';
import { loadTokens } from './auth.js';
import {
  finalizedPublishOptionsPayload,
  type KnowledgeAssetFinalizedPublishOptions,
} from './finalized-publish-options.js';
import type { RegisterPcaAgentResult } from './pca-confirmation-wire.js';
import { parseRegisterPcaAgentResult } from './pca-confirmation-wire.js';
import type { KnowledgeAssetContentEnvelope } from '@origintrail-official/dkg-publisher';

export type { KnowledgeAssetFinalizedPublishOptions } from './finalized-publish-options.js';
export type { KnowledgeAssetContentEnvelope } from '@origintrail-official/dkg-publisher';

export type ContextGraphJoinPolicyMode = 'manual' | 'open';

export interface ContextGraphJoinPolicyResponse {
  contextGraphId: string;
  mode: ContextGraphJoinPolicyMode;
  maxMembers?: number | null;
  maxApprovalsPerHour?: number | null;
  memberCount?: number;
  approvalsLastHour?: number;
  ownerAgentAddress?: string;
  updatedAt?: number | null;
  [key: string]: unknown;
}

export type ContextGraphJoinPolicyUpdate =
  | { mode: 'manual' }
  | {
      mode: 'open';
      maxMembers: number;
      maxApprovalsPerHour: number;
      acknowledgeOpenEnrollment: true;
    };

export type QueryResult =
  | { type: 'bindings'; bindings: Array<Record<string, string>> }
  | { type: 'boolean'; value: boolean }
  | { type?: undefined; [key: string]: unknown };

export interface PreSignedAuthorAttestationPayload {
  address: string;
  /**
   * OT-RFC-43 Section F2 -- the packed reservedKaId the author signed the
   * AuthorAttestation over, as a decimal string (uint256-safe over JSON).
   * Required: the digest binds it, so the daemon honours the author's
   * reserved slot rather than re-allocating.
   */
  reservedKaId: string;
  signature: { r: string; vs: string };
}

export interface KnowledgeAssetWritableQuad {
  subject: string;
  predicate: string;
  object: string;
  graph?: string;
}

export interface KnowledgeAssetCreateOptions {
  subGraphName?: string;
  quads?: KnowledgeAssetWritableQuad[];
  /**
   * Seal the draft after writing `quads` (default true). `false` keeps an
   * editable WM draft and never touches the chain. Cannot be combined with
   * `alsoShareSwm`/`alsoPublishVm` (those require a sealed assertion).
   */
  finalize?: boolean;
  authorAgentAddress?: string;
  preSignedAuthorAttestation?: PreSignedAuthorAttestationPayload;
  schemeVersion?: number;
  alsoShareSwm?: boolean;
  alsoPublishVm?: boolean | KnowledgeAssetFinalizedPublishOptions;
  awaitCuratorAck?: boolean;
}

export interface KnowledgeAssetCreateResponse {
  name?: string;
  assertionUri?: string;
  status?: string;
  written?: number;
  merkleRoot?: string;
  shareOperationId?: string;
  swmShared?: boolean;
  promotedCount?: number;
  publishReady?: boolean;
  errors?: KnowledgeAssetLifecycleError[];
  [key: string]: unknown;
}

export interface KnowledgeAssetWriteResponse {
  written: number;
}

export interface KnowledgeAssetShareResponse {
  swmShared: boolean;
  promotedCount: number;
  sealed?: boolean;
  publishReady?: boolean;
  shareOperationId?: string;
  errors?: KnowledgeAssetLifecycleError[];
}

export interface KnowledgeAssetShareTargetOptions {
  subGraphName?: string;
  /** @deprecated Atomic sharing always means the complete Knowledge Asset. */
  entities?: 'all';
}

export interface KnowledgeAssetShareOptions extends KnowledgeAssetShareTargetOptions {
  awaitCuratorAck?: boolean;
  skipSeal?: false;
}

export type KnowledgeAssetShareAsyncOptions = KnowledgeAssetShareTargetOptions;

export interface KnowledgeAssetPublishResponse {
  kaId?: string;
  ual?: string;
  txHash?: string;
  status?: string;
  error?: string;
  errors?: KnowledgeAssetLifecycleError[];
  contextGraphError?: unknown;
  [key: string]: unknown;
}

export interface KnowledgeAssetLifecycleError {
  phase?: string;
  code?: string;
  message?: string;
  [key: string]: unknown;
}

export type KnowledgeAssetPublishAsyncResponse = KnowledgeAssetContentEnvelope & {
  jobId: string;
  status: string;
  contextGraphId: string;
  name: string;
  subGraphName?: string;
  shareOperationId?: string;
  sealMerkleRoot?: string;
  intentKey?: string;
  rootsCount?: number;
};

export type KnowledgeAssetShareJobState =
  | 'queued'
  | 'running'
  | 'failed'
  | 'failed_retrying'
  | 'succeeded';

export interface KnowledgeAssetShareJobView {
  jobId: string;
  state: KnowledgeAssetShareJobState;
  contextGraphId: string;
  assertionName: string;
  subGraphName?: string;
  entities: readonly string[] | 'all';
  enqueuedAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  entitiesPromoted?: number;
  attempts: number;
  maxAttempts: number;
  nextRetryAt?: string;
  lastError?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  reason?: string;
}

export interface AssertionCreateResponse extends Record<string, unknown> {
  assertionUri: string;
  written?: number;
  seal?: {
    merkleRoot: string;
    authorAddress: string;
    schemeVersion: number;
    chainId: string;
    kav10Address: string;
    eip712Digest: string;
  };
  promotedCount?: number;
  shareOperationId?: string;
}

function createAlsoPublishVmPayload(value: unknown): boolean | Record<string, unknown> {
  if (typeof value === 'boolean') return value;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (Object.keys(value).length === 0) return {};
    const payload = finalizedPublishOptionsPayload(value as KnowledgeAssetFinalizedPublishOptions);
    if (payload) return payload;
    throw new Error(
      'alsoPublishVm options object must include at least one supported option; use true to publish with defaults',
    );
  }
  throw new Error('alsoPublishVm must be a boolean or publish-options object');
}

function hasOwnKey<K extends PropertyKey>(value: unknown, key: K): value is Record<K, unknown> {
  return value !== null
    && typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, key);
}

function assertSupportedAsyncShareOptions(options: KnowledgeAssetShareAsyncOptions | undefined): void {
  if (hasOwnKey(options, 'skipSeal') && options.skipSeal !== undefined) {
    throw new Error('skipSeal is not supported; graph-scoped Knowledge Assets are always seal-before-share');
  }
  if (hasOwnKey(options, 'awaitCuratorAck') && options.awaitCuratorAck !== undefined) {
    throw new Error('awaitCuratorAck is not supported for async share; use knowledgeAssetShare() when curator acknowledgement must block');
  }
}

function assertAtomicKnowledgeAssetShare(options: unknown): void {
  if (
    hasOwnKey(options, 'entities')
    && options.entities !== undefined
    && options.entities !== 'all'
  ) {
    throw new Error(
      'entities selection is not supported; graph-scoped Knowledge Assets are shared atomically',
    );
  }
}

function atomicKnowledgeAssetSharePayload<T extends object>(options: T | undefined): Omit<T, 'entities'> | undefined {
  assertAtomicKnowledgeAssetShare(options);
  if (!options) return undefined;
  const { entities: _legacyEntities, ...payload } = options as T & { entities?: unknown };
  return payload;
}

function assertionCreateResponse(result: KnowledgeAssetCreateResponse): AssertionCreateResponse {
  if (typeof result.assertionUri !== 'string' || result.assertionUri.length === 0) {
    throw new Error('Knowledge asset create response missing assertionUri for assertion compatibility');
  }
  return { ...result, assertionUri: result.assertionUri };
}

function assertExclusiveAuthorFields(args: {
  authorAgentAddress?: string;
  preSignedAuthorAttestation?: PreSignedAuthorAttestationPayload;
}): void {
  if (args.authorAgentAddress != null && args.preSignedAuthorAttestation != null) {
    throw new Error('authorAgentAddress and preSignedAuthorAttestation are mutually exclusive');
  }
}

function assertCreateFinalizeFieldsHaveQuads(args: {
  quads?: unknown[];
  finalize?: boolean;
  authorAgentAddress?: string;
  preSignedAuthorAttestation?: PreSignedAuthorAttestationPayload;
  schemeVersion?: number;
}): void {
  const hasFinalizeOnlyField =
    args.authorAgentAddress != null ||
    args.preSignedAuthorAttestation != null ||
    args.schemeVersion !== undefined;
  // These fields only take effect at finalize, so they require both non-empty
  // quads AND finalize !== false -- mirrors the daemon create-route guard.
  const willFinalize = Array.isArray(args.quads) && args.quads.length > 0 && args.finalize !== false;
  if (hasFinalizeOnlyField && !willFinalize) {
    throw new Error('authorAgentAddress, preSignedAuthorAttestation, and schemeVersion require non-empty quads and finalize !== false');
  }
}

/**
 * Response shape for `/api/random-sampling/status`. Mirrors
 * `RandomSamplingStatus` from `@origintrail-official/dkg-agent` but
 * lives here so the CLI doesn't take a runtime dep on the agent
 * package (only types). The `loop.lastOutcome` is intentionally
 * `unknown` -- the CLI prints it as JSON; the structured discrimination
 * is the prover's concern, not the CLI's. `disabledReason` distinguishes
 * identity, admission, adapter, and bind failures without a chain call.
 */
export interface RandomSamplingStatusResponse {
  enabled: boolean;
  role: 'core' | 'edge';
  identityId: string;
  /** Optional for compatibility with daemons that predate explicit status reasons. */
  disabledReason?: RandomSamplingDisabledReason | null;
  loop: null | {
    totalTicks: number;
    inflight: boolean;
    lastTickAt: string | null;
    lastOutcome: unknown;
    submittedCount: number;
    lastSubmittedTxHash: string | null;
    lastSubmittedAt: string | null;
  };
}

export interface RelayStatusResponse {
  isCore: boolean;
  reservationsHeld: number;
  reservationCapacity: number | null;
  activeCircuits: number | null;
  bytesIn: string | null;
  bytesOut: string | null;
  natStatus: 'public' | 'private' | 'unknown';
  advertisedAddresses: string[];
  configuredAnnounceAddresses: string[];
}

export interface DaemonStatusResponse {
  name: string;
  peerId: string;
  nodeRole?: string;
  networkConfig?: string;
  networkId?: string;
  networkName?: string | null;
  uptimeMs: number;
  connectedPeers: number;
  relayConnected: boolean;
  multiaddrs: string[];
  relay: RelayStatusResponse;
  chain?: {
    chainId: string | null;
    configured: boolean;
    rpcEndpointCount: number;
    hubConfigured: boolean;
  } | null;
  // Triple-store backend fields (RFC 120). For local backends only
  // `storeBackend` is meaningful; external backends additionally surface
  // `storeUrl` and a TTL-cached `storeQuads` count. `storeQuadsStatus`
  // distinguishes an initial background refresh from an unreachable store.
  // Older daemons omit the status; consumers should retain the legacy
  // `null` = unreachable fallback in that case.
  storeBackend?: string;
  storeUrl?: string | null;
  storeQuads?: number | null;
  storeQuadsStatus?: 'pending' | 'ready' | 'unreachable';
  // Concurrency admission control (PR #1209 limiter, surfaced by #1230):
  // inFlight = requests currently holding a slot, max = effective cap
  // (0 = disabled), rejectedTotal = cumulative 503-shed count since boot.
  // Optional: daemons predating #1230 omit it.
  admission?: {
    inFlight: number;
    max: number;
    rejectedTotal: number;
  };
  // Auto-update status (surfaced by /api/status). Optional — daemons may omit.
  // `updateAvailable` is null until the first check completes;
  // `updateChannelTargetMissing` is true when a pinned auto-update channel has
  // no acceptable target (tag unpublished / prerelease rejected / non-semver).
  updateAvailable?: boolean | null;
  updateChannelTargetMissing?: boolean;
  latestVersion?: string | null;
  latestCommit?: string | null;
}

export interface ApiClientConnectOptions {
  allowConfigFallback?: boolean;
}

const DAEMON_NOT_RUNNING_MESSAGE = 'Daemon is not running. Start it with: dkg start';
const DEFAULT_NODE_NAME = 'dkg-node';

function controlPlaneWarning(missingFiles: string[]): string | undefined {
  if (missingFiles.length === 0) return undefined;
  return `Warning: selected DKG home is missing control-plane file(s): ${missingFiles.join(', ')}. Using configured API port fallback.`;
}

function isAmbiguousFallbackName(name: unknown): boolean {
  return typeof name !== 'string' || name.trim() === '' || name.trim() === DEFAULT_NODE_NAME;
}

function configuredApiBaseUrl(apiHost: unknown, port: number): string {
  const configuredHost = typeof apiHost === 'string' ? apiHost.trim() : '';
  const host = !configuredHost || configuredHost === '0.0.0.0'
    ? '127.0.0.1'
    : configuredHost === '::'
      ? '::1'
      : configuredHost;
  const authority = host.includes(':') ? `[${host}]` : host;
  return `http://${authority}:${port}`;
}

function isConnectionFailure(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if ('httpStatus' in err) return false;
  const name = 'name' in err ? String((err as { name?: unknown }).name) : '';
  const message = 'message' in err ? String((err as { message?: unknown }).message) : '';
  return name === 'TypeError' && /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|terminated/i.test(message);
}

function isDaemonStatusResponse(value: unknown): value is DaemonStatusResponse {
  if (!value || typeof value !== 'object') return false;
  const status = value as Record<string, unknown>;
  return typeof status.name === 'string'
    && typeof status.peerId === 'string'
    && typeof status.uptimeMs === 'number'
    && Number.isFinite(status.uptimeMs)
    && typeof status.connectedPeers === 'number'
    && Number.isFinite(status.connectedPeers)
    && typeof status.relayConnected === 'boolean'
    && Array.isArray(status.multiaddrs)
    && status.multiaddrs.every(addr => typeof addr === 'string');
}

function requireDaemonStatusResponse(value: unknown, expectedName?: string): DaemonStatusResponse {
  if (!isDaemonStatusResponse(value)) {
    throw new Error('Configured API port did not return a DKG daemon status response.');
  }
  if (expectedName && value.name !== expectedName) {
    throw new Error(
      `Configured API port responded as DKG node "${value.name}", expected selected home node "${expectedName}".`,
    );
  }
  return value;
}

export class ApiClient {
  private baseUrl: string;
  private token?: string;
  private expectedStatusName?: string;
  readonly controlPlaneWarning?: string;

  constructor(portOrBaseUrl: number | string, token?: string, opts?: {
    controlPlaneWarning?: string;
    expectedStatusName?: string;
  }) {
    this.baseUrl = typeof portOrBaseUrl === 'number'
      ? `http://127.0.0.1:${portOrBaseUrl}`
      : portOrBaseUrl.replace(/\/+$/, '');
    this.token = token;
    this.expectedStatusName = opts?.expectedStatusName;
    this.controlPlaneWarning = opts?.controlPlaneWarning;
  }

  static async connect(opts: ApiClientConnectOptions = {}): Promise<ApiClient> {
    const hasEnvPort = process.env.DKG_API_PORT !== undefined && process.env.DKG_API_PORT !== '';
    const envPort = hasEnvPort
      ? parseInt(process.env.DKG_API_PORT as string, 10)
      : null;

    const filePort = hasEnvPort ? null : await readApiPort();
    let port = envPort ?? filePort;
    let warning: string | undefined;
    let expectedStatusName: string | undefined;
    let config: Awaited<ReturnType<typeof loadConfig>> | null = null;

    // A persisted api.port contains only the bound port. Pair it with the
    // configured bind host so CLI commands reach daemons bound to a specific
    // non-loopback address. Keep the port usable if config parsing fails.
    if (!hasEnvPort && filePort && configExists()) {
      config = await loadConfig().catch(() => null);
    }

    if (!port) {
      const pid = await readPid();
      if (opts.allowConfigFallback && !hasEnvPort && configExists()) {
        config = config ?? await loadConfig();
        const configuredPort = Number.isFinite(config.apiPort) && config.apiPort > 0 ? config.apiPort : null;
        if (configuredPort && !isAmbiguousFallbackName(config.name)) {
          const missingFiles = ['api.port', ...(pid ? [] : ['daemon.pid'])];
          port = configuredPort;
          expectedStatusName = config.name;
          warning = controlPlaneWarning(missingFiles);
        }
      }
    }

    if (!port) {
      const pid = await readPid();
      if (!pid || !isProcessRunning(pid)) {
        throw new Error(DAEMON_NOT_RUNNING_MESSAGE);
      }
      throw new Error('Cannot read API port. Set DKG_API_PORT or restart: dkg stop && dkg start');
    }

    const tokens = await loadTokens();
    const environmentToken = process.env.DKG_AUTH_TOKEN?.trim();
    const token = environmentToken || (tokens.size > 0 ? tokens.values().next().value : undefined);
    const portOrBaseUrl = !hasEnvPort && config
      ? configuredApiBaseUrl(config.apiHost, port)
      : port;
    return new ApiClient(portOrBaseUrl, token, { controlPlaneWarning: warning, expectedStatusName });
  }

  async status(): Promise<DaemonStatusResponse> {
    let status: unknown;
    try {
      status = await this.get<unknown>('/api/status', { auth: false });
    } catch (err) {
      if (this.expectedStatusName && isConnectionFailure(err)) {
        throw new Error(DAEMON_NOT_RUNNING_MESSAGE);
      }
      throw err;
    }
    return requireDaemonStatusResponse(status, this.expectedStatusName);
  }

  async agents(): Promise<{
    agents: Array<{ agentUri: string; name: string; peerId: string; framework?: string; nodeRole?: string }>;
  }> {
    return this.get('/api/agents');
  }

  /**
   * Mint a fresh workspace encryption key for a custodial local agent and
   * re-publish the agent's profile so peers learn the new key. Pass
   * `retireOld: true` to also revoke the previous default key in the same
   * operation (use only after propagation has settled, or for urgent
   * compromise scenarios). Returns the new key URI plus, optionally, the
   * retired one.
   */
  async rotateAgentEncryptionKey(
    address: string,
    opts: { retireOld?: boolean } = {},
  ): Promise<{
    ok: true;
    newKeyId: string;
    retiredKeyId?: string;
    profilePublished: boolean;
    profilePublishError?: string;
  }> {
    return this.post(
      `/api/agent/${encodeURIComponent(address)}/rotate-encryption-key`,
      opts,
    );
  }

  /**
   * Wallet-sign and publish a revocation for a specific workspace encryption
   * key. Refuses to revoke the agent's last active key; rotate first in that
   * case. Idempotent for already-revoked keys.
   *
   * The response surfaces `profilePublished` + `profilePublishError`; callers
   * MUST treat `profilePublished: false` as a partial failure for revocation
   * (peers still encrypt to the supposedly retired key until profile sync).
   */
  async revokeAgentEncryptionKey(
    address: string,
    keyId: string,
  ): Promise<{
    ok: true;
    revokedKeyId: string;
    revokedAt: string;
    profilePublished: boolean;
    profilePublishError?: string;
  }> {
    return this.post(
      `/api/agent/${encodeURIComponent(address)}/revoke-encryption-key`,
      { keyId },
    );
  }

  /**
   * Re-publish the daemon's default agent profile. This is the retry
   * endpoint for the partial-failure path of rotate/revoke: when
   * local persistence succeeded but the implicit republish errored,
   * the caller fixes the underlying transport / chain issue and
   * retries here. Node-admin token only.
   */
  async publishAgentProfile(): Promise<{ ok: true; ual: string | null }> {
    return this.post('/api/agent/publish-profile', {});
  }

  /**
   * V10 Random Sampling prover snapshot. Cheap; safe to poll. Returns
   * `enabled: false` when the node is ineligible or binding failed
   * (edge node, no identity, awaiting sharding-table admission, etc.).
   * Read `disabledReason` for the exact state; `loop` is then `null`.
   */
  async randomSamplingStatus(): Promise<RandomSamplingStatusResponse> {
    return this.get('/api/random-sampling/status');
  }

  async peerInfo(peerId: string): Promise<{
    peerId: string;
    connected: boolean;
    connectionCount: number;
    transports: string[];
    directions: string[];
    remoteAddrs: Array<string | null>;
    protocols: string[];
    syncCapable: boolean;
    syncStatus?: {
      capable: boolean;
      capability?: 'supported' | 'unsupported' | 'unknown';
      lastSuccessfulSyncAt: number | null;
      stale: boolean;
      backoff: {
        failures: number;
        nextRetryAt: number;
        retryInMs: number;
      } | null;
    };
    lastSeen: number | null;
    latencyMs: number | null;
  }> {
    return this.get(`/api/peer-info?peerId=${encodeURIComponent(peerId)}`);
  }

  async skills(): Promise<{
    skills: Array<{
      agentName: string; skillType: string;
      pricePerCall?: number; currency?: string;
    }>;
  }> {
    return this.get('/api/skills');
  }

  async sendChat(
    to: string,
    text: string,
    opts?: { contextGraphId?: string },
  ): Promise<{ delivered: boolean; error?: string }> {
    return this.post('/api/chat', {
      to,
      text,
      ...(opts?.contextGraphId ? { contextGraphId: opts.contextGraphId } : {}),
    });
  }

  async messages(opts?: {
    peer?: string;
    since?: number;
    sinceId?: number;
    limit?: number;
    direction?: 'in' | 'out';
    order?: 'asc' | 'desc';
  }): Promise<{
    messages: Array<{
      id: number; ts: number; direction: 'in' | 'out';
      peer: string; peerName?: string; text: string;
    }>;
  }> {
    const params = new URLSearchParams();
    if (opts?.peer) params.set('peer', opts.peer);
    if (opts?.since) params.set('since', String(opts.since));
    if (typeof opts?.sinceId === 'number') params.set('sinceId', String(opts.sinceId));
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.direction === 'in' || opts?.direction === 'out') {
      params.set('direction', opts.direction);
    }
    if (opts?.order === 'asc' || opts?.order === 'desc') {
      params.set('order', opts.order);
    }
    const qs = params.toString();
    return this.get(`/api/messages${qs ? '?' + qs : ''}`);
  }

  /**
   * Create an assertion in WM, optionally writing quads + finalizing +
   * promoting in the same call. Maps directly to the extended
   * `POST /api/knowledge-assets` body.
   *
   * RFC-001 Section 9.x -- the assertion lifecycle is the canonical entry
   * point for staging content for VM publish.
   */
  // -- OT-RFC-43 Section 10.5 -- GitHub-shaped Knowledge Asset SDK ------------------
  // Layer-explicit wrappers over /api/knowledge-assets/... (the clean product surface).

  /**
   * Create a KA + open a WM draft. Pass `quads` to write them atomically; by
   * default the draft is also sealed (finalized). Pass `finalize: false` to
   * write a draft WITHOUT sealing -- an editable WM-only assertion that never
   * touches the chain (the only lifecycle available to local-only /
   * on-chain-unregistered CGs).
   */
  async createKnowledgeAsset(
    contextGraphId: string,
    name: string,
    options?: KnowledgeAssetCreateOptions,
  ): Promise<KnowledgeAssetCreateResponse> {
    assertExclusiveAuthorFields(options ?? {});
    assertCreateFinalizeFieldsHaveQuads(options ?? {});
    const payload: Record<string, unknown> = { contextGraphId, name, ...(options ?? {}) };
    if (options?.alsoPublishVm !== undefined) {
      payload.alsoPublishVm = createAlsoPublishVmPayload(options.alsoPublishVm);
    }
    return this.post('/api/knowledge-assets', payload);
  }

  /** GET a KA's lifecycle state by name. */
  async getKnowledgeAsset(contextGraphId: string, name: string, subGraphName?: string, agentAddress?: string): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams({
      contextGraphId,
      ...(subGraphName ? { subGraphName } : {}),
      ...(agentAddress ? { agentAddress } : {}),
    }).toString();
    return this.get(`/api/knowledge-assets/${encodeURIComponent(name)}?${qs}`);
  }

  /** Append quads to the KA's WM draft. */
  async knowledgeAssetWrite(
    contextGraphId: string,
    name: string,
    quads: KnowledgeAssetWritableQuad[],
    options?: { subGraphName?: string },
  ): Promise<KnowledgeAssetWriteResponse> {
    return this.post(`/api/knowledge-assets/${encodeURIComponent(name)}/wm/write`, { contextGraphId, quads, ...(options ?? {}) });
  }

  /** Seal the WM draft (git commit). */
  async knowledgeAssetFinalize(
    contextGraphId: string,
    name: string,
    options?: {
      subGraphName?: string;
      /** @deprecated Only WM finalization is supported. `swm` fails read-only. */
      layer?: 'wm' | 'swm';
      authorAgentAddress?: string;
      preSignedAuthorAttestation?: PreSignedAuthorAttestationPayload;
      schemeVersion?: number;
    },
  ): Promise<{ merkleRoot: string; eip712Digest: string }> {
    if (options?.layer === 'swm') {
      throw new LegacyKnowledgeAssetReadOnlyError();
    }
    // Mirror the mcp-dkg / openclaw / node-ui clients: reject the
    // self-sign vs external-signer conflict client-side instead of relying on
    // the daemon, so every SDK surface enforces the same contract.
    assertExclusiveAuthorFields(options ?? {});
    const wireOptions = { ...(options ?? {}) };
    delete wireOptions.layer;
    return this.post(`/api/knowledge-assets/${encodeURIComponent(name)}/wm/finalize`, { contextGraphId, ...wireOptions });
  }

  /** Discard the WM draft. */
  async knowledgeAssetDiscard(contextGraphId: string, name: string, options?: { subGraphName?: string }): Promise<{ discarded: boolean }> {
    return this.post(`/api/knowledge-assets/${encodeURIComponent(name)}/wm/discard`, { contextGraphId, ...(options ?? {}) });
  }

  /** Seed a fresh WM draft from the file's SWM/VM state (git checkout). */
  async knowledgeAssetPullFrom(
    contextGraphId: string,
    name: string,
    layer: 'swm' | 'vm',
    options?: { subGraphName?: string; onConflict?: 'reject' | 'replace' },
  ): Promise<Record<string, unknown>> {
    return this.post(`/api/knowledge-assets/${encodeURIComponent(name)}/wm/pull-from`, { contextGraphId, layer, ...(options ?? {}) });
  }

  /** Advance the SWM pointer (WM -> SWM; git push origin <branch>). */
  async knowledgeAssetShare(
    contextGraphId: string,
    name: string,
    options?: KnowledgeAssetShareOptions,
  ): Promise<KnowledgeAssetShareResponse> {
    const payload = atomicKnowledgeAssetSharePayload(options);
    if ((options as { skipSeal?: unknown } | undefined)?.skipSeal === true) {
      throw new Error('skipSeal is not supported; graph-scoped Knowledge Assets are always seal-before-share');
    }
    return this.post(`/api/knowledge-assets/${encodeURIComponent(name)}/swm/share`, { contextGraphId, ...(payload ?? {}) });
  }

  async knowledgeAssetShareAsync(
    contextGraphId: string,
    name: string,
    options?: KnowledgeAssetShareAsyncOptions,
  ): Promise<{ jobId: string; state: 'queued' }> {
    assertSupportedAsyncShareOptions(options);
    const payload = atomicKnowledgeAssetSharePayload(options);
    return this.post(`/api/knowledge-assets/${encodeURIComponent(name)}/swm/share-async`, { contextGraphId, ...(payload ?? {}) });
  }

  async knowledgeAssetShareJobs(options?: {
    contextGraphId?: string;
    state?: KnowledgeAssetShareJobState | KnowledgeAssetShareJobState[];
    limit?: number;
  }): Promise<{ jobs: KnowledgeAssetShareJobView[] }> {
    const params = new URLSearchParams();
    if (options?.contextGraphId) params.set('contextGraphId', options.contextGraphId);
    if (options?.state) {
      params.set('state', Array.isArray(options.state) ? options.state.join(',') : options.state);
    }
    if (options?.limit !== undefined) params.set('limit', String(options.limit));
    const qs = params.toString();
    return this.get(`/api/knowledge-assets/swm/share-jobs${qs ? `?${qs}` : ''}`);
  }

  async knowledgeAssetShareJob(jobId: string): Promise<KnowledgeAssetShareJobView> {
    return this.get(`/api/knowledge-assets/swm/share-jobs/${encodeURIComponent(jobId)}`);
  }

  async knowledgeAssetCancelShareJob(jobId: string): Promise<{ jobId: string; state: KnowledgeAssetShareJobState }> {
    return this.del(`/api/knowledge-assets/swm/share-jobs/${encodeURIComponent(jobId)}`);
  }

  async knowledgeAssetRecoverShareJob(jobId: string): Promise<{ jobId: string; state: KnowledgeAssetShareJobState }> {
    return this.post(`/api/knowledge-assets/swm/share-jobs/${encodeURIComponent(jobId)}/recover`, {});
  }

  /** Publish to VM (mint or update on chain; git push origin main). */
  async knowledgeAssetPublish(
    contextGraphId: string,
    name: string,
    options?: { subGraphName?: string } & KnowledgeAssetFinalizedPublishOptions,
  ): Promise<KnowledgeAssetPublishResponse> {
    const { subGraphName, ...finalizedOptions } = options ?? {};
    const publishOptions = finalizedPublishOptionsPayload(finalizedOptions);
    return this.post(`/api/knowledge-assets/${encodeURIComponent(name)}/vm/publish`, {
      contextGraphId,
      ...(subGraphName ? { subGraphName } : {}),
      ...(publishOptions ? { options: publishOptions } : {}),
    });
  }

  async knowledgeAssetPublishAsync(
    contextGraphId: string,
    name: string,
    options?: { subGraphName?: string } & KnowledgeAssetFinalizedPublishOptions,
  ): Promise<KnowledgeAssetPublishAsyncResponse> {
    const { subGraphName, ...finalizedOptions } = options ?? {};
    const publishOptions = finalizedPublishOptionsPayload(finalizedOptions);
    return this.post(`/api/knowledge-assets/${encodeURIComponent(name)}/vm/publish-async`, {
      contextGraphId,
      ...(subGraphName ? { subGraphName } : {}),
      ...(publishOptions ? { options: publishOptions } : {}),
    });
  }

  async createAssertion(
    contextGraphId: string,
    name: string,
    options?: {
      subGraphName?: string;
      quads?: Array<{ subject: string; predicate: string; object: string; graph: string }>;
      finalize?: boolean;
      alsoShareSwm?: boolean;
      authorAgentAddress?: string;
      preSignedAuthorAttestation?: PreSignedAuthorAttestationPayload;
      schemeVersion?: number;
    },
  ): Promise<AssertionCreateResponse> {
    const result = await this.createKnowledgeAsset(
      contextGraphId,
      name,
      options,
    );
    return assertionCreateResponse(result);
  }

  /**
   * Append quads to an existing WM assertion. Wraps
   * `POST /api/knowledge-assets/:name/wm/write`. Used by batched ingest paths
   * (e.g. `dkg index`) that materialize a single named assertion
   * across many round-trips before finalize.
   */
  async appendToAssertion(
    contextGraphId: string,
    name: string,
    quads: Array<{ subject: string; predicate: string; object: string; graph: string }>,
    options?: { subGraphName?: string },
  ): Promise<{ written: number }> {
    return this.post(`/api/knowledge-assets/${encodeURIComponent(name)}/wm/write`, {
      contextGraphId,
      quads,
      ...(options?.subGraphName ? { subGraphName: options.subGraphName } : {}),
    });
  }

  /**
   * Finalize a previously-created assertion. RFC-001 Section 9.x -- computes
   * the canonical merkleRoot, builds the EIP-712 AuthorAttestation,
   * signs (custodial / pre-signed / publisher fallback), and stamps
   * the seal triples to `_meta`.
   */
  async finalizeAssertion(
    contextGraphId: string,
    name: string,
    options?: {
      subGraphName?: string;
      authorAgentAddress?: string;
      preSignedAuthorAttestation?: PreSignedAuthorAttestationPayload;
      schemeVersion?: number;
    },
  ): Promise<{
    assertionUri: string;
    merkleRoot: string;
    authorAddress: string;
    schemeVersion: number;
    chainId: string;
    kav10Address: string;
    eip712Digest: string;
  }> {
    return this.post(
      `/api/knowledge-assets/${encodeURIComponent(name)}/wm/finalize`,
      {
        contextGraphId,
        ...(options?.subGraphName ? { subGraphName: options.subGraphName } : {}),
        ...(options?.authorAgentAddress
          ? { authorAgentAddress: options.authorAgentAddress }
          : {}),
        ...(options?.preSignedAuthorAttestation
          ? { preSignedAuthorAttestation: options.preSignedAuthorAttestation }
          : {}),
        ...(options?.schemeVersion !== undefined
          ? { schemeVersion: options.schemeVersion }
          : {}),
      },
    );
  }

  /**
   * Publish a previously-finalized assertion to the verifiable-memory
   * chain. The seal in `_meta` (written by `finalizeAssertion`)
   * supplies the AuthorAttestation; the publisher forwards it
   * verbatim and never re-signs.
   *
   * Pre-condition: the assertion must be both finalized AND promoted
   * to SWM. The high-level `publishAssertion` helper handles the
   * whole sequence in one call.
   *
   * Routes to the canonical per-KA publish `POST
   * /api/knowledge-assets/:name/vm/publish` (the URL name selects the
   * assertion). Kept as a thin wrapper over `knowledgeAssetPublish` so
   * lifecycle callers (`dkg publisher publish-async`, `dkg index`,
   * `publishAssertion`) keep a narrow typed return.
   */
  async publishFromFinalizedAssertion(
    contextGraphId: string,
    assertionName: string,
    options?: {
      subGraphName?: string;
      clearAfter?: boolean;
      publishEpochs?: number;
      publisherNodeIdentityIdOverride?: bigint;
    },
  ): Promise<{
    kaId: string;
    status: 'tentative' | 'confirmed';
    assertionUri: string;
    authorAddress: string;
    merkleRoot: string;
    kas: Array<{ tokenId: string; rootEntity: string }>;
    txHash?: string;
    blockNumber?: number;
    contextGraphError?: string;
  }> {
    return this.knowledgeAssetPublish(contextGraphId, assertionName, options) as Promise<{
      kaId: string;
      status: 'tentative' | 'confirmed';
      assertionUri: string;
      authorAddress: string;
      merkleRoot: string;
      kas: Array<{ tokenId: string; rootEntity: string }>;
      txHash?: string;
      blockNumber?: number;
      contextGraphError?: string;
    }>;
  }

  /**
   * High-level convenience: create -> write -> finalize -> promote ->
   * publish, all in two HTTP round-trips. The composite mirrors what
   * a typical OpenClaw/Hermes client does -- stage content, commit it,
   * push it on-chain. Use this unless you need fine-grained control
   * over the individual steps.
   */
  async publishAssertion(
    contextGraphId: string,
    name: string,
    quads: Array<{ subject: string; predicate: string; object: string; graph: string }>,
    options?: {
      subGraphName?: string;
      authorAgentAddress?: string;
      preSignedAuthorAttestation?: PreSignedAuthorAttestationPayload;
      schemeVersion?: number;
      clearAfter?: boolean;
      publishEpochs?: number;
      publisherNodeIdentityIdOverride?: bigint;
    },
  ): Promise<{
    assertionUri: string;
    kaId: string;
    status: 'tentative' | 'confirmed';
    authorAddress: string;
    merkleRoot: string;
    kas: Array<{ tokenId: string; rootEntity: string }>;
    txHash?: string;
    blockNumber?: number;
  }> {
    const created = await this.createAssertion(contextGraphId, name, {
      ...(options?.subGraphName ? { subGraphName: options.subGraphName } : {}),
      quads,
      finalize: true,
      alsoShareSwm: true,
      ...(options?.authorAgentAddress
        ? { authorAgentAddress: options.authorAgentAddress }
        : {}),
      ...(options?.preSignedAuthorAttestation
        ? { preSignedAuthorAttestation: options.preSignedAuthorAttestation }
        : {}),
      ...(options?.schemeVersion !== undefined
        ? { schemeVersion: options.schemeVersion }
        : {}),
    });
    const published = await this.publishFromFinalizedAssertion(
      contextGraphId,
      name,
      {
        ...(options?.subGraphName ? { subGraphName: options.subGraphName } : {}),
        ...(options?.clearAfter !== undefined
          ? { clearAfter: options.clearAfter }
          : {}),
        ...(options?.publishEpochs !== undefined
          ? { publishEpochs: options.publishEpochs }
          : {}),
        ...(options?.publisherNodeIdentityIdOverride !== undefined
          ? { publisherNodeIdentityIdOverride: options.publisherNodeIdentityIdOverride }
          : {}),
      },
    );
    return {
      assertionUri: created.assertionUri,
      kaId: published.kaId,
      status: published.status,
      authorAddress: published.authorAddress,
      merkleRoot: published.merkleRoot,
      kas: published.kas,
      ...(published.txHash !== undefined ? { txHash: published.txHash } : {}),
      ...(published.blockNumber !== undefined
        ? { blockNumber: published.blockNumber }
        : {}),
    };
  }

  // --- Publishing Conviction Account (PCA) ----------------------------

  async createPca(request: {
    tokens: string;
    // OT-RFC-51: the node identityId this PCA's committed TRAC funds. Required
    // -- a PCA created with no node seeds publishing allocation to nobody.
    primaryNode: string;
  }): Promise<{
    accountId: string;
    txHash: string;
    blockNumber: number;
    committedTokens: string;
  }> {
    return this.post('/api/pca', request);
  }

  async deregisterPcaAgent(accountId: string, agent: string): Promise<{
    accountId: string;
    agent: string;
    deregistered: boolean;
    txHash: string;
    blockNumber: number;
  }> {
    return this.del(
      `/api/pca/${encodeURIComponent(accountId)}/agent/${encodeURIComponent(agent)}`,
    );
  }

  async settlePca(accountId: string): Promise<{
    accountId: string;
    settled: boolean;
    txHash: string;
    blockNumber: number;
  }> {
    return this.post(`/api/pca/${encodeURIComponent(accountId)}/settle`, {});
  }

  async addPcaFunds(accountId: string, tokens: string): Promise<{
    accountId: string;
    addedTokens: string;
    txHash: string;
    blockNumber: number;
  }> {
    return this.post(`/api/pca/${encodeURIComponent(accountId)}/funds`, { tokens });
  }

  // The client is the version-skew boundary: it posts, then PARSES + normalizes
  // the raw JSON (validated at runtime, not just cast) into a stable
  // `{ registered, advisory }` result — so callers render directly and a
  // malformed/incoherent wire shape fails loudly here rather than mis-rendering.
  async registerPcaAgent(accountId: string, agent: string): Promise<RegisterPcaAgentResult> {
    const raw = await this.post<unknown>(`/api/pca/${encodeURIComponent(accountId)}/agent`, { agent });
    return parseRegisterPcaAgentResult(raw);
  }

  async getPcaInfo(accountId: string, probeKey?: string): Promise<{
    accountId: string;
    owner: string;
    committedTRAC: string;
    committedTRACTrac: string;
    baseEpochAllowance: string;
    topUpBuffer: string;
    topUpBufferTrac: string;
    createdAtEpoch: number;
    expiresAtEpoch: number;
    createdAtTimestamp: number;
    expiresAtTimestamp: number;
    discountBps: number;
    agentCount: number;
    lastSettledWindow: number;
    fullySwept: boolean;
    // OT-RFC-51 node association (string uint72; '0' = unset).
    primaryNode?: string;
    probedKey?: { key: string; registered: boolean; adapterSupported?: boolean; error?: string };
  }> {
    const qs = probeKey ? `?key=${encodeURIComponent(probeKey)}` : '';
    return this.get(`/api/pca/${encodeURIComponent(accountId)}${qs}`);
  }

  /**
   * List the PCAs owned by this node's operational wallet, each annotated with
   * its OT-RFC-51 `primaryNode` association and whether it funds this node.
   */
  async listPcas(): Promise<{
    accounts: Array<{
      accountId: string;
      owner: string;
      committedTRAC: string;
      committedTRACTrac: string;
      baseEpochAllowance: string;
      topUpBuffer: string;
      topUpBufferTrac: string;
      createdAtEpoch: number;
      expiresAtEpoch: number;
      createdAtTimestamp: number;
      expiresAtTimestamp: number;
      discountBps: number;
      agentCount: number;
      lastSettledWindow: number;
      fullySwept: boolean;
      primaryNode?: string;
      fundsThisNode?: boolean;
    }>;
  }> {
    return this.get('/api/pca');
  }

  /** OT-RFC-51 owner-gated re-designation of the node a PCA funds. */
  async setPcaPrimaryNode(accountId: string, node: string): Promise<{
    accountId: string;
    primaryNode: string;
    txHash: string;
    blockNumber: number;
  }> {
    return this.post(`/api/pca/${encodeURIComponent(accountId)}/primary-node`, { node });
  }

  // ─── Node operational wallets (Identity operational keys) ────────────

  /** List the node's local operational wallets (addresses only) + on-chain status. */
  async listOperationalWallets(): Promise<{
    identityId: string;
    hasProfile: boolean;
    adminKeyConfigured: boolean;
    canManage: boolean;
    wallets: Array<{
      address: string;
      isAdmin: boolean;
      isPrimary: boolean;
      registered: boolean | null;
    }>;
  }> {
    return this.get('/api/operational-wallets');
  }

  /** Authorize an address as an operational key on the node identity (admin-signed). */
  async addOperationalWallet(address: string): Promise<{
    address: string;
    added: boolean;
    txHash: string;
    blockNumber: number;
  }> {
    return this.post('/api/operational-wallets', { address });
  }

  /** De-authorize an operational key (admin-signed); refuses the primary wallet. */
  async removeOperationalWallet(address: string): Promise<{
    address: string;
    removed: boolean;
    txHash: string;
    blockNumber: number;
  }> {
    return this.del(`/api/operational-wallets/${encodeURIComponent(address)}`);
  }

  /** List a local agent's workspace encryption keys (public fields only). */
  async getAgentEncryptionKeys(address: string): Promise<{
    agentAddress: string;
    agentDid: string;
    keys: Array<{
      encryptionKeyId: string;
      encryptionKeyAlgorithm: string;
      publicEncryptionKey: string;
      encryptionKeyProof: string;
      createdAt: string;
      revokedAt: string | null;
      status: 'active' | 'revoked';
    }>;
  }> {
    return this.get(`/api/agent/${encodeURIComponent(address)}/encryption-keys`);
  }

  async publisherJobs(status?: string): Promise<{ jobs: any[] }> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    return this.get(`/api/publisher/jobs${qs}`);
  }

  async publisherJob(jobId: string): Promise<{ job: any }> {
    return this.get(`/api/publisher/job?id=${encodeURIComponent(jobId)}`);
  }

  async publisherJobPayload(jobId: string): Promise<{ job: any; payload: any }> {
    return this.get(`/api/publisher/job-payload?id=${encodeURIComponent(jobId)}`);
  }

  async publisherStats(): Promise<Record<string, number>> {
    return this.get('/api/publisher/stats');
  }

  async publisherCancel(jobId: string): Promise<{ cancelled: string }> {
    return this.post('/api/publisher/cancel', { jobId });
  }

  async publisherRetry(status: 'failed' = 'failed'): Promise<{ retried: number }> {
    return this.post('/api/publisher/retry', { status });
  }

  async publisherClear(status: 'failed' | 'finalized'): Promise<{ cleared: number; status: 'failed' | 'finalized' }> {
    return this.post('/api/publisher/clear', { status });
  }

  // ------------------------- EPCIS -------------------------------------

  async captureEpcis(request: {
    epcisDocument: unknown;
    contextGraphId?: string;
    subGraphName?: string;
    publishOptions?: {
      accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
      allowedPeers?: string[];
    };
  }): Promise<{
    captureID: string;
    receivedAt: string;
    eventCount: number;
    status: 'accepted';
  }> {
    return this.post('/api/epcis/capture', request);
  }

  async getEpcisCapture(captureID: string): Promise<{
    captureID: string;
    state: 'accepted' | 'claimed' | 'validated' | 'broadcast' | 'included' | 'finalized' | 'failed';
    receivedAt: string;
    finalizedAt: string | null;
    error: string | null;
  }> {
    return this.get(`/api/epcis/capture/${encodeURIComponent(captureID)}`);
  }

  async queryEpcisEvents(params: {
    contextGraphId?: string;
    subGraphName?: string;
    finalized?: boolean;
    epc?: string;
    bizStep?: string;
    bizLocation?: string;
    from?: string;
    to?: string;
    eventID?: string;
    eventType?: string;
    action?: string;
    disposition?: string;
    readPoint?: string;
    parentID?: string;
    childEPC?: string;
    inputEPC?: string;
    outputEPC?: string;
    anyEPC?: string;
    configurationId?: string;
    shipmentId?: string;
    perPage?: number;
    nextPageToken?: string;
  } = {}): Promise<{
    body: unknown;
    nextPageUrl: string | null;
  }> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      search.set(key, String(value));
    }
    const qs = search.toString();
    return this.queryEpcisEventsByPath(`/api/epcis/events${qs ? `?${qs}` : ''}`);
  }

  async queryEpcisEventsByPath(path: string): Promise<{
    body: unknown;
    nextPageUrl: string | null;
  }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw ApiClient.httpError(res.status, ApiClient.errorMessageFromBody(body, res.statusText), body);
    }
    const body = (await res.json()) as unknown;
    const linkHeader = res.headers.get('Link') ?? res.headers.get('link');
    const nextPageUrl = parseNextLink(linkHeader);
    return { body, nextPageUrl };
  }

  /**
   * Run SPARQL via the daemon. `opts` covers the full /api/query surface --
   * memory-layer routing (`view`, `graphSuffix`, `verifiedGraph`,
   * `subGraphName`, `includeSharedMemory`, `includeContextGraphPartitions`,
   * `agentAddress`, `assertionName`), and P-13's `minTrust` (only meaningful
   * on `view: "verifiable-memory"`; ignored elsewhere). `contextGraphId` stays
   * in the 2nd positional slot for backwards compatibility.
   */
  async query(
    sparql: string,
    contextGraphId?: string,
    opts?: {
      graphSuffix?: string;
      includeSharedMemory?: boolean;
      includeContextGraphPartitions?: boolean;
      view?: 'working-memory' | 'shared-working-memory' | 'verifiable-memory';
      agentAddress?: string;
      assertionName?: string;
      subGraphName?: string;
      verifiedGraph?: string;
      minTrust?:
        | 'SelfAttested'
        | 'Endorsed'
        | 'PartiallyVerified'
        | 'ConsensusVerified'
        | 0
        | 1
        | 2
        | 3;
    },
  ): Promise<{ result: QueryResult }> {
    return this.post('/api/query', {
      sparql,
      contextGraphId,
      graphSuffix: opts?.graphSuffix,
      includeSharedMemory: opts?.includeSharedMemory,
      includeContextGraphPartitions: opts?.includeContextGraphPartitions,
      view: opts?.view,
      agentAddress: opts?.agentAddress,
      assertionName: opts?.assertionName,
      subGraphName: opts?.subGraphName,
      verifiedGraph: opts?.verifiedGraph,
      minTrust: opts?.minTrust,
    });
  }

  async readQueryCatalog(contextGraphId: string): Promise<{ result: QueryResult }> {
    return this.post('/api/profile/query-catalog/read', { contextGraphId });
  }

  async queryRemote(peerId: string, request: {
    lookupType: string;
    contextGraphId?: string;
    ual?: string;
    entityUri?: string;
    rdfType?: string;
    sparql?: string;
    limit?: number;
    timeout?: number;
  }): Promise<{
    operationId: string;
    status: string;
    ntriples?: string;
    bindings?: string;
    entityUris?: string[];
    truncated: boolean;
    resultCount: number;
    gasConsumed?: number;
    error?: string;
  }> {
    return this.post('/api/query-remote', { peerId, ...request });
  }

  async subscribeToContextGraph(contextGraphId: string, options?: { includeSharedMemory?: boolean }): Promise<{
    subscribed: string;
    catchup?:
      | {
        connectedPeers: number;
        totalPeers?: number;
        selectedPeers?: number;
        syncCapablePeers: number;
        peersTried: number;
        peersResponded: number;
        peersSucceeded: number;
        deferredBackpressure: number;
        dataSynced: number;
        sharedMemorySynced: number;
        denied: boolean;
        deniedPeers: number;
        diagnostics?: {
          noProtocolPeers: number;
          durable: {
            fetchedMetaTriples: number;
            fetchedDataTriples: number;
            insertedMetaTriples: number;
            insertedDataTriples: number;
            bytesReceived: number;
            resumedPhases: number;
            timedOutPhases: number;
            completedPhases: number;
            checkpointAdvances: number;
            emptyResponses: number;
            metaOnlyResponses: number;
            dataRejectedMissingMeta: number;
            rejectedKcs: number;
            failedPeers: number;
            failedPhases: number;
            deferredBackpressure: number;
          };
          sharedMemory: {
            fetchedMetaTriples: number;
            fetchedDataTriples: number;
            insertedMetaTriples: number;
            insertedDataTriples: number;
            bytesReceived: number;
            resumedPhases: number;
            timedOutPhases: number;
            completedPhases: number;
            checkpointAdvances: number;
            emptyResponses: number;
            droppedDataTriples: number;
            failedPeers: number;
            failedPhases: number;
            deferredBackpressure: number;
          };
        };
      }
      | {
        status: 'queued';
        includeWorkspace: boolean;
        jobId: string;
      };
  }> {
    return this.post('/api/context-graph/subscribe', { contextGraphId, includeWorkspace: options?.includeSharedMemory });
  }

  /**
   * Reconcile one context graph against its on-chain registration watermark.
   * A current graph returns without starting VM-slice or peer catch-up work.
   */
  async reconcileContextGraph(contextGraphId: string): Promise<ContextGraphReconcileResult> {
    return this.post('/api/context-graph/reconcile', { contextGraphId });
  }

  /** @deprecated Use subscribeToContextGraph */
  async subscribe(contextGraphId: string, options?: { includeWorkspace?: boolean }): Promise<{
    subscribed: string;
    catchup?:
      | {
        connectedPeers: number;
        totalPeers?: number;
        selectedPeers?: number;
        syncCapablePeers: number;
        peersTried: number;
        peersResponded: number;
        peersSucceeded: number;
        deferredBackpressure: number;
        dataSynced: number;
        sharedMemorySynced: number;
        denied: boolean;
        deniedPeers: number;
        diagnostics?: {
          noProtocolPeers: number;
          durable: {
            fetchedMetaTriples: number;
            fetchedDataTriples: number;
            insertedMetaTriples: number;
            insertedDataTriples: number;
            bytesReceived: number;
            resumedPhases: number;
            timedOutPhases: number;
            completedPhases: number;
            checkpointAdvances: number;
            emptyResponses: number;
            metaOnlyResponses: number;
            dataRejectedMissingMeta: number;
            rejectedKcs: number;
            failedPeers: number;
            failedPhases: number;
            deferredBackpressure: number;
          };
          sharedMemory: {
            fetchedMetaTriples: number;
            fetchedDataTriples: number;
            insertedMetaTriples: number;
            insertedDataTriples: number;
            bytesReceived: number;
            resumedPhases: number;
            timedOutPhases: number;
            completedPhases: number;
            checkpointAdvances: number;
            emptyResponses: number;
            droppedDataTriples: number;
            failedPeers: number;
            failedPhases: number;
            deferredBackpressure: number;
          };
        };
      }
      | {
        status: 'queued';
        includeWorkspace: boolean;
        jobId: string;
      };
  }> {
    return this.subscribeToContextGraph(contextGraphId, { includeSharedMemory: options?.includeWorkspace });
  }

  async catchupStatus(contextGraphId: string): Promise<{
    jobId: string;
    contextGraphId: string;
    includeWorkspace: boolean;
    status: 'queued' | 'running' | 'done' | 'denied' | 'deferred' | 'failed' | 'unreachable';
    queuedAt: number;
    startedAt?: number;
    finishedAt?: number;
    result?: {
      connectedPeers: number;
      totalPeers?: number;
      selectedPeers?: number;
      syncCapablePeers: number;
      peersTried: number;
      peersResponded: number;
      peersSucceeded: number;
      deferredBackpressure: number;
      dataSynced: number;
      sharedMemorySynced: number;
      denied: boolean;
      deniedPeers: number;
      diagnostics?: {
        noProtocolPeers: number;
        durable: {
          fetchedMetaTriples: number;
          fetchedDataTriples: number;
          insertedMetaTriples: number;
          insertedDataTriples: number;
          bytesReceived: number;
          resumedPhases: number;
          timedOutPhases: number;
          completedPhases: number;
          checkpointAdvances: number;
          emptyResponses: number;
          metaOnlyResponses: number;
          dataRejectedMissingMeta: number;
          rejectedKcs: number;
          failedPeers: number;
          failedPhases: number;
          deferredBackpressure: number;
        };
        sharedMemory: {
          fetchedMetaTriples: number;
          fetchedDataTriples: number;
          insertedMetaTriples: number;
          insertedDataTriples: number;
          bytesReceived: number;
          resumedPhases: number;
          timedOutPhases: number;
          completedPhases: number;
          checkpointAdvances: number;
          emptyResponses: number;
          droppedDataTriples: number;
          failedPeers: number;
          failedPhases: number;
          deferredBackpressure: number;
        };
      };
    };
    error?: string;
  }> {
    return this.get(`/api/sync/catchup-status?contextGraphId=${encodeURIComponent(contextGraphId)}`);
  }

  async connect(multiaddr: string): Promise<{ connected: boolean }> {
    return this.post('/api/connect', { multiaddr });
  }

  /**
   * V10 DHT-based dial: hand the daemon a peer id, and it resolves the
   * peer's current multiaddrs via libp2p Kademlia
   * (`peerRouting.findPeer`) before dialling. Used by invites that carry
   * only a peer id so they survive relay rotations.
   */
  async connectByPeerId(peerId: string): Promise<{ connected: boolean }> {
    return this.post('/api/connect', { peerId });
  }

  async createContextGraph(id: string, name: string, description?: string, options?: {
    private?: boolean;
    accessPolicy?: number;
    allowedAgents?: string[];
    participantAgents?: string[];
    /**
     * Atomic combined-flow flag. When `true`, the daemon registers the
     * CG on-chain in the same call after the local create step
     * succeeds. Required when `pcaAccountId` is supplied (a standalone
     * `createContextGraph` does NOT persist PCA ids -- Codex PR #502
     * round-3).
     */
    register?: boolean;
    /**
     * Publish policy override forwarded to `registerContextGraph` in
     * the combined-flow path. Only meaningful together with
     * `register: true`. The agent otherwise defaults
     * `publishPolicy = curated (0)` for curated/private CGs and
     * `publishPolicy = open (1)` for public CGs -- which makes the
     * valid `{ accessPolicy: 0 (public), publishPolicy: 0 (curated),
     * pcaAccountId }` combo unreachable unless the caller can pin
     * `publishPolicy` explicitly. Codex PR #502 round-10 (raised by
     * @branarakic).
     */
    publishPolicy?: number;
    /**
     * Publishing Conviction Account id for PCA-curated registration.
     * Only meaningful together with `register: true`. The daemon
     * rejects the create-only-with-pcaAccountId combo with a 400
     * (Codex PR #502 round-5). For a two-step flow, use
     * {@link registerContextGraph} instead.
     */
    pcaAccountId?: string | number | bigint;
  }, allowedPeers?: string[]): Promise<{
    created: string;
    uri: string;
    /** Present only when caller passed `register: true`. */
    registered?: boolean;
    onChainId?: string;
    /** Present when `register: true` was requested but the register leg failed. */
    registerError?: string;
    hint?: string;
  }> {
    return this.post('/api/context-graph/create', {
      id,
      name,
      description,
      ...(allowedPeers?.length ? { allowedPeers } : {}),
      ...(options?.accessPolicy != null ? { accessPolicy: options.accessPolicy } : {}),
      ...(options?.allowedAgents?.length ? { allowedAgents: options.allowedAgents } : {}),
      ...(options?.participantAgents?.length ? { participantAgents: options.participantAgents } : {}),
      ...(options?.private ? { private: true } : {}),
      ...(options?.register === true ? { register: true } : {}),
      ...(options?.publishPolicy != null ? { publishPolicy: options.publishPolicy } : {}),
      ...(options?.pcaAccountId != null ? { pcaAccountId: options.pcaAccountId.toString() } : {}),
    });
  }

  async createSubGraph(contextGraphId: string, subGraphName: string): Promise<{
    created: string;
    contextGraphId: string;
  }> {
    return this.post('/api/sub-graph/create', { contextGraphId, subGraphName });
  }

  async registerContextGraph(id: string, opts?: {
    /** @deprecated V10 ContextGraphs registration ignores metadata reveal. */
    revealOnChain?: boolean;
    accessPolicy?: number;
    publishPolicy?: number;
    pcaAccountId?: string | number | bigint;
  }): Promise<{
    registered: string;
    onChainId: string;
    hint?: string;
  }> {
    return this.post('/api/context-graph/register', {
      id,
      ...(opts?.accessPolicy != null ? { accessPolicy: opts.accessPolicy } : {}),
      ...(opts?.publishPolicy != null ? { publishPolicy: opts.publishPolicy } : {}),
      ...(opts?.pcaAccountId != null ? { pcaAccountId: opts.pcaAccountId.toString() } : {}),
    });
  }

  /** @deprecated Use addAgent instead. */
  async inviteToContextGraph(contextGraphId: string, peerId: string): Promise<{
    invited: string;
    contextGraphId: string;
  }> {
    return this.post('/api/context-graph/invite', { contextGraphId, peerId });
  }

  async addAgent(contextGraphId: string, agentAddress: string): Promise<{
    ok: boolean;
    contextGraphId: string;
    agentAddress: string;
  }> {
    return this.post(`/api/context-graph/${encodeURIComponent(contextGraphId)}/add-participant`, { agentAddress });
  }

  async removeAgent(contextGraphId: string, agentAddress: string): Promise<{
    ok: boolean;
    contextGraphId: string;
    agentAddress: string;
  }> {
    return this.post(`/api/context-graph/${encodeURIComponent(contextGraphId)}/remove-participant`, { agentAddress });
  }

  async listAgents(contextGraphId: string): Promise<{
    contextGraphId: string;
    allowedAgents: string[];
  }> {
    return this.get(`/api/context-graph/${encodeURIComponent(contextGraphId)}/participants`);
  }

  /**
   * Sign-only join request. Returns the `SignedAgentDelegation` that
   * the local agent produced; does NOT forward over P2P. To deliver it
   * to the curator, follow up with `requestJoin(...)` and the
   * `curatorPeerId` from the V10 invite. PR #448 split sign vs forward
   * to fix a duplicate-forward bug -- see daemon route comment.
   *
   * The `delegation` shape mirrors `SignedAgentDelegation` from
   * `@dkg/agent`: `version` is part of the digest grammar (see
   * `computeDelegationDigest`), not the on-the-wire payload, so it is
   * intentionally absent here. Verifiers re-derive the digest from the
   * fields below.
   */
  async signJoinRequest(contextGraphId: string): Promise<{
    ok: boolean;
    contextGraphId: string;
    delegation: {
      agentAddress: string;
      scope: string;
      issuedAtMs: number;
      expiresAtMs: number;
      delegateePeerId?: string;
      delegateeOpKey?: string;
      signature: string;
    };
    agentAddress: string;
  }> {
    return this.post(`/api/context-graph/${encodeURIComponent(contextGraphId)}/sign-join`, {});
  }

  /**
   * Forward a previously-signed join delegation to the curator over
   * P2P. The daemon dials `curatorPeerId` directly (DHT-resolved if
   * not currently connected). Returns the delivery count so callers can detect
   * "no curator reachable" without inspecting log output.
   */
  async requestJoin(
    contextGraphId: string,
    delegation: unknown,
    curatorPeerId: string,
    agentName?: string,
  ): Promise<{
    ok: boolean;
    status: string;
    delivered: number | 'local';
    alreadyMember?: boolean;
    autoApproved?: boolean;
  }> {
    return this.post(
      `/api/context-graph/${encodeURIComponent(contextGraphId)}/request-join`,
      { delegation, curatorPeerId, ...(agentName ? { agentName } : {}) },
    );
  }

  async approveJoin(contextGraphId: string, agentAddress: string): Promise<{
    ok: boolean;
    status: string;
    agentAddress: string;
  }> {
    return this.post(`/api/context-graph/${encodeURIComponent(contextGraphId)}/approve-join`, { agentAddress });
  }

  async rejectJoin(contextGraphId: string, agentAddress: string): Promise<{
    ok: boolean;
    status: string;
    agentAddress: string;
  }> {
    return this.post(`/api/context-graph/${encodeURIComponent(contextGraphId)}/reject-join`, { agentAddress });
  }

  async listJoinRequests(contextGraphId: string): Promise<{
    contextGraphId: string;
    requests: Array<{
      agentAddress: string;
      status: string;
      timestamp?: string;
      agentName?: string;
    }>;
  }> {
    return this.get(`/api/context-graph/${encodeURIComponent(contextGraphId)}/join-requests`);
  }

  async getContextGraphJoinPolicy(contextGraphId: string): Promise<ContextGraphJoinPolicyResponse> {
    return this.get(`/api/context-graph/${encodeURIComponent(contextGraphId)}/join-policy`);
  }

  async setContextGraphJoinPolicy(
    contextGraphId: string,
    update: ContextGraphJoinPolicyUpdate,
  ): Promise<ContextGraphJoinPolicyResponse> {
    return this.put(`/api/context-graph/${encodeURIComponent(contextGraphId)}/join-policy`, update);
  }

  async getAgentIdentity(): Promise<{
    agentAddress: string;
    agentDid: string;
    name: string;
    peerId: string;
  }> {
    return this.get('/api/agent/identity');
  }

  async listContextGraphs(): Promise<{
    contextGraphs: Array<{
      id: string;
      uri: string;
      name: string;
      description?: string;
      creator?: string;
      createdAt?: string;
      isSystem: boolean;
      subscribed?: boolean;
      synced?: boolean;
      curator?: string;
      accessPolicy?: string;
      callerInvolved?: boolean;
    }>;
  }> {
    return this.get('/api/context-graph/list');
  }

  async contextGraphExists(id: string): Promise<{ id: string; exists: boolean }> {
    return this.get(`/api/context-graph/exists?id=${encodeURIComponent(id)}`);
  }

  async verify(request: {
    contextGraphId: string;
    verifiableMemoryId: string;
    batchId: string;
    timeoutMs?: number;
    requiredSignatures?: number;
  }): Promise<{
    txHash?: string;
    blockNumber?: number;
    verifiableMemoryId: string;
    signers: string[];
    status?: 'verified' | 'partial' | 'no_quorum';
    trustLevel?: number;
  }> {
    return this.post('/api/verify', request);
  }

  async endorse(request: {
    contextGraphId: string;
    ual: string;
    /**
     * Optional. If supplied it MUST match the address resolved from
     * the bearer token; the daemon rejects any mismatch with 403.
     * Prefer omitting and relying on the token -- see A-12 review on
     * /api/endorse for the provenance-forgery rationale.
     */
    agentAddress?: string;
  }): Promise<{ endorsed: boolean; endorserAddress: string }> {
    return this.post('/api/endorse', request);
  }

  async importAssertionFile(name: string, request: {
    filePath: string;
    contextGraphId: string;
    contentType?: string;
    ontologyRef?: string;
    subGraphName?: string;
  }): Promise<{
    assertionUri: string;
    fileHash: string;
    detectedContentType?: string;
    extraction?: {
      status: string;
      tripleCount?: number;
      pipelineUsed?: string;
      mdIntermediateHash?: string;
      error?: string;
    };
  }> {
    const fileBytes = await readFile(request.filePath);
    const form = new FormData();
    const contentType = request.contentType ?? inferUploadContentType(request.filePath);
    const file = contentType
      ? new Blob([fileBytes], { type: contentType })
      : new Blob([fileBytes]);

    form.append('file', file, basename(request.filePath));
    form.append('contextGraphId', request.contextGraphId);
    if (request.contentType) form.append('contentType', request.contentType);
    if (request.ontologyRef) form.append('ontologyRef', request.ontologyRef);
    if (request.subGraphName) form.append('subGraphName', request.subGraphName);

    return this.postForm(`/api/knowledge-assets/${encodeURIComponent(name)}/wm/import-file`, form);
  }

  async assertionExtractionStatus(name: string, contextGraphId: string, subGraphName?: string): Promise<{
    assertionUri?: string;
    fileHash?: string;
    status?: string;
    tripleCount?: number;
    pipelineUsed?: string;
    mdIntermediateHash?: string;
    error?: string;
  }> {
    const params = new URLSearchParams({ contextGraphId });
    if (subGraphName) params.set('subGraphName', subGraphName);
    return this.get(
      `/api/knowledge-assets/${encodeURIComponent(name)}/wm/extraction-status?${params.toString()}`,
    );
  }

  async promoteAssertion(name: string, request: {
    contextGraphId: string;
    /** @deprecated Atomic sharing always means the complete Knowledge Asset. */
    entities?: 'all';
    subGraphName?: string;
  }): Promise<{
    promoted?: boolean;
    swmShared?: boolean;
    promotedCount?: number;
    contextGraphId?: string;
    count?: number;
    sharedMemoryGraph?: string;
    rootEntities?: string[];
  }> {
    const { contextGraphId, ...options } = request;
    return this.knowledgeAssetShare(contextGraphId, name, options);
  }

  async queryAssertion(name: string, request: {
    contextGraphId: string;
    subGraphName?: string;
  }): Promise<{
    quads: Array<{ subject: string; predicate: string; object: string; graph: string }>;
    count: number;
  }> {
    const params = new URLSearchParams({ contextGraphId: request.contextGraphId });
    if (request.subGraphName) params.set('subGraphName', request.subGraphName);
    return this.get(`/api/knowledge-assets/${encodeURIComponent(name)}/wm/quads?${params.toString()}`);
  }

  async publishCclPolicy(request: {
    contextGraphId: string;
    name: string;
    version: string;
    content: string;
    description?: string;
    contextType?: string;
    language?: string;
    format?: string;
  }): Promise<{ policyUri: string; hash: string; status: 'proposed' }> {
    return this.post('/api/ccl/policy/publish', request);
  }

  async approveCclPolicy(request: {
    contextGraphId: string;
    policyUri: string;
    contextType?: string;
  }): Promise<{ policyUri: string; bindingUri: string; contextType?: string; approvedAt: string }> {
    return this.post('/api/ccl/policy/approve', request);
  }

  async revokeCclPolicy(request: {
    contextGraphId: string;
    policyUri: string;
    contextType?: string;
  }): Promise<{ policyUri: string; bindingUri: string; contextType?: string; revokedAt: string; status: 'revoked' }> {
    return this.post('/api/ccl/policy/revoke', request);
  }

  async listCclPolicies(opts: {
    contextGraphId?: string;
    name?: string;
    contextType?: string;
    status?: string;
    includeBody?: boolean;
  } = {}): Promise<{ policies: any[] }> {
    const params = new URLSearchParams();
    if (opts.contextGraphId) params.set('contextGraphId', opts.contextGraphId);
    if (opts.name) params.set('name', opts.name);
    if (opts.contextType) params.set('contextType', opts.contextType);
    if (opts.status) params.set('status', opts.status);
    if (opts.includeBody) params.set('includeBody', 'true');
    const qs = params.toString();
    return this.get(`/api/ccl/policy/list${qs ? `?${qs}` : ''}`);
  }

  async resolveCclPolicy(opts: {
    contextGraphId: string;
    name: string;
    contextType?: string;
    includeBody?: boolean;
  }): Promise<{ policy: any | null }> {
    const params = new URLSearchParams({ contextGraphId: opts.contextGraphId, name: opts.name });
    if (opts.contextType) params.set('contextType', opts.contextType);
    if (opts.includeBody) params.set('includeBody', 'true');
    return this.get(`/api/ccl/policy/resolve?${params.toString()}`);
  }

  async evaluateCclPolicy(request: {
    contextGraphId: string;
    name: string;
    facts?: Array<[string, ...unknown[]]>;
    contextType?: string;
    view?: string;
    snapshotId?: string;
    scopeUal?: string;
    publishResult?: boolean;
  }): Promise<{
    policy: any;
    context: any;
    factSetHash: string;
    factQueryHash: string;
    factResolverVersion: string;
    factResolutionMode: 'manual' | 'snapshot-resolved';
    result: any;
  }> {
    return this.post('/api/ccl/eval', request);
  }

  async listCclEvaluations(opts: {
    contextGraphId: string;
    policyUri?: string;
    snapshotId?: string;
    view?: string;
    contextType?: string;
    resultKind?: 'derived' | 'decision';
    resultName?: string;
  }): Promise<{ evaluations: any[] }> {
    const params = new URLSearchParams({ contextGraphId: opts.contextGraphId });
    if (opts.policyUri) params.set('policyUri', opts.policyUri);
    if (opts.snapshotId) params.set('snapshotId', opts.snapshotId);
    if (opts.view) params.set('view', opts.view);
    if (opts.contextType) params.set('contextType', opts.contextType);
    if (opts.resultKind) params.set('resultKind', opts.resultKind);
    if (opts.resultName) params.set('resultName', opts.resultName);
    return this.get(`/api/ccl/results?${params.toString()}`);
  }

  async shutdown(): Promise<void> {
    try {
      await this.post('/api/shutdown', {});
    } catch {
      // Connection may close before response
    }
  }

  private authHeaders(): Record<string, string> {
    if (!this.token) return {};
    return { Authorization: `Bearer ${this.token}` };
  }

  private async get<T>(path: string, opts: { auth?: boolean } = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: opts.auth === false ? {} : this.authHeaders(),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw ApiClient.httpError(res.status, ApiClient.errorMessageFromBody(body, res.statusText), body);
    }
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw ApiClient.httpError(res.status, ApiClient.errorMessageFromBody(data, res.statusText), data);
    }
    return res.json() as Promise<T>;
  }

  private async put<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw ApiClient.httpError(res.status, ApiClient.errorMessageFromBody(data, res.statusText), data);
    }
    return res.json() as Promise<T>;
  }

  private async del<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw ApiClient.httpError(res.status, ApiClient.errorMessageFromBody(data, res.statusText), data);
    }
    return res.json() as Promise<T>;
  }

  private async postForm<T>(path: string, body: FormData): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.authHeaders(),
      body,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw ApiClient.httpError(res.status, ApiClient.errorMessageFromBody(data, res.statusText), data);
    }
    return res.json() as Promise<T>;
  }

  /** Create an Error with an `httpStatus` property so callers can distinguish
   *  application-level responses from connection failures. */
  static httpError(status: number, message?: string, responseBody?: unknown): Error & { httpStatus: number; responseBody?: unknown } {
    const err = new Error(message ?? `HTTP ${status}`) as Error & { httpStatus: number; responseBody?: unknown };
    err.httpStatus = status;
    if (responseBody !== undefined) err.responseBody = responseBody;
    return err;
  }

  private static errorMessageFromBody(body: unknown, fallback?: string): string | undefined {
    if (!body || typeof body !== 'object') return fallback;
    const record = body as Record<string, unknown>;
    const extraction = record.extraction;
    if (extraction && typeof extraction === 'object') {
      const extractionError = (extraction as Record<string, unknown>).error;
      if (typeof extractionError === 'string' && extractionError.length > 0) {
        return extractionError;
      }
    }
    if (typeof record.error === 'string' && record.error.length > 0) {
      return record.error;
    }
    return fallback;
  }
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const segments = linkHeader.split(',');
  for (const segment of segments) {
    const match = segment.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i);
    if (!match) continue;
    const target = match[1];
    if (!target) continue;
    if (target.startsWith('http://') || target.startsWith('https://')) {
      try {
        const url = new URL(target);
        return `${url.pathname}${url.search}`;
      } catch {
        return null;
      }
    }
    return target;
  }
  return null;
}

// NOTE: mirrored in `packages/adapter-openclaw/src/DkgNodePlugin.ts`
// (`UPLOAD_CONTENT_TYPES` there). `adapter-openclaw` can't import this
// directly (circular workspace dep), so update both tables together when
// adding a new format until a shared upload module lives in `dkg-core`.
const UPLOAD_CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'application/xml',
  '.epub': 'application/epub+zip',
};

function inferUploadContentType(filePath: string): string | undefined {
  const lower = filePath.toLowerCase();
  for (const [ext, ct] of Object.entries(UPLOAD_CONTENT_TYPES)) {
    if (lower.endsWith(ext)) return ct;
  }
  return undefined;
}
