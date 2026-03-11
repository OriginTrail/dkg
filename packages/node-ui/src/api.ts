import { type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { DashboardDB } from './db.js';
import type { ChatAssistant, ChatLlmDiagnostics, ChatResponse } from './chat-assistant.js';
import { type ChatMemoryManager, IMPORT_SOURCES } from './chat-memory.js';
import type { MetricsCollector } from './metrics-collector.js';
import { ChatPersistenceQueue, type TurnPersistenceJobInput } from './chat-persistence-queue.js';

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

const chatPersistenceQueues = new WeakMap<DashboardDB, ChatPersistenceQueue>();
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const PERIOD_UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

function parsePeriodMs(input: string): number {
  const num = parseInt(input, 10);
  if (!isNaN(num) && num > 0 && /^\d+$/.test(input)) return num;
  const match = input.match(/^(\d+)\s*([mhdw])$/i);
  if (match) {
    const val = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (val > 0 && PERIOD_UNITS[unit]) return val * PERIOD_UNITS[unit];
  }
  return 86_400_000;
}

function autoBucketMs(periodMs: number): number {
  if (periodMs <= 15 * 60_000) return 60_000;          // <=15min  → 1-min buckets
  if (periodMs <= 60 * 60_000) return 5 * 60_000;      // <=1h     → 5-min buckets
  if (periodMs <= 6 * 3_600_000) return 15 * 60_000;   // <=6h     → 15-min buckets
  if (periodMs <= 24 * 3_600_000) return 3_600_000;     // <=24h    → 1-hour buckets
  if (periodMs <= 7 * 86_400_000) return 6 * 3_600_000; // <=7d     → 6-hour buckets
  return 86_400_000;                                     // >7d      → daily buckets
}

function getChatPersistenceQueue(db: DashboardDB, memoryManager: ChatMemoryManager): ChatPersistenceQueue {
  let queue = chatPersistenceQueues.get(db);
  if (!queue) {
    queue = new ChatPersistenceQueue(db, memoryManager);
    chatPersistenceQueues.set(db, queue);
  }
  return queue;
}

function normalizeSessionId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  return SESSION_ID_PATTERN.test(value) ? value : null;
}

function normalizeTurnId(raw: unknown): string | null {
  return normalizeSessionId(raw);
}

export interface LlmSettingsCallbacks {
  getLlm: () => { apiKey?: string; model?: string; baseURL?: string } | undefined;
  setLlm: (llm: { apiKey: string; model?: string; baseURL?: string } | null) => Promise<void>;
}

