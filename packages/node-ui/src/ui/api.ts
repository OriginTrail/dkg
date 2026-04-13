const BASE = '';

declare global {
  interface Window { __DKG_TOKEN__?: string; }
}

export function authHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const token = window.__DKG_TOKEN__;
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

class HttpError extends Error {
  status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
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
    throw new Error(msg);
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
export const fetchLogs = (params: Record<string, string> = {}) => {
  const qs = new URLSearchParams(params).toString();
  return get<{ logs: any[]; total: number }>(`/api/logs${qs ? '?' + qs : ''}`);
};

export const fetchNodeLog = (params: { lines?: number; q?: string } = {}) => {
  const qs = new URLSearchParams();
  if (params.lines) qs.set('lines', String(params.lines));
  if (params.q) qs.set('q', params.q);
  const q = qs.toString();
  return get<{ lines: string[]; totalSize: number }>(`/api/node-log${q ? '?' + q : ''}`);
};

// --- Context Graphs ---
// Use /api/paranet/* which works on both the installed release and dev builds.
// The V10 aliases (/api/context-graph/*) are only available on the latest dev daemon.
export async function fetchContextGraphs(): Promise<{ contextGraphs: any[] }> {
  const data = await get<{ paranets?: any[]; contextGraphs?: any[] }>('/api/paranet/list');
  const list = data.contextGraphs ?? data.paranets ?? [];
  return { contextGraphs: list.filter((p: any) => !p.isSystem) };
}

export async function createContextGraph(id: string, name: string, description?: string): Promise<{ created: string; uri: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${BASE}/api/paranet/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ id, name, description }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error((errBody as { error?: string })?.error ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<{ created: string; uri: string }>;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error('Creating project is taking longer than expected — it may still complete in the background. Refresh the page in a moment.');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// --- Catch-up sync jobs ---
export interface CatchupStatusResponse {
  jobId: string;
  contextGraphId: string;
  includeSharedMemory: boolean;
  status: 'queued' | 'running' | 'done' | 'failed';
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: {
    connectedPeers: number;
    syncCapablePeers: number;
    peersTried: number;
    dataSynced: number;
    sharedMemorySynced: number;
  };
  error?: string;
}

export const fetchCatchupStatus = (contextGraphId: string) =>
  get<CatchupStatusResponse>(`/api/sync/catchup-status?contextGraphId=${encodeURIComponent(contextGraphId)}`);

// --- File import to Working Memory ---
export interface ImportFileResult {
  assertionUri: string;
  fileHash: string;
  detectedContentType: string;
  extraction: {
    status: 'completed' | 'skipped' | 'error';
    tripleCount?: number;
    triplesWritten?: number;
    provenance?: any;
    error?: string;
    pipelineUsed?: string;
  };
}

const EXT_TO_MIME: Record<string, string> = {
  md: 'text/markdown', txt: 'text/plain', csv: 'text/csv',
  json: 'application/json', xml: 'application/xml',
  yaml: 'text/yaml', yml: 'text/yaml',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
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

  const res = await fetch(`${BASE}/api/assertion/${encodeURIComponent(assertionName)}/import-file`, {
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
export const executeQuery = (sparql: string, contextGraphId?: string, includeSharedMemory?: boolean, graphSuffix?: '_shared_memory') =>
  post<{ result: any }>('/api/query', { sparql, contextGraphId, includeSharedMemory, graphSuffix });

// --- Publish (SWM-first: write to shared memory, then publish) ---
export const publishTriples = async (contextGraphId: string, quads: any[]) => {
  await post<any>('/api/shared-memory/write', { contextGraphId, quads });
  return post<any>('/api/shared-memory/publish', { contextGraphId, selection: 'all', clearAfter: true });
};

// --- Assertions (WM objects) ---

export interface AssertionInfo {
  name: string;
  graphUri: string;
  tripleCount?: number;
}

/** Discover assertions in WM by querying named graphs that match the assertion pattern. */
export async function listAssertions(contextGraphId: string): Promise<AssertionInfo[]> {
  const sparql = `SELECT DISTINCT ?g (COUNT(?s) AS ?cnt) WHERE { GRAPH ?g { ?s ?p ?o } } GROUP BY ?g`;
  const data = await executeQuery(sparql, contextGraphId);
  const bindings: any[] = data?.result?.bindings ?? [];
  const prefix = `did:dkg:context-graph:${contextGraphId}/assertion/`;
  const result: AssertionInfo[] = [];
  for (const b of bindings) {
    const g = typeof b.g === 'string' ? b.g : b.g?.value;
    if (!g || !g.startsWith(prefix)) continue;
    const tail = g.slice(prefix.length);
    const slash = tail.indexOf('/');
    const name = slash >= 0 ? tail.slice(slash + 1) : tail;
    const cnt = typeof b.cnt === 'string' ? parseInt(b.cnt, 10) : (b.cnt?.value ? parseInt(b.cnt.value, 10) : undefined);
    result.push({ name, graphUri: g, tripleCount: Number.isFinite(cnt) ? cnt : undefined });
  }
  return result;
}

/** Promote an assertion from WM to SWM. */
export const promoteAssertion = (contextGraphId: string, assertionName: string, entities: string | string[] = 'all') =>
  post<{ promotedCount: number }>(`/api/assertion/${encodeURIComponent(assertionName)}/promote`, { contextGraphId, entities });

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

/** Fetch extraction status for an assertion (includes fileHash + contentType). */
export const fetchExtractionStatus = (assertionName: string, contextGraphId: string) =>
  get<ExtractionStatus>(`/api/assertion/${encodeURIComponent(assertionName)}/extraction-status?contextGraphId=${encodeURIComponent(contextGraphId)}`);

/** Build a URL to serve a stored file by its hash (sha256: or keccak256:). */
export function fileUrl(hash: string, contentType?: string): string {
  const params = contentType ? `?contentType=${encodeURIComponent(contentType)}` : '';
  if (hash.startsWith('keccak256:') || hash.startsWith('sha256:')) {
    return `${BASE}/api/file/${hash}${params}`;
  }
  return `${BASE}/api/file/sha256:${hash}${params}`;
}

export interface SwmRootEntity {
  uri: string;
  label: string;
  tripleCount: number;
}

/** List root entities in SWM with their triple counts. */
export async function listSwmEntities(contextGraphId: string): Promise<SwmRootEntity[]> {
  const sparql = `SELECT ?s (COUNT(?p) AS ?cnt) WHERE { ?s ?p ?o } GROUP BY ?s ORDER BY DESC(?cnt)`;
  const data = await post<{ result: any }>('/api/query', { sparql, contextGraphId, view: 'shared-working-memory' });
  const bindings: any[] = data?.result?.bindings ?? [];
  return bindings.map((b) => {
    const uri = typeof b.s === 'string' ? b.s : b.s?.value ?? '';
    const cntRaw = typeof b.cnt === 'string' ? b.cnt : b.cnt?.value ?? '0';
    const m = cntRaw.match(/^"?(\d+)/);
    const tripleCount = m ? parseInt(m[1], 10) : 0;
    const hash = uri.lastIndexOf('#');
    const slash = uri.lastIndexOf('/');
    const cut = Math.max(hash, slash);
    const label = cut >= 0 ? uri.slice(cut + 1) : uri;
    return { uri, label, tripleCount };
  });
}

export interface PublishResult {
  kcId: string;
  status: string;
  kas: { tokenId: string; rootEntity: string }[];
  txHash?: string;
  blockNumber?: number;
}

/** Publish SWM content on-chain (SWM -> VM). Pass rootEntities to selectively publish, or omit for all. */
export const publishSharedMemory = (contextGraphId: string, rootEntities?: string[]) =>
  post<PublishResult>('/api/shared-memory/publish', {
    contextGraphId,
    selection: rootEntities ?? 'all',
    clearAfter: !rootEntities,
  });

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
    author: string;
    text: string;
    ts: string;
    turnId?: string;
    persistStatus?: 'pending' | 'in_progress' | 'stored' | 'failed' | 'skipped';
  }>;
}
export interface MemorySessionPublicationStatus {
  sessionId: string;
  sharedMemoryTripleCount: number;
  dataTripleCount: number;
  scope: 'shared_memory_only' | 'published' | 'published_with_pending' | 'empty';
  rootEntityCount: number;
}
export interface MemorySessionPublishResult {
  sessionId: string;
  rootEntityCount: number;
  status: string;
  tripleCount: number;
  ual?: string;
  publication: MemorySessionPublicationStatus;
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
export const fetchMemorySession = (sessionId: string) =>
  get<MemorySession>(`/api/memory/sessions/${encodeURIComponent(sessionId)}`);
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
export const fetchMemorySessionPublication = (sessionId: string) =>
  get<MemorySessionPublicationStatus>(`/api/memory/sessions/${encodeURIComponent(sessionId)}/publication`);
export const publishMemorySession = (
  sessionId: string,
  opts: { rootEntities?: string[]; clearAfter?: boolean } = {},
) =>
  post<MemorySessionPublishResult>(`/api/memory/sessions/${encodeURIComponent(sessionId)}/publish`, opts);
export const fetchMemoryStats = () =>
  get<{ contextGraphId: string; initialized: boolean; chatTriples: number; knowledgeTriples: number; totalTriples: number; sessionCount: number; entityCount: number }>('/api/memory/stats');

export const IMPORT_SOURCES = ['claude', 'chatgpt', 'gemini', 'other'] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

export interface ImportMemoryQuad {
  subject: string;
  predicate: string;
  object: string;
}

export interface ImportMemoryResult {
  batchId: string | null;
  source: ImportSource;
  memoryCount: number;
  tripleCount: number;
  entityCount: number;
  quads: ImportMemoryQuad[];
  quadsTruncated?: boolean;
  warnings?: string[];
}
export const importMemories = (text: string, source?: ImportSource, useLlm?: boolean) =>
  post<ImportMemoryResult>('/api/memory/import', { text, source, useLlm });

// --- Peer-to-peer messaging ---
export const sendPeerMessage = (to: string, text: string) =>
  post<{ delivered: boolean; error?: string }>('/api/chat', { to, text });

export const fetchMessages = (opts: { peer?: string; since?: number; limit?: number } = {}) => {
  const params = new URLSearchParams();
  if (opts.peer) params.set('peer', opts.peer);
  if (opts.since) params.set('since', String(opts.since));
  if (opts.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return get<{ messages: Array<{ ts: number; direction: 'in' | 'out'; peer: string; peerName?: string; text: string }> }>(
    `/api/messages${qs ? '?' + qs : ''}`,
  );
};

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

export const sendOpenClawChat = (peerId: string, text: string) =>
  post<{ delivered: boolean; reply: string | null; timedOut: boolean; waitMs: number; error?: string }>(
    '/api/chat-openclaw',
    { peerId, text },
  );

// --- OpenClaw local channel bridge ---

export async function sendOpenClawLocalChat(
  text: string,
  opts?: { correlationId?: string; signal?: AbortSignal; identity?: string },
): Promise<{ text: string; correlationId: string }> {
  const body = {
    text,
    correlationId: opts?.correlationId ?? crypto.randomUUID(),
    ...(opts?.identity ? { identity: opts.identity } : {}),
  };
  const res = await fetch('/api/openclaw-channel/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
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
  | { type: 'final'; text: string; correlationId: string }
  | { type: 'error'; error: string };

/**
 * SSE streaming variant of sendOpenClawLocalChat.
 * Yields text deltas as the agent produces them.
 */
export async function streamOpenClawLocalChat(
  text: string,
  opts: {
    correlationId?: string;
    signal?: AbortSignal;
    onEvent?: (event: OpenClawStreamEvent) => void;
    identity?: string;
  } = {},
): Promise<{ text: string; correlationId: string }> {
  const body = {
    text,
    correlationId: opts.correlationId ?? crypto.randomUUID(),
    ...(opts.identity ? { identity: opts.identity } : {}),
  };
  const res = await fetch('/api/openclaw-channel/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      ...authHeaders(),
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error((errBody as { error?: string })?.error ?? `Request failed (${res.status})`);
  }

  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();

  // Fallback: if server didn't return SSE, treat as JSON
  if (!res.body || !contentType.includes('text/event-stream')) {
    const data = await res.json() as { text: string; correlationId: string };
    opts.onEvent?.({ type: 'final', ...data });
    return data;
  }

  // Read SSE stream
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalPayload: { text: string; correlationId: string } | undefined;
  let streamError: Error | undefined;

  const handleEvent = (event: OpenClawStreamEvent): void => {
    opts.onEvent?.(event);
    if (event.type === 'error') {
      streamError = new Error(event.error || 'Stream failed');
    } else if (event.type === 'final') {
      finalPayload = { text: event.text, correlationId: event.correlationId };
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
  get<{
    ok: boolean;
    target?: 'bridge' | 'gateway';
    bridge?: { ok: boolean; channel?: string; cached?: boolean; error?: string };
    gateway?: { ok: boolean; channel?: string; error?: string };
    error?: string;
  }>(
    '/api/openclaw-channel/health',
  );

interface LocalAgentIntegrationRecord {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  status?: 'disconnected' | 'configured' | 'connecting' | 'ready' | 'degraded' | 'error';
  capabilities?: {
    localChat?: boolean;
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
  | 'bridge_offline'
  | 'available'
  | 'coming_soon';

export interface LocalAgentIntegration {
  id: string;
  name: string;
  framework: string;
  description: string;
  chatSupported: boolean;
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
  target?: 'bridge' | 'gateway';
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
}

interface LocalAgentSurface {
  connectSupported: boolean;
  chatSupported: boolean;
  defaultSessionId?: (integrationId: string) => string;
  resolveChatContext?: (args: {
    integrationId: string;
    sessionId?: string;
  }) => Record<string, unknown>;
  fetchHealth?: () => Promise<{
    ok: boolean;
    target?: 'bridge' | 'gateway';
    error?: string;
  }>;
  streamChat?: typeof streamOpenClawLocalChat;
}

const LOCAL_AGENT_SURFACES: Record<string, LocalAgentSurface> = {
  openclaw: {
    connectSupported: true,
    chatSupported: true,
    defaultSessionId: (integrationId: string) => `${integrationId}:dkg-ui`,
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
};

export function getDefaultLocalAgentSessionId(integrationId: string): string | null {
  const normalizedId = integrationId.trim().toLowerCase();
  return LOCAL_AGENT_SURFACES[normalizedId]?.defaultSessionId?.(normalizedId) ?? null;
}

function resolveLocalAgentHistorySessionId(integrationId: string, sessionId?: string): string | null {
  if (sessionId?.trim()) return sessionId.trim();
  return getDefaultLocalAgentSessionId(integrationId);
}

async function fetchLocalAgentHistoryBySessionId(
  sessionId: string,
  limit = 50,
): Promise<LocalAgentHistoryMessage[]> {
  try {
    const session = await fetchMemorySession(sessionId);
    return session.messages
      .slice(-limit)
      .map((message, index) => ({
        uri: `urn:dkg:chat:session:${sessionId}:message:${index}`,
        text: message.text,
        author: message.author,
        ts: message.ts,
        turnId: message.turnId,
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

async function mapLocalAgentIntegrationRecord(record: LocalAgentIntegrationRecord): Promise<LocalAgentIntegration> {
  const id = String(record.id ?? '').toLowerCase();
  const surface = LOCAL_AGENT_SURFACES[id];
  const hasChatBridge = record.capabilities?.localChat === true && surface?.chatSupported === true;
  const connectSupported = record.capabilities?.connectFromUi === true && surface?.connectSupported === true;
  const configured = record.enabled === true;
  const runtimeStatus = record.runtime?.status;
  const health = configured && hasChatBridge && surface?.fetchHealth
    ? await surface.fetchHealth().catch(() => null)
    : null;
  const chatReady = health?.ok === true;
  const bridgeOnline = chatReady;
  const persistentChat = configured && hasChatBridge && (
    chatReady
    || runtimeStatus === 'connecting'
    || record.runtime?.ready === true
    || hasLocalAgentTransportHints(record)
  );

  let status: LocalAgentIntegrationStatus;
  let statusLabel: string;
  let detail: string;
  if (bridgeOnline) {
    status = 'chat_ready';
    statusLabel = 'Chat ready';
    detail = `${record.name} is connected to this node and ready for chat.`;
  } else if (persistentChat && record.runtime?.status === 'connecting') {
    status = 'connecting';
    statusLabel = 'Connecting';
    detail = record.runtime?.lastError
      ?? `${record.name} is registered and still starting up.`;
  } else if (persistentChat) {
    status = 'bridge_offline';
    statusLabel = 'Bridge offline';
    detail = health?.error
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
    chatSupported: hasChatBridge,
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

export async function fetchLocalAgentHealth(id: string) {
  if (id === 'openclaw') return fetchOpenClawLocalHealth();
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
  opts: {
    correlationId?: string;
    signal?: AbortSignal;
    onEvent?: (event: LocalAgentStreamEvent) => void;
    sessionId?: string;
  } = {},
): Promise<{ text: string; correlationId: string }> {
  const normalizedId = id.trim().toLowerCase();
  const surface = LOCAL_AGENT_SURFACES[normalizedId];
  if (surface?.streamChat) {
    return surface.streamChat(text, {
      ...opts,
      ...surface.resolveChatContext?.({
        integrationId: normalizedId,
        sessionId: opts.sessionId,
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
  get<{ ok: boolean; rpcUrl: string | null; latencyMs: number | null; blockNumber: number | null; error?: string }>('/api/chain/rpc-health');

// --- Apps ---
export const fetchApps = () =>
  get<Array<{ id: string; label: string; path: string; staticUrl?: string }>>('/api/apps');

// --- Node control ---
export const shutdownNode = () =>
  post<{ ok: boolean }>('/api/shutdown', {});

// --- Integrations ---
export const fetchIntegrations = () =>
  get<{ adapters: Array<{ id: string; name: string; enabled: boolean; description?: string }>; skills: any[]; contextGraphs: any[] }>('/api/integrations');
export const subscribeToContextGraph = (contextGraphId: string) =>
  post<{ subscribed: string }>('/api/subscribe', { contextGraphId });

// --- Notifications ---

export interface Notification {
  id: number;
  ts: number;
  type: string;
  title: string;
  message: string;
  source: string | null;
  peer: string | null;
  read: number;
  meta: string | null;
}

export const fetchNotifications = (opts?: { since?: number; limit?: number }) => {
  const params = new URLSearchParams();
  if (opts?.since) params.set('since', String(opts.since));
  if (opts?.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return get<{ notifications: Notification[]; unreadCount: number }>(`/api/notifications${qs ? `?${qs}` : ''}`);
};

export const markNotificationsRead = (ids?: number[]) =>
  post<{ marked: number }>('/api/notifications/read', ids ? { ids } : {});

// --- OriginTrail Game ---
const GAME_BASE = '/api/apps/origin-trail-game';

export const gameApi = {
  info:   () => get<any>(`${GAME_BASE}/info`),
  lobby:  () => get<{ openSwarms: any[]; mySwarms: any[] }>(`${GAME_BASE}/lobby`),
  swarm:  (id: string) => get<any>(`${GAME_BASE}/swarm/${id}`),
  create: (playerName: string, swarmName: string, maxPlayers?: number) =>
    post<any>(`${GAME_BASE}/create`, { playerName, swarmName, maxPlayers }),
  join:   (swarmId: string, playerName: string) =>
    post<any>(`${GAME_BASE}/join`, { swarmId, playerName }),
  leave:  (swarmId: string) =>
    post<any>(`${GAME_BASE}/leave`, { swarmId }),
  start:  (swarmId: string) =>
    post<any>(`${GAME_BASE}/start`, { swarmId }),
  vote:   (swarmId: string, voteAction: string, params?: Record<string, any>) =>
    post<any>(`${GAME_BASE}/vote`, { swarmId, voteAction, params }),
  forceResolve: (swarmId: string) =>
    post<any>(`${GAME_BASE}/force-resolve`, { swarmId }),
};
