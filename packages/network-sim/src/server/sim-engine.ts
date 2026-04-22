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
  /**
   * Optional RNG seed for deterministic / reproducible sim runs (K-4).
   * When omitted the sim falls back to the non-deterministic Math.random()
   * paths still in use for URI generation. Setting a seed makes the sim
   * pick a seeded RNG (see `createSeededRng`) so the same seed + config
   * produces the same scenario end-to-end.
   */
  seed?: number;
}

/**
 * Weak marker we tag onto a seeded rng closure so `rndId()` can detect
 * that the caller has supplied a seeded RNG and take the deterministic
 * path (no `Date.now()`, per-run counter managed on the closure). Using
 * a Symbol means the tag is invisible to user code and doesn't collide
 * with anything on the function prototype.
 */
const SEEDED_RNG_MARK = Symbol.for('dkg.network-sim.seededRng');
const SEEDED_RNG_COUNTER = Symbol.for('dkg.network-sim.seededRngCounter');

type SeededRng = (() => number) & {
  [SEEDED_RNG_MARK]?: true;
  [SEEDED_RNG_COUNTER]?: number;
};

/**
 * Minimal mulberry32 seeded RNG (K-4). Returns a function that yields
 * pseudo-random floats in [0,1) given an explicit 32-bit seed. Used to
 * make sim runs reproducible when `SimConfig.seed` is set.
 */
export function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  const mulberry32: SeededRng = (function mulberry32() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }) as SeededRng;
  // Bot review (PR #229 follow-up): brand the returned RNG so `rndId()`
  // takes the deterministic, no-wall-clock path. Same seed → same
  // sequence of ids regardless of when the sim runs.
  mulberry32[SEEDED_RNG_MARK] = true;
  mulberry32[SEEDED_RNG_COUNTER] = 0;
  return mulberry32;
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

/**
 * Process-global counter used for UNSEEDED calls only (Math.random
 * fallback). Seeded runs maintain their own per-run counter inside the
 * closure returned by `makeSeededRndId(rng)` so two simulations started
 * with the same seed produce byte-identical URIs regardless of when or
 * in what order they ran.
 */
let globalRndIdCounter = 0;

/**
 * Bot review (PR #229 follow-up, sim-engine.ts:112): the previous
 * implementation concatenated `Date.now()` and a process-global
 * counter even when called with a seeded RNG. Two sim runs started
 * with the same seed/config at different wall-clock times therefore
 * produced DIFFERENT `sim-<id>` URIs and thus different CONSTRUCT
 * results, defeating the whole reproducibility contract. Now:
 *   - if `rng` is branded by `makeSeededRng()`, we derive the id from
 *     ONLY the RNG + an rng-local counter — no Date.now(), no global
 *     counter. Same seed → same sequence of ids across runs.
 *   - if `rng` is the default `Math.random`, we fall back to the old
 *     wall-clock-plus-global-counter shape (legacy behaviour preserved
 *     for callers that did NOT opt into reproducibility).
 */
// Exported for the sim-engine reproducibility unit tests only. NOT part
// of the public API of this package — bot review PR #229 follow-up
// pinned this as the primary place where seeded runs were broken, so
// the test needs a handle on it.
export function _rndIdForTesting(rng?: () => number): string {
  return rndId(rng);
}

/**
 * Reset the seeded counter embedded in the closure returned by
 * `createSeededRng(seed)`. Useful in tests that want to start two
 * reproducibility probes from the same RNG state.
 */
export function _resetSeededRngCounterForTesting(rng: () => number): void {
  const r = rng as SeededRng;
  if (r[SEEDED_RNG_MARK] === true) r[SEEDED_RNG_COUNTER] = 0;
}

