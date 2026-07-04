import { daemonFetch, daemonPath, type DaemonPath } from './dashboardSessionClient.js';

const BASE = '';
const CONTEXT_GRAPH_URI_PREFIX = 'did:dkg:context-graph:';
const CONTEXT_GRAPH_LOAD_TIMEOUT_MS = 60000;

export {
  daemonFetch,
  daemonPath,
  dashboardSessionAuthKey,
  ensureDashboardSession,
  exchangeDashboardSession,
  getDashboardSession,
  isDashboardSessionReady,
  subscribeDashboardSession,
  withDashboardSessionCredentials,
  type DaemonPath,
  type DashboardSessionStatus,
} from './dashboardSessionClient.js';

export const apiFetch: typeof daemonFetch = daemonFetch;

function apiDaemonPath(path: string): DaemonPath {
  return daemonPath(`${BASE}${path}`);
}

function normalizeContextGraphId(contextGraphIdOrUri: string): string {
  const trimmed = contextGraphIdOrUri.trim();
  return trimmed.startsWith(CONTEXT_GRAPH_URI_PREFIX)
    ? trimmed.slice(CONTEXT_GRAPH_URI_PREFIX.length)
    : trimmed;
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
  authorAgentAddress?: string;
  preSignedAuthorAttestation?: PreSignedAuthorAttestationPayload;
  schemeVersion?: number;
}): void {
  const hasFinalizeOnlyField =
    args.authorAgentAddress != null ||
    args.preSignedAuthorAttestation != null ||
    args.schemeVersion !== undefined;
  if (hasFinalizeOnlyField && !(Array.isArray(args.quads) && args.quads.length > 0)) {
    throw new Error('authorAgentAddress, preSignedAuthorAttestation, and schemeVersion require non-empty quads');
  }
}

