import { type IncomingMessage, type ServerResponse } from 'node:http';
import { join, resolve, relative, sep, isAbsolute } from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat, realpath } from 'node:fs/promises';
import { PayloadTooLargeError } from '@origintrail-official/dkg-core';
import type { DashboardDB } from './db.js';
import { type ChatMemoryManager } from './chat-memory.js';
import type { MetricsCollector } from './metrics-collector.js';

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

/**
 * Per-request CORS origin — stored on the ServerResponse to avoid
 * global state races in concurrent async handlers and long-lived SSE streams.
 */

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
  _legacyRemovedArg?: unknown,
  metricsCollector?: MetricsCollector,
  authToken?: string,
  memoryManager?: ChatMemoryManager,
  llmSettings?: LlmSettingsCallbacks,
  telemetrySettings?: TelemetrySettingsCallbacks,
  corsOrigin?: string | null,
): Promise<boolean> {
  (res as any).__corsOrigin = corsOrigin ?? null;
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
    const llm = llmSettings?.getLlm();
    return json(res, 200, {
      configured: !!llm?.apiKey,
      model: llm?.model,
      baseURL: llm?.baseURL,
    });
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
      return json(res, 200, {
        ok: true,
        configured: !!llm?.apiKey,
        model: llm?.model,
        baseURL: llm?.baseURL,
      });
    } catch (err: any) {
      return json(res, 500, { error: err.message ?? 'Failed to save LLM config' });
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
    const rawLimit = url.searchParams.get('limit');
    const parsedLimit = rawLimit && /^\d+$/.test(rawLimit)
      ? Number.parseInt(rawLimit, 10)
      : undefined;
    if (rawLimit && (!/^\d+$/.test(rawLimit) || (parsedLimit ?? 0) <= 0)) {
      return json(res, 400, { error: 'Invalid "limit" query parameter' });
    }
    const rawOrder = (url.searchParams.get('order') ?? 'asc').toLowerCase();
    if (rawOrder !== 'asc' && rawOrder !== 'desc') {
      return json(res, 400, { error: 'Invalid "order" query parameter' });
    }
    try {
      const session = await memoryManager.getSession(sessionId, {
        ...(parsedLimit != null ? { limit: parsedLimit } : {}),
        order: rawOrder,
      });
      if (!session) return json(res, 404, { error: 'Session not found' });
      return json(res, 200, session);
    } catch (err: any) {
      return json(res, 500, { error: err.message ?? 'Failed to fetch session' });
    }
  }

  // B38: `/api/memory/sessions/:id/publication` and
  // `/api/memory/sessions/:id/publish` are both backed by a
  // shared-memory read path that the openclaw-dkg-primary-memory
  // workstream broke by design: chat turns now live in Working Memory
  // assertions (`agent-context/chat-turns`) and never reach SWM
  // automatically, so `getSessionPublicationStatus` always reports
  // `empty` and `publishSession` throws
  // `No shared memory entities found for session ...`. The chat-memory
  // methods still exist with a TODO pointing at the v2 follow-up
  // (reimplement via `agent.assertion.promote` against the chat-turns
  // WM assertion), but exposing them through these routes in v1 just
  // returns misleading empty statuses or 400s to the UI. Return 501
  // Not Implemented with a stable error code and a pointer at the
  // follow-up issue so callers can gracefully degrade instead of
  // treating the misleading response as a real publication state.
  if (req.method === 'GET' && path.startsWith('/api/memory/sessions/') && path.endsWith('/publication') && memoryManager) {
    return json(res, 501, {
      error: 'Session publication is not implemented in v1',
      errorCode: 'session_publication_not_implemented_v1',
      reason:
        'Chat turns now live in Working Memory assertions (agent-context/chat-turns) and are ' +
        'not promoted into shared memory automatically, so the old SWM-based publication flow ' +
        'returns misleading empty state. A future release will re-implement session promotion ' +
        'via agent.assertion.promote against the chat-turns WM assertion.',
    });
  }

  if (req.method === 'POST' && path.startsWith('/api/memory/sessions/') && path.endsWith('/publish') && memoryManager) {
    return json(res, 501, {
      error: 'Session publication is not implemented in v1',
      errorCode: 'session_publication_not_implemented_v1',
      reason:
        'Chat turns now live in Working Memory assertions (agent-context/chat-turns) and are ' +
        'not promoted into shared memory automatically, so the old SWM-based /publish flow ' +
        'has nothing to promote. A future release will re-implement session promotion via ' +
        'agent.assertion.promote against the chat-turns WM assertion.',
    });
  }

  // B52: POST /api/memory/import was retired as part of the
  // openclaw-dkg-primary-memory work. It was a V9 relic that required LLM
  // API keys on the node and wrote dkg:ImportedMemory ad-hoc types into a
  // throwaway sidecar graph. Rather than let existing callers fall
  // through to the generic 404 (wire-level contract break with no
  // migration signal), serve a 410 Gone stub that names the two
  // replacements so external CLI scripts, MCP servers, and local agents
  // see a clear migration pointer. Mirrors the B38 pattern for the
  // session-publication routes above.
  if (req.method === 'POST' && path === '/api/memory/import') {
    return json(res, 410, {
      error: 'POST /api/memory/import is retired in v1',
      errorCode: 'memory_import_endpoint_retired_v1',
      reason:
        'This endpoint was a V9 relic that required LLM API keys on the node and wrote ' +
        'ad-hoc `dkg:ImportedMemory` triples into a throwaway sidecar graph. It was retired ' +
        'as part of the openclaw-dkg-primary-memory workstream.',
      replacements: [
        {
          surface: 'adapter tool',
          name: 'dkg_memory_import',
          description:
            'Agent-callable tool registered by `DkgMemoryPlugin` on the OpenClaw side. ' +
            'Writes a memory into a project context graph\'s `memory` Working Memory assertion.',
        },
        {
          surface: 'daemon HTTP route',
          method: 'POST',
          path: '/api/assertion/:name/write',
          description:
            'Direct V10 WM assertion write route on the daemon. Use when writing from ' +
            'a non-OpenClaw caller (CLI, external agent, MCP server) that already has a ' +
            'resolved context graph id and peer identity.',
        },
      ],
    });
  }

  if (req.method === 'GET' && path === '/api/memory/stats' && memoryManager) {
    try {
      const stats = await memoryManager.getStats();
      return json(res, 200, stats);
    } catch (err: any) {
      return json(res, 200, { contextGraphId: 'agent-context', initialized: false, messageCount: 0, knowledgeTriples: 0, totalTriples: 0, sessionCount: 0, entityCount: 0 });
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

async function serveStatic(res: ServerResponse, staticDir: string, urlPath: string, authToken?: string): Promise<true> {
  let filePath = urlPath === '/ui' || urlPath === '/ui/'
    ? join(staticDir, 'index.html')
    : join(staticDir, urlPath.slice('/ui/'.length));

  const lexicalResolved = resolve(filePath);
  const lexicalBase = resolve(staticDir);
  const lexicalRel = relative(lexicalBase, lexicalResolved);
  if (lexicalRel === '..' || lexicalRel.startsWith(`..${sep}`) || isAbsolute(lexicalRel) || resolve(lexicalBase, lexicalRel) !== lexicalResolved) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden' }));
    return true;
  }

  if (existsSync(filePath)) {
    try {
      const realFile = await realpath(filePath);
      const realBase = await realpath(staticDir);
      const realRel = relative(realBase, realFile);
      if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return true;
      }
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return true;
      }
    }
  }

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
      const stream = createReadStream(filePath);
      stream.on('error', (err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Stream read error' }));
        } else {
          res.destroy(err);
        }
      });
      stream.pipe(res);
    }
  } catch {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!DOCTYPE html><html><body><h1>Node UI not built</h1><p>Run <code>pnpm build:ui</code> in @origintrail-official/dkg-node-ui</p></body></html>');
  }

  return true;
}

function json(res: ServerResponse, status: number, data: unknown): true {
  const origin = (res as any).__corsOrigin as string | null ?? null;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    if (origin !== '*') headers['Vary'] = 'Origin';
  }
  res.writeHead(status, headers);
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

