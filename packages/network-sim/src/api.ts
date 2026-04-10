import type { DevnetConfig, NodeStatus } from './types';

function nodeBase(nodeId: number): string {
  return `/node/${nodeId}`;
}

async function parseError(res: Response, url: string): Promise<Error> {
  try {
    const body = await res.json();
    return new Error(body.error || `HTTP ${res.status}: ${url}`);
  } catch {
    return new Error(`HTTP ${res.status}: ${url}`);
  }
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw await parseError(res, url);
  return res.json() as Promise<T>;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseError(res, url);
  return res.json() as Promise<T>;
}

export async function fetchDevnetConfig(): Promise<DevnetConfig> {
  return get<DevnetConfig>('/devnet/config');
}

export async function fetchNodeStatus(nodeId: number): Promise<NodeStatus> {
  return get<NodeStatus>(`${nodeBase(nodeId)}/api/status`);
}

export async function fetchConnections(nodeId: number) {
  return get<{
    total: number;
    direct: number;
    relayed: number;
    connections: Array<{
      peerId: string;
      remoteAddr: string;
      transport: string;
      direction: string;
    }>;
  }>(`${nodeBase(nodeId)}/api/connections`);
}

export async function fetchAgents(nodeId: number) {
  return get<{
    agents: Array<{
      peerId: string;
      name?: string;
      connectionStatus: string;
    }>;
  }>(`${nodeBase(nodeId)}/api/agents`);
}

export async function publishKA(
  nodeId: number,
  contextGraphId: string,
  quads: Array<{ subject: string; predicate: string; object: string; graph?: string }>,
  privateQuads?: Array<{ subject: string; predicate: string; object: string; graph?: string }>,
) {
  if (privateQuads?.length) {
    throw new Error('privateQuads are not supported in V10 SWM-first publish');
  }
  await post<any>(`${nodeBase(nodeId)}/api/shared-memory/write`, { paranetId: contextGraphId, quads });
  return post<{
    kcId: string;
    status: string;
    kas: Array<{ tokenId: string; rootEntity: string }>;
    txHash?: string;
  }>(`${nodeBase(nodeId)}/api/shared-memory/publish`, { paranetId: contextGraphId, selection: 'all', clearAfter: true });
}

export async function queryNode(
  nodeId: number,
  sparql: string,
  contextGraphId?: string,
  opts?: { graphSuffix?: '_shared_memory'; includeSharedMemory?: boolean },
) {
  return post<{ result: unknown }>(`${nodeBase(nodeId)}/api/query`, {
    sparql,
    contextGraphId,
    ...opts,
  });
}

export async function share(
  nodeId: number,
  contextGraphId: string,
  quads: Array<{ subject: string; predicate: string; object: string; graph?: string }>,
) {
  return post<{ shareOperationId: string }>(`${nodeBase(nodeId)}/api/shared-memory/write`, {
    contextGraphId,
    quads,
  });
}

export async function publishFromSharedMemory(
  nodeId: number,
  contextGraphId: string,
  selection: 'all' | { rootEntities: string[] } = 'all',
  clearAfter = true,
) {
  return post<{
    kcId: string;
    status: string;
    kas: Array<{ tokenId: string; rootEntity: string }>;
    txHash?: string;
  }>(`${nodeBase(nodeId)}/api/shared-memory/publish`, {
    contextGraphId,
    selection,
    clearAfter,
  });
}

export async function sendChat(nodeId: number, to: string, text: string) {
  return post<{ delivered: boolean; error?: string }>(`${nodeBase(nodeId)}/api/chat`, { to, text });
}

export async function fetchMessages(nodeId: number, peer?: string) {
  const qs = peer ? `?peer=${encodeURIComponent(peer)}` : '';
  return get<{
    messages: Array<{
      ts: number;
      direction: 'in' | 'out';
      peer: string;
      peerName?: string;
      text: string;
    }>;
  }>(`${nodeBase(nodeId)}/api/messages${qs}`);
}

export async function fetchContextGraphs(nodeId: number) {
  return get<{ contextGraphs: Array<{ id: string; name: string; uri?: string }> }>(
    `${nodeBase(nodeId)}/api/context-graph/list`,
  );
}

export async function createContextGraph(nodeId: number, id: string, name: string) {
  return post<{ created: boolean; uri: string }>(`${nodeBase(nodeId)}/api/context-graph/create`, {
    id,
    name,
  });
}

export async function subscribeContextGraph(nodeId: number, contextGraphId: string) {
  return post<{ subscribed: string }>(`${nodeBase(nodeId)}/api/subscribe`, { contextGraphId });
}

export async function fetchWalletBalances(nodeId: number) {
  return get<{
    wallets: string[];
    balances: Array<{ address: string; eth: string; trac: string; symbol: string }>;
  }>(`${nodeBase(nodeId)}/api/wallets/balances`);
}

export async function queryRemote(
  nodeId: number,
  peerId: string,
  opts: { lookupType: string; sparql?: string; ual?: string; contextGraphId?: string },
) {
  return post<{
    operationId: string;
    status: string;
    ntriples?: string;
    bindings?: unknown;
    error?: string;
  }>(`${nodeBase(nodeId)}/api/query-remote`, { peerId, ...opts });
}

export interface MetricSnapshot {
  ts: number;
  cpu_percent: number | null;
  mem_used_bytes: number | null;
  mem_total_bytes: number | null;
  heap_used_bytes: number | null;
  uptime_seconds: number | null;
  peer_count: number | null;
  direct_peers: number | null;
  relayed_peers: number | null;
  context_graph_count: number | null;
  total_triples: number | null;
  total_kcs: number | null;
  total_kas: number | null;
  store_bytes: number | null;
  confirmed_kcs: number | null;
  tentative_kcs: number | null;
  rpc_latency_ms: number | null;
  rpc_healthy: number | null;
}

export async function fetchNodeMetrics(nodeId: number): Promise<MetricSnapshot> {
  return get<MetricSnapshot>(`${nodeBase(nodeId)}/api/metrics`);
}

export async function fetchNodeMetricsHistory(
  nodeId: number,
  from?: number,
  to?: number,
  maxPoints = 200,
): Promise<{ snapshots: MetricSnapshot[] }> {
  const params = new URLSearchParams();
  if (from) params.set('from', String(from));
  if (to) params.set('to', String(to));
  params.set('maxPoints', String(maxPoints));
  return get<{ snapshots: MetricSnapshot[] }>(`${nodeBase(nodeId)}/api/metrics/history?${params}`);
}

export interface OperationStats {
  summary: {
    totalCount: number;
    successCount: number;
    errorCount: number;
    successRate: number;
    avgDurationMs: number;
    avgGasCostEth: number;
    totalGasCostEth: number;
    avgTracCost: number;
    totalTracCost: number;
  };
  timeSeries: Array<{
    bucket: number;
    count: number;
    successRate: number;
    avgDurationMs: number;
    avgGasCostEth: number;
    totalGasCostEth: number;
  }>;
}

export async function fetchOperationStats(
  nodeId: number,
  name?: string,
  period = '24h',
): Promise<OperationStats> {
  const params = new URLSearchParams({ period });
  if (name) params.set('name', name);
  return get<OperationStats>(`${nodeBase(nodeId)}/api/operation-stats?${params}`);
}
