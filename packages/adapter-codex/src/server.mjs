import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, createReadStream, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, extname, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { CodexRpc } from './rpc.mjs';
import { CodexBridge, HTTP_ERROR } from './bridge.mjs';
import { DkgMemory } from './memory.mjs';
import { NativeMemory } from './native-memory.mjs';

export function readToken(path) {
  try { return readFileSync(path, 'utf8').split(/\r?\n/).map((s) => s.trim()).find((s) => s && !s.startsWith('#')) || ''; }
  catch { return ''; }
}
const equal = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function validOrigin(req, port) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(req.headers.host)) return false;
  if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return false;
  if (['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) return false;
  return true;
}
export function readJson(req, limit = 1_000_000) {
  return new Promise((resolveBody, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(HTTP_ERROR(413, 'Request is too large.')); req.resume(); }
      else chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (size > limit) return;
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch { reject(HTTP_ERROR(400, 'Invalid JSON.')); }
    });
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };

export function createServer({ bridge, uiDir, port = 9210, dkgPort = 9200, dkgHome, sessionToken = randomBytes(32).toString('hex'), nativeMemory, hookToken }) {
  const json = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!validOrigin(req, port)) return json(res, 403, { error: 'Only the local DKG UI may access this bridge.' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    try {
      if (req.method === 'GET' && path === '/') { res.writeHead(302, { Location: '/ui/codex' }); return res.end(); }
      if (path === '/ui' || path.startsWith('/ui/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw HTTP_ERROR(405, 'Method not allowed.');
        const suffix = decodeURIComponent(path.slice('/ui/'.length));
        const candidate = resolve(uiDir, suffix);
        if (!candidate.startsWith(resolve(uiDir) + '/')) {
          if (path !== '/ui' && path !== '/ui/') throw HTTP_ERROR(404, 'Not found.');
        }
        const isFile = existsSync(candidate) && candidate.startsWith(resolve(uiDir) + '/') && statSync(candidate).isFile();
        if (path.includes('/assets/') && !isFile) throw HTTP_ERROR(404, 'Asset not found.');
        const file = isFile ? candidate : join(uiDir, 'index.html');
        res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
        if (extname(file) === '.html') {
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Set-Cookie', `dkg_codex=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`);
          const html = readFileSync(file, 'utf8').replace('</head>', '<script>window.__DKG_CODEX__=true;</script></head>');
          return res.end(req.method === 'HEAD' ? undefined : html);
        }
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        if (req.method === 'HEAD') return res.end();
        return createReadStream(file).pipe(res);
      }
      if (path === '/api/codex/memory/hook' && req.method === 'POST') {
        if (!nativeMemory || !hookToken || !equal(req.headers.authorization, `Bearer ${hookToken}`)) throw HTTP_ERROR(401, 'Local memory hook authentication required.');
        return json(res, 200, await nativeMemory.handle(await readJson(req, 3000000)));
      }
      const cookie = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('dkg_codex='))?.slice(10);
      if (!equal(cookie, sessionToken)) throw HTTP_ERROR(401, 'Open the DKG UI to connect.');
      if (path.startsWith('/api/codex/')) {
        if (req.method === 'POST' && req.headers['x-dkg-codex'] !== '1') throw HTTP_ERROR(403, 'Missing UI request header.');
        if (req.method === 'GET' && path === '/api/codex/status') return json(res, 200, await bridge.status());
        if (req.method === 'GET' && path === '/api/codex/memory') return json(res, 200, bridge.memory?.snapshot(url.searchParams.get('threadId')) || { settings: null, records: [] });
        if (req.method === 'GET' && path === '/api/codex/threads') return json(res, 200, await bridge.list({ cursor: url.searchParams.get('cursor'), search: url.searchParams.get('search') }));
        if (req.method === 'GET' && path === '/api/codex/thread') return json(res, 200, await bridge.read(url.searchParams.get('id')));
        if (req.method === 'GET' && path === '/api/codex/file') {
          const file = await bridge.file(url.searchParams.get('threadId'), url.searchParams.get('path'));
          const extension = extname(file).toLowerCase();
          const inline = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.txt', '.md'].includes(extension);
          const type = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf' }[extension] || (['.txt', '.md'].includes(extension) ? 'text/plain; charset=utf-8' : MIME[extension]);
          res.writeHead(200, { 'Content-Type': inline ? type : 'application/octet-stream', 'Cache-Control': 'no-store',
            'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(basename(file))}` });
          return createReadStream(file).pipe(res);
        }
        if (req.method === 'GET' && path === '/api/codex/events') {
          const threadId = url.searchParams.get('threadId');
          if (!threadId) throw HTTP_ERROR(400, 'Select a conversation.');
          let since = Number(req.headers['last-event-id'] || url.searchParams.get('since') || 0);
          // Event IDs are process-local; a restarted service begins a new log.
          if (!Number.isFinite(since) || since > bridge.sequence) since = 0;
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          res.flushHeaders();
          const send = (event) => {
            if (event.sequence <= since || res.destroyed) return;
            const p = event.params;
            const eventThread = p.threadId ?? p.thread?.id ?? p.params?.threadId ?? p.params?.conversationId;
            if (eventThread && eventThread !== threadId) return;
            since = event.sequence;
            if (res.writableLength > 2_000_000) return res.destroy();
            res.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
          };
          bridge.on('event', send);
          for (const event of bridge.events) send(event);
          const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15_000);
          res.on('close', () => { clearInterval(heartbeat); bridge.off('event', send); });
          return;
        }
        if (req.method === 'POST') {
          const body = await readJson(req, path === '/api/codex/attach' ? 12_000_000 : 1_000_000);
          let value;
          switch (path) {
            case '/api/codex/memory/settings': value = bridge.memory.configure(body); break;
            case '/api/codex/memory/retry': await bridge.memory.retry(); value = { ok: true }; break;
            case '/api/codex/select': value = await bridge.select(body.threadId); break;
            case '/api/codex/new': value = await bridge.create(body); break;
            case '/api/codex/attach': value = await bridge.attach(body); break;
            case '/api/codex/send': value = await bridge.send(body); break;
            case '/api/codex/stop': value = await bridge.stop(body.threadId); break;
            case '/api/codex/reply': value = bridge.reply(body); break;
            default: throw HTTP_ERROR(404, 'Unknown Codex endpoint.');
          }
          return json(res, 200, value);
        }
        throw HTTP_ERROR(404, 'Unknown Codex endpoint.');
      }
      // Existing DKG calls retain their original method/body and use the node's
      // own token. The token never appears in browser storage or URLs.
      if (path.startsWith('/api/') || path.startsWith('/.well-known/')) {
        const headers = { ...req.headers, host: `127.0.0.1:${dkgPort}` };
        delete headers.cookie; delete headers.origin; delete headers.referer;
        const token = readToken(join(dkgHome, 'auth.token'));
        if (token) headers.authorization = `Bearer ${token}`;
        const upstream = http.request({ hostname: '127.0.0.1', port: dkgPort, path: req.url,
          method: req.method, headers }, (response) => {
          const out = { ...response.headers };
          delete out['access-control-allow-origin']; delete out['set-cookie'];
          res.writeHead(response.statusCode, out); response.pipe(res);
        });
        upstream.on('error', () => { if (!res.headersSent) json(res, 502, { error: 'The DKG node is unavailable.' }); else res.destroy(); });
        res.on('close', () => upstream.destroy());
        req.pipe(upstream);
        return;
      }
      throw HTTP_ERROR(404, 'Not found.');
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { error: error.message });
      else res.end();
    }
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const configPath = process.env.DKG_CODEX_CONFIG;
  const config = configPath ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  const dkgHome = config.dkgHome || join(homedir(), '.dkg');
  const stateDir = config.stateDir || join(dkgHome, 'codex');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const tokenPath = join(stateDir, 'memory-hook.token');
  if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(32).toString('hex'), { mode: 0o600 });
  const hookToken = readFileSync(tokenPath, 'utf8').trim();
  const memory = new DkgMemory({ stateDir, dkgHome, dkgPort: config.dkgPort || 9200, defaults: config.memory || {} });
  const nativeMemory = new NativeMemory(memory);
  const rpc = new CodexRpc({ binary: config.codexBinary || 'codex', args: config.codexArgs || ['-c', 'experimental_thread_store={type="local"}', 'app-server'], cwd: config.defaultCwd || homedir(),
    env: { ...process.env, DKG_CODEX_SURFACE: 'dkg', PATH: `${dirname(process.execPath)}:${process.env.PATH || '/usr/bin:/bin'}` } });
  const bridge = new CodexBridge({ rpc, stateDir, memory,
    defaultCwd: config.defaultCwd || homedir(), initialThreadId: config.initialThreadId });
  if (config.dkgCli) bridge.mcp = {
    'mcp_servers.dkg_node': { command: process.execPath, args: [join(packageDir, 'src/mcp-launcher.mjs'), config.dkgCli, dkgHome, String(config.dkgPort || 9200)],
      startup_timeout_sec: 30, tool_timeout_sec: 300 },
  };
  const server = createServer({ bridge, dkgHome, port: config.port || 9210,
    dkgPort: config.dkgPort || 9200, uiDir: config.uiDir || resolve(packageDir, '../node-ui/dist-ui'), nativeMemory, hookToken });
  let retrying = false;
  const retry = async () => { if (retrying) return; retrying = true; try { await nativeMemory.retry(); await memory.retry(); } finally { retrying = false; } };
  const retryTimer = setInterval(() => void retry().catch(() => {}), 20000);
  server.listen(config.port || 9210, '127.0.0.1', () => console.log(`DKG Codex UI: http://127.0.0.1:${config.port || 9210}/ui/codex`));
  const close = () => { clearInterval(retryTimer); rpc.close(); server.closeAllConnections(); server.close(() => process.exit(0)); };
  process.on('SIGTERM', close); process.on('SIGINT', close);
}