export interface TelemetrySettingsCallbacks {
  getTelemetryEnabled: () => boolean;
  setTelemetryEnabled: (enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Handles all /api/metrics, /api/operations, /api/logs, /api/query-history,
 * /api/saved-queries, and /ui routes. Returns true if the request was handled.
 */
export async function handleNodeUIRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  db: DashboardDB,
  staticDir: string,
  chatAssistant?: ChatAssistant,
  metricsCollector?: MetricsCollector,
  authToken?: string,
  memoryManager?: ChatMemoryManager,
  llmSettings?: LlmSettingsCallbacks,
  telemetrySettings?: TelemetrySettingsCallbacks,
): Promise<boolean> {
  const path = url.pathname;

  // --- Metrics ---

  if (req.method === 'GET' && path === '/api/metrics') {
    if (metricsCollector) {
      try {
        const live = await metricsCollector.collect();
        return json(res, 200, live);
      } catch {
        const snap = db.getLatestSnapshot();
        return json(res, 200, snap ?? {});
      }
    }
    const snap = db.getLatestSnapshot();
    return json(res, 200, snap ?? {});
  }

  if (req.method === 'GET' && path === '/api/metrics/history') {
    const from = parseInt(url.searchParams.get('from') ?? '0', 10) || (Date.now() - 86_400_000);
    const to = parseInt(url.searchParams.get('to') ?? '0', 10) || Date.now();
    const maxPoints = parseInt(url.searchParams.get('maxPoints') ?? '500', 10);
    const snapshots = db.getSnapshotHistory(from, to, maxPoints);
    return json(res, 200, { snapshots });
  }

  // --- Prometheus metrics ---

  // TODO: Prometheus /metrics endpoint — implementation in progress, hidden until ready
  // if (req.method === 'GET' && path === '/metrics') {
  //   if (metricsCollector) {
  //     try {
  //       const m = await metricsCollector.collect();
  //       const lines = [
  //         `# HELP dkg_uptime_seconds Node uptime in seconds`,
  //         `# TYPE dkg_uptime_seconds gauge`,
  //         `dkg_uptime_seconds ${m.uptime_seconds ?? 0}`,
  //         `# HELP dkg_cpu_percent CPU usage percentage`,
  //         `# TYPE dkg_cpu_percent gauge`,
  //         `dkg_cpu_percent ${m.cpu_percent ?? 0}`,
  //         `# HELP dkg_memory_bytes Memory usage in bytes`,
  //         `# TYPE dkg_memory_bytes gauge`,
  //         `dkg_memory_bytes{type="heap"} ${m.heap_used_bytes ?? 0}`,
  //         `dkg_memory_bytes{type="system"} ${m.mem_used_bytes ?? 0}`,
  //         `# HELP dkg_peers_total Number of connected peers`,
  //         `# TYPE dkg_peers_total gauge`,
  //         `dkg_peers_total{type="direct"} ${m.direct_peers ?? 0}`,
  //         `dkg_peers_total{type="relayed"} ${m.relayed_peers ?? 0}`,
  //         `dkg_peers_total{type="mesh"} ${m.mesh_peers ?? 0}`,
  //         `# HELP dkg_triples_total Total triples in the store`,
  //         `# TYPE dkg_triples_total gauge`,
  //         `dkg_triples_total ${m.total_triples ?? 0}`,
  //         `# HELP dkg_kcs_total Knowledge collections`,
  //         `# TYPE dkg_kcs_total gauge`,
  //         `dkg_kcs_total{status="confirmed"} ${m.confirmed_kcs ?? 0}`,
  //         `dkg_kcs_total{status="tentative"} ${m.tentative_kcs ?? 0}`,
  //         `# HELP dkg_kas_total Knowledge assets`,
  //         `# TYPE dkg_kas_total gauge`,
  //         `dkg_kas_total ${m.total_kas ?? 0}`,
  //         `# HELP dkg_store_bytes Triple store size in bytes`,
  //         `# TYPE dkg_store_bytes gauge`,
  //         `dkg_store_bytes ${m.store_bytes ?? 0}`,
  //         `# HELP dkg_rpc_latency_ms RPC latency in milliseconds`,
  //         `# TYPE dkg_rpc_latency_ms gauge`,
  //         `dkg_rpc_latency_ms ${m.rpc_latency_ms ?? 0}`,
  //         `# HELP dkg_rpc_healthy RPC health status (1=healthy, 0=unhealthy)`,
  //         `# TYPE dkg_rpc_healthy gauge`,
  //         `dkg_rpc_healthy ${m.rpc_healthy ?? 0}`,
  //         '',
  //       ];
  //       res.writeHead(200, {
  //         'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
  //         'Cache-Control': 'no-cache',
  //       });
  //       res.end(lines.join('\n'));
  //       return true;
  //     } catch {
  //       res.writeHead(503, { 'Content-Type': 'text/plain' });
  //       res.end('# metrics temporarily unavailable\n');
  //       return true;
  //     }
  //   }
  //   res.writeHead(503, { 'Content-Type': 'text/plain' });
  //   res.end('# metrics collector not initialized\n');
  //   return true;
  // }

  // --- Error hotspots ---

  if (req.method === 'GET' && path === '/api/error-hotspots') {
    const periodMs = parseInt(url.searchParams.get('periodMs') ?? String(7 * 86_400_000), 10);
    const hotspots = db.getErrorHotspots(periodMs);
    return json(res, 200, { hotspots });
  }

  if (req.method === 'GET' && path === '/api/failed-operations') {
    const phase = url.searchParams.get('phase') ?? undefined;
    const operationName = url.searchParams.get('operationName') ?? undefined;
    const periodMs = parseInt(url.searchParams.get('periodMs') ?? String(7 * 86_400_000), 10);
    const q = url.searchParams.get('q') ?? undefined;
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    const result = db.getFailedOperations({ phase, operationName, periodMs, q, limit });
    return json(res, 200, result);
  }

  // --- Operations ---

  if (req.method === 'GET' && path === '/api/operations') {
    const name = url.searchParams.get('name') ?? undefined;
    const status = url.searchParams.get('status') ?? undefined;
    const operationId = url.searchParams.get('operationId') ?? undefined;
    const from = url.searchParams.get('from') ? parseInt(url.searchParams.get('from')!, 10) : undefined;
    const to = url.searchParams.get('to') ? parseInt(url.searchParams.get('to')!, 10) : undefined;
    const limit = parseInt(url.searchParams.get('limit') ?? '100', 10);
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const includePhases = url.searchParams.get('phases') === '1';
    if (includePhases) {
      const result = db.getOperationsWithPhases({ name, status, operationId, from, to, limit, offset });
      return json(res, 200, result);
    }
    const result = db.getOperations({ name, status, operationId, from, to, limit, offset });
    return json(res, 200, result);
  }

  if (req.method === 'GET' && path.startsWith('/api/operations/')) {
    const opId = path.slice('/api/operations/'.length);
    if (!opId) return json(res, 400, { error: 'Missing operation ID' });
    const result = db.getOperation(opId);
    if (!result.operation) return json(res, 404, { error: 'Operation not found' });
    return json(res, 200, result);
  }

  // --- Operation stats ---

  if (req.method === 'GET' && path === '/api/operation-stats') {
    const name = url.searchParams.get('name') ?? undefined;
    const periodMs = parsePeriodMs(url.searchParams.get('periodMs') ?? url.searchParams.get('period') ?? '24h');
    const bucketMs = autoBucketMs(periodMs);
    const result = db.getOperationStats({ name, periodMs, bucketMs });
    return json(res, 200, result);
  }

  // --- Success rates by operation type ---

  if (req.method === 'GET' && path === '/api/success-rates') {
    const periodMs = parsePeriodMs(url.searchParams.get('periodMs') ?? url.searchParams.get('period') ?? '7d');
    const rates = db.getSuccessRatesByType(periodMs);
    return json(res, 200, { rates });
  }

  // --- Per-type time series ---

  if (req.method === 'GET' && path === '/api/per-type-stats') {
    const periodMs = parsePeriodMs(url.searchParams.get('periodMs') ?? url.searchParams.get('period') ?? '7d');
    const rawBucket = url.searchParams.get('bucketMs');
    const bucketMs = rawBucket ? parseInt(rawBucket, 10) : autoBucketMs(periodMs);
    const result = db.getPerTypeTimeSeries({ periodMs, bucketMs });
    return json(res, 200, result);
  }

  // --- Spending / Economics ---

  if (req.method === 'GET' && path === '/api/economics') {
    const spending = db.getSpendingSummary();
    return json(res, 200, spending);
  }

  // --- Logs ---

  if (req.method === 'GET' && path === '/api/logs') {
    const q = url.searchParams.get('q') ?? undefined;
    const operationId = url.searchParams.get('operationId') ?? undefined;
    const level = url.searchParams.get('level') ?? undefined;
    const module = url.searchParams.get('module') ?? undefined;
    const from = url.searchParams.get('from') ? parseInt(url.searchParams.get('from')!, 10) : undefined;
    const to = url.searchParams.get('to') ? parseInt(url.searchParams.get('to')!, 10) : undefined;
    const limit = parseInt(url.searchParams.get('limit') ?? '200', 10);
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const result = db.searchLogs({ q, operationId, level, module, from, to, limit, offset });
    return json(res, 200, result);
  }

  // --- Node log (daemon.log file) ---

  if (req.method === 'GET' && path === '/api/node-log') {
    const logFilePath = join(db.dataDir, 'daemon.log');
    const rawLines = parseInt(url.searchParams.get('lines') ?? '500', 10);
    const tailLines = Number.isFinite(rawLines) && rawLines > 0 ? Math.min(rawLines, 5000) : 500;
    const search = url.searchParams.get('q') ?? '';
    try {
      const fileStat = await stat(logFilePath);
      const TAIL_BYTES = Math.min(tailLines * 300, fileStat.size);
      const { createReadStream } = await import('node:fs');
      const start = Math.max(0, fileStat.size - TAIL_BYTES);
      const chunk = await new Promise<string>((resolve, reject) => {
        const parts: string[] = [];
        createReadStream(logFilePath, { start, encoding: 'utf-8' })
          .on('data', (d: string | Buffer) => parts.push(typeof d === 'string' ? d : d.toString('utf-8')))
          .on('end', () => resolve(parts.join('')))
          .on('error', reject);
      });
      let lines = chunk.split('\n');
      if (start > 0) lines = lines.slice(1);
      lines = lines.slice(-tailLines);
      if (search) {
        const lower = search.toLowerCase();
        lines = lines.filter(l => l.toLowerCase().includes(lower));
      }
      return json(res, 200, { lines, totalSize: fileStat.size });
    } catch {
      return json(res, 200, { lines: [], totalSize: 0 });
    }
  }

  // --- Query history ---

  if (req.method === 'GET' && path === '/api/query-history') {
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const history = db.getQueryHistory(limit, offset);
    return json(res, 200, { history });
  }

  // --- Saved queries ---

  if (req.method === 'GET' && path === '/api/saved-queries') {
    const queries = db.getSavedQueries();
    return json(res, 200, { queries });
  }

  if (req.method === 'POST' && path === '/api/saved-queries') {
    const body = await readBody(req);
    const { name, description, sparql } = JSON.parse(body);
    if (!name || !sparql) return json(res, 400, { error: 'Missing "name" or "sparql"' });
    const id = db.insertSavedQuery({ name, description, sparql });
    return json(res, 201, { id });
  }

  if (req.method === 'PUT' && path.startsWith('/api/saved-queries/')) {
    const id = parseInt(path.slice('/api/saved-queries/'.length), 10);
    if (isNaN(id)) return json(res, 400, { error: 'Invalid ID' });
    const body = await readBody(req);
    const updates = JSON.parse(body);
    db.updateSavedQuery(id, updates);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'DELETE' && path.startsWith('/api/saved-queries/')) {
    const id = parseInt(path.slice('/api/saved-queries/'.length), 10);
    if (isNaN(id)) return json(res, 400, { error: 'Invalid ID' });
    db.deleteSavedQuery(id);
    return json(res, 200, { ok: true });
  }

  // --- Data retention settings ---

  if (req.method === 'GET' && path === '/api/settings/retention') {
    return json(res, 200, { retentionDays: db.getRetentionDays() });
  }

  if (req.method === 'PUT' && path === '/api/settings/retention') {
    const body = await readBody(req);
    const payload = JSON.parse(body ?? '{}') as { retentionDays?: number };
    const days = payload.retentionDays;
    if (days == null || !Number.isInteger(days) || days < 1 || days > 365) {
      return json(res, 400, { error: 'retentionDays must be an integer 1-365' });
    }
    db.setRetentionDays(days as number);
    db.prune();
    return json(res, 200, { ok: true, retentionDays: db.getRetentionDays() });
  }

  // --- Telemetry settings ---

  if (req.method === 'GET' && path === '/api/settings/telemetry') {
    const enabled = telemetrySettings?.getTelemetryEnabled() ?? false;
    return json(res, 200, { enabled });
  }

  if (req.method === 'PUT' && path === '/api/settings/telemetry') {
    if (!telemetrySettings) return json(res, 501, { error: 'Telemetry not available' });
    const body = await readBody(req);
    const payload = JSON.parse(body ?? '{}') as { enabled?: boolean };
    if (typeof payload.enabled !== 'boolean') {
      return json(res, 400, { error: 'enabled must be a boolean' });
    }
    const result = await telemetrySettings.setTelemetryEnabled(payload.enabled);
    if (!result.ok) return json(res, 422, { error: result.error });
    return json(res, 200, { ok: true, enabled: payload.enabled });
  }

  // --- LLM settings ---

  if (req.method === 'GET' && path === '/api/settings/llm') {
    if (chatAssistant) {
      const info = chatAssistant.getLlmConfig();
      return json(res, 200, info);
    }
    return json(res, 200, { configured: false });
  }

  if (req.method === 'PUT' && path === '/api/settings/llm' && llmSettings) {
    const body = await readBody(req);
    const payload = JSON.parse(body ?? '{}') as {
      apiKey?: unknown;
      model?: unknown;
      baseURL?: unknown;
      clear?: unknown;
    };
    const incomingApiKey = typeof payload.apiKey === 'string' ? payload.apiKey : undefined;
    const incomingModel = typeof payload.model === 'string' ? payload.model.trim() : undefined;
    const incomingBaseURL = typeof payload.baseURL === 'string' ? payload.baseURL.trim() : undefined;
    const clearRequested = payload.clear === true;

    // Backward compatibility: old clients send { apiKey: "" } to clear.
    const legacyClearRequested =
      incomingApiKey === '' &&
      payload.model === undefined &&
      payload.baseURL === undefined;

    let llm: { apiKey: string; model?: string; baseURL?: string } | null;
    if (clearRequested || legacyClearRequested) {
      llm = null;
    } else {
      const current = llmSettings.getLlm();
      const currentApiKey = current?.apiKey?.trim();
      const nextApiKey = incomingApiKey?.trim() || currentApiKey;
      if (!nextApiKey) {
        return json(res, 400, {
          error: 'Missing API key. Provide "apiKey" or clear the config explicitly.',
        });
      }
      llm = {
        apiKey: nextApiKey,
        model: payload.model !== undefined ? (incomingModel || undefined) : current?.model,
        baseURL: payload.baseURL !== undefined ? (incomingBaseURL || undefined) : current?.baseURL,
      };
    }
    try {
      await llmSettings.setLlm(llm);
      const info = chatAssistant?.getLlmConfig() ?? { configured: !!llm };
      return json(res, 200, { ok: true, ...info });
    } catch (err: any) {
      return json(res, 500, { error: err.message ?? 'Failed to save LLM config' });
    }
  }

  // --- Chat assistant ---

  if (req.method === 'GET' && path === '/api/chat-assistant/persistence/events' && memoryManager) {
    const queue = getChatPersistenceQueue(db, memoryManager);
    beginSse(res);
    const now = Date.now();
    sendSse(res, {
      type: 'persist_health',
      ts: now,
      ...queue.getHealthSnapshot(now),
    });

    const unsubscribe = queue.subscribe((event) => {
      sendSse(res, event);
    });

    const keepAlive = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      res.write(': ping\n\n');
    }, 15_000);

