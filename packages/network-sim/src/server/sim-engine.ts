import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SimulationRuns, type SimulationRun } from './simulation-runs.js';
import { SIMULATION_OPERATIONS, isSimOp, type SimOp, type SimulationSettings, type OpEvent, type SimEvent } from '../simulation-protocol.js';

const DEVNET_NUM_NODES = 6;
const DEVNET_API_PORT_BASE = 9201;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SimConfig extends SimulationSettings {
  name: string;
  contextGraph: string;
}

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

const runs = new SimulationRuns();

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

  // RFC-001 §9.x — route through the knowledge-asset lifecycle (sign at
  // creation): the daemon's `/api/knowledge-assets` endpoint accepts a
  // `quads + finalize: true + alsoShareSwm: true` shape that folds the
  // create→write→finalize→share chain into a single round-trip.
  // The publish call then forwards the seal verbatim.
  const assertionName = `netsim-publish-${Date.now()}-${rndId()}`;
  try {
    const createRes = await fetch(`http://127.0.0.1:${node.port}/api/knowledge-assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(node) },
      body: JSON.stringify({
        contextGraphId: config.contextGraph,
        name: assertionName,
        quads,
        finalize: true,
        alsoShareSwm: true,
      }),
      signal: opSignal(signal, 'publish'),
    });
    if (!createRes.ok) {
      const createBody = (await createRes.json().catch(() => ({}))) as { error?: string };
      const dur = Date.now() - t0;
      return {
        type: 'op',
        opType: 'publish',
        nodeId: node.id,
        success: false,
        durationMs: dur,
        detail: `assertion create+finalize failed: ${createBody.error ?? `HTTP ${createRes.status}`}`,
        phases: {},
      };
    }
    const res = await fetch(`http://127.0.0.1:${node.port}/api/knowledge-assets/${encodeURIComponent(assertionName)}/vm/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(node) },
      body: JSON.stringify({ contextGraphId: config.contextGraph }),
      signal: opSignal(signal, 'publish'),
    });
    const body = (await res.json()) as { kaId?: string; kas?: unknown[]; status?: string; error?: string; phases?: Record<string, number> };
    const dur = Date.now() - t0;
    const kasCount = Array.isArray(body.kas) ? body.kas.length : (res.ok ? config.kasPerPublish : 0);
    const kcDisplay = res.ok ? (body.kaId != null ? String(body.kaId).slice(0, 12) : '0') : '—';
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
    const name = `netsim-workspace-${Date.now()}-${rndId()}`;
    const res = await fetch(`http://127.0.0.1:${node.port}/api/knowledge-assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(node) },
      body: JSON.stringify({
        contextGraphId: config.contextGraph,
        name,
        quads,
        finalize: true,
        alsoShareSwm: true,
      }),
      signal: opSignal(signal, 'sharedMemory'),
    });
    const body = (await res.json()) as { phases?: Record<string, number> };
    const dur = Date.now() - t0;
    return {
      type: 'op',
      opType: 'workspace',
      nodeId: node.id,
      success: res.ok,
      durationMs: dur,
      detail: `ka: ${name}`,
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

async function ensureContextGraph(nodes: NodeInfo[], contextGraphId: string, signal: AbortSignal, broadcast: (event: SimEvent) => void): Promise<void> {
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

async function runSimulation(config: SimConfig, run: SimulationRun) {
  const { stats } = run;
  const signal = run.abort.signal;
  const broadcast = (event: SimEvent) => runs.emit(run, event);
  const nodes = getNodes();

  await loadNodeTokens(nodes);
  if (signal.aborted) return;
  await ensureContextGraph(nodes, config.contextGraph, signal, broadcast);
  if (signal.aborted) return;

  if (config.enabledOps.includes('chat')) {
    await discoverPeerIds(nodes, signal);
  }

  if (signal.aborted) return;
  broadcast({ type: 'status', ...runs.status(run) });

  // Periodic status broadcaster
  const statusInterval = setInterval(() => {
    if (signal.aborted) return;
    broadcast({ type: 'status', ...runs.status(run) });
  }, 500);

  const executors: Record<SimOp, (node: NodeInfo) => Promise<OpEvent>> = {
    publish: node => execPublish(node, config, signal),
    query: node => execQuery(node, config, signal),
    workspace: node => execWorkspace(node, config, signal),
    chat: node => execChat(node, nodes, signal),
  };

  let dispatched = 0;
  let inflight = 0;

  const minIntervalMs = 1000 / config.opsPerSec;
  let lastDispatchTime = 0;

  await new Promise<void>((resolve) => {
    function onOpDone(event: OpEvent) {
      if (!runs.record(run, event)) return;
      inflight--;

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

      const promise = executors[opType](node);

      promise.then(onOpDone).catch(() => onOpDone({
        type: 'op', opType, nodeId: node.id, success: false, durationMs: 0,
        detail: 'Unexpected executor error', phases: {},
      }));
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
    if (stats.errors > 0 && stats.operations.size > 0) {
      const byOp = [...stats.operations]
        .filter(([, s]) => s.metrics.errors > 0)
        .map(([op, s]) => `${op}: ${s.metrics.errors} fail`)
        .join(', ');
      console.error(`[sim] done: ${stats.completed} ok, ${stats.errors} errors (${byOp})`);
    }

  }
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

/** Exported for unit tests. */
export async function handleSimRequest(req: IncomingMessage, res: ServerResponse) {
  const url = req.url ?? '';
  const parsed = new URL(url, 'http://localhost');
  const runId = parsed.searchParams.get('runId') ?? undefined;
  const path = parsed.pathname;
  if (runId !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(runId)) {
    jsonResponse(res, 400, { error: 'Invalid simulation run ID' });
    return;
  }

  if (path === '/sim/start' && req.method === 'POST') {
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

    if (!Array.isArray(config.enabledOps) || !config.enabledOps.every(isSimOp)) {
      jsonResponse(res, 400, { error: `enabledOps must be an array of supported operations: ${SIMULATION_OPERATIONS.join(', ')}` });
      return;
    }

    config.concurrency = config.concurrency ?? 10;
    config.kasPerPublish = config.kasPerPublish ?? 1;
    config.contextGraph = config.contextGraph ?? 'devnet-test';
    config.name = config.name ?? `Sim-${rndId()}`;

    const id = runId ?? randomUUID();
    // Admission is synchronous and follows body parsing, including early cancellation.
    const admission = runs.admit(id, config.opCount);
    if (!admission.accepted) {
      jsonResponse(res, 409, { error: admission.error });
      return;
    }
    const { run } = admission;
    jsonResponse(res, 200, { started: true, name: config.name, runId: id });
    runSimulation(config, run)
      .catch(err => runs.fail(run, err))
      .finally(() => runs.finish(run));
    return;
  }

  if (path === '/sim/stop' && req.method === 'POST') {
    jsonResponse(res, 200, runs.cancel(runId));
    return;
  }

  if (path === '/sim/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('\n');
    req.on('close', () => runs.unsubscribe(res));
    runs.subscribe(res, runId);
    return;
  }

  if (path === '/sim/status' && req.method === 'GET') {
    const run = runId ? runs.get(runId) : runs.latest;
    if (runId && !run) jsonResponse(res, 404, { error: 'Simulation result is no longer available' });
    else jsonResponse(res, 200, run ? runs.status(run) : {
      running: false, total: 0, completed: 0, errors: 0, opsPerSec: 0, elapsedMs: 0, byOp: {},
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
