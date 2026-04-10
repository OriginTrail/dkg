import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const DEVNET_NUM_NODES = 6;
const DEVNET_API_PORT_BASE = 9201;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SimConfig {
  name: string;
  opCount: number;
  opsPerSec: number;
  concurrency: number;
  kasPerPublish: number;
  contextGraph: string;
  enabledOps: string[];
}

interface OpEvent {
  type: 'op';
  opType: string;
  nodeId: number;
  success: boolean;
  durationMs: number;
  detail: string;
  phases: Record<string, number>;
}

interface StatusEvent {
  type: 'status';
  total: number;
  completed: number;
  errors: number;
  opsPerSec: number;
}

interface DoneEvent {
  type: 'done';
  total: number;
  completed: number;
  errors: number;
  elapsedMs: number;
  byOp?: Record<string, OpStats>;
}

interface ErrorEvent {
  type: 'error';
  message: string;
}

type SimEvent = OpEvent | StatusEvent | DoneEvent | ErrorEvent;

interface NodeInfo {
  id: number;
  port: number;
  peerId?: string;
  authToken?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rndId(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/** Devnet auth token path for a node (node1, node2, … not node-1). Used by loadNodeTokens; exported for tests. */
export function devnetAuthTokenPath(devnetDir: string, nodeId: number): string {
  return join(devnetDir, `node${nodeId}`, 'auth.token');
}

function authHeaders(node: NodeInfo): Record<string, string> {
  if (!node.authToken) return {};
  return { Authorization: `Bearer ${node.authToken}` };
}

async function loadNodeTokens(nodes: NodeInfo[]): Promise<void> {
  const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
  const devnetDir = join(repoRoot, '.devnet');
  await Promise.allSettled(
    nodes.map(async (node) => {
      try {
        const tokenPath = devnetAuthTokenPath(devnetDir, node.id);
        const raw = await readFile(tokenPath, 'utf-8');
        for (const line of raw.split('\n')) {
          const t = line.trim();
          if (t.length > 0 && !t.startsWith('#')) {
            node.authToken = t;
            break;
          }
        }
      } catch {
        // No token file — node may not require auth
      }
    }),
  );
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

const OP_TIMEOUT_MS: Record<string, number> = {
  publish: 60_000,
  sharedMemory: 60_000,
  query: 30_000,
  chat: 10_000,
};

function opSignal(simSignal: AbortSignal, opType: string): AbortSignal {
  const timeoutMs = OP_TIMEOUT_MS[opType] ?? 30_000;
  return AbortSignal.any([simSignal, AbortSignal.timeout(timeoutMs)]);
}

/** Exported for unit tests. */
export function fmtError(err: unknown, opType: string): string {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return `timeout (${(OP_TIMEOUT_MS[opType] ?? 30_000) / 1000}s)`;
  }
  if (err instanceof DOMException && err.name === 'AbortError') {
    return 'aborted (simulation stopped)';
  }
  return String(err instanceof Error ? err.message : err);
}

function jsonResponse(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Simulation state
// ---------------------------------------------------------------------------

let activeAbort: AbortController | null = null;
let sseClients: Set<ServerResponse> = new Set();

interface OpStats {
  ok: number;
  fail: number;
  timeouts: number;
  totalMs: number;
}

let stats = {
  total: 0,
  completed: 0,
  errors: 0,
  startedAt: 0,
  recentTimestamps: [] as number[],
  byOp: {} as Record<string, OpStats>,
};

function resetStats(total: number) {
  stats = { total, completed: 0, errors: 0, startedAt: Date.now(), recentTimestamps: [], byOp: {} };
}

function recordOp(opType: string, success: boolean, durationMs: number, isTimeout: boolean) {
  if (!stats.byOp[opType]) {
    stats.byOp[opType] = { ok: 0, fail: 0, timeouts: 0, totalMs: 0 };
  }
  const s = stats.byOp[opType];
  if (success) { s.ok++; } else { s.fail++; }
  if (isTimeout) s.timeouts++;
  if (success) s.totalMs += durationMs;
}

function currentOpsPerSec(): number {
  const now = Date.now();
  const window = stats.recentTimestamps.filter((t) => now - t < 10_000);
  stats.recentTimestamps = window;
  if (window.length < 2) return 0;
  const span = (now - window[0]) / 1000;
  return span > 0 ? window.length / span : 0;
}

const MAX_ERROR_LOG = 20;
let errorLogCount = 0;

function broadcast(event: SimEvent) {
  if (event.type === 'op' && !event.success && errorLogCount < MAX_ERROR_LOG) {
    errorLogCount++;
    console.error(`[sim] error #${errorLogCount}: ${event.opType} node${event.nodeId} — ${event.detail}`);
  }
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ---------------------------------------------------------------------------
// Node discovery
// ---------------------------------------------------------------------------

function getNodes(): NodeInfo[] {
  return Array.from({ length: DEVNET_NUM_NODES }, (_, i) => ({
    id: i + 1,
    port: DEVNET_API_PORT_BASE + i,
  }));
}

async function discoverPeerIds(nodes: NodeInfo[], signal: AbortSignal): Promise<void> {
  await Promise.allSettled(
    nodes.map(async (node) => {
      try {
        const res = await fetch(`http://127.0.0.1:${node.port}/api/status`, { signal });
        if (res.ok) {
          const data = (await res.json()) as { peerId?: string };
          node.peerId = data.peerId;
        }
      } catch {
        // node offline — leave peerId undefined
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Operation executors
// ---------------------------------------------------------------------------

async function execPublish(
  node: NodeInfo,
  config: SimConfig,
  signal: AbortSignal,
): Promise<OpEvent> {
  const t0 = Date.now();
  const graph = `did:dkg:context-graph:${config.contextGraph}`;
  const quads = Array.from({ length: config.kasPerPublish }, () => {
    const entity = `did:dkg:entity:sim-${rndId()}`;
    return {
      subject: entity,
      predicate: 'http://schema.org/name',
      object: `"SimEntity-${rndId()}"`,
      graph,
    };
  });

  try {
    const writeRes = await fetch(`http://127.0.0.1:${node.port}/api/shared-memory/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(node) },
      body: JSON.stringify({ paranetId: config.contextGraph, quads }),
      signal: opSignal(signal, 'publish'),
    });
    if (!writeRes.ok) {
      const writeBody = (await writeRes.json().catch(() => ({}))) as { error?: string };
      const dur = Date.now() - t0;
      return {
        type: 'op',
        opType: 'publish',
        nodeId: node.id,
        success: false,
        durationMs: dur,
        detail: `SWM write failed: ${writeBody.error ?? `HTTP ${writeRes.status}`}`,
        phases: {},
      };
    }
    const res = await fetch(`http://127.0.0.1:${node.port}/api/shared-memory/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(node) },
      body: JSON.stringify({ paranetId: config.contextGraph, selection: 'all', clearAfter: true }),
      signal: opSignal(signal, 'publish'),
    });
    const body = (await res.json()) as { kcId?: string; kas?: unknown[]; status?: string; error?: string; phases?: Record<string, number> };
    const dur = Date.now() - t0;
    const kasCount = Array.isArray(body.kas) ? body.kas.length : (res.ok ? config.kasPerPublish : 0);
    const kcDisplay = res.ok ? (body.kcId != null ? String(body.kcId).slice(0, 12) : '0') : '—';
    const detail = res.ok
      ? `KC: ${kcDisplay} (${kasCount} KAs)${body.status ? ` ${body.status}` : ''}`
      : `${body.error ?? `HTTP ${res.status}`} (${kasCount} KAs)`;
    return {
      type: 'op',
      opType: 'publish',
      nodeId: node.id,
      success: res.ok,
      durationMs: dur,
      detail,
      phases: body.phases ?? {},
    };
  } catch (err) {
    return {
      type: 'op',
      opType: 'publish',
      nodeId: node.id,
      success: false,
      durationMs: Date.now() - t0,
      detail: fmtError(err, 'publish'),
      phases: {},
    };
  }
}

async function execQuery(
  node: NodeInfo,
  config: SimConfig,
  signal: AbortSignal,
): Promise<OpEvent> {
  const t0 = Date.now();
  const limit = 5 + Math.floor(Math.random() * 21);
  const sparql = `SELECT * WHERE { ?s ?p ?o } LIMIT ${limit}`;

  try {
    const res = await fetch(`http://127.0.0.1:${node.port}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(node) },
      body: JSON.stringify({ sparql, contextGraphId: config.contextGraph }),
      signal: opSignal(signal, 'query'),
    });
    const body = (await res.json()) as { result?: { bindings?: unknown[] }; phases?: Record<string, number> };
    const dur = Date.now() - t0;
    const count = Array.isArray(body.result?.bindings) ? body.result.bindings.length : 0;
    return {
      type: 'op',
      opType: 'query',
      nodeId: node.id,
      success: res.ok,
      durationMs: dur,
      detail: `${count} bindings (LIMIT ${limit})`,
      phases: body.phases ?? {},
    };
  } catch (err) {
    return {
      type: 'op',
      opType: 'query',
      nodeId: node.id,
      success: false,
      durationMs: Date.now() - t0,
      detail: fmtError(err, 'query'),
      phases: {},
    };
  }
}

async function execWorkspace(
  node: NodeInfo,
  config: SimConfig,
  signal: AbortSignal,
): Promise<OpEvent> {
  const t0 = Date.now();
  const graph = `did:dkg:context-graph:${config.contextGraph}`;
  const entity = `did:dkg:entity:sim-ws-${rndId()}`;
  const quads = [
    {
      subject: entity,
      predicate: 'http://schema.org/name',
      object: `"WsEntity-${rndId()}"`,
      graph,
    },
  ];

  try {
    const res = await fetch(`http://127.0.0.1:${node.port}/api/shared-memory/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(node) },
      body: JSON.stringify({ contextGraphId: config.contextGraph, quads }),
      signal: opSignal(signal, 'sharedMemory'),
    });
    const body = (await res.json()) as { shareOperationId?: string; phases?: Record<string, number> };
    const dur = Date.now() - t0;
    return {
      type: 'op',
      opType: 'workspace',
      nodeId: node.id,
      success: res.ok,
      durationMs: dur,
      detail: `opId: ${body.shareOperationId?.slice(0, 8) ?? '?'}`,
      phases: body.phases ?? {},
    };
  } catch (err) {
    return {
      type: 'op',
      opType: 'workspace',
      nodeId: node.id,
      success: false,
      durationMs: Date.now() - t0,
      detail: fmtError(err, 'sharedMemory'),
      phases: {},
    };
  }
}

async function execChat(
  node: NodeInfo,
  nodes: NodeInfo[],
  signal: AbortSignal,
): Promise<OpEvent> {
  const t0 = Date.now();
  const peers = nodes.filter((n) => n.id !== node.id && n.peerId);
  if (peers.length === 0) {
    return {
      type: 'op',
      opType: 'chat',
      nodeId: node.id,
      success: false,
      durationMs: 0,
      detail: 'No peers with known peerId',
      phases: {},
    };
  }

  const target = pickRandom(peers);
  try {
    const res = await fetch(`http://127.0.0.1:${node.port}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(node) },
      body: JSON.stringify({ to: target.peerId, text: `sim-ping-${rndId()}` }),
      signal: opSignal(signal, 'chat'),
    });
    const body = (await res.json()) as { delivered?: boolean; error?: string; phases?: Record<string, number> };
    const dur = Date.now() - t0;
    return {
      type: 'op',
      opType: 'chat',
      nodeId: node.id,
      success: res.ok && body.delivered !== false,
      durationMs: dur,
      detail: body.delivered ? `→ node ${target.id}` : (body.error ?? 'not delivered'),
      phases: body.phases ?? {},
    };
  } catch (err) {
    return {
      type: 'op',
      opType: 'chat',
      nodeId: node.id,
      success: false,
      durationMs: Date.now() - t0,
      detail: fmtError(err, 'chat'),
      phases: {},
    };
  }
}

// ---------------------------------------------------------------------------
// Simulation runner
// ---------------------------------------------------------------------------

async function ensureContextGraph(nodes: NodeInfo[], contextGraphId: string, signal: AbortSignal): Promise<void> {
  try {
    // Create context graph on every node that will be used for publish/shared-memory/query.
    // Each node checks contextGraphExists() locally, so all must have the context graph definition.
    broadcast({ type: 'error', message: `Ensuring context graph "${contextGraphId}" exists on all nodes...` });
    const createBody = JSON.stringify({
      id: contextGraphId,
      name: contextGraphId,
      description: `Auto-created by sim engine`,
    });
    const results = await Promise.allSettled(
      nodes.map(async (n) => {
        const existsRes = await fetch(
          `http://127.0.0.1:${n.port}/api/context-graph/exists?id=${encodeURIComponent(contextGraphId)}`,
          { signal, headers: authHeaders(n) },
        );
        const existsData = (await existsRes.json()) as { exists?: boolean };
        if (existsData.exists) return;

        const createRes = await fetch(`http://127.0.0.1:${n.port}/api/context-graph/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders(n) },
          body: createBody,
          signal,
        });
        if (!createRes.ok) {
          const err = (await createRes.json().catch(() => ({}))) as { error?: string };
          if (err.error?.includes('already exists')) return;
          throw new Error(`Node ${n.id}: ${err.error ?? createRes.status}`);
        }
      }),
    );
    for (const r of results) {
      if (r.status === 'rejected') throw r.reason;
    }
    broadcast({ type: 'error', message: `Context graph "${contextGraphId}" ready on all nodes.` });
    await new Promise((r) => setTimeout(r, 500));
  } catch (err) {
    broadcast({ type: 'error', message: `Context graph setup failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}

async function runSimulation(config: SimConfig, signal: AbortSignal) {
  const nodes = getNodes();

  await loadNodeTokens(nodes);

  await ensureContextGraph(nodes, config.contextGraph, signal);

  if (config.enabledOps.includes('chat')) {
    await discoverPeerIds(nodes, signal);
  }

  resetStats(config.opCount);
  errorLogCount = 0;
  broadcast({ type: 'status', total: config.opCount, completed: 0, errors: 0, opsPerSec: 0 });

  // Periodic status broadcaster
  const statusInterval = setInterval(() => {
    if (signal.aborted) return;
    broadcast({
      type: 'status',
      total: config.opCount,
      completed: stats.completed,
      errors: stats.errors,
      opsPerSec: Math.round(currentOpsPerSec() * 10) / 10,
    });
  }, 500);

  let dispatched = 0;
  let inflight = 0;

  const minIntervalMs = 1000 / config.opsPerSec;
  let lastDispatchTime = 0;

  await new Promise<void>((resolve) => {
    function onOpDone(event: OpEvent) {
      inflight--;
      stats.completed++;
      stats.recentTimestamps.push(Date.now());
      const isTimeout = !event.success && event.detail.startsWith('timeout');
      if (!event.success) stats.errors++;
      recordOp(event.opType, event.success, event.durationMs, isTimeout);
      broadcast(event);

      if (stats.completed >= config.opCount) {
        resolve();
        return;
      }
      tryDispatch();
    }

    let nodeRR = 0;
    function launchOne() {
      if (dispatched >= config.opCount) return; // cap so we never exceed opCount (avoids race overshoot)
      const opType = pickRandom(config.enabledOps);
      nodeRR = (nodeRR + 1) % nodes.length;
      const node = nodes[nodeRR];
      dispatched++;
      inflight++;
      lastDispatchTime = Date.now();

      let promise: Promise<OpEvent>;
      switch (opType) {
        case 'publish':
          promise = execPublish(node, config, signal);
          break;
        case 'query':
          promise = execQuery(node, config, signal);
          break;
        case 'workspace':
          promise = execWorkspace(node, config, signal);
          break;
        case 'chat':
          promise = execChat(node, nodes, signal);
          break;
        default:
          promise = execPublish(node, config, signal);
      }

      promise.then(onOpDone).catch(() => {
        inflight--;
        stats.completed++;
        stats.errors++;
        stats.recentTimestamps.push(Date.now());
        broadcast({
          type: 'op',
          opType,
          nodeId: node.id,
          success: false,
          durationMs: 0,
          detail: 'Unexpected executor error',
          phases: {},
        });
        if (stats.completed >= config.opCount) resolve();
        else tryDispatch();
      });
    }

    function tryDispatch() {
      if (signal.aborted) { resolve(); return; }
      if (dispatched >= config.opCount) return;
      while (dispatched < config.opCount && inflight < config.concurrency) {
        const now = Date.now();
        const elapsed = now - lastDispatchTime;
        if (elapsed < minIntervalMs && dispatched > 0) {
          if (dispatched >= config.opCount) return;
          setTimeout(tryDispatch, minIntervalMs - elapsed);
          return;
        }
        launchOne();
      }
    }

    tryDispatch();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });

  clearInterval(statusInterval);

  if (!signal.aborted) {
    if (stats.errors > 0 && Object.keys(stats.byOp).length > 0) {
      const byOp = Object.entries(stats.byOp)
        .filter(([, s]) => s.fail > 0)
        .map(([op, s]) => `${op}: ${s.fail} fail`)
        .join(', ');
      console.error(`[sim] done: ${stats.completed} ok, ${stats.errors} errors (${byOp})`);
    }
    broadcast({
      type: 'done',
      total: config.opCount,
      completed: stats.completed,
      errors: stats.errors,
      elapsedMs: Date.now() - stats.startedAt,
      byOp: stats.byOp,
    });
  }
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

/** Exported for unit tests. */
export async function handleSimRequest(req: IncomingMessage, res: ServerResponse) {
  const url = req.url ?? '';

  // --- POST /sim/start ---
  if (url === '/sim/start' && req.method === 'POST') {
    if (activeAbort) {
      jsonResponse(res, 409, { error: 'Simulation already running' });
      return;
    }

    let config: SimConfig;
    try {
      const raw = await readBody(req);
      config = JSON.parse(raw) as SimConfig;
    } catch {
      jsonResponse(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    if (!config.opCount || !config.opsPerSec || !config.enabledOps?.length) {
      jsonResponse(res, 400, { error: 'Missing required fields: opCount, opsPerSec, enabledOps' });
      return;
    }

    config.concurrency = config.concurrency ?? 10;
    config.kasPerPublish = config.kasPerPublish ?? 1;
    config.contextGraph = config.contextGraph ?? 'devnet-test';
    config.name = config.name ?? `Sim-${rndId()}`;

    const abort = new AbortController();
    activeAbort = abort;

    jsonResponse(res, 200, { started: true, name: config.name });

    runSimulation(config, abort.signal)
      .catch((err) => {
        broadcast({ type: 'error', message: String(err instanceof Error ? err.message : err) });
      })
      .finally(() => {
        activeAbort = null;
      });
    return;
  }

  // --- POST /sim/stop ---
  if (url === '/sim/stop' && req.method === 'POST') {
    if (!activeAbort) {
      jsonResponse(res, 200, { stopped: false, reason: 'No simulation running' });
      return;
    }
    activeAbort.abort();
    activeAbort = null;
    broadcast({
      type: 'done',
      total: stats.total,
      completed: stats.completed,
      errors: stats.errors,
      elapsedMs: Date.now() - stats.startedAt,
      byOp: stats.byOp,
    });
    jsonResponse(res, 200, { stopped: true });
    return;
  }

  // --- GET /sim/events ---
  if (url === '/sim/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('\n');
    sseClients.add(res);

    // Send current status immediately if a simulation is running
    if (activeAbort) {
      const payload = `data: ${JSON.stringify({
        type: 'status',
        total: stats.total,
        completed: stats.completed,
        errors: stats.errors,
        opsPerSec: Math.round(currentOpsPerSec() * 10) / 10,
      } satisfies StatusEvent)}\n\n`;
      res.write(payload);
    }

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // --- GET /sim/status ---
  if (url === '/sim/status' && req.method === 'GET') {
    jsonResponse(res, 200, {
      running: !!activeAbort,
      total: stats.total,
      completed: stats.completed,
      errors: stats.errors,
      opsPerSec: Math.round(currentOpsPerSec() * 10) / 10,
      elapsedMs: stats.startedAt ? Date.now() - stats.startedAt : 0,
      byOp: stats.byOp,
    });
    return;
  }

  jsonResponse(res, 404, { error: `Unknown sim endpoint: ${req.method} ${url}` });
}

// ---------------------------------------------------------------------------
// Vite plugin
// ---------------------------------------------------------------------------

export function simEngine(): Plugin {
  return {
    name: 'sim-engine',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/sim/')) {
          handleSimRequest(req, res);
        } else {
          next();
        }
      });
    },
  };
}
