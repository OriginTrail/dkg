const BASE = '';

declare global {
  interface Window { __DKG_TOKEN__?: string; }
}

function authHeaders(): Record<string, string> {
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
export const fetchOperation = (id: string) =>
  get<{ operation: any; logs: any[]; phases: any[] }>(`/api/operations/${id}`);

// --- Operation stats ---
export const fetchOperationStats = (params: { name?: string; period?: string } = {}) => {
  const qs = new URLSearchParams();
  if (params.name) qs.set('name', params.name);
  if (params.period) qs.set('period', params.period);
  const q = qs.toString();
  return get<{ summary: any; timeSeries: any[] }>(`/api/operation-stats${q ? '?' + q : ''}`);
};

// --- Logs ---
export const fetchLogs = (params: Record<string, string> = {}) => {
  const qs = new URLSearchParams(params).toString();
  return get<{ logs: any[]; total: number }>(`/api/logs${qs ? '?' + qs : ''}`);
};

// --- Paranets ---
export const fetchParanets = () => get<{ paranets: any[] }>('/api/paranet/list');

// --- Query ---
export const executeQuery = (sparql: string, paranetId?: string, includeWorkspace?: boolean, graphSuffix?: '_workspace') =>
  post<{ result: any }>('/api/query', { sparql, paranetId, includeWorkspace, graphSuffix });

// --- Publish ---
export const publishTriples = (paranetId: string, quads: any[]) =>
  post<any>('/api/publish', { paranetId, quads });

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

// --- Chat assistant ---
export interface ChatLlmDiagnostics {
  message: string;
  status?: number;
  provider?: string;
  model?: string;
  compatibilityHint?: string;
}

export interface ChatAssistantTurnResponse {
  reply: string;
  data?: unknown;
  sparql?: string;
  sessionId?: string;
  turnId?: string;
  persistStatus?: 'pending' | 'in_progress' | 'stored' | 'failed' | 'skipped';
  persistError?: string;
  timings?: { llm_ms: number; store_ms: number; total_ms: number };
  responseMode?: 'streaming' | 'blocking' | 'rule-based';
  llmDiagnostics?: ChatLlmDiagnostics;
}

export type ChatAssistantStreamEvent =
  | { type: 'meta'; sessionId: string }
  | { type: 'text_delta'; delta: string }
  | ({ type: 'final' } & ChatAssistantTurnResponse)
  | { type: 'error'; error: string; llmDiagnostics?: ChatLlmDiagnostics };

export interface ChatPersistenceStatusEvent {
  type: 'persist_status';
  turnId: string;
  sessionId: string;
  status: 'pending' | 'in_progress' | 'stored' | 'failed';
  attempts: number;
  maxAttempts: number;
  queuedAt: number;
  updatedAt: number;
  nextAttemptAt?: number;
  storeMs?: number;
  error?: string;
}

export interface ChatPersistenceHealthEvent {
  type: 'persist_health';
  ts: number;
  pending: number;
  inProgress: number;
  stored: number;
  failed: number;
  overduePending: number;
  oldestPendingAgeMs: number | null;
}

export type ChatPersistenceStreamEvent = ChatPersistenceStatusEvent | ChatPersistenceHealthEvent;

export const sendChatMessage = (message: string, sessionId?: string) =>
  post<ChatAssistantTurnResponse>('/api/chat-assistant', { message, sessionId });

export async function streamChatMessage(
  message: string,
  opts: {
    sessionId?: string;
    signal?: AbortSignal;
    onEvent?: (event: ChatAssistantStreamEvent) => void;
  } = {},
): Promise<ChatAssistantTurnResponse> {
  const res = await fetch(`${BASE}/api/chat-assistant`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      ...authHeaders(),
    },
    body: JSON.stringify({ message, sessionId: opts.sessionId, stream: true }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const msg = (errBody as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }

  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!res.body || !contentType.includes('text/event-stream')) {
    const data = await res.json() as ChatAssistantTurnResponse;
    opts.onEvent?.({ type: 'final', ...data });
    return data;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalPayload: ChatAssistantTurnResponse | undefined;
  let streamError: Error | undefined;

  const handleEvent = (event: ChatAssistantStreamEvent): void => {
    opts.onEvent?.(event);
    if (event.type === 'error') {
      streamError = new Error(event.error || 'Chat stream failed');
      return;
    }
    if (event.type === 'final') {
      const { type: _ignored, ...payload } = event;
      finalPayload = payload;
    }
  };

  const processBufferLines = (finalFlush: boolean): void => {
    let lineEnd = buffer.indexOf('\n');
    while (lineEnd !== -1) {
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      lineEnd = buffer.indexOf('\n');
      if (!line.startsWith('data:')) continue;
      const dataLine = line.slice(5).trim();
      if (!dataLine) continue;
      try {
        const parsed = JSON.parse(dataLine) as ChatAssistantStreamEvent;
        handleEvent(parsed);
      } catch {
        /* ignore malformed stream frames */
      }
      if (streamError) return;
    }

    if (finalFlush && buffer.trim().startsWith('data:')) {
      const dataLine = buffer.trim().slice(5).trim();
      if (!dataLine) return;
      try {
        const parsed = JSON.parse(dataLine) as ChatAssistantStreamEvent;
        handleEvent(parsed);
      } catch {
        /* ignore malformed stream frames */
      }
      buffer = '';
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    processBufferLines(false);
    if (streamError) break;
  }
  buffer += decoder.decode();
  processBufferLines(true);

  if (streamError) throw streamError;
  if (!finalPayload) throw new Error('Chat stream ended without final payload');
  return finalPayload;
}

export const fetchChatPersistenceHealth = () =>
  get<{
    ts: number;
    pending: number;
    inProgress: number;
    stored: number;
    failed: number;
    overduePending: number;
    oldestPendingAgeMs: number | null;
  }>('/api/chat-assistant/persistence/health');

export async function streamChatPersistenceEvents(
  opts: {
    signal?: AbortSignal;
    onEvent: (event: ChatPersistenceStreamEvent) => void;
  },
): Promise<void> {
  const res = await fetch(`${BASE}/api/chat-assistant/persistence/events`, {
    method: 'GET',
    headers: {
      'Accept': 'text/event-stream',
      ...authHeaders(),
    },
    signal: opts.signal,
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const msg = (errBody as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }

  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!res.body || !contentType.includes('text/event-stream')) {
    throw new Error('Persistence event endpoint did not return SSE stream');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const processBuffer = (finalFlush: boolean): void => {
    let lineEnd = buffer.indexOf('\n');
    while (lineEnd !== -1) {
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      lineEnd = buffer.indexOf('\n');
      if (!line.startsWith('data:')) continue;
      const dataLine = line.slice(5).trim();
      if (!dataLine) continue;
      try {
        const parsed = JSON.parse(dataLine) as ChatPersistenceStreamEvent;
        opts.onEvent(parsed);
      } catch {
        /* ignore malformed frames */
      }
    }

    if (finalFlush && buffer.trim().startsWith('data:')) {
      const dataLine = buffer.trim().slice(5).trim();
      if (!dataLine) return;
      try {
        const parsed = JSON.parse(dataLine) as ChatPersistenceStreamEvent;
        opts.onEvent(parsed);
      } catch {
        /* ignore malformed frames */
      }
      buffer = '';
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    processBuffer(false);
  }

  buffer += decoder.decode();
  processBuffer(true);
}

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
  workspaceTripleCount: number;
  dataTripleCount: number;
  scope: 'workspace_only' | 'enshrined' | 'enshrined_with_pending' | 'empty';
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
  get<{ paranetId: string; initialized: boolean; chatTriples: number; knowledgeTriples: number; totalTriples: number; sessionCount: number; entityCount: number }>('/api/memory/stats');

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
  opts?: { correlationId?: string; signal?: AbortSignal },
): Promise<{ text: string; correlationId: string }> {
  const body = { text, correlationId: opts?.correlationId ?? crypto.randomUUID() };
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
  } = {},
): Promise<{ text: string; correlationId: string }> {
  const body = { text, correlationId: opts.correlationId ?? crypto.randomUUID() };
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
  get<{ ok: boolean; bridge?: { ok: boolean; channel: string }; error?: string }>(
    '/api/openclaw-channel/health',
  );

/**
 * Load chat history for the local OpenClaw agent from the DKG graph.
 * Queries schema:Message items linked to the openclaw:dkg-ui session.
 */
export async function fetchOpenClawLocalHistory(limit = 50): Promise<
  Array<{ uri: string; text: string; author: string; ts: string }>
> {
  const sparql = `SELECT ?uri ?text ?author ?ts WHERE {
      ?uri a <http://schema.org/Message> ;
           <http://schema.org/isPartOf> <urn:dkg:chat:session:openclaw:dkg-ui> ;
           <http://schema.org/text> ?text ;
           <http://schema.org/author> ?author ;
           <http://schema.org/dateCreated> ?ts .
    }
    ORDER BY ?ts
    LIMIT ${limit}`;
  const res = await executeQuery(sparql, 'agent-memory', true);
  const bindings: any[] = res?.result?.bindings ?? (res as any)?.results?.bindings ?? [];
  return bindings.map((b: any) => ({
    uri: bv(b.uri) ?? '',
    text: bv(b.text) ?? '',
    author: bv(b.author) ?? '',
    ts: bv(b.ts) ?? '',
  }));
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
  get<{ adapters: Array<{ id: string; name: string; enabled: boolean; description?: string }>; skills: any[]; paranets: any[] }>('/api/integrations');
export const subscribeToParanet = (paranetId: string) =>
  post<{ subscribed: string }>('/api/subscribe', { paranetId });

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