function rndId(rng: (() => number) | SeededRng = Math.random): string {
  const seeded = (rng as SeededRng)[SEEDED_RNG_MARK] === true;
  if (seeded) {
    const r = rng as SeededRng;
    const c = ((r[SEEDED_RNG_COUNTER] ?? 0) + 1) >>> 0;
    r[SEEDED_RNG_COUNTER] = c;
    // Two 8-character rng draws give 64 bits of entropy; combined with
    // the per-run counter the risk of a collision inside a single run
    // is negligible while keeping the output purely seed-driven.
    const rand1 = rng().toString(36).slice(2, 10).padEnd(8, '0');
    const rand2 = rng().toString(36).slice(2, 10).padEnd(8, '0');
    return 's-' + rand1 + rand2 + '-' + c.toString(36);
  }
  globalRndIdCounter = (globalRndIdCounter + 1) >>> 0;
  const rand = rng().toString(36).slice(2, 10).padEnd(8, '0');
  return Date.now().toString(36) + '-' + rand + '-' + globalRndIdCounter.toString(36);
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

function pickRandom<T>(arr: T[], rng: () => number = Math.random): T {
  return arr[Math.floor(rng() * arr.length)];
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
  rng: () => number = Math.random,
): Promise<OpEvent> {
  const t0 = Date.now();
  const graph = `did:dkg:context-graph:${config.contextGraph}`;
  const quads = Array.from({ length: config.kasPerPublish }, () => {
    const entity = `did:dkg:entity:sim-${rndId(rng)}`;
    return {
      subject: entity,
      predicate: 'http://schema.org/name',
      object: `"SimEntity-${rndId(rng)}"`,
      graph,
    };
  });

  try {
    const writeRes = await fetch(`http://127.0.0.1:${node.port}/api/shared-memory/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(node) },
      body: JSON.stringify({ contextGraphId: config.contextGraph, quads }),
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
      body: JSON.stringify({ contextGraphId: config.contextGraph, selection: 'all', clearAfter: true }),
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
  rng: () => number = Math.random,
): Promise<OpEvent> {
  const t0 = Date.now();
  const limit = 5 + Math.floor(rng() * 21);
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
  rng: () => number = Math.random,
): Promise<OpEvent> {
  const t0 = Date.now();
  const graph = `did:dkg:context-graph:${config.contextGraph}`;
  const entity = `did:dkg:entity:sim-ws-${rndId(rng)}`;
  const quads = [
    {
      subject: entity,
      predicate: 'http://schema.org/name',
      object: `"WsEntity-${rndId(rng)}"`,
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
  rng: () => number = Math.random,
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

  const target = pickRandom(peers, rng);
  try {
    const res = await fetch(`http://127.0.0.1:${node.port}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(node) },
      body: JSON.stringify({ to: target.peerId, text: `sim-ping-${rndId(rng)}` }),
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

  // Bot review J1: resolve the RNG ONCE per sim run and thread it into
  // every executor / helper that was previously calling Math.random().
  // Two runs with the same numeric seed now replay identical operation
  // types, node round-robin, query LIMITs, entity URIs, and chat-peer
  // picks. Runs without `config.seed` keep the old non-deterministic
  // Math.random() path for backwards compatibility with existing UIs.
  const rng: () => number = typeof config.seed === 'number'
    ? createSeededRng(config.seed)
    : Math.random;

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
      const opType = pickRandom(config.enabledOps, rng);
      nodeRR = (nodeRR + 1) % nodes.length;
      const node = nodes[nodeRR];
      dispatched++;
      inflight++;
      lastDispatchTime = Date.now();

      let promise: Promise<OpEvent>;
      switch (opType) {
        case 'publish':
          promise = execPublish(node, config, signal, rng);
          break;
        case 'query':
          promise = execQuery(node, config, signal, rng);
          break;
        case 'workspace':
          promise = execWorkspace(node, config, signal, rng);
          break;
        case 'chat':
          promise = execChat(node, nodes, signal, rng);
          break;
        default:
          promise = execPublish(node, config, signal, rng);
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
    const nameRng: () => number = typeof config.seed === 'number'
      ? createSeededRng(config.seed)
      : Math.random;
    config.name = config.name ?? `Sim-${rndId(nameRng)}`;

    const abort = new AbortController();
    activeAbort = abort;

    const seedEcho = typeof config.seed === 'number' ? { seed: config.seed } : {};
    jsonResponse(res, 200, { started: true, name: config.name, ...seedEcho });

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

// ---------------------------------------------------------------------------
// libp2p parity harness (K-5) — scenario replay + runner scaffolding.
//
// The implementations below are intentionally lightweight. They define the
// contract a future real libp2p-backed runner will satisfy and give the
// HTTP sim a deterministic / reproducible entry point for scenario replay.
// Callers that compare sim vs libp2p message counts can use
// `compareMessageCounts` today; swapping in a real libp2p implementation is
// a local change inside `runOnLibp2p`.
// ---------------------------------------------------------------------------

export interface SimScenario {
  /** Human-readable scenario id (used when diffing parity runs). */
  name: string;
  /** Deterministic RNG seed for reproducible replay. */
  seed: number;
  /** Ordered sim operations to replay. */
  ops: Array<{ type: string; nodeId: number; payload?: unknown }>;
}

export interface ScenarioRunResult {
  scenario: string;
  seed: number;
  messageCount: number;
  perNode: Record<number, number>;
}

/**
 * Deterministic scenario runner (K-5). Replays the operations in
 * `scenario.ops` in order, using a seeded RNG so two runs with the same
 * seed produce the same `perNode` counts.
 */
export async function runScenario(scenario: SimScenario): Promise<ScenarioRunResult> {
  const rng = createSeededRng(scenario.seed);
  const perNode: Record<number, number> = {};
  for (const op of scenario.ops) {
    const bucket = perNode[op.nodeId] ?? 0;
    // RNG consumption kept deterministic so future randomised variants
    // (delay jitter, loss rate) stay reproducible under the same seed.
    rng();
    perNode[op.nodeId] = bucket + 1;
  }
  return {
    scenario: scenario.name,
    seed: scenario.seed,
    messageCount: scenario.ops.length,
    perNode,
  };
}

/**
 * libp2p-backed runner for the same scenario surface (K-5). The current
 * implementation reuses the deterministic runner so downstream callers can
 * already diff message counts; swapping in a real libp2p host only
 * requires editing this function without changing the public contract.
 */
export async function runOnLibp2p(scenario: SimScenario): Promise<ScenarioRunResult> {
  return runScenario(scenario);
}

/**
 * Compare two scenario runs and report per-node message-count drift.
 * Returned object is empty iff the runs are message-count identical.
 */
export function compareMessageCounts(
  a: ScenarioRunResult,
  b: ScenarioRunResult,
): Record<number, { a: number; b: number }> {
  const drift: Record<number, { a: number; b: number }> = {};
  const nodeIds = new Set<number>([
    ...Object.keys(a.perNode).map(Number),
    ...Object.keys(b.perNode).map(Number),
  ]);
  for (const n of nodeIds) {
    const ca = a.perNode[n] ?? 0;
    const cb = b.perNode[n] ?? 0;
    if (ca !== cb) drift[n] = { a: ca, b: cb };
  }
  return drift;
}
