const BASE = '';
const CONTEXT_GRAPH_URI_PREFIX = 'did:dkg:context-graph:';
declare global {
  interface Window { __DKG_TOKEN__?: string; }
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

export function authHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const token = window.__DKG_TOKEN__;
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
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

async function fetchWithTimeout(input: string, init: RequestInit = {}, timeoutMs = 10000): Promise<Response> {
  try {
    return await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (!res.ok) throw new HttpError(res.status);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
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
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
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
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
  fetchWithTimeout(`${BASE}/api/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
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
  fetchWithTimeout(`${BASE}/api/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
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
  const data = await get<{ contextGraphs?: any[] }>('/api/context-graph/list');
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
    const res = await fetch(`${BASE}/api/context-graph/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
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
  opts: { accessPolicy?: number; publishPolicy?: number } = {},
) =>
  post<{ registered: string; onChainId: string; hint?: string }>(
    '/api/context-graph/register',
    {
      id,
      ...(opts.accessPolicy !== undefined ? { accessPolicy: opts.accessPolicy } : {}),
      ...(opts.publishPolicy !== undefined ? { publishPolicy: opts.publishPolicy } : {}),
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

  const res = await fetch(`${BASE}/api/knowledge-assets/${encodeURIComponent(assertionName)}/wm/import-file`, {
    method: 'POST',
    headers: authHeaders(),
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
    const res = await fetch(`${BASE}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
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

// --- Publish (assertion-lifecycle: RFC-001 §9.x sign-at-creation) ---
//
// Creates a fresh auto-named assertion, writes the supplied quads,
// finalizes (computes the merkle root and signs the EIP-712
// AuthorAttestation stamped into `_meta`), promotes into SWM, and
// publishes — the publisher forwards the seal verbatim and never
// re-signs.
export const publishTriples = async (contextGraphId: string, quads: any[]) => {
  const assertionName = `ui-publish-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const created = await post<{ assertionUri: string; seal?: Record<string, unknown> }>(
    '/api/knowledge-assets',
    {
      contextGraphId,
      name: assertionName,
      quads,
      finalize: true,
      promote: true,
    },
  );
  const published = await post<any>('/api/shared-memory/publish', {
    contextGraphId,
    assertionName,
  });
  return { ...published, assertionUri: created.assertionUri, ...(created.seal ? { seal: created.seal } : {}) };
};

export const writeSharedMemory = (
  contextGraphId: string,
  quads: Array<{ subject: string; predicate: string; object: string; graph?: string }>,
  opts: { subGraphName?: string; localOnly?: boolean } = {},
) =>
  post<any>('/api/shared-memory/write', {
    contextGraphId,
    quads,
    ...(opts.subGraphName ? { subGraphName: opts.subGraphName } : {}),
    ...(opts.localOnly !== undefined ? { localOnly: opts.localOnly } : {}),
  });

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
  const countSparql = `SELECT ?g (COUNT(*) AS ?cnt) WHERE {
    GRAPH <${metaGraph}> { ?g <http://dkg.io/ontology/memoryLayer> "WM" }
    GRAPH ?g { ?s ?p ?o }
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
    const cnt = cntRaw != null ? parseInt(cntRaw, 10) : NaN;
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
    const key = `${subGraph ?? ''} ${name}`;
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
  | { kind: 'not-persisted'; message: string; expectedTripleCount?: number };

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
export function fileUrl(hash: string, contentType?: string): string {
  const normalizedHash = hash.startsWith('sha256:') || hash.startsWith('keccak256:')
    ? hash
    : `sha256:${hash}`;
  const params = contentType ? `?contentType=${encodeURIComponent(contentType)}` : '';
  return `${BASE}/api/file/${encodeURIComponent(normalizedHash)}${params}`;
}

export interface SwmRootEntity {
  uri: string;
  label: string;
  tripleCount: number;
}

const SKOLEM_GENID_SEGMENT = '/.well-known/genid/';

function canonicalSwmRootUri(uri: string): string {
  const trimmed = uri.trim();
  const unwrapped = trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed;
  const idx = unwrapped.indexOf(SKOLEM_GENID_SEGMENT);
  return idx === -1 ? unwrapped : unwrapped.slice(0, idx);
}

function labelFromUri(uri: string): string {
  const hash = uri.lastIndexOf('#');
  const slash = uri.lastIndexOf('/');
  const cut = Math.max(hash, slash);
  return cut >= 0 ? uri.slice(cut + 1) : uri;
}

/** List root entities in SWM with their triple counts. */
export async function listSwmEntities(contextGraphId: string): Promise<SwmRootEntity[]> {
  const swmGraph = `did:dkg:context-graph:${contextGraphId}/_shared_memory`;
  const sparql = `SELECT ?s (COUNT(?p) AS ?cnt) WHERE {
    GRAPH ?g {
      ?s ?p ?o .
      FILTER(STR(?g) = "${swmGraph}")
      FILTER(?p != <http://dkg.io/ontology/workspaceOwner>)
    }
  } GROUP BY ?s ORDER BY DESC(?cnt)`;
  const data = await post<{ result: any }>('/api/query', { sparql, contextGraphId, view: 'shared-working-memory' });
  const bindings: any[] = data?.result?.bindings ?? [];
  const countsByRoot = new Map<string, number>();
  for (const b of bindings) {
    const uri = typeof b.s === 'string' ? b.s : b.s?.value ?? '';
    const cntRaw = typeof b.cnt === 'string' ? b.cnt : b.cnt?.value ?? '0';
    const m = cntRaw.match(/^"?(\d+)/);
    const tripleCount = m ? parseInt(m[1], 10) : 0;
    const rootUri = canonicalSwmRootUri(uri);
    if (!rootUri) continue;
    countsByRoot.set(rootUri, (countsByRoot.get(rootUri) ?? 0) + tripleCount);
  }
  return [...countsByRoot.entries()]
    .map(([uri, tripleCount]) => ({ uri, label: labelFromUri(uri), tripleCount }))
    .sort((a, b) => b.tripleCount - a.tripleCount || a.label.localeCompare(b.label));
}

export interface PublishResult {
  kaId: string;
  status: string;
  kas: { tokenId: string; rootEntity: string }[];
  txHash?: string;
  blockNumber?: number;
}

/**
 * Publish one SWM root on-chain (SWM -> VM).
 * Selection-based shared-memory publish is not atomic across independent roots
 * yet, so the UI keeps the single-root guard until the daemon can identify one
 * lifecycle/assertion for a multi-root request.
 */
export const publishSharedMemory = (contextGraphId: string, rootEntities: string[]) => {
  if (rootEntities.length !== 1) {
    throw new Error('Shared-memory publish currently requires exactly one root entity.');
  }
  return post<PublishResult>('/api/shared-memory/publish', {
    contextGraphId,
    selection: rootEntities,
    clearAfter: false,
  });
};

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

export async function sendOpenClawLocalChat(
  text: string,
  opts?: LocalAgentChatRequestOptions,
): Promise<LocalAgentChatResponse> {
  const res = await fetch('/api/openclaw-channel/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(buildLocalAgentChatBody(text, opts)),
    signal: opts?.signal,
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error((errBody as { error?: string })?.error ?? `Request failed (${res.status})`);
  }
  return res.json();
}

export type OpenClawStreamEvent =
  | { type: 'text_delta'; delta: string }
  | ({ type: 'final' } & LocalAgentChatResponse)
  | { type: 'error'; error: string };

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
  const res = await fetch('/api/openclaw-channel/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      ...authHeaders(),
    },
    body: JSON.stringify(buildLocalAgentChatBody(text, opts)),
    signal: opts.signal,
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error((errBody as { error?: string })?.error ?? `Request failed (${res.status})`);
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
      streamError = new Error(event.error || 'Stream failed');
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
  const res = await fetch('/api/hermes-channel/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(buildLocalAgentChatBody(text, opts)),
    signal: opts?.signal,
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(formatLocalAgentError(errBody, `Request failed (${res.status})`));
  }
  return res.json();
}

export async function streamHermesLocalChat(
  text: string,
  opts: LocalAgentChatRequestOptions & {
    onEvent?: (event: OpenClawStreamEvent) => void;
  } = {},
): Promise<LocalAgentChatResponse> {
  const res = await fetch('/api/hermes-channel/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      ...authHeaders(),
    },
    body: JSON.stringify(buildLocalAgentChatBody(text, opts)),
    signal: opts.signal,
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(formatLocalAgentError(errBody, `Request failed (${res.status})`));
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
      streamError = new Error(event.error || 'Stream failed');
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

export type NotifWire =
  | JoinRequestNotif
  | JoinApprovedNotif
  | JoinRejectedNotif
  | AssertionActivityNotif;

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
  get<{ contextGraphId: string; subGraphs: SubGraphInfo[] }>(
    `/api/sub-graph/list?contextGraphId=${encodeURIComponent(contextGraphId)}`,
  );
