import { type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { DashboardDB } from './db.js';
import type { ChatAssistant } from './chat-assistant.js';
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

  // --- Operations ---

  if (req.method === 'GET' && path === '/api/operations') {
    const name = url.searchParams.get('name') ?? undefined;
    const status = url.searchParams.get('status') ?? undefined;
    const from = url.searchParams.get('from') ? parseInt(url.searchParams.get('from')!, 10) : undefined;
    const to = url.searchParams.get('to') ? parseInt(url.searchParams.get('to')!, 10) : undefined;
    const limit = parseInt(url.searchParams.get('limit') ?? '100', 10);
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const result = db.getOperations({ name, status, from, to, limit, offset });
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
    const period = url.searchParams.get('period') ?? '24h';
    const periodMs = period === '30d' ? 30 * 86_400_000
      : period === '7d' ? 7 * 86_400_000
      : 86_400_000;
    const bucketMs = period === '30d' ? 86_400_000
      : period === '7d' ? 86_400_000
      : 3_600_000;
    const result = db.getOperationStats({ name, periodMs, bucketMs });
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

  // --- Chat assistant ---

  if (req.method === 'POST' && path === '/api/chat-assistant' && chatAssistant) {
    const body = await readBody(req);
    const { message } = JSON.parse(body);
    if (!message) return json(res, 400, { error: 'Missing "message"' });
    try {
      const reply = await chatAssistant.answer({ message });
      return json(res, 200, reply);
    } catch (err: any) {
      return json(res, 500, { error: err.message });
    }
  }

  // --- Static UI files ---

  if (path === '/ui' || path.startsWith('/ui/')) {
    return serveStatic(res, staticDir, path);
  }

  return false;
}

async function serveStatic(res: ServerResponse, staticDir: string, urlPath: string): Promise<true> {
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

  try {
    const s = await stat(filePath);
    const mimeExt = filePath.slice(filePath.lastIndexOf('.'));
    const contentType = MIME[mimeExt] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': s.size,
      'Cache-Control': mimeExt === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    createReadStream(filePath).pipe(res);
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}