export class HttpError extends Error {
  status: number;
  body?: unknown;
  constructor(status: number, message?: string, body?: unknown) {
    super(message ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export class LocalAgentApiError extends Error {
  status?: number;
  code?: string;
  source?: string;
  details?: string;
  correlationId?: string;
  timeoutMs?: number;
  target?: string;
  route?: string;
  integrationId?: string;
  retryable?: boolean;

  constructor(message: string, metadata: Partial<LocalAgentApiError> = {}) {
    super(message);
    this.name = 'LocalAgentApiError';
    Object.assign(this, metadata);
  }
}

async function fetchWithTimeout(input: DaemonPath, init: RequestInit = {}, timeoutMs = 10000): Promise<Response> {
  try {
    return await apiFetch(input, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await apiFetch(apiDaemonPath(path));
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const msg = (errBody as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new HttpError(res.status, msg, errBody);
  }
  return res.json() as Promise<T>;
}

// GET that parses the daemon's `{ error, code }` body into the HttpError (like
// `post`/`delJson`). The legacy `get` above throws a bodyless HttpError, but PCA
// reads need the body to tell a CAPABILITY 503 (feature unavailable) from a
// TRANSPORT 503/504 (transient RPC outage, `code: 'RPC_*'`) — see
// `isPcaFeatureUnavailable` / `describePcaError`.
async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(apiDaemonPath(path));
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const msg = (errBody as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new HttpError(res.status, msg, errBody);
  }
  return res.json() as Promise<T>;
}

async function getWithTimeout<T>(path: string, timeoutMs: number): Promise<T> {
  const res = await fetchWithTimeout(apiDaemonPath(path), {}, timeoutMs);
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const msg = (errBody as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new HttpError(res.status, msg, errBody);
  }
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await apiFetch(apiDaemonPath(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const msg = (errBody as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new HttpError(res.status, msg, errBody);
  }
  return res.json() as Promise<T>;
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await apiFetch(apiDaemonPath(path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const msg = (errBody as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

async function del<T>(path: string): Promise<T> {
  const res = await apiFetch(apiDaemonPath(path), { method: 'DELETE' });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const msg = (errBody as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new HttpError(res.status, msg, errBody);
  }
  return res.json() as Promise<T>;
}

// DELETE variant that parses the daemon's `{ error }` body into an `HttpError`
// (status + body), mirroring `post`. The legacy `del` above predates the
// HttpError-aware error path and throws a bare `Error`, so callers that need to
// branch on the status/code (e.g. the PCA deregister flow mapping 403/409 via
// `describePcaError`) route through this instead. Both are kept so existing
// `del` callers keep their current contract.
async function delJson<T>(path: string): Promise<T> {
  const res = await apiFetch(apiDaemonPath(path), { method: 'DELETE' });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const msg = (errBody as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new HttpError(res.status, msg, errBody);
  }
  return res.json() as Promise<T>;
}

// --- Status ---
export const fetchStatus = () => get<any>('/api/status');

// --- LLM Settings ---
export interface LlmSettingsResponse {
  configured: boolean;
  model?: string;
  baseURL?: string;
}
export const fetchLlmSettings = () => get<LlmSettingsResponse>('/api/settings/llm');
export const updateLlmSettings = (data: { apiKey?: string; model?: string; baseURL?: string; clear?: boolean }) =>
  put<LlmSettingsResponse & { ok: boolean }>('/api/settings/llm', data);
export const fetchRetentionSettings = () => get<{ retentionDays: number }>('/api/settings/retention');
export const updateRetentionSettings = (retentionDays: number) =>
  put<{ ok: boolean; retentionDays: number }>('/api/settings/retention', { retentionDays });
export const fetchTelemetrySettings = () => get<{ enabled: boolean }>('/api/settings/telemetry');
export const updateTelemetrySettings = (enabled: boolean) =>
  put<{ ok: boolean; enabled: boolean }>('/api/settings/telemetry', { enabled });
export const fetchConnections = () => get<any>('/api/connections');
export const connectToPeerWithTimeout = (multiaddr: string, timeoutMs = 10000) =>
  fetchWithTimeout(apiDaemonPath('/api/connect'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ multiaddr }),
  }, timeoutMs).then(async (res) => {
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const msg = (errBody as { error?: string })?.error ?? `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return res.json() as Promise<{ connected?: boolean }>;
  });
// Resolve a peer's current multiaddrs via the libp2p Kademlia DHT and dial.
// Used by V10 invites that carry only a peer id, decoupling invite stability
// from relay/IP rotation. Daemon side: `POST /api/connect { peerId }` →
// `agent.connectToPeerId` → `peerRouting.findPeer` → `libp2p.dial`.
export const connectToPeerIdWithTimeout = (peerId: string, timeoutMs = 20000) =>
  fetchWithTimeout(apiDaemonPath('/api/connect'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peerId }),
  }, timeoutMs).then(async (res) => {
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const msg = (errBody as { error?: string })?.error ?? `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return res.json() as Promise<{ connected?: boolean }>;
  });
export const fetchAgents = () => get<any>('/api/agents');

// --- Metrics ---
export const fetchMetrics = () => get<any>('/api/metrics');
export const fetchMetricsHistory = (from: number, to: number, maxPoints = 300) =>
  get<{ snapshots: any[] }>(`/api/metrics/history?from=${from}&to=${to}&maxPoints=${maxPoints}`);

// --- Operations ---
export const fetchOperations = (params: Record<string, string> = {}) => {
  const qs = new URLSearchParams(params).toString();
  return get<{ operations: any[]; total: number }>(`/api/operations${qs ? '?' + qs : ''}`);
};
export const fetchOperationsWithPhases = (params: Record<string, string> = {}) => {
  const qs = new URLSearchParams({ ...params, phases: '1' }).toString();
  return get<{ operations: any[]; total: number }>(`/api/operations?${qs}`);
};
export const fetchOperation = (id: string) =>
  get<{ operation: any; logs: any[]; phases: any[] }>(`/api/operations/${id}`);
export const fetchErrorHotspots = (periodMs?: number) => {
  const qs = periodMs ? `?periodMs=${periodMs}` : '';
  return get<{ hotspots: Array<{ phase: string; error_count: number; last_error: string | null; last_occurred: number | null }> }>(`/api/error-hotspots${qs}`);
};
export const fetchFailedOperations = (params: { phase?: string; operationName?: string; periodMs?: number; q?: string; limit?: number } = {}) => {
  const qs = new URLSearchParams();
  if (params.phase) qs.set('phase', params.phase);
  if (params.operationName) qs.set('operationName', params.operationName);
  if (params.periodMs) qs.set('periodMs', String(params.periodMs));
  if (params.q) qs.set('q', params.q);
  if (params.limit) qs.set('limit', String(params.limit));
  const q = qs.toString();
  return get<{ operations: any[] }>(`/api/failed-operations${q ? '?' + q : ''}`);
};

// --- Replication (chain-driven VM reconciliation) — Phase F ---
export interface ReplicationSummary {
  periodMs: number;
  counts: Record<string, number>;
  promotes: number;
  fetches: number;
  defers: number;
  successRate: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  totalEvents: number;
}
export interface ReplicationPerCgRow {
  context_graph_id: string;
  on_chain_cg_id: string | null;
  promotes: number;
  fetches: number;
  defers: number;
  cursor_advances: number;
  last_watermark: number | null;
  last_head: number | null;
  last_event_ts: number | null;
}
export interface ReplicationTimelineBucket {
  bucket: number;
  promotes: number;
  fetches: number;
  defers: number;
  total: number;
}
export interface ReplicationCursorRow {
  context_graph_id: string;
  on_chain_id: string | null;
  last_reconciled_ordinal: number | null;
  core_hosted: number | null;
  subscribed: number | null;
  last_head: number | null;
  last_event_ts: number | null;
}
export interface ReplicationEventRow {
  ts: number;
  context_graph_id: string;
  on_chain_cg_id: string | null;
  action: string;
  ual: string | null;
  ordinal: number | null;
  ka_id: string | null;
  from_watermark: number | null;
  to_watermark: number | null;
  head: number | null;
  reconciled: number | null;
  pending: number | null;
  detail: string | null;
}
export const fetchReplicationSummary = (periodMs?: number) =>
  get<ReplicationSummary>(`/api/replication/summary${periodMs ? `?periodMs=${periodMs}` : ''}`);
export const fetchReplicationPerCg = (periodMs?: number) =>
  get<{ rows: ReplicationPerCgRow[] }>(`/api/replication/per-cg${periodMs ? `?periodMs=${periodMs}` : ''}`);
export const fetchReplicationTimeline = (params: { periodMs?: number; bucketMs?: number; cg?: string } = {}) => {
  const qs = new URLSearchParams();
  if (params.periodMs) qs.set('periodMs', String(params.periodMs));
  if (params.bucketMs) qs.set('bucketMs', String(params.bucketMs));
  if (params.cg) qs.set('cg', params.cg);
  const q = qs.toString();
  return get<{ buckets: ReplicationTimelineBucket[] }>(`/api/replication/timeline${q ? '?' + q : ''}`);
};
export const fetchReplicationCursors = () =>
  get<{ cursors: ReplicationCursorRow[] }>(`/api/replication/cursors`);
export const fetchReplicationEvents = (cg: string, limit = 100) =>
  get<{ events: ReplicationEventRow[] }>(`/api/replication/events?cg=${encodeURIComponent(cg)}&limit=${limit}`);

// --- Operation stats ---
export const fetchOperationStats = (params: { name?: string; periodMs?: number } = {}) => {
  const qs = new URLSearchParams();
  if (params.name) qs.set('name', params.name);
  if (params.periodMs) qs.set('periodMs', String(params.periodMs));
  const q = qs.toString();
  return get<{ summary: any; timeSeries: any[] }>(`/api/operation-stats${q ? '?' + q : ''}`);
};

export const fetchSuccessRates = (periodMs: number) =>
  get<{ rates: Array<{ type: string; total: number; success: number; error: number; rate: number; avgMs: number }> }>(`/api/success-rates?periodMs=${periodMs}`);

export const fetchPerTypeStats = (periodMs: number, bucketMs?: number) => {
  const qs = `periodMs=${periodMs}${bucketMs ? `&bucketMs=${bucketMs}` : ''}`;
  return get<{
    buckets: number[];
    types: string[];
    series: Record<string, Array<{ count: number; avgMs: number; successRate: number; gasCostEth: number }>>;
  }>(`/api/per-type-stats?${qs}`);
};

// --- Logs ---
// NOTE: A `fetchLogs()` wrapper around the DB-backed /api/logs route
// used to live here. It had no production importer (only its own unit
// test) and the underlying route was removed in V15 of the dashboard
// DB schema. The UI's actual log viewer uses `fetchNodeLog()` below,
// which is file-backed.

export const fetchNodeLog = (params: { lines?: number; q?: string } = {}) => {
  const qs = new URLSearchParams();
  if (params.lines) qs.set('lines', String(params.lines));
  if (params.q) qs.set('q', params.q);
  const q = qs.toString();
  return get<{ lines: string[]; totalSize: number }>(`/api/node-log${q ? '?' + q : ''}`);
};

// --- Context graphs (V10) — legacy daemon paths keep working server-side redirects.
export async function fetchContextGraphs(): Promise<{ contextGraphs: any[] }> {
  const data = await getWithTimeout<{ contextGraphs?: any[] }>(
    '/api/context-graph/list',
    CONTEXT_GRAPH_LOAD_TIMEOUT_MS,
  );
  const list = data.contextGraphs ?? [];
  return { contextGraphs: list.filter((p: any) => !p.isSystem) };
}

// --- Agent Identity ---
export interface AgentIdentity {
  agentAddress: string;
  agentDid: string;
  name: string;
  framework?: string;
  peerId: string;
  nodeIdentityId: string;
}

export const fetchCurrentAgent = () => get<AgentIdentity>('/api/agent/identity');

export async function createContextGraph(
  id: string,
  name: string,
  description?: string,
  opts?: { allowedAgents?: string[]; accessPolicy?: number; publishPolicy?: number; register?: boolean },
): Promise<{ created: string; uri: string; registered?: boolean; onChainId?: string; registerError?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await apiFetch(apiDaemonPath('/api/context-graph/create'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id, name, description,
        // Codex PR #608 R1/R2 #5/#8 + OT-RFC-38 LU-6 contract:
        // project creation is LOCAL-ONLY by default. SWM works immediately
        // (cores opaquely buffer ciphertext for curated CGs in host-mode
        // for the pre-registration TTL); on-chain registration is deferred
        // until either (a) the user opts in via `opts.register: true`
        // (UI checkbox below), or (b) the first VM publish triggers
        // `/api/shared-memory/publish` auto-register. Avoids requiring
        // the user to hold TRAC / pay gas just to start a project, while
        // still letting funded users register up-front.
        ...(opts?.register ? { register: true } : {}),
        ...(opts?.allowedAgents ? { allowedAgents: opts.allowedAgents } : {}),
        ...(opts?.accessPolicy !== undefined ? { accessPolicy: opts.accessPolicy } : {}),
        ...(opts?.publishPolicy !== undefined ? { publishPolicy: opts.publishPolicy } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error((errBody as { error?: string })?.error ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<{ created: string; uri: string; registered?: boolean; onChainId?: string; registerError?: string }>;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error('Creating project is taking longer than expected — it may still complete in the background. Refresh the page in a moment.');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Register an EXISTING context graph on-chain. VM (Verifiable Memory) is the
 * on-chain layer, so an off-chain CG must be registered before finalize / VM
 * publish. Mirrors the daemon's `POST /api/context-graph/register`.
 */
export const registerContextGraph = (
  id: string,
  opts: { accessPolicy?: number; publishPolicy?: number; pcaAccountId?: string } = {},
) =>
  post<{ registered: string; onChainId: string; txHash?: string; hint?: string }>(
    '/api/context-graph/register',
    {
      id,
      ...(opts.accessPolicy !== undefined ? { accessPolicy: opts.accessPolicy } : {}),
      ...(opts.publishPolicy !== undefined ? { publishPolicy: opts.publishPolicy } : {}),
      // PCA CG-binding (S3 §5.3 step 6): the daemon's register route accepts an
      // optional pcaAccountId (curated-only; signer must == PCA owner). No new
      // route — this is the existing register path with the publish-authority arg.
      ...(opts.pcaAccountId ? { pcaAccountId: opts.pcaAccountId } : {}),
    },
  );

/**
 * Ensure a context graph is registered on-chain before an operation that
 * requires it (WM finalize / VM publish). Returns the on-chain id. No-op when
 * already registered. The UI calls this transparently so users never hit
 * "context graph is not registered on-chain" — VM is the on-chain layer, so
 * publishing to it auto-registers the CG first.
 */
export async function ensureContextGraphOnChain(contextGraphId: string): Promise<string | undefined> {
  const { contextGraphs } = await fetchContextGraphs();
  const cg = (contextGraphs ?? []).find((c: any) => c?.id === contextGraphId);
  if (cg?.onChainId) return String(cg.onChainId);
  const res = await registerContextGraph(contextGraphId);
  return res?.onChainId;
}

// --- Context Graph Participant Management ---
export const addParticipant = (contextGraphId: string, agentAddress: string) =>
  post<{ ok: boolean }>(`/api/context-graph/${encodeURIComponent(contextGraphId)}/add-participant`, { agentAddress });

export const removeParticipant = (contextGraphId: string, agentAddress: string) =>
  post<{ ok: boolean }>(`/api/context-graph/${encodeURIComponent(contextGraphId)}/remove-participant`, { agentAddress });

export const listParticipants = (contextGraphId: string) =>
  get<{ contextGraphId: string; allowedAgents: string[] }>(`/api/context-graph/${encodeURIComponent(contextGraphId)}/participants`);

// --- Join Request flow (Phase 2: signed agent delegation) ---
//
// A join request now IS a `SignedAgentDelegation` — the agent's
// signature scoped to `sync:<cgId>` that authorises their hosting node
// (peer-id and/or operational key) to act on their behalf for that CG.
// On approval the curator promotes the named delegatee identifiers
// into the CG allowlist so post-approval sync passes auth without the
// agent having to co-sign every wire message.
export interface SignedAgentDelegation {
  agentAddress: string;
  scope: string;
  issuedAtMs: number;
  expiresAtMs?: number;
  delegateePeerId?: string;
  delegateeOpKey?: string;
  signature: string;
}

// SignJoinResponse is intentionally narrow — `/sign-join` is sign-only
// (PR #448 review: forwarding lives in `/request-join` to avoid a
// duplicate-forward bug where the UI was sending the same delegation
// twice). Delivery status comes back from `submitJoinRequest` instead.
export interface SignJoinResponse {
  ok: boolean;
  contextGraphId: string;
  delegation: SignedAgentDelegation;
  agentAddress: string;
}

export interface PendingJoinRequest {
  agentAddress: string;
  name?: string;
  signature: string;
  timestamp: number;
  status: string;
}

export const signJoinRequest = (contextGraphId: string) =>
  post<SignJoinResponse>(
    `/api/context-graph/${encodeURIComponent(contextGraphId)}/sign-join`,
    {},
  );

/**
 * Daemon's `/request-join` returns `delivered` describing how the
 * signed delegation was routed:
 *  - `'local'`  — local node IS the curator; stored locally, no P2P
 *  - `number`   — count of remote curator peers that returned `ok` for
 *                 the broadcast/targeted forward (typically `1`)
 * The 502 path (no curator reachable) throws here via `post()`, so a
 * resolved response always implies at least one delivery destination.
 */
export const submitJoinRequest = (
  contextGraphId: string,
  req: { delegation: SignedAgentDelegation; agentName?: string; curatorPeerId?: string },
) =>
  post<{ ok: boolean; status: string; delivered: number | 'local'; alreadyMember?: boolean }>(
    `/api/context-graph/${encodeURIComponent(contextGraphId)}/request-join`,
    req,
  );

export const listJoinRequests = (contextGraphId: string) =>
  get<{ contextGraphId: string; requests: PendingJoinRequest[] }>(`/api/context-graph/${encodeURIComponent(contextGraphId)}/join-requests`);

export const approveJoinRequest = (contextGraphId: string, agentAddress: string) =>
  post<{ ok: boolean; status: string; agentAddress: string }>(`/api/context-graph/${encodeURIComponent(contextGraphId)}/approve-join`, { agentAddress });

export const rejectJoinRequest = (contextGraphId: string, agentAddress: string) =>
  post<{ ok: boolean; status: string; agentAddress: string }>(`/api/context-graph/${encodeURIComponent(contextGraphId)}/reject-join`, { agentAddress });

// --- Catch-up sync jobs ---
export interface CatchupStatusResponse {
  jobId: string;
  contextGraphId: string;
  includeSharedMemory: boolean;
  /**
   * `unreachable` is the V10 terminal status emitted when the daemon
   * subscribed and ran the catchup, but no peer could deliver the CG
   * content (curator offline, no node holds the CG, or transport
   * failures across the whole peer set). Distinct from `denied`
   * (responder explicitly refused) so the UI can render targeted
   * copy + a "send signed join request" CTA.
   */
  status: 'queued' | 'running' | 'done' | 'denied' | 'failed' | 'unreachable';
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: {
    connectedPeers: number;
    syncCapablePeers: number;
    peersTried: number;
    /** See `unreachable` above; subset of `peersTried` that responded without failure or denial. */
    peersSucceeded: number;
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
        emptyResponses: number;
        metaOnlyResponses: number;
        dataRejectedMissingMeta: number;
        rejectedKcs: number;
        failedPeers: number;
      };
      sharedMemory: {
        fetchedMetaTriples: number;
        fetchedDataTriples: number;
        insertedMetaTriples: number;
        insertedDataTriples: number;
        bytesReceived: number;
        resumedPhases: number;
        emptyResponses: number;
        droppedDataTriples: number;
        failedPeers: number;
      };
    };
  };
  error?: string;
}

export const fetchCatchupStatus = (contextGraphId: string) =>
  get<CatchupStatusResponse>(`/api/sync/catchup-status?contextGraphId=${encodeURIComponent(contextGraphId)}`);

// --- File import to Working Memory ---
export interface ImportFileResult {
  assertionUri: string;
  fileHash: string;
  rootEntity?: string;
  detectedContentType: string;
  extraction: {
    status: 'completed' | 'skipped' | 'failed';
    tripleCount?: number;
    triplesWritten?: number;
    provenance?: any;
    error?: string;
    pipelineUsed?: string | null;
    mdIntermediateHash?: string;
  };
}

const EXT_TO_MIME: Record<string, string> = {
  md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', csv: 'text/csv',
  json: 'application/json', xml: 'application/xml',
  yaml: 'text/yaml', yml: 'text/yaml',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  epub: 'application/epub+zip',
  ttl: 'text/turtle', rdf: 'application/rdf+xml', owl: 'application/rdf+xml',
  html: 'text/html', htm: 'text/html',
  py: 'text/x-python', ts: 'text/typescript', js: 'text/javascript',
  tsx: 'text/typescript', jsx: 'text/javascript',
  java: 'text/x-java', go: 'text/x-go', rs: 'text/x-rust',
  c: 'text/x-c', cpp: 'text/x-c++', h: 'text/x-c',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
};

function detectContentType(file: File): string | undefined {
  if (file.type && file.type !== 'application/octet-stream') return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_MIME[ext];
}

export async function importFile(
  assertionName: string,
  contextGraphId: string,
  file: File,
  opts?: { ontologyRef?: string; subGraphName?: string },
): Promise<ImportFileResult> {
  const form = new FormData();
  form.append('file', file);
  form.append('contextGraphId', contextGraphId);
  const ct = detectContentType(file);
  if (ct) form.append('contentType', ct);
  if (opts?.ontologyRef) form.append('ontologyRef', opts.ontologyRef);
  if (opts?.subGraphName) form.append('subGraphName', opts.subGraphName);

  const res = await apiFetch(apiDaemonPath(`/api/knowledge-assets/${encodeURIComponent(assertionName)}/wm/import-file`), {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error((errBody as { error?: string })?.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<ImportFileResult>;
}

// --- Query ---

// In-flight POST /api/query dedup. Coalesces concurrent identical
// requests so React strict-mode double-mounts and sibling views asking
// the same SPARQL against the same CG share one underlying fetch.
//
// Scope is *strictly inflight*: the entry is deleted as soon as the
// promise settles (success OR failure), so the next call always issues
// a fresh request. No caching, no staleness window — this is purely
// concurrent-coalescing, drop-in safe for every existing caller.
//
// Motivation: opening a project on the dashboard fires `useMemoryEntities`
// from two mounted instances (Dashboard card + ProjectView), giving 6
// identical `/api/query` POSTs for the WM/SWM/VM fan-out against a
// multi-GB Oxigraph store. Each duplicate adds seconds of wall time on
// large stores. Inflight dedup collapses the dupes to one.
const inflightQuery = new Map<string, Promise<{ result: any }>>();

export function postQueryDeduped(body: Record<string, unknown>): Promise<{ result: any }> {
  const key = JSON.stringify(body);
  const existing = inflightQuery.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const res = await apiFetch(apiDaemonPath('/api/query'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: key,
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const msg = (errBody as { error?: string })?.error ?? `HTTP ${res.status}`;
      throw new HttpError(res.status, msg, errBody);
    }
    return res.json() as Promise<{ result: any }>;
  })().finally(() => {
    inflightQuery.delete(key);
  });
  inflightQuery.set(key, promise);
  return promise;
}

export const executeQuery = (
  sparql: string,
  contextGraphId?: string,
  includeSharedMemory?: boolean,
  graphSuffix?: '_shared_memory',
  view?: 'verified-memory' | 'shared-working-memory',
  // Opt the CG-scoped allow-list into the assertion partitions. Without it the
  // daemon restricts `GRAPH ?g { … }` to the static set
  // { <cg>, <cg>/_meta, <cg>/_shared_memory_meta } (see the long note on
  // `listWmAssertions`), so a `GRAPH ?g` enumeration of WM content comes back
  // empty. Callers that read raw partition triples (e.g. the WM layer view)
  // pass `true`.
  includeContextGraphPartitions?: boolean,
) =>
  postQueryDeduped({ sparql, contextGraphId, includeSharedMemory, graphSuffix, view, includeContextGraphPartitions });

/**
 * Map of assertion name → deterministic Option-1 UAL (`dkg:reservedUal`,
 * `did:dkg:evm:<chainId>/<author>/<number>`). Stamped on the lifecycle URN at
 * creation, so it's available for every assertion (WM/SWM/published) — the
 * assertions list renders it next to the filename. Keyed by `dkg:assertionName`.
 */
export async function fetchAssertionUals(contextGraphId: string): Promise<Record<string, string>> {
  const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
  const sparql = `SELECT ?name ?ual WHERE {
    GRAPH <${metaGraph}> {
      ?lc <http://dkg.io/ontology/assertionName> ?name ;
          <http://dkg.io/ontology/reservedUal> ?ual .
    }
  }`;
  const data = await executeQuery(sparql, contextGraphId);
  const map: Record<string, string> = {};
  for (const b of (data?.result?.bindings ?? [])) {
    const name = typeof b.name === 'string' ? b.name : b.name?.value;
    const ual = typeof b.ual === 'string' ? b.ual : b.ual?.value;
    if (name && ual && !map[name]) map[name] = ual;
  }
  return map;
}

// NOTE: the legacy `publishTriples` (create + `/api/shared-memory/publish`
// {assertionName}) and `writeSharedMemory` (`/api/shared-memory/write`) helpers
// were removed in the API-cleanup pass (#1087). Publishing now goes through the
// canonical per-KA `knowledgeAssetPublish` (`…/vm/publish`); the
// `/api/shared-memory/write` ROUTE still exists daemon-side but has no node-UI
// caller.

export const writeProfileQueryCatalog = (
  contextGraphId: string,
  quads: Array<{ subject: string; predicate: string; object: string; graph?: string }>,
) =>
  post<any>('/api/profile/query-catalog/write', {
    contextGraphId,
    quads,
  });

// --- Knowledge Assets (OT-RFC-43 §10.5 — GitHub-shaped KA surface) ---
// Layer-explicit wrappers over the clean /api/knowledge-assets/... routes that
// supersede the legacy assertion/* + shared-memory/* calls above during the v10
// migration window. One file = one Knowledge Asset (Design B / OT-RFC-44): a KA
// may carry any number of member entities. WM → SWM → VM maps to the git-shaped
// verbs write → finalize → share → publish.

export interface KnowledgeAssetQuad {
  subject: string;
  predicate: string;
  object: string;
  graph: string;
}

/**
 * Author attestation produced by an external signer. Mirrors the
 * `packages/cli/src/api-client.ts` reference so finalize / create KA flows can
 * carry a pre-built EIP-712 attestation instead of signing on the daemon.
 */
export interface PreSignedAuthorAttestationPayload {
  address: string;
  signature: { r: string; vs: string };
}

/**
 * VM-publish controls for the finalized-assertion publish path. Mirrors
 * `KnowledgeAssetFinalizedPublishOptions` in `packages/cli/src/api-client.ts`.
 * Browser callers must pass large node identity ids as decimal strings rather
 * than JavaScript numbers, which can lose uint64 precision before serialization.
 */
export interface KnowledgeAssetFinalizedPublishOptions {
  /**
   * SDK-friendly spelling for the finalized publish cleanup flag. The
   * knowledge-assets daemon route forwards `clearSharedMemoryAfter` to
   * `publishFromFinalizedAssertion`, so the client translates before POST.
   */
  clearAfter?: boolean;
  publishEpochs?: number;
  publisherNodeIdentityIdOverride?: string;
}

const FINALIZED_PUBLISH_OPTION_KEYS = new Set([
  'clearAfter',
  'publishEpochs',
  'publisherNodeIdentityIdOverride',
]);

const publisherNodeIdentityOverridePayload = (value: unknown): string => {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  throw new Error('publisherNodeIdentityIdOverride must be passed as a decimal string');
}

/** Translate {@link KnowledgeAssetFinalizedPublishOptions} into the daemon body. */
const finalizedPublishOptionsPayload = (
  options?: KnowledgeAssetFinalizedPublishOptions,
  allowedExtraKeys: readonly string[] = [],
): Record<string, unknown> | undefined => {
  if (!options) return undefined;
  const unsupportedKeys = Object.keys(options).filter(
    (key) => !FINALIZED_PUBLISH_OPTION_KEYS.has(key) && !allowedExtraKeys.includes(key),
  );
  if (unsupportedKeys.length > 0) {
    throw new Error(`Unsupported finalized publish option(s): ${unsupportedKeys.join(', ')}`);
  }
  const payload: Record<string, unknown> = {};
  if (options.clearAfter !== undefined) payload.clearSharedMemoryAfter = options.clearAfter;
  if (options.publishEpochs !== undefined) payload.publishEpochs = options.publishEpochs;
  const publisherNodeIdentityIdOverride =
    (options as Record<string, unknown>).publisherNodeIdentityIdOverride;
  if (publisherNodeIdentityIdOverride !== undefined) {
    payload.publisherNodeIdentityIdOverride =
      publisherNodeIdentityOverridePayload(publisherNodeIdentityIdOverride);
  }
  return Object.keys(payload).length > 0 ? payload : undefined;
};

const createAlsoPublishVmPayload = (value: unknown): boolean | Record<string, unknown> => {
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
};

/**
 * Create a KA and open its WM draft. Pass `quads` to atomically write+finalize
 * in one call; `alsoShareSwm` / `alsoPublishVm` to advance layers in the same
 * request (best-effort tails — partial failures are reported via HTTP 207).
 */
export const createKnowledgeAsset = (
  contextGraphId: string,
  name: string,
  opts: {
    subGraphName?: string;
    quads?: KnowledgeAssetQuad[];
    authorAgentAddress?: string;
    preSignedAuthorAttestation?: PreSignedAuthorAttestationPayload;
    schemeVersion?: number;
    alsoShareSwm?: boolean;
    alsoPublishVm?: boolean | KnowledgeAssetFinalizedPublishOptions;
  } = {},
) => {
  assertExclusiveAuthorFields(opts);
  assertCreateFinalizeFieldsHaveQuads(opts);
  const normalizedContextGraphId = normalizeContextGraphId(contextGraphId);
  const body: Record<string, unknown> = {
    contextGraphId: normalizedContextGraphId,
    name,
    ...opts,
  };
  // Object form carries finalized-publish controls; translate to the daemon
  // body shape (mirrors the cli ApiClient). `true`/`false` pass through.
  if (opts.alsoPublishVm !== undefined) {
    body.alsoPublishVm = createAlsoPublishVmPayload(opts.alsoPublishVm);
  }
  return post<Record<string, unknown>>('/api/knowledge-assets', body);
};

/** GET a KA's per-layer lifecycle state by name. */
export const getKnowledgeAsset = (
  contextGraphId: string,
  name: string,
  subGraphName?: string,
) => {
  const qs = new URLSearchParams({
    contextGraphId: normalizeContextGraphId(contextGraphId),
    ...(subGraphName ? { subGraphName } : {}),
  }).toString();
  return get<Record<string, unknown>>(
    `/api/knowledge-assets/${encodeURIComponent(name)}?${qs}`,
  );
};

/** Append quads to the KA's WM draft (git add/edit). */
export const knowledgeAssetWrite = (
  contextGraphId: string,
  name: string,
  quads: KnowledgeAssetQuad[],
  opts: { subGraphName?: string } = {},
) =>
  post<{ written: number }>(
    `/api/knowledge-assets/${encodeURIComponent(name)}/wm/write`,
    { contextGraphId: normalizeContextGraphId(contextGraphId), quads, ...opts },
  );

/** Seal the WM draft — computes the merkle root + signs the seal (git commit). */
export const knowledgeAssetFinalize = (
  contextGraphId: string,
  name: string,
  opts: {
    subGraphName?: string;
    authorAgentAddress?: string;
    preSignedAuthorAttestation?: PreSignedAuthorAttestationPayload;
    schemeVersion?: number;
    // #1116 — `layer:"swm"` seals content already shared to SWM (the daemon
    // reconstructs a transient WM draft from SWM, finalizes, drops the draft);
    // default ("wm") seals the open Working-Memory draft. Lets a publish path
    // seal an unsealed-in-SWM asset in place before retrying /vm/publish.
    layer?: 'wm' | 'swm';
  } = {},
) => {
  assertExclusiveAuthorFields(opts);
  return post<{ merkleRoot: string; eip712Digest: string }>(
    `/api/knowledge-assets/${encodeURIComponent(name)}/wm/finalize`,
    { contextGraphId: normalizeContextGraphId(contextGraphId), ...opts },
  );
};

/** Discard the open WM draft (git checkout -- .). */
export const knowledgeAssetDiscard = (
  contextGraphId: string,
  name: string,
  opts: { subGraphName?: string } = {},
) =>
  post<{ discarded: boolean }>(
    `/api/knowledge-assets/${encodeURIComponent(name)}/wm/discard`,
    { contextGraphId: normalizeContextGraphId(contextGraphId), ...opts },
  );

/** Seed a fresh WM draft from the file's current SWM/VM state (git checkout). */
export const knowledgeAssetPullFrom = (
  contextGraphId: string,
  name: string,
  layer: 'swm' | 'vm',
  opts: { subGraphName?: string; onConflict?: 'reject' | 'replace' } = {},
) =>
  post<Record<string, unknown>>(
    `/api/knowledge-assets/${encodeURIComponent(name)}/wm/pull-from`,
    { contextGraphId: normalizeContextGraphId(contextGraphId), layer, ...opts },
  );

/** Advance the SWM pointer (WM → SWM; git push origin <branch>). */
export const knowledgeAssetShare = (
  contextGraphId: string,
  name: string,
  opts: { subGraphName?: string; entities?: string[] | 'all' } = {},
) =>
  post<{ swmShared: boolean; promotedCount: number }>(
    `/api/knowledge-assets/${encodeURIComponent(name)}/swm/share`,
    { contextGraphId: normalizeContextGraphId(contextGraphId), ...opts },
  );

/** Publish to VM — mint or update on chain (git push origin main). */
export const knowledgeAssetPublish = (
  contextGraphId: string,
  name: string,
  opts: { subGraphName?: string } & KnowledgeAssetFinalizedPublishOptions = {},
) => {
  const publishOptions = finalizedPublishOptionsPayload(opts, ['subGraphName']);
  return post<Record<string, unknown>>(
    `/api/knowledge-assets/${encodeURIComponent(name)}/vm/publish`,
    {
      contextGraphId: normalizeContextGraphId(contextGraphId),
      ...(opts.subGraphName ? { subGraphName: opts.subGraphName } : {}),
      ...(publishOptions ? { options: publishOptions } : {}),
    },
  );
};

/**
 * Thrown by `knowledgeAssetPublishWithSeal` when a SWM asset can't be sealed in
 * place because only a subset of it was shared (daemon `SWM_SUBSET_NOT_SEALABLE`).
 * The UI surfaces this as "share the full asset first" — it is NOT retried.
 */
export class SwmSubsetNotSealableError extends Error {
  constructor(message?: string) {
    super(message ?? 'Share the full asset to Shared Memory before publishing.');
    this.name = 'SwmSubsetNotSealableError';
  }
}

/**
 * Publish a named SWM assertion to VM, sealing it in place first if the daemon
 * reports it isn't finalized (the #1116 / §4.4 catch→seal→retry contract).
 *
 * Normal path: by the time content reaches SWM it is sealed (seal-on-share is
 * the default), so the first `/vm/publish` succeeds. This is the robustness
 * safety net for the rare unsealed-in-SWM case:
 *   - `PUBLISH_NOT_FULL_SHARE` / `VM_PUBLISH_PRECONDITION` (409) → seal in place
 *     via `wm/finalize {layer:"swm"}`, then retry publish ONCE.
 *   - `SWM_SUBSET_NOT_SEALABLE` (409, on the seal) → throw
 *     `SwmSubsetNotSealableError` (caller tells the user to share the full
 *     asset); never loops.
 * `sealed` in the result tells the caller a seal step ran so it can surface
 * "sealing then publishing" instead of a silent skip.
 *
 * A daemon HTTP-207 partial publish (KA minted on-chain but the context-graph
 * binding failed) comes back as `res.ok`, so it is NOT thrown — the body
 * carries `contextGraphError`. Callers MUST check that field and surface a
 * partial/warning state rather than treating it as a clean success.
 */
export async function knowledgeAssetPublishWithSeal(
  contextGraphId: string,
  name: string,
  opts: { subGraphName?: string } & KnowledgeAssetFinalizedPublishOptions = {},
): Promise<Record<string, unknown> & { sealed?: boolean; contextGraphError?: string }> {
  try {
    return await knowledgeAssetPublish(contextGraphId, name, opts);
  } catch (err: unknown) {
    const code =
      err instanceof HttpError && err.status === 409
        ? (err.body as { code?: string } | undefined)?.code
        : undefined;
    if (code !== 'PUBLISH_NOT_FULL_SHARE' && code !== 'VM_PUBLISH_PRECONDITION') throw err;
    // Unsealed in SWM — seal in place, then retry the publish once.
    try {
      await knowledgeAssetFinalize(contextGraphId, name, {
        layer: 'swm',
        ...(opts.subGraphName ? { subGraphName: opts.subGraphName } : {}),
      });
    } catch (sealErr: unknown) {
      if (
        sealErr instanceof HttpError &&
        sealErr.status === 409 &&
        (sealErr.body as { code?: string } | undefined)?.code === 'SWM_SUBSET_NOT_SEALABLE'
      ) {
        throw new SwmSubsetNotSealableError(
          (sealErr.body as { error?: string } | undefined)?.error,
        );
      }
      throw sealErr;
    }
    const result = await knowledgeAssetPublish(contextGraphId, name, opts);
    return { ...result, sealed: true };
  }
}

/**
 * Aggregate result of a batch SWM→VM publish. Shared so every batch-publish CTA reports
 * the partial/sample/error accounting identically (no per-component drift).
 */
export interface BatchPublishResult {
  published: number;
  total: number;
  sealed: number;        // how many needed an in-place seal before publishing
  partial: number;       // how many minted on-chain but failed the CG binding (207)
  partialError?: string; // a sample contextGraphError detail (the first 207's reason)
  // Every per-KA failure (not just the last), so callers can report the count + the
  // name/reason of each — `failures.length` is the failed count.
  failures: Array<{ name: string; subGraph?: string; error: string }>;
  sample: PublishResult | null; // a representative confirmed result for the headline
  // B8 (#1365 round-3) — the CONFIRMED discount aggregated across the batch, NOT a
  // property of the headline `sample` (which is picked for cleanliness, not discount).
  // baseCost/discountedCost are SUMMED over every item that drew on a PCA, so the badge
  // derives the blended % + the TRUE total saved; absent when no item drew one (→ badge
  // hidden, #9). accountId/epoch name the first drawing item (single-PCA is the norm).
  convictionCostCovered?: ConvictionCostCovered;
}

/**
 * Publish each named SWM assertion to Verifiable Memory through
 * `knowledgeAssetPublishWithSeal` (seal-in-SWM retry + 207 partial handling), aggregating
 * into ONE `BatchPublishResult`. The canonical batch-publish loop reused by every CTA
 * (MemoryLayerView / entities / layer-widgets) so the partial-detail, sample, and per-KA
 * error accounting cannot drift between them. Per-KA failures are collected into
 * the `failures[]` array (never thrown); the caller renders the aggregate.
 */
export async function publishAssertionsToVm(
  contextGraphId: string,
  items: Array<{ name: string; subGraph?: string }>,
): Promise<BatchPublishResult> {
  let published = 0;
  let sealed = 0;
  let partial = 0;
  let firstPartialError: string | undefined;
  const failures: BatchPublishResult['failures'] = [];
  let sample: PublishResult | null = null;
  // B8 (#1365 round-3) — aggregate the CONFIRMED discount across the BATCH (the headline
  // `sample` is picked for cleanliness, not discount, so a mixed batch could hide a real
  // draw if the badge read it off `sample`). Sum baseCost/discountedCost over every item
  // that drew on a PCA → blended % + true total saved; the first drawing item names the
  // account/epoch.
  let aggBase = 0n;
  let aggDiscounted = 0n;
  let aggDrawnEpoch = 0n;
  let aggDrawnTopUp = 0n;
  let firstCovered: ConvictionCostCovered | undefined;
  let sameCoveredAccount = true;
  let sameCoveredEpoch = true;
  for (const a of items) {
    try {
      const res = await knowledgeAssetPublishWithSeal(
        contextGraphId,
        a.name,
        a.subGraph ? { subGraphName: a.subGraph } : {},
      );
      published += 1;
      if (res.sealed) sealed += 1;
      // PR #972 — a 207 partial: minted on-chain but the CG binding failed.
      if (res.contextGraphError) {
        partial += 1;
        if (firstPartialError === undefined) firstPartialError = res.contextGraphError;
      }
      const pr = res as unknown as PublishResult;
      // Prefer a fully-clean sample (confirmed + txHash + no binding error) for the
      // headline; fall back to the first result otherwise.
      if (!sample || (pr.status === 'confirmed' && !!pr.txHash && !pr.contextGraphError)) sample = pr;
      const cc = pr.convictionCostCovered;
      if (cc) {
        try {
          aggBase += BigInt(cc.baseCost);
          aggDiscounted += BigInt(cc.discountedCost);
          aggDrawnEpoch += BigInt(cc.drawnFromEpoch);
          aggDrawnTopUp += BigInt(cc.drawnFromTopUp);
          if (!firstCovered) {
            firstCovered = cc;
          } else {
            if (cc.accountId !== firstCovered.accountId) sameCoveredAccount = false;
            if (cc.epoch !== firstCovered.epoch) sameCoveredEpoch = false;
          }
        } catch {
          // skip an un-parseable per-item event; never let it break the batch accounting.
        }
      }
    } catch (err: unknown) {
      const message =
        err instanceof SwmSubsetNotSealableError
          ? err.message
          : (err as { message?: string })?.message ?? 'publish failed';
      failures.push({ name: a.name, ...(a.subGraph ? { subGraph: a.subGraph } : {}), error: message });
    }
  }
  const convictionCostCovered: ConvictionCostCovered | undefined = firstCovered
    ? {
        ...(sameCoveredAccount && firstCovered.accountId ? { accountId: firstCovered.accountId } : {}),
        ...(sameCoveredEpoch && firstCovered.epoch != null ? { epoch: firstCovered.epoch } : {}),
        baseCost: aggBase.toString(),
        discountedCost: aggDiscounted.toString(),
        drawnFromEpoch: aggDrawnEpoch.toString(),
        drawnFromTopUp: aggDrawnTopUp.toString(),
      }
    : undefined;
  return { published, total: items.length, sealed, partial, partialError: firstPartialError, failures, sample, convictionCostCovered };
}

// --- Assertions (WM objects) ---

export interface AssertionInfo {
  name: string;
  graphUri: string;
  tripleCount?: number;
  /**
   * Sub-graph slug when the assertion lives in a sub-graph
   * partition, undefined for root-bucket assertions. Lets the UI
   * surface the structural placement inline on each row without a
   * separate lookup. Field is uniformly populated on both WM and
   * SWM `AssertionInfo`s so consumers don't need a layer-aware
   * branch.
   */
  subGraph?: string;
}

/**
 * Discover assertions in a given memory layer.
 *
 * WM uses a cheap graph-listing query: the assertion graph URI shape is
 * `did:dkg:context-graph:<cg>/assertion/<agent>/<name>` and a WM assertion
 * still carries its triples there.
 *
 * SWM is different. When an assertion is promoted its triples move into
 * the single `/_shared_memory` graph, so the assertion graph itself becomes
 * empty and the WM-style listing returns nothing. The authoring node's
 * `_meta` graph also records full lifecycle entities (`dkg:state`,
 * `dkg:memoryLayer`, `prov:Activity` events), but `_meta` is NOT replicated
 * between peers — only the context graph's data graphs and the
 * `_shared_memory_meta` partitions propagate over sync.
 *
 * What DOES land on every replica is one `dkg:ShareTransition` entity per
 * promote, authored by `generateShareTransitionMetadata()` in
 * `@origintrail-official/dkg-publisher`:
 *
 *   GRAPH <did:dkg:context-graph:<cg>[/<sg>]/_shared_memory_meta> {
 *     <urn:dkg:share:<opId>> a dkg:ShareTransition ;
 *                            dkg:source   "assertion/<agent>/<name>" ;
 *                            dkg:agent    did:dkg:agent:<address> ;
 *                            dkg:timestamp "…"^^xsd:dateTime .
 *   }
 *
 * So on every node — authoring or replica — we can enumerate promoted
 * assertions by listing ShareTransitions and reconstructing the lifecycle
 * URN that the UI already uses as `graphUri` elsewhere. We parse the
 * sub-graph suffix (if any) from the meta graph IRI itself so this keeps
 * working for sub-graph-scoped shares.
 */
export async function listAssertions(
  contextGraphId: string,
  layer: 'wm' | 'swm' = 'wm',
): Promise<AssertionInfo[]> {
  if (layer === 'swm') {
    // SWM membership comes from the canonical `dkg:memoryLayer "SWM"` lifecycle
    // marker in `<cg>/_meta` (flipped from "WM" by promote) — NOT from
    // `dkg:ShareTransition` records in `_shared_memory_meta`. ShareTransitions
    // are written by the ASYNC SWM share (key-setup/gossip) and therefore LAG
    // the promote, so a publish fired right after promoting saw zero shared
    // assertions ("nothing to publish") even though the content was already in
    // SWM. The marker is synchronous and is the same source the WM listing uses.
    // Parsing mirrors the WM branch: accept BOTH the lifecycle-URN and the
    // data-graph-URI marker forms, dedupe by (subGraph, name), and exclude the
    // reserved `meta` sub-graph.
    const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
    const cgPrefix = `did:dkg:context-graph:${contextGraphId}/`;
    const urnPrefix = `urn:dkg:assertion:${contextGraphId}:`;
    // Exclude assertions already PUBLISHED to VM. Publish records a
    // `dkg:vmCurrentAssertion` pointer but (a backend gap — the
    // generateAssertionPublishedMetadata flip's SPARQL gate never matches the
    // lifecycle record) does NOT flip `dkg:memoryLayer` off "SWM", so published
    // assertions would otherwise linger in the Shared-Memory list. The pointer
    // lives on the lifecycle-URN form; key the exclusion by (subGraph, name) so
    // the data-graph-URI marker row for the same assertion is dropped too.
    const sparql = `SELECT ?g ?vm WHERE {
      GRAPH <${metaGraph}> {
        ?g <http://dkg.io/ontology/memoryLayer> "SWM"
        OPTIONAL { ?g <http://dkg.io/ontology/vmCurrentAssertion> ?vm }
      }
      FILTER(!CONTAINS(STR(?g), "/meta/assertion/"))
    }`;
    const data = await executeQuery(sparql, contextGraphId);
    const bindings: any[] = data?.result?.bindings ?? [];
    const published = new Set<string>();
    const rows: Array<{ key: string; name: string; subGraph?: string; g: string }> = [];
    for (const b of bindings) {
      const g = typeof b.g === 'string' ? b.g : b.g?.value;
      if (!g) continue;
      const vm = typeof b.vm === 'string' ? b.vm : b.vm?.value;
      let subGraph: string | undefined;
      let name: string | undefined;
      if (g.startsWith(cgPrefix)) {
        const segments = g.slice(cgPrefix.length).split('/');
        if (segments.length === 3 && segments[0] === 'assertion') {
          name = segments[2];
        } else if (segments.length === 4 && segments[1] === 'assertion') {
          subGraph = segments[0];
          name = segments[3];
        } else {
          continue;
        }
      } else if (g.startsWith(urnPrefix)) {
        const rest = g.slice(urnPrefix.length);
        let m = /^(0x[0-9a-fA-F]{40}):(.+)$/.exec(rest);
        if (m) {
          name = m[2];
        } else {
          m = /^([^:]+):(0x[0-9a-fA-F]{40}):(.+)$/.exec(rest);
          if (m) { subGraph = m[1]; name = m[3]; }
        }
      } else {
        continue;
      }
      if (!name) continue;
      if (subGraph === 'meta') continue;
      const key = `${subGraph ?? ''} ${name}`;
      rows.push({ key, name, subGraph, g });
      if (vm) published.add(key);
    }
    const seen = new Set<string>();
    const result: AssertionInfo[] = [];
    for (const r of rows) {
      if (published.has(r.key) || seen.has(r.key)) continue;
      seen.add(r.key);
      result.push({ name: r.name, graphUri: r.g, subGraph: r.subGraph });
    }
    return result;
  }

  // layer === 'wm'
  //
  // #864 rc.12 follow-up — without `includeContextGraphPartitions`, the
  // daemon's contextGraphId-scoped routing (DKGQueryEngine.query, the
  // `effectiveContextGraphId && !options?.view` branch) restricts
  // `GRAPH ?g { … }` reads to the static allow-list
  //   { <cg>, <cg>/_meta, <cg>/_shared_memory_meta }
  // via `constrainGraphVariablesToAllowedSet`. Every WM assertion lives
  // in a content partition (`<cg>/assertion/<agent>/<name>` or the
  // sub-graph variant `<cg>/<sg>/assertion/<agent>/<name>`) — none of
  // which are in that allow-list — so this enumeration came back empty
  // for any CG no matter how many assertions actually existed.
  // Downstream that surfaced as:
  //   - `AssertionsList` rendered "no assertions" right after import.
  //   - `LayerActionsWidget` showed the correct "Promote N to SWM" badge
  //     (the count comes from `useMemoryEntities`, which already opts
  //     into `includeContextGraphPartitions`), but on click its
  //     `handleAction` loop iterated zero times and hit the no-op
  //     bulk-promote branch — the exact "0 triples promoted" symptom
  //     the rc.12 issue reported even after the publisher-side
  //     `AssertionNotPersistedError` fix landed.
  // Opting into the same partition-aware scope `useMemoryEntities`
  // already uses brings the assertion partitions back into `GRAPH ?g`
  // expansion. Same `/api/query` route, same `postQueryDeduped` cache,
  // same privacy/cost envelope as the dashboard counters.
  // Codex review on #898 — listing WM by raw `GRAPH ?g { ?s ?p ?o }`
  // counts re-listed promoted assertions because `assertionPromote`
  // intentionally leaves daemon-owned `urn:dkg:file:*` /
  // `urn:dkg:extraction:*` quads behind in the assertion data graph
  // (publisher Bug 8 / Round 9 Bug 25 import-bookkeeping filter), so
  // those graphs stay non-empty after promote even though the
  // lifecycle in `_meta` has flipped to `dkg:memoryLayer "SWM"`. The
  // UI was therefore offering Promote on assertions that were no
  // longer in WM. Derive WM membership from the lifecycle marker the
  // publisher itself owns: `<assertionGraphUri> dkg:memoryLayer "WM"`
  // in `<cg>/_meta` (set by `assertionCreate`, flipped to "SWM" by
  // `assertionPromote`). The OPTIONAL keeps WM rows visible even when
  // the data graph is genuinely empty (fresh create with no writes
  // yet), matching the prior listing semantics for that case.
  const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
  const cgPrefix = `did:dkg:context-graph:${contextGraphId}/`;
  // Two scoped queries instead of a single `OPTIONAL { GRAPH ?g { … } }`.
  // The OPTIONAL nested a GRAPH *variable* below the top level of the
  // WHERE block, which the scoped local-query path
  // (`constrainGraphVariablesToAllowedSet`, PR #749) rejects with
  // "GRAPH variables must appear at the top level of scoped local
  // queries". Split the concern:
  //   • `listSparql`  — authoritative WM membership from the fixed
  //     `_meta` graph (no GRAPH variable at all). Includes assertions
  //     whose data partition is still empty (fresh create, no writes),
  //     preserving the prior listing semantics the OPTIONAL existed for.
  //   • `countSparql` — per-partition triple counts with the GRAPH
  //     variable at the top level (guard-safe). Both GRAPH clauses are
  //     siblings at the top of the WHERE block, so the `?g` variable
  //     stays top-level and the guard passes. The leading fixed-graph
  //     join restricts counting to the WM-marked assertion graphs only —
  //     without it the count fanned out over *every* partition under the
  //     CG (SWM/VM/meta included), turning a small WM listing into a full
  //     CG scan. In the UI `includeContextGraphPartitions: true` expands
  //     the allow-list to the assertion partitions so these counts populate.
  // Counts are merged by graph URI; a WM graph with no count row simply
  // renders without a triple badge (the badge is `!= null`-guarded).
  // The two queries fire in parallel, but the count is BEST-EFFORT: it feeds
  // only the triple-count badge, so a count failure (timeout, a future
  // scoped-query edge case) must not reject the whole listing and regress the
  // promote flow back to "no assertions". Its rejection is swallowed to `null`
  // (rows then render with `tripleCount: undefined`); the membership query
  // stays authoritative and its rejection still propagates.
  // Exclude the reserved `meta` namespace. Profile / query-catalog artifacts
  // (prof:Profile, prof:SavedQuery, …) are published as WM-marked assertions
  // under `<cg>/meta/assertion/<addr>/<name>`, so a bare `memoryLayer "WM"`
  // join scoops them in alongside real user knowledge. Since this listing
  // feeds the assertions table + bulk-promote, those UI-config drafts would
  // otherwise be promotable into SWM. Match the reserved bucket by its path
  // SHAPE (`/meta/assertion/`) rather than a `/_meta` suffix: a raw suffix
  // match would also drop a perfectly valid WM assertion whose *name* is
  // `_meta` (names may start with `_`). The parser below keys on the parsed
  // sub-graph segment (`=== 'meta'`), which is fully name-safe.
  const metaFilter = `FILTER(!CONTAINS(STR(?g), "/meta/assertion/"))`;
  const listSparql = `SELECT ?g WHERE {
    GRAPH <${metaGraph}> { ?g <http://dkg.io/ontology/memoryLayer> "WM" }
    ${metaFilter}
  }`;
  // rc.17 per-KA WM: the data graph is …/_working_memory/{addr}/{number} (number-keyed),
  // but the surviving list row is the lifecycle URN (name-keyed). Count the URN's data
  // graph via its dkg:assertionGraph pointer and key by the URN too — else
  // countByGraph.get(urn) is undefined and the triple-count badge is lost for every WM KA.
  //
  // The pointer (`dkg:assertionGraph`) is stamped ONLY on the lifecycle-URN
  // subject form (`urn:dkg:assertion:…`), never on the data-graph-URI form, so
  // a straight INNER join `?g assertionGraph ?dg . GRAPH ?dg { … }` yields exactly
  // one count row per WM KA, already keyed by the URN that the parser keeps below.
  // (The earlier `OPTIONAL { GRAPH <_meta> { … } } BIND(COALESCE(…)) GRAPH ?countGraph`
  // shape was rejected 400 "expected OPTIONAL" by the node's SPARQL engine — the
  // whole count query failed and every WM KA lost its triple badge.) A freshly
  // created WM KA with no data graph yet simply produces no count row and renders
  // without a badge — the badge is `!= null`-guarded, matching prior semantics.
  const countSparql = `SELECT ?g (COUNT(*) AS ?cnt) WHERE {
    GRAPH <${metaGraph}> {
      ?g <http://dkg.io/ontology/memoryLayer> "WM" ;
         <http://dkg.io/ontology/assertionGraph> ?dg
    }
    GRAPH ?dg { ?s ?p ?o }
    ${metaFilter}
  } GROUP BY ?g`;
  const [listData, countData] = await Promise.all([
    postQueryDeduped({ sparql: listSparql, contextGraphId, includeContextGraphPartitions: true }),
    postQueryDeduped({ sparql: countSparql, contextGraphId, includeContextGraphPartitions: true })
      .catch(() => null),
  ]);
  const bindings: any[] = listData?.result?.bindings ?? [];
  const countByGraph = new Map<string, number>();
  for (const b of (countData?.result?.bindings ?? [])) {
    const g = typeof b.g === 'string' ? b.g : b.g?.value;
    const cntRaw = typeof b.cnt === 'string' ? b.cnt : b.cnt?.value;
    // The aggregate comes back as a typed RDF literal whose lexical form can be
    // wrapped: `"21"^^<http://www.w3.org/2001/XMLSchema#integer>`. A bare
    // `parseInt('"21"^^…')` reads the leading quote and yields NaN, which the
    // `isFinite` guard then drops — losing the badge even when the query
    // succeeds. Pull the leading digits past an optional quote, mirroring
    // `listSwmEntities`' `^"?(\d+)` handling of the same value shape.
    const cntMatch = typeof cntRaw === 'string' ? cntRaw.match(/^"?(\d+)/) : null;
    const cnt = cntMatch ? parseInt(cntMatch[1], 10) : NaN;
    if (g && Number.isFinite(cnt)) countByGraph.set(g, cnt);
  }
  // #706 fix — the prior `startsWith('did:dkg:context-graph:<cg>/assertion/')`
  // shape silently dropped sub-graph-scoped WM assertions, whose graph
  // URI is `did:dkg:context-graph:<cg>/<sg>/assertion/<agent>/<name>`
  // (the sub-graph segment sits between `<cg>/` and `/assertion/`).
  // We accept exactly two shapes, post-cgPrefix:
  //   root-bucket : ['assertion', <agent>, <name>]            (3 segs)
  //   sub-graph   : [<subGraphName>, 'assertion', <agent>, <name>] (4 segs)
  // Anything else (extra segments on either side, internal meta
  // graphs sharing the prefix, etc.) is silently dropped. The parse
  // is deliberately strict so a row never gets admitted with a
  // mis-derived name — promote/preview lookups key on `name` and
  // would silently miss otherwise. The cgId itself is treated as
  // opaque (it may contain `/assertion/` as a literal substring,
  // per `validateContextGraphId`).
  // The `dkg:memoryLayer "WM"` marker can sit on EITHER subject form:
  //   • data-graph URI : did:dkg:context-graph:<cg>/[<sg>/]assertion/<agent>/<name>
  //   • lifecycle URN  : urn:dkg:assertion:<cg>:[<sg>:]<agent>:<name>   (canonical,
  //                      `assertionLifecycleUri`, written by every create path)
  // Regular `create` writes BOTH; a FILE IMPORT writes ONLY the URN (the data-URI
  // stamp is import-path-specific). The previous parser accepted only the data-URI
  // form, so it silently dropped every file-imported WM assertion → the bulk-promote
  // loop iterated zero times → "0 triples promoted" even though the content was
  // fully promotable. Accept BOTH forms and dedupe by (subGraph, name).
  const result: AssertionInfo[] = [];
  const seen = new Set<string>();
  const urnPrefix = `urn:dkg:assertion:${contextGraphId}:`;
  // Data-URI rows first: the triple-count badge is keyed on the data graph in
  // `countByGraph`, so preferring that form when both are present keeps the count.
  const ordered = [...bindings].sort((a, b) => {
    const ga = (typeof a.g === 'string' ? a.g : a.g?.value) ?? '';
    const gb = (typeof b.g === 'string' ? b.g : b.g?.value) ?? '';
    return (ga.startsWith(cgPrefix) ? 0 : 1) - (gb.startsWith(cgPrefix) ? 0 : 1);
  });
  for (const b of ordered) {
    const g = typeof b.g === 'string' ? b.g : b.g?.value;
    if (!g) continue;
    let subGraph: string | undefined;
    let name: string | undefined;
    if (g.startsWith(cgPrefix)) {
      const segments = g.slice(cgPrefix.length).split('/');
      if (segments.length === 3 && segments[0] === 'assertion') {
        name = segments[2];
      } else if (segments.length === 4 && segments[1] === 'assertion') {
        subGraph = segments[0];
        name = segments[3];
      } else {
        continue;
      }
    } else if (g.startsWith(urnPrefix)) {
      // `<agent>` is a 0x EVM address (no colons); `<name>` MAY contain ':'.
      // Peel the agent deterministically — whatever precedes it (if anything)
      // is the sub-graph segment, the greedy remainder is the name.
      const rest = g.slice(urnPrefix.length);
      let m = /^(0x[0-9a-fA-F]{40}):(.+)$/.exec(rest);
      if (m) {
        name = m[2];
      } else {
        m = /^([^:]+):(0x[0-9a-fA-F]{40}):(.+)$/.exec(rest);
        if (m) { subGraph = m[1]; name = m[3]; }
      }
    } else {
      continue;
    }
    if (!name) continue;
    // Defense-in-depth for the meta-namespace exclusion above: the reserved
    // `meta` sub-graph (`<cg>/meta/assertion/…` profile/query-catalog drafts)
    // is UI configuration, not user knowledge, and must never reach the
    // assertions table or the bulk-promote flow. The SPARQL `metaFilter`
    // already drops these daemon-side; this guards the parser too.
    if (subGraph === 'meta') continue;
    const key = `${subGraph ?? ''}\0${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cnt = countByGraph.get(g);
    result.push({ name, graphUri: g, tripleCount: cnt, subGraph });
  }
  return result;
}

/**
 * Promote an assertion from WM to SWM.
 *
 * PR #710 fix — `subGraphName` is the third part of the daemon's
 * lookup key alongside `(contextGraphId, assertionName)`. Without
 * it, promoting a sub-graph-scoped assertion either 404s or
 * silently promotes a same-named root-bucket assertion. The
 * daemon route already accepts the field
 * (`packages/cli/src/daemon/routes/assertion.ts:820-823`); only
 * spread it when supplied so root-bucket promotes keep the prior
 * wire shape.
 */
export const promoteAssertion = (
  contextGraphId: string,
  assertionName: string,
  entities: string | string[] = 'all',
  subGraphName?: string,
) =>
  post<{ promotedCount: number }>(
    `/api/knowledge-assets/${encodeURIComponent(assertionName)}/swm/share`,
    { contextGraphId, entities, ...(subGraphName ? { subGraphName } : {}) },
  );

// Issue #864 — central UI translator for `promoteAssertion` outcomes so
// every call-site speaks the same language. Two shapes get massaged
// here that the bare-promotedCount path used to render confusingly:
//
//   • `promotedCount === 0` is technically a success but normally
//     means "the assertion graph was already empty when promote ran"
//     (already-promoted re-click, discarded draft, or — the rc.12
//     bug from issue #864 — a transient state where _meta indicates
//     persistence but the data graph isn't visible yet). Surface that
//     ambiguity instead of the misleading literal "Promoted 0 triples
//     to Shared Memory" toast.
//   • An HttpError with `body.code === 'ASSERTION_NOT_PERSISTED'`
//     (the new 409 from the /promote route) means we caught the
//     inconsistency on the daemon side. Re-render the daemon's hint
//     as a UI-friendly sentence that includes the expected count so
//     the user understands re-import is the recovery path.
export type PromoteOutcome =
  | { kind: 'success'; promotedCount: number; message: string }
  | { kind: 'noop'; message: string }
  | { kind: 'not-persisted'; message: string; expectedTripleCount?: number }
  | { kind: 'payload-too-large'; message: string; actualBytes?: number; limitBytes?: number };

export function describePromoteResult(
  assertionName: string,
  res: { promotedCount: number },
): PromoteOutcome {
  if (res.promotedCount > 0) {
    return {
      kind: 'success',
      promotedCount: res.promotedCount,
      message: `Promoted ${res.promotedCount} triple${res.promotedCount === 1 ? '' : 's'} from ${assertionName} to Shared Working Memory.`,
    };
  }
  return {
    kind: 'noop',
    message: `${assertionName} had no triples to promote. It may already be in Shared Working Memory, or the extracted content is still being committed — refresh and try again.`,
  };
}

export function describePromoteError(
  assertionName: string,
  err: unknown,
): PromoteOutcome | null {
  if (err instanceof HttpError && err.status === 413) {
    const body = err.body as {
      code?: string;
      actualBytes?: number;
      limitBytes?: number;
      hint?: string;
    } | undefined;
    if (body?.code === 'SWM_GOSSIP_PAYLOAD_TOO_LARGE') {
      const hint = typeof body.hint === 'string' && body.hint.length > 0
        ? body.hint
        : 'Promote fewer entities per call or split the assertion into smaller root-entity batches.';
      return {
        kind: 'payload-too-large',
        actualBytes: typeof body.actualBytes === 'number' ? body.actualBytes : undefined,
        limitBytes: typeof body.limitBytes === 'number' ? body.limitBytes : undefined,
        message: `${assertionName} is too large to promote to Shared Working Memory. ${hint}`,
      };
    }
  }
  if (err instanceof HttpError && err.status === 409) {
    const body = err.body as { code?: string; expectedTripleCount?: number } | undefined;
    if (body?.code === 'ASSERTION_NOT_PERSISTED') {
      const expected = typeof body.expectedTripleCount === 'number' ? body.expectedTripleCount : undefined;
      return {
        kind: 'not-persisted',
        expectedTripleCount: expected,
        message: expected
          ? `${assertionName} was imported with ${expected} extracted triple${expected === 1 ? '' : 's'} but the data graph is empty. Re-import the source file (or re-write the assertion) before promoting.`
          : `${assertionName}'s data graph is empty but its extraction metadata says it should hold content. Re-import the source file before promoting.`,
      };
    }
  }
  return null;
}

// --- Publisher Conviction Accounts (PCA) ----------------------------------
//
// Client helpers for the daemon's `/api/pca/*` routes (see
// `packages/cli/src/daemon/routes/pca.ts`). They route through the private
// `get`/`post`/`delJson` so they inherit same-origin base, bearer auth, and
// `HttpError`-shaped failures — never hand-roll `fetch` here.
//
// Terminology discipline (PCA UX §P1): the registered identity is the
// OPERATIONAL WALLET that signs publishes (`msg.sender`). User-facing copy in
// `describePcaError` says "approved publishing wallet" / "operational wallet",
// never the contract word "agent" (which survives only in the route/field
// identifiers like `pcaAddAgent` and the `AgentAlreadyRegistered` error code).

/** A wallet-probe result, present on `fetchPca(id, key)` (the `?key=` query). */
export interface PcaProbedKey {
  key: string;
  /** Whether `key` is an approved publishing wallet on this account. */
  registered?: boolean;
  /** False only when the chain adapter can't answer (capability gap). */
  adapterSupported?: boolean;
  /** Set instead of `registered` when `key` isn't a valid EVM address. */
  error?: string;
}

/**
 * A PCA snapshot — mirrors the daemon's `serializeAccountInfo`
 * (`pca.ts:138`). Wei amounts are decimal strings (`committedTRAC`); the
 * matching `*Trac` fields are pre-formatted ether strings. Epoch indices and
 * timestamps are numbers; `*Timestamp` are unix SECONDS (multiply by 1000 for
 * a JS `Date`).
 *
 * The EXTENDED group (`primaryNode`, `lastPrimaryNodeChangeEpoch`,
 * `remainingAllowance`(+Trac), `currentEpoch`) is GAP-4/5, only serialized when
 * the GET route is called with `{ extended: true }`. They are optional because
 * the daemon can fail-soft an extended chain read and still return the core
 * snapshot. `extendedRequested` is a client-side marker added by `fetchPca` so
 * coverage code can tell "not requested" from "requested but unavailable".
 */
export interface PcaSnapshot {
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
  probedKey?: PcaProbedKey;
  // --- Extended (P2 / `?extended=1` only — undefined in P0) ---
  /** The node identityId this PCA directs publishing-reward weight to (uint72 string). */
  primaryNode?: string;
  /** Epoch index of the last `setPrimaryNode` change. */
  lastPrimaryNodeChangeEpoch?: number;
  /** Spendable allowance remaining in the current epoch (wei string). */
  remainingAllowance?: string;
  /** Pre-formatted ether form of `remainingAllowance`. */
  remainingAllowanceTrac?: string;
  /** The current protocol epoch index (resolves the lock-period readout). */
  currentEpoch?: number;
  /** Client-side only: this snapshot came from a `fetchPca(..., { extended:true })` read. */
  extendedRequested?: boolean;
}

export interface CreatePcaResult {
  accountId: string;
  txHash?: string;
  blockNumber?: number;
  committedTokens: string;
}

export interface PcaAddAgentResult {
  accountId: string;
  agent: string;
  /** The daemon re-reads the chain after the tx; trust this over a bare 200. */
  registered: boolean;
  adapterSupported: boolean;
  txHash?: string;
  blockNumber?: number;
}

export interface PcaRemoveAgentResult {
  accountId: string;
  agent: string;
  deregistered: boolean;
  txHash?: string;
  blockNumber?: number;
}

export interface PcaTopUpResult {
  accountId: string;
  addedTokens: string;
  txHash?: string;
  blockNumber?: number;
}

export interface PcaSettleResult {
  accountId: string;
  settled: boolean;
  txHash?: string;
  blockNumber?: number;
}

/**
 * GET a PCA snapshot. Pass `key` (an operational wallet address) to additionally
 * probe whether that wallet is an approved publishing wallet on the account
 * (the result lands on `snapshot.probedKey`). `GET` is permissionless.
 *
 * `opts.extended` (`?extended=1`) requests the GAP-4/5 extended fields
 * (primaryNode / remainingAllowance / currentEpoch). The returned snapshot is
 * marked with `extendedRequested` because the daemon may fail-soft and omit the
 * optional fields; spend-time coverage must then become inconclusive instead of
 * falling back to nominal `baseEpochAllowance`.
 */
export const fetchPca = (
  accountId: string,
  key?: string,
  opts?: { extended?: boolean },
) => {
  const params = new URLSearchParams();
  if (key) params.set('key', key);
  if (opts?.extended) params.set('extended', '1');
  const qs = params.toString();
  return getJson<PcaSnapshot>(`/api/pca/${encodeURIComponent(accountId)}${qs ? `?${qs}` : ''}`)
    .then((snap) => (opts?.extended ? { ...snap, extendedRequested: true } : snap));
};

/** Create a PCA (commit TRAC for a publishing discount). Owner = the daemon EOA. */
export const createPca = (args: { tokens: string; primaryNode: string }) =>
  post<CreatePcaResult>('/api/pca', { tokens: args.tokens, primaryNode: args.primaryNode });

/** Approve an operational wallet as a publishing wallet on a PCA (owner-gated). */
export const pcaAddAgent = (accountId: string, address: string) =>
  post<PcaAddAgentResult>(`/api/pca/${encodeURIComponent(accountId)}/agent`, { agent: address });

/** Remove an approved publishing wallet from a PCA (owner-gated). */
export const pcaRemoveAgent = (accountId: string, address: string) =>
  delJson<PcaRemoveAgentResult>(
    `/api/pca/${encodeURIComponent(accountId)}/agent/${encodeURIComponent(address)}`,
  );

/** Top up a PCA's spendable buffer (owner-gated). Does NOT extend the lock period. */
export const pcaTopUp = (accountId: string, tokens: string) =>
  post<PcaTopUpResult>(`/api/pca/${encodeURIComponent(accountId)}/funds`, { tokens });

/** Run the lazy-settlement sweep (permissionless — enabled even for non-owners). */
export const pcaSettle = (accountId: string) =>
  post<PcaSettleResult>(`/api/pca/${encodeURIComponent(accountId)}/settle`, {});

export interface PcaAgentsResult {
  accountId: string;
  /** The FULL set of approved publishing-wallet addresses (checksummed). `[]` = a
   *  real 0-approved account, distinct from a 404 (unknown account). */
  agents: string[];
}

/**
 * B3 — list the approved publishing wallets on a PCA (the full on-chain enumerator,
 * vs just this node's wallets the detail view can probe). Existence-checked like
 * {@link fetchPca}: an unknown account 404s (so the caller distinguishes "no such
 * account" from `agents: []`); 503 = capability/transport. `GET` is permissionless.
 */
export const listPcaAgents = (accountId: string) =>
  getJson<PcaAgentsResult>(`/api/pca/${encodeURIComponent(accountId)}/agents`);

export interface PcaAgentAccountResult {
  /** Echoed checksummed address that was queried. */
  agent: string;
  /** The PCA this wallet is an approved publishing wallet on, or `null` if none. A
   *  wallet is approved on at most one account, so this is a direct answer. */
  accountId: string | null;
}

/**
 * GAP-3 — resolve which PCA (if any) an operational wallet is an approved publishing
 * wallet on (`GET /api/pca/agent/:address`). A faster/authoritative path than probing
 * each tracked account; `accountId: null` = not a publishing agent anywhere. 400 =
 * invalid address, 503 = capability/transport. NOTE: this is a discovery/optimization
 * primitive only — coverage MUST still resolve via `fetchPca` → `classifyCoverage`
 * (registered ≠ covered; the #1344 honesty line). `GET` is permissionless.
 */
export const pcaAgentAccount = (address: string) =>
  getJson<PcaAgentAccountResult>(`/api/pca/agent/${encodeURIComponent(address)}`);

export interface MyPcaEntry extends Partial<PcaSnapshot> {
  accountId: string;
  relation: 'owned' | 'agent' | 'both';
}

/**
 * GAP-1 enumeration route: every PCA this node relates to through owned PCA
 * NFTs and/or approved operational publishing wallets. Hydration is best
 * effort server-side, so relation rows remain useful even when snapshot fields
 * are omitted.
 */
export const fetchMyPcas = (opts?: { hydrate?: boolean }) =>
  getJson<{ accounts: MyPcaEntry[] }>(`/api/pca/mine${opts?.hydrate ? '?hydrate=1' : ''}`);

/**
 * One staked sharding-table node, as the API returns it. `identityId` (DECIMAL string) is the
 * on-chain id a PCA designates as its `primaryNode` (the value Create submits); `nodeId` is a HEX
 * string (on-chain `bytes`, the node's self-reported id → shown only as an "unverified" label);
 * `stake`/`ask` are wei strings. `ask` is REQUIRED on the API type — the route always sends it; the
 * picker just doesn't display it, so its separate prop type omits `ask` (don't loosen this contract).
 */
export interface DesignatableNode {
  /** Hex string (`0x…`) — the node's self-reported id; display-only ("unverified"). */
  nodeId: string;
  /** Decimal string — the on-chain identity; the value passed as `primaryNode`. */
  identityId: string;
  /** Wei string. */
  stake: string;
  /** Wei string; returned by the route, not shown in the picker. */
  ask: string;
}

/** The sharding table is capped (≤500), read+cached whole, and the UI drains it whole, so the route
 *  returns the FULL list in one response (no offset pagination). */
export interface DesignatableNodesResult {
  nodes: DesignatableNode[];
  /** Total nodes in the sharding table. */
  total: number;
}

/**
 * The staked sharding-table nodes for the PrimaryNodePicker. The daemon reads the whole (≤500) table,
 * TTL-caches it, and returns it in ONE response (no pagination). A read failure 503s
 * (`SHARDING_TABLE_READ_FAILED` / transport / capability) — all retryable; the picker shows a retry,
 * and `primaryNode` is required so edge can't proceed until it loads. `fresh:true` BYPASSES the
 * daemon's 30s TTL cache + repopulates it — used by the picker Retry + the
 * `PrimaryNodeNotInShardingTable` recovery so a just-(un)staked node is seen immediately, not after
 * the stale window. `GET` is permissionless.
 */
export const listDesignatableNodes = (opts?: { fresh?: boolean }) =>
  getJson<DesignatableNodesResult>(
    `/api/pca/designatable-nodes${opts?.fresh ? '?fresh=1' : ''}`,
  );

/**
 * Resolved PCA contract addresses + chain — the bootstrap the in-browser wallet (web3) layer needs.
 * The daemon resolves these via its Hub config (the browser does NOT re-resolve the Hub). Minimal
 * set: the NFT wrapper (every wallet-signed write + the ERC721Enumerable owned-PCA walk + the mint
 * `Transfer` accountId decode all target it), the TRAC token (approve/allowance), the chain id, and
 * the browser-safe RPC endpoints for a viem publicClient. `nativeCurrency` is NOT here — the browser
 * derives the gas symbol from `nativeGasSymbol(chainId)`.
 */
export interface PcaContracts {
  /** DKGPublishingConvictionNFT address (EIP-55). */
  nft: string;
  /** TRAC ERC-20 address (EIP-55) — `approve`/`allowance`. */
  token: string;
  /** Chain id; may be the compound `"slug:chainId"` form (e.g. `"base:84532"`) — extract the numeric
   *  tail for the viem `Chain.id`. */
  chainId: string | number;
  /** Browser-safe RPC endpoints for the viem publicClient (reads + receipt polling). */
  rpcUrls: string[];
  /** Optional wallet-public RPC endpoints safe to hand to wallet_addEthereumChain. */
  walletRpcUrls?: string[];
}

/**
 * Bootstrap the in-browser web3 layer (contract addresses + chain). `GET` is permissionless. A node
 * without the PCA contract deployed 503s `FEATURE_UNAVAILABLE` (same family as the other PCA routes →
 * a clean "unavailable" state); an address-read failure 503s `CONTRACTS_READ_FAILED` (retryable).
 */
export const listPcaContracts = () => getJson<PcaContracts>('/api/pca/contracts');

/** Normalized, terminology-disciplined PCA error code (UI branches on this). */
export type PcaErrorCode =
  | 'FEATURE_UNAVAILABLE'
  | 'CONTRACTS_READ_FAILED'
  | 'InvalidAmount'
  | 'PrimaryNodeNotInShardingTable'
  | 'ZeroPrimaryNode'
  | 'PrimaryNodeUnchanged'
  | 'PrimaryNodeChangeRateLimited'
  | 'ZeroAgentAddress'
  | 'TokenTransferFailed'
  | 'NotAccountOwner'
  | 'UnknownAccount'
  | 'AgentAlreadyRegistered'
  | 'AgentNotRegistered'
  | 'AgentCapReached'
  | 'AccountExpired'
  | 'AccountAlreadyFullySettled'
  | 'BadRequest'
  | 'Conflict'
  | 'ServerError'
  | 'Unknown';

export interface PcaErrorInfo {
  code: PcaErrorCode;
  status: number;
  /** User-facing copy ("approved publishing wallet", never "agent"). */
  message: string;
  /**
   * B10: the conviction account a wallet is ALREADY approved on, surfaced on
   * `AgentAlreadyRegistered`. The P1 daemon NOW returns it (`resolveConflictingAccountId`
   * + the register route populate it), so `describePcaError` names "PCA #M — deregister
   * it there first". It is `undefined` only on the rare case the daemon can't resolve the
   * id, where the copy degrades to "another PCA".
   */
  existingAccountId?: string;
}

/**
 * A transient RPC-transport failure (the daemon's failover layer exhausted /
 * timed out), distinguished by the body code: `RPC_*` (e.g. RPC_ENDPOINTS_EXHAUSTED
 * → 503, RPC_RECEIPT_LOOKUP_FAILED → 503) OR the bare `TIMEOUT` the chain-tx
 * timeout 504 carries (http-utils RPC_TIMEOUT surfaces as `code:'TIMEOUT'`). NOT
 * a capability gap — the feature exists, the chain read just hiccupped, so it
 * must not gate the tab. (The double-mint guard is UNAFFECTED — it keys on
 * `err.status===504` directly, before this.)
 */
export function isRpcTransportError(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false;
  const code = (err.body as { code?: string } | undefined)?.code;
  return typeof code === 'string' && (code.startsWith('RPC_') || code === 'TIMEOUT');
}

/**
 * Whether an error is the daemon's CAPABILITY 503 — PCA isn't deployed on this
 * network. A transport 503/504 (`RPC_*` code) is explicitly excluded so a
 * transient RPC blip during the mount probe doesn't falsely lock the whole tab.
 */
export function isPcaFeatureUnavailable(err: unknown): boolean {
  return err instanceof HttpError && err.status === 503 && !isRpcTransportError(err);
}

export function isPcaReadFailed(err: unknown): boolean {
  if (!(err instanceof HttpError) || err.status !== 503) return false;
  const body = err.body as { code?: string; error?: string } | undefined;
  return body?.code === 'PCA_LOOKUP_READ_FAILED' || body?.error === 'PCA_LOOKUP_READ_FAILED';
}

// Code tokens the daemon embeds in the `{ error }` body (a bare code on a
// contract revert, or a longer sentence like "NotAccountOwner — daemon EOA is
// not the PCA owner"). Matched by word boundary, most-specific intent first.
const PCA_ERROR_CODES: PcaErrorCode[] = [
  'PrimaryNodeNotInShardingTable',
  'PrimaryNodeUnchanged',
  'PrimaryNodeChangeRateLimited',
  'ZeroPrimaryNode',
  'InvalidAmount',
  'ZeroAgentAddress',
  'TokenTransferFailed',
  'NotAccountOwner',
  'AgentAlreadyRegistered',
  'AgentNotRegistered',
  'AgentCapReached',
  'AccountExpired',
  'AccountAlreadyFullySettled',
  'UnknownAccount',
];

/**
 * Map a PCA route failure to terminology-disciplined, user-facing copy —
 * the PCA counterpart to {@link describePromoteError}. Branches on
 * `HttpError.status` + the `{ error }` body code. Returns `null` for
 * non-`HttpError` throwables so the caller falls back to `err.message`;
 * for any `HttpError` it always returns a populated `PcaErrorInfo`.
 *
 * `opts.accountId` lets the copy name the precise "PCA #N".
 */
export function describePcaError(
  err: unknown,
  opts: { accountId?: string } = {},
): PcaErrorInfo | null {
  if (!(err instanceof HttpError)) return null;
  const status = err.status;
  const body = (err.body ?? {}) as { error?: string; existingAccountId?: string | number };
  const raw = typeof body.error === 'string' && body.error.length > 0 ? body.error : err.message;
  const pcaRef = opts.accountId ? `PCA #${opts.accountId}` : 'this Publisher Conviction Account';
  const existingAccountId =
    body.existingAccountId != null ? String(body.existingAccountId) : undefined;

  // Transient RPC-transport outage (RPC_* code, 503/504) — NOT a capability gap.
  // Check before the capability-503 branch so a failover blip reads as
  // "try again", not "not available on this network".
  if (isRpcTransportError(err)) {
    return {
      code: 'ServerError',
      status,
      message: 'The chain RPC is temporarily unavailable — try again.',
    };
  }

  // 503 (without an RPC_* code) is the network-capability gate.
  if (status === 503) {
    return {
      code: 'FEATURE_UNAVAILABLE',
      status,
      message: "Publisher Conviction Accounts aren't available on this network.",
    };
  }

  const matched = PCA_ERROR_CODES.find((c) => new RegExp(`\\b${c}\\b`).test(raw));
  if (matched) {
    let message: string;
    switch (matched) {
      case 'InvalidAmount':
        message = 'Enter a TRAC amount greater than 0.';
        break;
      case 'PrimaryNodeNotInShardingTable':
        message = "That primary node isn't a staked node in the sharding table.";
        break;
      case 'ZeroPrimaryNode':
        message = 'Choose a staked node as the primary node.';
        break;
      case 'PrimaryNodeUnchanged':
        message = "That's already this account's primary node.";
        break;
      case 'PrimaryNodeChangeRateLimited':
        message = 'The primary node was changed too recently — try again later.';
        break;
      case 'ZeroAgentAddress':
        message = 'Enter a valid operational wallet address.';
        break;
      case 'TokenTransferFailed':
        message = "The TRAC transfer failed — check the owner wallet's TRAC balance and allowance.";
        break;
      case 'NotAccountOwner':
        message = `This node isn't the owner of ${pcaRef}, so it can't manage it.`;
        break;
      case 'UnknownAccount':
        message = `${pcaRef} doesn't exist.`;
        break;
      case 'AgentAlreadyRegistered':
        message = existingAccountId
          ? `This operational wallet is already an approved publishing wallet on PCA #${existingAccountId} — deregister it there first.`
          : 'This operational wallet is already approved on another PCA — deregister it there first.';
        break;
      case 'AgentNotRegistered':
        message = `This operational wallet isn't an approved publishing wallet on ${pcaRef}.`;
        break;
      case 'AgentCapReached':
        message = `${pcaRef} already has the maximum 100 approved publishing wallets.`;
        break;
      case 'AccountExpired':
        message = `${pcaRef} has expired.`;
        break;
      case 'AccountAlreadyFullySettled':
        message = `${pcaRef} is already fully settled.`;
        break;
      default:
        message = raw;
    }
    return { code: matched, status, message, ...(existingAccountId ? { existingAccountId } : {}) };
  }

  // No code token matched — fall back to a status-shaped default. 404 (the
  // GET route returns "Unknown PCA accountId N", which carries no code token)
  // and 403 still get friendly copy; 400 surfaces the daemon's validation
  // sentence (already readable); 5xx is generic.
  if (status === 404) {
    return { code: 'UnknownAccount', status, message: `${pcaRef} doesn't exist.` };
  }
  if (status === 403) {
    return {
      code: 'NotAccountOwner',
      status,
      message: `This node isn't the owner of ${pcaRef}, so it can't manage it.`,
    };
  }
  if (status === 400) {
    return { code: 'BadRequest', status, message: raw };
  }
  if (status === 409) {
    return { code: 'Conflict', status, message: raw };
  }
  if (status >= 500) {
    return {
      code: 'ServerError',
      status,
      message: 'Something went wrong talking to the chain — try again.',
    };
  }
  return { code: 'Unknown', status, message: raw };
}

// --- File preview ---

export interface ExtractionStatus {
  assertionUri: string;
  status: string;
  fileHash: string;
  detectedContentType: string;
  pipelineUsed: string | null;
  tripleCount: number;
  mdIntermediateHash?: string;
  startedAt: string;
  completedAt?: string;
}

/**
 * Fetch extraction status for an assertion (includes fileHash + contentType).
 *
 * PR #710 Fix E — `subGraphName` is the third part of the daemon's
 * lookup key alongside `(contextGraphId, assertionName)`. The route
 * already accepts the query param
 * (`packages/cli/src/daemon/routes/assertion.ts:3364`); only set it
 * when supplied so root-bucket calls keep the prior URL shape.
 */
export const fetchExtractionStatus = (
  assertionName: string,
  contextGraphId: string,
  subGraphName?: string,
) => {
  const params = new URLSearchParams({ contextGraphId });
  if (subGraphName) params.set('subGraphName', subGraphName);
  return get<ExtractionStatus>(
    `/api/knowledge-assets/${encodeURIComponent(assertionName)}/wm/extraction-status?${params}`,
  );
};

/** Build a URL to serve a stored file by its hash (sha256: or keccak256:). */
export function fileUrl(hash: string, contentType?: string): DaemonPath {
  const normalizedHash = hash.startsWith('sha256:') || hash.startsWith('keccak256:')
    ? hash
    : `sha256:${hash}`;
  const params = contentType ? `?contentType=${encodeURIComponent(contentType)}` : '';
  return apiDaemonPath(`/api/file/${encodeURIComponent(normalizedHash)}${params}`);
}

/**
 * The post-publish CostCovered signal (B8) — decoded by the daemon from the on-chain
 * `CostCovered(accountId, epoch, baseCost, discountedCost, drawnFromEpoch, drawnFromTopUp)`
 * event and attached to the publish response when the publish drew on a PCA (absent
 * otherwise → the badge degrades to hidden, #9). Lives at the api boundary so both the
 * publish response and the `pca_cost_covered` bell meta reuse it. Wei amounts are decimal
 * strings; `epoch` is a JSON number (uint40, fits safely in Number).
 */
export interface ConvictionCostCovered {
  accountId?: string;
  epoch?: number;
  baseCost: string;
  discountedCost: string;
  drawnFromEpoch: string;
  drawnFromTopUp: string;
}

export interface PublishResult {
  kaId: string;
  status: string;
  kas: { tokenId: string; rootEntity: string }[];
  txHash?: string;
  blockNumber?: number;
  // B8 — the CONFIRMED post-publish discount, attached when this publish drew on a
  // PCA (absent otherwise → DiscountAppliedBadge renders nothing, #9). Distinct from
  // S5's pre-spend PREDICTION; the badge derives bps from baseCost/discountedCost.
  convictionCostCovered?: ConvictionCostCovered;
  // Set when the daemon returned HTTP 207 (PR #972): the KA minted on-chain
  // (status "confirmed", txHash present) BUT the context-graph binding failed.
  // A PARTIAL publish — the asset is permanently on-chain, but it isn't linked
  // into the context graph, so CG-scoped views may be incomplete. Re-publishing
  // does NOT repair the binding (the KA is already minted); this is a node-side
  // condition for the operator. Callers must surface it, not treat the
  // confirmed/txHash result as a clean success.
  contextGraphError?: string;
}

/**
 * Short status suffix for a 207 partial publish — appended to a "confirmed"
 * status so the row reads as a warning, not a clean success.
 */
export const PARTIAL_PUBLISH_STATUS_SUFFIX = 'binding incomplete';

/**
 * The single, canonical explanation for a 207 partial publish, shared by every
 * publish CTA so the copy can't drift. Accurate to the contract: the asset is
 * already on-chain and re-publishing will NOT repair the context-graph binding
 * — so this surfaces the condition to the node operator WITHOUT suggesting a
 * republish. The daemon's `contextGraphError` detail is appended when present.
 */
export function partialPublishWarning(contextGraphError?: string): string {
  const base =
    'Published on-chain, but linking it into the context graph did not complete, ' +
    'so context-graph views may be incomplete.';
  return contextGraphError ? `${base} (${contextGraphError})` : base;
}

// --- Query history ---
export const fetchQueryHistory = (limit = 50, offset = 0) =>
  get<{ history: any[] }>(`/api/query-history?limit=${limit}&offset=${offset}`);

// --- Saved queries ---
export const fetchSavedQueries = () => get<{ queries: any[] }>('/api/saved-queries');
export const createSavedQuery = (data: { name: string; description?: string; sparql: string }) =>
  post<{ id: number }>('/api/saved-queries', data);
export const updateSavedQuery = (id: number, data: any) =>
  put<{ ok: boolean }>(`/api/saved-queries/${id}`, data);
export const deleteSavedQuery = (id: number) =>
  del<{ ok: boolean }>(`/api/saved-queries/${id}`);

// --- Memory (private chat memories in DKG) ---
export interface MemorySession {
  session: string;
  messages: Array<{
    uri: string;
    author: string;
    text: string;
    ts: string;
    turnId?: string;
    persistStatus?: 'pending' | 'in_progress' | 'stored' | 'failed' | 'skipped';
    failureReason?: string | null;
    attachmentRefs?: LocalAgentChatAttachmentRef[];
    toolCalls?: Array<{ name: string; args: Record<string, unknown>; result: unknown }>;
  }>;
}
export interface MemorySessionGraphDeltaWatermark {
  baseTurnId: string | null;
  previousTurnId: string | null;
  appliedTurnId: string | null;
  latestTurnId: string | null;
  turnIndex: number;
  turnCount: number;
}
export interface MemorySessionGraphDelta {
  mode: 'delta' | 'full_refresh_required';
  reason?: 'session_empty' | 'turn_not_found' | 'missing_watermark' | 'watermark_mismatch';
  sessionId: string;
  turnId: string;
  watermark: MemorySessionGraphDeltaWatermark;
  triples: Array<{ subject: string; predicate: string; object: string }>;
}
export const fetchMemorySessions = (limit = 20) =>
  get<{ sessions: MemorySession[] }>(`/api/memory/sessions?limit=${limit}`);
export const fetchMemorySession = (
  sessionId: string,
  opts: {
    limit?: number;
    order?: 'asc' | 'desc';
  } = {},
) => {
  const params = new URLSearchParams();
  if (opts.limit && Number.isInteger(opts.limit) && opts.limit > 0) {
    params.set('limit', String(opts.limit));
  }
  if (opts.order === 'desc' || opts.order === 'asc') {
    params.set('order', opts.order);
  }
  const query = params.toString();
  return get<MemorySession>(
    `/api/memory/sessions/${encodeURIComponent(sessionId)}${query ? `?${query}` : ''}`,
  );
};
export const fetchMemorySessionGraphDelta = (
  sessionId: string,
  turnId: string,
  opts: { baseTurnId?: string | null } = {},
) => {
  const params = new URLSearchParams();
  params.set('turnId', turnId);
  if (opts.baseTurnId) params.set('baseTurnId', opts.baseTurnId);
  return get<MemorySessionGraphDelta>(
    `/api/memory/sessions/${encodeURIComponent(sessionId)}/graph-delta?${params.toString()}`,
  );
};

// IMPORT_SOURCES / ImportSource / ImportMemoryQuad / ImportMemoryResult /
// importMemories were retired with /api/memory/import as part of the
// openclaw-dkg-primary-memory work. Agents write memory via
// the adapter's dkg_memory_import tool, and file-import flows go through
// /api/assertion/:name/import-file directly.

// --- OpenClaw agents ---
export interface OpenClawAgent {
  peerId: string;
  name: string;
  description?: string;
  framework: string;
  connected: boolean;
  lastSeen: number | null;
  latencyMs: number | null;
}

export const fetchOpenClawAgents = () =>
  get<{ agents: OpenClawAgent[] }>('/api/openclaw-agents');

export interface LocalAgentChatAttachmentRef {
  id?: string;
  fileName: string;
  contextGraphId: string;
  assertionName?: string;
  assertionUri: string;
  fileHash: string;
  detectedContentType?: string;
  extractionStatus?: 'completed';
  tripleCount?: number;
  rootEntity?: string;
  mdIntermediateHash?: string;
  markdownHash?: string;
  markdownForm?: string;
}

export interface LocalAgentChatAttachmentImportResult {
  id?: string;
  fileName: string;
  contextGraphId: string;
  assertionName?: string;
  assertionUri: string;
  fileHash: string;
  detectedContentType: string;
  extractionStatus: 'skipped';
  pipelineUsed?: string | null;
  tripleCount?: number;
  rootEntity?: string;
  mdIntermediateHash?: string;
  error?: string;
}

export interface LocalAgentChatContextEntry {
  key: string;
  label: string;
  value: string;
}

interface LocalAgentChatRequestOptions {
  correlationId?: string;
  signal?: AbortSignal;
  identity?: string;
  sessionId?: string;
  profile?: string;
  persistUserMessage?: string;
  attachments?: LocalAgentChatAttachmentRef[];
  attachmentImportResults?: LocalAgentChatAttachmentImportResult[];
  contextEntries?: LocalAgentChatContextEntry[];
  /**
   * UI-selected project context graph for this turn. Forwarded unchanged as
   * `contextGraphId`; the local agent may use it as contextual signal, while
   * explicit DKG write tools still choose their own target graph.
   */
  contextGraphId?: string;
}

export const sendOpenClawChat = (peerId: string, text: string) =>
  post<{ delivered: boolean; reply: string | null; timedOut: boolean; waitMs: number; error?: string }>(
    '/api/chat-openclaw',
    { peerId, text },
  );

// --- OpenClaw local channel bridge ---

export interface LocalAgentChatResponse {
  text: string;
  correlationId: string;
  sessionId?: string;
  turnId?: string;
}

export interface LocalAgentChatFailurePersistenceOptions {
  sessionId?: string;
  correlationId?: string;
  userMessage: string;
  assistantReply?: string;
  failureReason?: string;
  profile?: string;
  attachments?: LocalAgentChatAttachmentRef[];
  contextGraphId?: string;
}

export interface LocalAgentChatFailurePersistenceResponse {
  ok?: boolean;
  turnId?: string;
}

export async function sendOpenClawLocalChat(
  text: string,
  opts?: LocalAgentChatRequestOptions,
): Promise<LocalAgentChatResponse> {
  const res = await apiFetch(apiDaemonPath('/api/openclaw-channel/send'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildLocalAgentChatBody(text, opts)),
    signal: opts?.signal,
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw buildLocalAgentApiError(errBody, `Request failed (${res.status})`, res.status);
  }
  return res.json();
}

export type OpenClawStreamEvent =
  | { type: 'text_delta'; delta: string }
  | ({ type: 'final' } & LocalAgentChatResponse)
  | ({
      type: 'error';
      error: string;
      code?: string;
      source?: string;
      details?: string;
      correlationId?: string;
      timeoutMs?: number;
      target?: string;
      route?: string;
      integrationId?: string;
      retryable?: boolean;
    });

type HermesRawStreamEvent =
  | OpenClawStreamEvent
  | { type: 'delta'; text?: string; correlationId?: string };

export type LocalAgentChannelTarget = 'bridge' | 'gateway';

export interface LocalAgentHealthResponse {
  ok: boolean;
  target?: LocalAgentChannelTarget;
  error?: string;
  profile?: string;
  memory?: string | {
    provider?: string;
    mode?: string;
    status?: string;
    conflict?: boolean;
    error?: string;
  };
  status?: string;
  bridge?: Omit<LocalAgentHealthResponse, 'bridge' | 'gateway'>;
  gateway?: Omit<LocalAgentHealthResponse, 'bridge' | 'gateway'>;
}

function buildLocalAgentChatBody(
  text: string,
  opts?: LocalAgentChatRequestOptions,
): Record<string, unknown> {
  return {
    text,
    correlationId: opts?.correlationId ?? crypto.randomUUID(),
    ...(opts?.identity ? { identity: opts.identity } : {}),
    ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts?.profile ? { profile: opts.profile } : {}),
    ...(opts?.persistUserMessage ? { persistUserMessage: opts.persistUserMessage } : {}),
    ...(opts?.attachments?.length ? { attachmentRefs: opts.attachments } : {}),
    ...(opts?.attachmentImportResults?.length ? { attachmentImportResults: opts.attachmentImportResults } : {}),
    ...(opts?.contextEntries?.length ? { contextEntries: opts.contextEntries } : {}),
    ...(opts?.contextGraphId ? { contextGraphId: opts.contextGraphId } : {}),
  };
}

/**
 * SSE streaming variant of sendOpenClawLocalChat.
 * Yields text deltas as the agent produces them.
 */
export async function streamOpenClawLocalChat(
  text: string,
  opts: LocalAgentChatRequestOptions & {
    onEvent?: (event: OpenClawStreamEvent) => void;
  } = {},
): Promise<LocalAgentChatResponse> {
  const res = await apiFetch(apiDaemonPath('/api/openclaw-channel/stream'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify(buildLocalAgentChatBody(text, opts)),
    signal: opts.signal,
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw buildLocalAgentApiError(errBody, `Request failed (${res.status})`, res.status);
  }

  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();

  // Fallback: if server didn't return SSE, treat as JSON
  if (!res.body || !contentType.includes('text/event-stream')) {
    const data = await res.json() as LocalAgentChatResponse;
    opts.onEvent?.({ type: 'final', ...data });
    return data;
  }

  // Read SSE stream
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalPayload: LocalAgentChatResponse | undefined;
  let streamError: Error | undefined;

  const handleEvent = (event: OpenClawStreamEvent): void => {
    opts.onEvent?.(event);
    if (event.type === 'error') {
      streamError = buildLocalAgentApiError(event, event.error || 'Stream failed');
    } else if (event.type === 'final') {
      finalPayload = {
        text: event.text,
        correlationId: event.correlationId,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        ...(event.turnId ? { turnId: event.turnId } : {}),
      };
    }
  };

  const processLines = (finalFlush: boolean): void => {
    let lineEnd = buffer.indexOf('\n');
    while (lineEnd !== -1) {
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      lineEnd = buffer.indexOf('\n');
      if (!line.startsWith('data:')) continue;
      const dataLine = line.slice(5).trim();
      if (!dataLine) continue;
      try {
        handleEvent(JSON.parse(dataLine) as OpenClawStreamEvent);
      } catch { /* ignore malformed frames */ }
      if (streamError) return;
    }
    if (finalFlush && buffer.trim().startsWith('data:')) {
      const dataLine = buffer.trim().slice(5).trim();
      if (!dataLine) return;
      try {
        handleEvent(JSON.parse(dataLine) as OpenClawStreamEvent);
      } catch { /* ignore malformed frames */ }
      buffer = '';
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    processLines(false);
    if (streamError) break;
  }
  buffer += decoder.decode();
  processLines(true);

  if (streamError) throw streamError;
  if (!finalPayload) throw new Error('Stream ended without final payload');
  return finalPayload;
}

export const fetchOpenClawLocalHealth = () =>
  get<LocalAgentHealthResponse & {
    bridge?: { ok: boolean; channel?: string; cached?: boolean; error?: string };
    gateway?: { ok: boolean; channel?: string; error?: string };
  }>(
    '/api/openclaw-channel/health',
  );

export async function sendHermesLocalChat(
  text: string,
  opts?: LocalAgentChatRequestOptions,
): Promise<LocalAgentChatResponse> {
  const res = await apiFetch(apiDaemonPath('/api/hermes-channel/send'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildLocalAgentChatBody(text, opts)),
    signal: opts?.signal,
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw buildLocalAgentApiError(errBody, `Request failed (${res.status})`, res.status);
  }
  return res.json();
}

export async function streamHermesLocalChat(
  text: string,
  opts: LocalAgentChatRequestOptions & {
    onEvent?: (event: OpenClawStreamEvent) => void;
  } = {},
): Promise<LocalAgentChatResponse> {
  const res = await apiFetch(apiDaemonPath('/api/hermes-channel/stream'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify(buildLocalAgentChatBody(text, opts)),
    signal: opts.signal,
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw buildLocalAgentApiError(errBody, `Request failed (${res.status})`, res.status);
  }

  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();

  if (!res.body || !contentType.includes('text/event-stream')) {
    const data = await res.json() as LocalAgentChatResponse;
    opts.onEvent?.({ type: 'final', ...data });
    return data;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalPayload: LocalAgentChatResponse | undefined;
  let streamError: Error | undefined;

  const normalizeHermesEvent = (event: HermesRawStreamEvent): OpenClawStreamEvent => {
    if (event.type === 'delta') {
      return { type: 'text_delta', delta: event.text ?? '' };
    }
    return event;
  };

  const handleEvent = (event: OpenClawStreamEvent): void => {
    opts.onEvent?.(event);
    if (event.type === 'error') {
      streamError = buildLocalAgentApiError(event, event.error || 'Stream failed');
    } else if (event.type === 'final') {
      finalPayload = {
        text: event.text,
        correlationId: event.correlationId,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        ...(event.turnId ? { turnId: event.turnId } : {}),
      };
    }
  };

  const processLines = (finalFlush: boolean): void => {
    let lineEnd = buffer.indexOf('\n');
    while (lineEnd !== -1) {
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      lineEnd = buffer.indexOf('\n');
      if (!line.startsWith('data:')) continue;
      const dataLine = line.slice(5).trim();
      if (!dataLine) continue;
      try {
        handleEvent(normalizeHermesEvent(JSON.parse(dataLine) as HermesRawStreamEvent));
      } catch { /* ignore malformed frames */ }
      if (streamError) return;
    }
    if (finalFlush && buffer.trim().startsWith('data:')) {
      const dataLine = buffer.trim().slice(5).trim();
      if (!dataLine) return;
      try {
        handleEvent(normalizeHermesEvent(JSON.parse(dataLine) as HermesRawStreamEvent));
      } catch { /* ignore malformed frames */ }
      buffer = '';
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    processLines(false);
    if (streamError) break;
  }
  buffer += decoder.decode();
  processLines(true);

  if (streamError) throw streamError;
  if (!finalPayload) throw new Error('Stream ended without final payload');
  return finalPayload;
}

export const fetchHermesLocalHealth = () =>
  get<LocalAgentHealthResponse>('/api/hermes-channel/health');

function formatLocalAgentError(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fallback;
  const record = body as Record<string, unknown>;
  const error = typeof record.error === 'string' && record.error.trim()
    ? record.error.trim()
    : fallback;
  if (record.details === undefined || record.details === null) return error;
  const details = typeof record.details === 'string'
    ? record.details.trim()
    : JSON.stringify(record.details);
  if (!details || details === error) return error;
  return `${error}: ${details}`;
}

function buildLocalAgentApiError(body: unknown, fallback: string, status?: number): LocalAgentApiError {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return new LocalAgentApiError(fallback, { status });
  }
  const record = body as Record<string, unknown>;
  const message = formatLocalAgentError(record, fallback);
  const stringField = (key: string): string | undefined => {
    const value = record[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  const numberField = (key: string): number | undefined => {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };
  const booleanField = (key: string): boolean | undefined => {
    const value = record[key];
    return typeof value === 'boolean' ? value : undefined;
  };
  return new LocalAgentApiError(message, {
    status,
    code: stringField('code'),
    source: stringField('source'),
    details: stringField('details'),
    correlationId: stringField('correlationId'),
    timeoutMs: numberField('timeoutMs'),
    target: stringField('target'),
    route: stringField('route'),
    integrationId: stringField('integrationId'),
    retryable: booleanField('retryable'),
  });
}

interface LocalAgentIntegrationRecord {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  status?: 'disconnected' | 'configured' | 'connecting' | 'ready' | 'degraded' | 'error';
  capabilities?: {
    localChat?: boolean;
    chatAttachments?: boolean;
    connectFromUi?: boolean;
    installNode?: boolean;
    dkgPrimaryMemory?: boolean;
    wmImportPipeline?: boolean;
    nodeServedSkill?: boolean;
  };
  transport?: {
    kind?: string;
    bridgeUrl?: string;
    gatewayUrl?: string;
    healthUrl?: string;
  };
  runtime?: {
    status?: 'disconnected' | 'configured' | 'connecting' | 'ready' | 'degraded' | 'error';
    ready?: boolean;
    lastError?: string | null;
    updatedAt?: string;
  };
  manifest?: {
    packageName?: string;
    version?: string;
    setupEntry?: string;
  };
  metadata?: Record<string, unknown>;
}

export type LocalAgentIntegrationStatus =
  | 'chat_ready'
  | 'connecting'
  | 'degraded'
  | 'bridge_offline'
  | 'available'
  | 'coming_soon';

export interface LocalAgentIntegration {
  id: string;
  name: string;
  framework: string;
  description: string;
  defaultSessionId?: string;
  profile?: string;
  chatSupported: boolean;
  chatAttachments: boolean;
  connectSupported: boolean;
  configured: boolean;
  detected: boolean;
  persistentChat: boolean;
  chatReady: boolean;
  bridgeOnline: boolean;
  bridgeStatusLabel: string;
  status: LocalAgentIntegrationStatus;
  statusLabel: string;
  detail: string;
  error?: string;
  target?: LocalAgentChannelTarget;
  source: 'live' | 'planned';
}

export interface LocalAgentConnectResult {
  integration: LocalAgentIntegration;
  notice?: string;
}

export interface LocalAgentHistoryMessage {
  uri: string;
  text: string;
  author: string;
  ts: string;
  turnId?: string;
  persistStatus?: 'pending' | 'in_progress' | 'stored' | 'failed' | 'skipped';
  failureReason?: string | null;
  attachmentRefs?: LocalAgentChatAttachmentRef[];
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; result: unknown }>;
}

interface LocalAgentSurface {
  connectSupported: boolean;
  chatSupported: boolean;
  defaultSessionId?: (args: {
    integrationId: string;
    record?: LocalAgentIntegrationRecord;
    health?: LocalAgentHealthResponse | null;
  }) => string;
  resolveChatContext?: (args: {
    integrationId: string;
    sessionId?: string;
    profile?: string;
  }) => Record<string, unknown>;
  fetchHealth?: () => Promise<{
    ok: boolean;
    target?: LocalAgentChannelTarget;
    error?: string;
    profile?: string;
    memory?: LocalAgentHealthResponse['memory'];
    status?: string;
  }>;
  streamChat?: typeof streamOpenClawLocalChat;
}

const LOCAL_AGENT_SURFACES: Record<string, LocalAgentSurface> = {
  openclaw: {
    connectSupported: true,
    chatSupported: true,
    defaultSessionId: ({ integrationId }) => `${integrationId}:dkg-ui`,
    resolveChatContext: ({ integrationId, sessionId }) => {
      if (!sessionId) return {};
      const prefix = `${integrationId}:dkg-ui:`;
      if (!sessionId.startsWith(prefix)) return {};
      const identity = sessionId.slice(prefix.length).trim();
      return identity ? { identity } : {};
    },
    fetchHealth: fetchOpenClawLocalHealth,
    streamChat: streamOpenClawLocalChat,
  },
  hermes: {
    connectSupported: true,
    chatSupported: true,
    defaultSessionId: ({ integrationId, record, health }) => buildHermesDefaultSessionId(integrationId, record, health),
    resolveChatContext: ({ sessionId, profile }) => ({
      ...(sessionId ? { sessionId } : {}),
      ...(profile ? { profile } : {}),
    }),
    fetchHealth: fetchHermesLocalHealth,
    streamChat: streamHermesLocalChat,
  },
};

export function getDefaultLocalAgentSessionId(integrationId: string): string | null {
  const normalizedId = integrationId.trim().toLowerCase();
  return LOCAL_AGENT_SURFACES[normalizedId]?.defaultSessionId?.({ integrationId: normalizedId }) ?? null;
}

function resolveLocalAgentHistorySessionId(integrationId: string, sessionId?: string): string | null {
  if (sessionId?.trim()) return sessionId.trim();
  return getDefaultLocalAgentSessionId(integrationId);
}

async function fetchLocalAgentHistoryBySessionId(
  sessionId: string,
  limit = 50,
): Promise<LocalAgentHistoryMessage[]> {
  const buildFallbackHistoryMessageUri = (message: Pick<MemorySession['messages'][number], 'author' | 'text' | 'ts' | 'turnId'>): string => {
    if (message.turnId) {
      return `urn:dkg:chat:turn:${encodeURIComponent(message.turnId)}:${encodeURIComponent(message.author)}`;
    }
    const source = `${sessionId}\n${message.author}\n${message.ts}\n${message.text}`;
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `urn:dkg:chat:session:${encodeURIComponent(sessionId)}:message:${(hash >>> 0).toString(16)}`;
  };

  try {
    const session = await fetchMemorySession(sessionId, {
      limit,
      order: 'desc',
    });
    return [...session.messages]
      .reverse()
      .map((message) => ({
        uri: message.uri || buildFallbackHistoryMessageUri(message),
        text: message.text,
        author: message.author,
        ts: message.ts,
        turnId: message.turnId,
        persistStatus: message.persistStatus,
        failureReason: message.failureReason,
        attachmentRefs: message.attachmentRefs,
        toolCalls: message.toolCalls,
      }));
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      return [];
    }
    throw err;
  }
}

/**
 * Load chat history for the local OpenClaw agent from the DKG graph.
 * Queries schema:Message items linked to the openclaw:dkg-ui session.
 */
export async function fetchOpenClawLocalHistory(limit = 50): Promise<LocalAgentHistoryMessage[]> {
  return fetchLocalAgentHistory('openclaw', limit);
}

export type LocalAgentStreamEvent = OpenClawStreamEvent;

function hasLocalAgentTransportHints(record: LocalAgentIntegrationRecord): boolean {
  return Boolean(
    record.transport?.bridgeUrl
    || record.transport?.gatewayUrl
    || record.transport?.healthUrl,
  );
}

function firstTrimmedString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function sessionSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || stableSessionHash(value);
}

function stableSessionHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function buildHermesDefaultSessionId(
  integrationId: string,
  record?: LocalAgentIntegrationRecord,
  health?: LocalAgentHealthResponse | null,
): string {
  const metadata = record?.metadata ?? {};
  const profile = firstTrimmedString(
    health?.profile,
    metadata.profileName,
    metadata.profile,
  );
  const hermesHome = firstTrimmedString(metadata.hermesHome);
  const transportSegment = !hermesHome ? buildHermesTransportSessionSegment(record) : null;
  const segments = [
    profile ? `profile-${sessionSegment(profile)}` : null,
    hermesHome ? `home-${stableSessionHash(hermesHome)}` : null,
    transportSegment,
  ].filter((value): value is string => value != null);
  return segments.length
    ? `${integrationId}:dkg-ui:${segments.join(':')}`
    : `${integrationId}:dkg-ui`;
}

function buildHermesTransportSessionSegment(record?: LocalAgentIntegrationRecord): string | null {
  const transport = record?.transport;
  if (!transport) return null;
  const parts = [
    transport.kind,
    transport.bridgeUrl,
    transport.gatewayUrl,
    transport.healthUrl,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return parts.length ? `transport-${stableSessionHash(parts.join('|'))}` : null;
}

function localAgentMemoryLabel(memory: LocalAgentHealthResponse['memory']): string | null {
  if (!memory) return null;
  if (typeof memory === 'string') return memory;
  return [
    memory.provider,
    memory.mode,
    memory.status,
  ].filter(Boolean).join(' / ') || null;
}

function isDegradedLocalAgentHealth(
  runtimeStatus: LocalAgentIntegrationRecord['status'] | undefined,
  health: LocalAgentHealthResponse | null,
): boolean {
  if (runtimeStatus === 'degraded') return true;
  const status = String(health?.status ?? '').toLowerCase();
  const memory = health?.memory;
  return status.includes('degraded')
    || status.includes('conflict')
    || (typeof memory === 'object' && memory != null && memory.conflict === true);
}

function isHealthObject(value: unknown): value is Omit<LocalAgentHealthResponse, 'bridge' | 'gateway'> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function healthObjectScore(value: unknown): number {
  if (!isHealthObject(value)) return -1;
  let score = value.ok === false ? 100 : 0;
  if (value.profile) score += 10;
  if (value.memory) score += 10;
  if (value.status) score += 10;
  if (value.error) score += 10;
  if (value.ok === true) score += 1;
  return score;
}

function localAgentHealthTargetDetails(health: LocalAgentHealthResponse): {
  target?: LocalAgentChannelTarget;
  details?: Omit<LocalAgentHealthResponse, 'bridge' | 'gateway'>;
} {
  if (health.target === 'bridge') return { target: 'bridge', details: health.bridge };
  if (health.target === 'gateway') return { target: 'gateway', details: health.gateway };

  const bridgeScore = healthObjectScore(health.bridge);
  const gatewayScore = healthObjectScore(health.gateway);
  if (bridgeScore < 0 && gatewayScore < 0) return {};
  return bridgeScore >= gatewayScore
    ? { target: 'bridge', details: health.bridge }
    : { target: 'gateway', details: health.gateway };
}

function normalizeLocalAgentHealth(health: LocalAgentHealthResponse | null): LocalAgentHealthResponse | null {
  if (!health) return null;
  const { target, details: targetDetails } = localAgentHealthTargetDetails(health);
  if (!isHealthObject(targetDetails)) return health;
  const targetOk = typeof targetDetails.ok === 'boolean' ? targetDetails.ok : undefined;
  return {
    ...targetDetails,
    ...health,
    ok: health.ok === false ? false : targetOk ?? health.ok,
    target: health.target ?? target,
    profile: health.profile ?? targetDetails.profile,
    memory: health.memory ?? targetDetails.memory,
    status: health.status ?? targetDetails.status,
    error: health.error ?? targetDetails.error,
  };
}

function hermesDetail(
  record: LocalAgentIntegrationRecord,
  health: LocalAgentHealthResponse | null,
): string | null {
  if (String(record.id ?? '').toLowerCase() !== 'hermes') return null;
  const profile = health?.profile;
  const profileText = profile ? `profile ${profile}` : 'the configured profile';
  const memoryLabel = localAgentMemoryLabel(health?.memory);
  const memory = typeof health?.memory === 'object' && health.memory != null ? health.memory : null;
  if (memory?.conflict === true || String(health?.status ?? '').toLowerCase().includes('conflict')) {
    return `${record.name} ${profileText} has a memory provider conflict${memoryLabel ? ` (${memoryLabel})` : ''}.`;
  }
  if (health?.ok) {
    return `${record.name} ${profileText} is connected${memoryLabel ? ` with ${memoryLabel} memory` : ''}.`;
  }
  if (health?.status) {
    return `${record.name} ${profileText} reports ${health.status}${memoryLabel ? ` (${memoryLabel})` : ''}.`;
  }
  return null;
}

async function mapLocalAgentIntegrationRecord(record: LocalAgentIntegrationRecord): Promise<LocalAgentIntegration> {
  const id = String(record.id ?? '').toLowerCase();
  const surface = LOCAL_AGENT_SURFACES[id];
  const hasChatBridge = record.capabilities?.localChat === true && surface?.chatSupported === true;
  const chatAttachments = hasChatBridge && record.capabilities?.chatAttachments === true;
  const connectSupported = record.capabilities?.connectFromUi === true && surface?.connectSupported === true;
  const configured = record.enabled === true;
  const runtimeStatus = record.runtime?.status;
  const health = configured && hasChatBridge && surface?.fetchHealth
    ? normalizeLocalAgentHealth(await surface.fetchHealth().catch(() => null))
    : null;
  const degraded = isDegradedLocalAgentHealth(runtimeStatus, health);
  const chatReady = health?.ok === true && !degraded;
  const bridgeOnline = chatReady;
  const persistentChat = configured && hasChatBridge && (
    chatReady
    || runtimeStatus === 'connecting'
    || runtimeStatus === 'degraded'
    || record.runtime?.ready === true
    || hasLocalAgentTransportHints(record)
  );
  const hermesRuntimeDetail = hermesDetail(record, health);
  const defaultSessionId = surface?.defaultSessionId?.({ integrationId: id, record, health });
  const profile = id === 'hermes'
    ? firstTrimmedString(health?.profile, record.metadata?.profileName, record.metadata?.profile)
    : undefined;

  let status: LocalAgentIntegrationStatus;
  let statusLabel: string;
  let detail: string;
  if (persistentChat && degraded) {
    status = 'degraded';
    statusLabel = 'Degraded';
    detail = hermesRuntimeDetail
      ?? health?.error
      ?? record.runtime?.lastError
      ?? `${record.name} is attached to this node, but one capability is degraded.`;
  } else if (persistentChat && record.runtime?.status === 'connecting') {
    status = 'connecting';
    statusLabel = 'Connecting';
    detail = record.runtime?.lastError
      ?? `${record.name} is registered and still starting up.`;
  } else if (bridgeOnline) {
    status = 'chat_ready';
    statusLabel = 'Chat ready';
    detail = `${record.name} is connected to this node and ready for chat.`;
  } else if (persistentChat) {
    status = 'bridge_offline';
    statusLabel = 'Bridge offline';
    detail = hermesRuntimeDetail
      ?? health?.error
      ?? record.runtime?.lastError
      ?? `${record.name} is attached to this node, but it is not responding right now.`;
  } else if (surface) {
    status = 'available';
    statusLabel = connectSupported ? 'Ready to connect' : 'Awaiting chat bridge';
    detail = configured
      ? `${record.name} is registered, but this panel is waiting for the framework chat bridge.`
      : (record.runtime?.lastError
          ?? `Use the node-served skill plus ${record.name} onboarding to attach an existing local agent.`);
  } else {
    status = 'coming_soon';
    statusLabel = configured ? 'Registered, panel pending' : 'Next integration';
    detail = configured
      ? `${record.name} is registered on the node, but the right-panel chat bridge is not wired yet.`
      : 'The local-agent registry is in place so this framework can plug into the same side-panel flow next.';
  }

  const bridgeStatusLabel = bridgeOnline
    ? 'Connected'
    : status === 'connecting'
      ? 'Connecting'
      : status === 'degraded'
        ? 'Degraded'
      : persistentChat
        ? 'Unavailable'
        : connectSupported
          ? 'Ready to connect'
          : 'Coming next';

  return {
    id,
    name: record.name,
    framework: record.name,
    description: record.description,
    defaultSessionId,
    profile,
    chatSupported: hasChatBridge,
    chatAttachments,
    connectSupported,
    configured,
    detected: configured || chatReady,
    persistentChat,
    chatReady,
    bridgeOnline,
    bridgeStatusLabel,
    status,
    statusLabel,
    detail,
    error: chatReady ? undefined : (health?.error ?? record.runtime?.lastError ?? undefined),
    target: health?.target,
    source: configured || surface ? 'live' : 'planned',
  } satisfies LocalAgentIntegration;
}

export type RegistryTrustTier = 'community' | 'verified' | 'featured';
export type RegistryMemoryLayer = 'WM' | 'SWM' | 'VM';
export type RegistryInstallKind = 'cli' | 'mcp' | 'service' | 'agent-plugin' | 'manual';

export interface RegistryIntegrationSummary {
  slug: string;
  name: string;
  description: string;
  trustTier: RegistryTrustTier;
  memoryLayers: RegistryMemoryLayer[];
  installKind: RegistryInstallKind;
  repo: string;
  maintainer: string;
  targetAgents: string[];
}

export interface RegistryListResult {
  entries: RegistryIntegrationSummary[];
  failures: Array<{ slug: string; error: string }>;
  fetchedAt: number;
  tier: RegistryTrustTier;
}

export async function fetchRegistryIntegrations(opts: { tier?: RegistryTrustTier } = {}): Promise<RegistryListResult> {
  const search = opts.tier ? `?tier=${encodeURIComponent(opts.tier)}` : '';
  return get<RegistryListResult>(`/api/integrations/registry${search}`);
}

export async function fetchLocalAgentIntegrations(): Promise<{ integrations: LocalAgentIntegration[] }> {
  const response = await get<{ integrations?: LocalAgentIntegrationRecord[] }>('/api/local-agent-integrations');
  const integrations = await Promise.all((response.integrations ?? []).map(mapLocalAgentIntegrationRecord));

  integrations.sort((a, b) => {
    const aPriority = a.id === 'openclaw' ? 0 : 1;
    const bPriority = b.id === 'openclaw' ? 0 : 1;
    if (aPriority !== bPriority) return aPriority - bPriority;
    if (a.persistentChat !== b.persistentChat) return a.persistentChat ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { integrations };
}

export async function connectLocalAgentIntegration(id: string): Promise<LocalAgentConnectResult> {
  const normalizedId = id.trim().toLowerCase();
  const surface = LOCAL_AGENT_SURFACES[normalizedId];
  if (!surface?.connectSupported) {
    throw new Error(`${id} local connect is not available yet.`);
  }

  const response = await post<{ ok: boolean; notice?: string; integration?: LocalAgentIntegrationRecord }>('/api/local-agent-integrations/connect', {
    id: normalizedId,
    metadata: {
      source: 'node-ui',
    },
  });
  const integration = response.integration
    ? await mapLocalAgentIntegrationRecord(response.integration)
    : (await fetchLocalAgentIntegrations()).integrations.find((item) => item.id === normalizedId);
  if (!integration) {
    throw new Error(`Missing local agent integration: ${normalizedId}`);
  }
  return {
    integration,
    notice: response.notice,
  };
}

export async function disconnectLocalAgentIntegration(id: string): Promise<void> {
  const normalizedId = id.trim().toLowerCase();
  await put(`/api/local-agent-integrations/${encodeURIComponent(normalizedId)}`, {
    enabled: false,
    runtime: {
      status: 'disconnected',
      ready: false,
      lastError: null,
    },
  });
}

export async function refreshLocalAgentIntegration(id: string): Promise<LocalAgentConnectResult> {
  const normalizedId = id.trim().toLowerCase();
  const response = await post<{ ok: boolean; notice?: string; integration?: LocalAgentIntegrationRecord }>(
    `/api/local-agent-integrations/${encodeURIComponent(normalizedId)}/refresh`,
    {},
  );
  const integration = response.integration
    ? await mapLocalAgentIntegrationRecord(response.integration)
    : (await fetchLocalAgentIntegrations()).integrations.find((item) => item.id === normalizedId);
  if (!integration) {
    throw new Error(`Missing local agent integration: ${normalizedId}`);
  }
  return {
    integration,
    notice: response.notice,
  };
}

export async function fetchLocalAgentHealth(id: string) {
  if (id === 'openclaw') return fetchOpenClawLocalHealth();
  if (id === 'hermes') return fetchHermesLocalHealth();
  throw new Error(`${id} local health is not available yet.`);
}

export async function fetchLocalAgentHistory(
  id: string,
  limit = 50,
  opts: { sessionId?: string } = {},
): Promise<LocalAgentHistoryMessage[]> {
  const sessionId = resolveLocalAgentHistorySessionId(id, opts.sessionId);
  if (!sessionId) return [];
  return fetchLocalAgentHistoryBySessionId(sessionId, limit);
}

async function persistHermesLocalChatFailure(
  opts: LocalAgentChatFailurePersistenceOptions,
): Promise<LocalAgentChatFailurePersistenceResponse> {
  const sessionId = opts.sessionId?.trim();
  if (!sessionId) throw new Error('Missing Hermes session id');
  return post<LocalAgentChatFailurePersistenceResponse>('/api/hermes-channel/persist-turn', {
    sessionId,
    userMessage: opts.userMessage,
    assistantReply: opts.assistantReply ?? '',
    correlationId: opts.correlationId,
    attachmentRefs: opts.attachments,
    persistenceState: 'failed',
    failureReason: opts.failureReason,
    contextGraphId: opts.contextGraphId,
    profile: opts.profile,
    metadata: { source: 'node-ui-failed-turn' },
  });
}

export async function persistLocalAgentChatFailure(
  id: string,
  opts: LocalAgentChatFailurePersistenceOptions,
): Promise<LocalAgentChatFailurePersistenceResponse> {
  const normalizedId = id.trim().toLowerCase();
  if (normalizedId === 'hermes') return persistHermesLocalChatFailure(opts);
  throw new Error(`${id} local chat persistence is not available yet.`);
}

export async function streamLocalAgentChat(
  id: string,
  text: string,
  opts: LocalAgentChatRequestOptions & {
    onEvent?: (event: LocalAgentStreamEvent) => void;
  } = {},
): Promise<LocalAgentChatResponse> {
  const normalizedId = id.trim().toLowerCase();
  const surface = LOCAL_AGENT_SURFACES[normalizedId];
  if (surface?.streamChat) {
    const { sessionId, profile, ...transportOpts } = opts;
    return surface.streamChat(text, {
      ...transportOpts,
      ...surface.resolveChatContext?.({
        integrationId: normalizedId,
        sessionId,
        profile,
      }),
    });
  }
  throw new Error(`${id} local chat is not available yet.`);
}

/** Extract plain string from a SPARQL binding value (standard JSON or N-Triples). */
function bv(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'object' && 'value' in (v as any)) return String((v as any).value);
  if (typeof v === 'string') {
    // N-Triples typed literal: "value"^^<type> or "value"@lang — strip suffix first
    let s = v;
    const typedMatch = s.match(/^(".*")\^\^<[^>]+>$/);
    if (typedMatch) s = typedMatch[1];
    const langMatch = s.match(/^(".*")@[a-z-]+$/i);
    if (langMatch) s = langMatch[1];
    // Strip surrounding quotes
    if (s.startsWith('"') && s.endsWith('"')) {
      return s.slice(1, -1)
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t');
    }
    return v;
  }
  return String(v);
}

// --- Economics / spending ---
export interface SpendingPeriod {
  label: string;
  publishCount: number;
  successCount: number;
  totalGasEth: number;
  totalTrac: number;
  avgGasEth: number;
  avgTrac: number;
}
export const fetchEconomics = () =>
  get<{ periods: SpendingPeriod[] }>('/api/economics');

// --- Wallet & chain ---
export const fetchWalletsBalances = () =>
  get<{
    wallets: string[];
    balances: Array<{ address: string; eth: string; trac: string; symbol: string }>;
    chainId: string | null;
    rpcUrl: string | null;
    symbol?: string;
    error?: string;
  }>('/api/wallets/balances');
export const fetchRpcHealth = () =>
  get<{
    ok: boolean;
    configured: boolean;
    rpcEndpointCount: number;
    latencyMs: number | null;
    blockNumber: number | null;
    error?: string;
    rpcs: Array<{
      index: number;
      role: 'primary' | 'backup';
      ok: boolean;
      latencyMs: number | null;
      blockNumber: number | null;
      error?: string;
    }>;
  }>('/api/chain/rpc-health');

// --- Node control ---
export const shutdownNode = () =>
  post<{ ok: boolean }>('/api/shutdown', {});

// --- Integrations ---
export const subscribeToContextGraph = (contextGraphId: string) =>
  post<{ subscribed: string; catchup?: { status: string; jobId: string } }>('/api/subscribe', { contextGraphId });

// --- Notifications (scoped pane wire contract — implementation-plan §3) ---
//
// The daemon now returns a caller-scoped, type-allowlisted, activity-collapsed,
// join_request-reconciled feed. Every member of the union is one notification
// kind; the pane never re-filters for correctness (scoping is server-side).
// See `data-contract.md` §4 and `implementation-plan.md` §3 for the frozen
// shape. Field names here are part of that frozen contract — daemon-engineer
// owns the server side and flags ui-lead before any rename.

/** Common envelope present on every pane notification. `contextGraphName`
 *  is the resolved display name; the client falls back to `shortId(cgId)`
 *  when it's absent (never blank). */
interface NotifWireBase {
  /** Numeric row id for persisted rows; a stable string `digestKey`
   *  (`activity:<cgId>:<kind>:<windowBucket>`) for collapsed activity
   *  digests. The read endpoint accepts both. */
  id: number | string;
  ts: number;
  /** 0 = unread, 1 = read. */
  read: 0 | 1;
  contextGraphId: string;
}

/** Incoming join request on a CG the caller curates — actionable
 *  (inline Approve/Deny). Emitted only on the curator's node, so the
 *  reader's role for this kind is always curator. */
export interface JoinRequestNotif extends NotifWireBase {
  type: 'join_request';
  meta: { contextGraphName?: string; agentAddress: string; agentName?: string };
}

/** Confirmation that the caller's own outbound join request was accepted.
 *  Counts toward the unread badge (positive, opens the new CG). */
export interface JoinApprovedNotif extends NotifWireBase {
  type: 'join_approved';
  meta: { contextGraphName?: string; agentAddress: string };
}

/** Confirmation that the caller's own outbound join request was declined.
 *  Demoted: informational, never counts toward the unread badge (the daemon's
 *  `badgeCount` already excludes it). */
export interface JoinRejectedNotif extends NotifWireBase {
  type: 'join_rejected';
  meta: { contextGraphName?: string; agentAddress: string };
}

/** Collapsed activity digest — per (contextGraphId × kind × window). `id` is
 *  the stable `digestKey`. `count` is summed over the window and INCLUDES the
 *  caller's own events (operators want visibility into their own agents). A
 *  sole-self digest sets `bySelf` so the row renders a "You" indicator;
 *  `actorAgentDid` / `actorAgentName` are populated ONLY when `soleAuthor ===
 *  true` AND it is a single OTHER author (otherwise omitted → count-only). */
export interface AssertionActivityNotif extends NotifWireBase {
  type: 'assertion_activity';
  id: string;
  meta: {
    contextGraphName?: string;
    kind: 'created' | 'promoted' | 'published';
    count: number;
    actorAgentDid?: string;
    actorAgentName?: string;
    soleAuthor?: boolean;
    /** True when the sole author is the reading agent → render "You". */
    bySelf?: boolean;
  };
}

/** B8 confirmed-discount bell row (P2) — a server-confirmed on-chain CostCovered
 *  draw on one of THIS node's publishing wallets (wallet-scoped, mirrors
 *  join_approved). Informational; counts toward the unread badge. `meta` reuses
 *  {@link ConvictionCostCovered} plus the publishing wallet. `contextGraphId` is
 *  optional (the locked wire shape). The P2 source is self-publish capture;
 *  sponsored/owner-side draws are P3. */
export interface PcaCostCoveredNotif {
  type: 'pca_cost_covered';
  id: number | string;
  ts: number;
  read: 0 | 1;
  contextGraphId?: string;
  meta: ConvictionCostCovered & { publisherAddress: string; contextGraphName?: string };
}

export type NotifWire =
  | JoinRequestNotif
  | JoinApprovedNotif
  | JoinRejectedNotif
  | AssertionActivityNotif
  | PcaCostCoveredNotif;

export interface NotificationsFeedResponse {
  /** Already scoped, type-allowlisted, activity-collapsed, join_request
   *  reconciled against the live pending set. Render as-is. */
  notifications: NotifWire[];
  /** Unread badge count over the scoped set: unread join_request +
   *  join_approved + assertion_activity digests. EXCLUDES join_rejected. */
  badgeCount: number;
  /** True when caller identity is unresolved → render "Verifying access…",
   *  never "all caught up". `notifications` is empty in that case. */
  scopeUnknown?: boolean;
}

/** Fetch the scoped notifications feed (`GET /api/notifications`). */
export const fetchNotificationsFeed = () =>
  get<NotificationsFeedResponse>('/api/notifications');

/** Mark notifications read by id. Accepts numeric row ids AND string
 *  `digestKey`s (the daemon resolves a digestKey to its underlying atomic
 *  row ids). Omit `ids` to mark every scoped row read. */
export const markNotificationsRead = (ids?: Array<number | string>) =>
  post<{ marked: number }>('/api/notifications/read', ids ? { ids } : {});

// --- Sub-graphs (lightweight list + counts for SubGraphBar) ---
export interface SubGraphInfo {
  name: string;
  uri: string;
  description?: string;
  createdBy?: string;
  createdAt?: string;
  entityCount: number;
  tripleCount: number;
}
export const fetchSubGraphs = (contextGraphId: string) =>
  getWithTimeout<{ contextGraphId: string; subGraphs: SubGraphInfo[] }>(
    `/api/sub-graph/list?contextGraphId=${encodeURIComponent(contextGraphId)}`,
    CONTEXT_GRAPH_LOAD_TIMEOUT_MS,
  );
