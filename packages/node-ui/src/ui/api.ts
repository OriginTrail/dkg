const BASE = '';

declare global {
  interface Window { __DKG_TOKEN__?: string; }
}

function authHeaders(): Record<string, string> {
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
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
export const updateLlmSettings = (data: { apiKey: string; model?: string; baseURL?: string }) =>
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
export const sendChatMessage = (message: string, sessionId?: string) =>
  post<{ reply: string; data?: unknown; sparql?: string; sessionId?: string }>('/api/chat-assistant', { message, sessionId });

// --- Memory (private chat memories in DKG) ---
export interface MemorySession {
  session: string;
  messages: Array<{ author: string; text: string; ts: string }>;
}
export const fetchMemorySessions = (limit = 20) =>
  get<{ sessions: MemorySession[] }>(`/api/memory/sessions?limit=${limit}`);
export const fetchMemorySession = (sessionId: string) =>
  get<MemorySession>(`/api/memory/sessions/${encodeURIComponent(sessionId)}`);
export const fetchMemoryStats = () =>
  get<{ paranetId: string; initialized: boolean; chatTriples: number; knowledgeTriples: number; totalTriples: number; sessionCount: number; entityCount: number }>('/api/memory/stats');

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

// --- Integrations ---
export const fetchIntegrations = () =>
  get<{ adapters: Array<{ id: string; name: string; enabled: boolean; description?: string }>; skills: any[]; paranets: any[] }>('/api/integrations');
export const subscribeToParanet = (paranetId: string) =>
  post<{ subscribed: string }>('/api/subscribe', { paranetId });

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