    const cleanup = () => {
      clearInterval(keepAlive);
      unsubscribe();
      if (!res.writableEnded) {
        res.end();
      }
    };

    req.on('close', cleanup);
    req.on('error', cleanup);
    return true;
  }

  if (req.method === 'GET' && path === '/api/chat-assistant/persistence/health' && memoryManager) {
    const queue = getChatPersistenceQueue(db, memoryManager);
    const now = Date.now();
    return json(res, 200, {
      ts: now,
      ...queue.getHealthSnapshot(now),
    });
  }

  if (req.method === 'POST' && path === '/api/chat-assistant' && chatAssistant) {
    const body = await readBody(req);
    let payload: { message?: unknown; sessionId?: unknown; stream?: unknown };
    try {
      payload = JSON.parse(body ?? '{}');
    } catch {
      return json(res, 400, { error: 'Invalid JSON payload' });
    }
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    const rawSessionId = payload.sessionId;
    const acceptHeader = Array.isArray(req.headers.accept) ? req.headers.accept.join(', ') : (req.headers.accept ?? '');
    const streamRequested = payload.stream === true || acceptHeader.includes('text/event-stream');
    if (!message) return json(res, 400, { error: 'Missing "message"' });
    const providedSessionId = rawSessionId === undefined ? null : normalizeSessionId(rawSessionId);
    if (rawSessionId !== undefined && !providedSessionId) {
      return json(res, 400, { error: 'Invalid "sessionId" format' });
    }
    const sessionId = providedSessionId ?? crypto.randomUUID();
    const turnId = crypto.randomUUID();

    if (streamRequested) {
      beginSse(res);
      sendSse(res, { type: 'meta', sessionId });
      const startedAt = Date.now();
      const llmStartedAt = Date.now();
      let finalReply: ChatResponse | undefined;
      try {
        for await (const event of chatAssistant.answerStream({ message })) {
          if (event.type === 'text_delta') {
            sendSse(res, event);
            continue;
          }
          if (event.type === 'final') {
            finalReply = event.response;
          }
        }
        if (!finalReply) throw new Error('Chat stream ended without a final response');

        const llmMs = Date.now() - llmStartedAt;
        const persisted = enqueueTurnPersistence(db, memoryManager, {
          turnId,
          sessionId,
          userMessage: message,
          assistantReply: finalReply.reply,
          toolCalls: finalReply.toolCalls,
        });
        const totalMs = Date.now() - startedAt;
        const responseMode = finalReply.responseMode ?? 'rule-based';
        sendSse(res, {
          type: 'final',
          ...finalReply,
          responseMode,
          sessionId,
          turnId,
          persistStatus: persisted.persistStatus,
          persistError: persisted.persistError,
          timings: {
            llm_ms: llmMs,
            store_ms: persisted.storeMs,
            total_ms: totalMs,
          },
        });
      } catch (err: unknown) {
        const messageText = err instanceof Error ? err.message : String(err);
        const diagnostics: ChatLlmDiagnostics | undefined = finalReply?.llmDiagnostics;
        console.error('[chat-assistant] Streaming error:', messageText);
        sendSse(res, {
          type: 'error',
          error: messageText,
          llmDiagnostics: diagnostics,
        });
      } finally {
        res.end();
      }
      return true;
    }

    try {
      const startedAt = Date.now();
      const llmStartedAt = Date.now();
      const reply = await chatAssistant.answer({ message });
      const llmMs = Date.now() - llmStartedAt;
      const persisted = enqueueTurnPersistence(db, memoryManager, {
        turnId,
        sessionId,
        userMessage: message,
        assistantReply: reply.reply,
        toolCalls: reply.toolCalls,
      });
      const totalMs = Date.now() - startedAt;
      const responseMode = reply.responseMode ?? 'rule-based';
      return json(res, 200, {
        ...reply,
        responseMode,
        sessionId,
        turnId,
        persistStatus: persisted.persistStatus,
        persistError: persisted.persistError,
        timings: {
          llm_ms: llmMs,
          store_ms: persisted.storeMs,
          total_ms: totalMs,
        },
      });
    } catch (err: any) {
      return json(res, 500, { error: err.message });
    }
  }

  // --- Memory (chat history stored in DKG) ---

  if (req.method === 'GET' && path === '/api/memory/sessions' && memoryManager) {
    const rawLimit = parseInt(url.searchParams.get('limit') ?? '20', 10);
    const limit = Math.max(1, Math.min(isNaN(rawLimit) ? 20 : rawLimit, 100));
    try {
      const sessions = await memoryManager.getRecentChats(limit);
      return json(res, 200, { sessions });
    } catch (err: any) {
      return json(res, 500, { error: err.message ?? 'Failed to fetch sessions' });
    }
  }

  if (req.method === 'GET' && path.startsWith('/api/memory/sessions/') && path.endsWith('/graph-delta') && memoryManager) {
    const sessionId = normalizeSessionId(decodeURIComponent(
      path.slice('/api/memory/sessions/'.length, -'/graph-delta'.length),
    ));
    if (!sessionId) return json(res, 400, { error: 'Invalid session ID' });
    const turnId = normalizeTurnId(url.searchParams.get('turnId'));
    if (!turnId) return json(res, 400, { error: 'Missing or invalid "turnId"' });
    const rawBaseTurnId = url.searchParams.get('baseTurnId');
    const baseTurnId = rawBaseTurnId == null || rawBaseTurnId === ''
      ? null
      : normalizeTurnId(rawBaseTurnId);
    if (rawBaseTurnId != null && rawBaseTurnId !== '' && !baseTurnId) {
      return json(res, 400, { error: 'Invalid "baseTurnId" format' });
    }
    try {
      const delta = await memoryManager.getSessionGraphDelta(sessionId, turnId, { baseTurnId });
      return json(res, 200, delta);
    } catch (err: any) {
      return json(res, 500, { error: err.message ?? 'Failed to fetch session graph delta' });
    }
  }

  if (
    req.method === 'GET' &&
    path.startsWith('/api/memory/sessions/') &&
    !path.endsWith('/graph-delta') &&
    !path.endsWith('/publication') &&
    !path.endsWith('/publish') &&
    memoryManager
  ) {
    const sessionId = normalizeSessionId(decodeURIComponent(path.slice('/api/memory/sessions/'.length)));
    if (!sessionId) return json(res, 400, { error: 'Invalid session ID' });
    try {
      const session = await memoryManager.getSession(sessionId);
      if (!session) return json(res, 404, { error: 'Session not found' });
      return json(res, 200, session);
    } catch (err: any) {
      return json(res, 500, { error: err.message ?? 'Failed to fetch session' });
    }
  }

  if (req.method === 'GET' && path.startsWith('/api/memory/sessions/') && path.endsWith('/publication') && memoryManager) {
    const sessionId = normalizeSessionId(decodeURIComponent(
      path.slice('/api/memory/sessions/'.length, -'/publication'.length),
    ));
    if (!sessionId) return json(res, 400, { error: 'Invalid session ID' });
    try {
      const status = await memoryManager.getSessionPublicationStatus(sessionId);
      return json(res, 200, status);
    } catch (err: any) {
      return json(res, 500, { error: err.message ?? 'Failed to fetch session publication status' });
    }
  }

  if (req.method === 'POST' && path.startsWith('/api/memory/sessions/') && path.endsWith('/publish') && memoryManager) {
    const sessionId = normalizeSessionId(decodeURIComponent(
      path.slice('/api/memory/sessions/'.length, -'/publish'.length),
    ));
    if (!sessionId) return json(res, 400, { error: 'Invalid session ID' });
    const body = await readBody(req);
    let payload: { rootEntities?: unknown; clearAfter?: unknown };
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      return json(res, 400, { error: 'Invalid JSON payload' });
    }
    const rootEntities = Array.isArray(payload.rootEntities)
      ? payload.rootEntities.filter((r): r is string => typeof r === 'string')
      : undefined;
    const clearWorkspaceAfter = payload.clearAfter === true;
    try {
      const result = await memoryManager.publishSession(sessionId, {
        rootEntities,
        clearWorkspaceAfter,
      });
      return json(res, 200, result);
    } catch (err: any) {
      const message = err?.message ?? 'Failed to publish session';
      const status = /No workspace entities found|Selected root entities/.test(message) ? 400 : 500;
      return json(res, status, { error: message });
    }
  }

  if (req.method === 'POST' && path === '/api/memory/import' && memoryManager) {
    let body: string;
    try {
      body = await readBody(req, IMPORT_MAX_BYTES);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) return json(res, 413, { error: 'Payload too large' });
      throw err;
    }
    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      return json(res, 400, { error: 'Invalid JSON body' });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return json(res, 400, { error: 'Request body must be a JSON object' });
    }
    const { text, source, useLlm } = parsed;
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return json(res, 400, { error: 'Missing or empty "text" field' });
    }
    const importSource = IMPORT_SOURCES.includes(source) ? source : 'other';
    try {
      const result = await memoryManager.importMemories(text.trim(), importSource, { useLlm: useLlm === true });
      return json(res, 200, result);
    } catch (err: any) {
      console.error('[node-ui] Import memories failed:', err);
      return json(res, 500, { error: 'Failed to import memories' });
    }
  }

  if (req.method === 'GET' && path === '/api/memory/stats' && memoryManager) {
    try {
      const stats = await memoryManager.getStats();
      return json(res, 200, stats);
    } catch (err: any) {
      return json(res, 200, { paranetId: 'agent-memory', initialized: false, messageCount: 0, knowledgeTriples: 0, totalTriples: 0, sessionCount: 0, entityCount: 0 });
    }
  }

  // --- Notifications ---

  if (req.method === 'GET' && path === '/api/notifications') {
    const since = url.searchParams.get('since');
    const limit = url.searchParams.get('limit');
    const data = db.getNotifications({
      since: since ? Number(since) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    return json(res, 200, data);
  }

  if (req.method === 'POST' && path === '/api/notifications/read') {
    const body = await readBody(req);
    let ids: number[] | undefined;
    try {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed.ids)) ids = parsed.ids.map(Number);
    } catch { /* mark all */ }
    const count = db.markNotificationsRead(ids);
    return json(res, 200, { marked: count });
  }

  // --- Static UI files ---

  if (path === '/ui' || path.startsWith('/ui/')) {
    return serveStatic(res, staticDir, path, authToken);
  }

  return false;
}

function enqueueTurnPersistence(
  db: DashboardDB,
  memoryManager: ChatMemoryManager | undefined,
  job: TurnPersistenceJobInput,
): {
  persistStatus: 'pending' | 'in_progress' | 'stored' | 'failed' | 'skipped';
  persistError?: string;
  storeMs: number;
} {
  if (!memoryManager) {
    return { persistStatus: 'skipped', storeMs: 0 };
  }
  try {
    const queue = getChatPersistenceQueue(db, memoryManager);
    const snapshot = queue.enqueue(job);
    return {
      persistStatus: snapshot.status,
      persistError: snapshot.error,
      storeMs: snapshot.storeMs ?? 0,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[chat-persistence] enqueue failed:', message);
    return { persistStatus: 'failed', persistError: message, storeMs: 0 };
  }
}

function beginSse(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
}

function sendSse(res: ServerResponse, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function serveStatic(res: ServerResponse, staticDir: string, urlPath: string, authToken?: string): Promise<true> {
  let filePath = urlPath === '/ui' || urlPath === '/ui/'
    ? join(staticDir, 'index.html')
    : join(staticDir, urlPath.slice('/ui/'.length));

  // SPA fallback: if not a file with extension, serve index.html
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  if (!MIME[ext]) {
    filePath = join(staticDir, 'index.html');
  }

  if (!existsSync(filePath)) {
    filePath = join(staticDir, 'index.html');
  }

  const mimeExt = filePath.slice(filePath.lastIndexOf('.'));
  const isHtml = mimeExt === '.html';

  try {
    if (isHtml && authToken) {
      const html = await readFile(filePath, 'utf-8');
      const injection = `<script>window.__DKG_TOKEN__=${JSON.stringify(authToken)}</script>`;
      const injected = html.replace('</head>', `${injection}</head>`);
      const buf = Buffer.from(injected, 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Length': buf.byteLength,
        'Cache-Control': 'no-cache',
      });
      res.end(buf);
    } else {
      const s = await stat(filePath);
      const contentType = MIME[mimeExt] ?? 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': s.size,
        'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
      });
      createReadStream(filePath).pipe(res);
    }
  } catch {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!DOCTYPE html><html><body><h1>Node UI not built</h1><p>Run <code>pnpm build:ui</code> in @dkg/node-ui</p></body></html>');
  }

  return true;
}

function json(res: ServerResponse, status: number, data: unknown): true {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
  return true;
}

function readBody(req: IncomingMessage, maxBytes?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let rejected = false;
    req.on('data', (c: Buffer) => {
      if (rejected) return;
      totalBytes += c.length;
      if (maxBytes != null && totalBytes > maxBytes) {
        rejected = true;
        reject(new PayloadTooLargeError());
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks).toString()); });
    req.on('error', reject);
  });
}

const IMPORT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

class PayloadTooLargeError extends Error {
  constructor() { super('Payload too large'); }
}
