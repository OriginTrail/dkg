import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createServer } from '../src/server.mjs';

test('owner bootstrap authorizes the UI, while arbitrary local clients, cross-origin requests and missing CSRF fail', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-codex-http-'));
  writeFileSync(join(dir, 'index.html'), '<html><head></head><body>DKG</body></html>');
  const bridge = new EventEmitter();
  bridge.events = [];
  bridge.status = async () => ({ connected: true });
  bridge.select = async () => ({ ok: true });
  // Match the loopback listener and the accepted Host port.
  const server = createServer({ bridge, uiDir: dir, dkgHome: dir, port: 19219,
    sessionToken: 'a'.repeat(64), bootstrapToken: 'owner-secret' });
  await new Promise((done) => server.listen(19219, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:19219';
  assert.equal((await fetch(base + '/api/codex/status')).status, 401);
  const ui = await fetch(base + '/ui/codex');
  assert.equal(ui.status, 200);
  assert.doesNotMatch(await ui.text(), /__DKG_CODEX__/);
  assert.equal(ui.headers.get('set-cookie'), null);
  assert.equal((await fetch(base + '/api/codex/status')).status, 401);
  assert.equal((await fetch(base + '/api/codex/session', { method: 'POST',
    headers: { 'X-DKG-Codex': '1', 'X-DKG-Codex-Bootstrap': 'wrong' } })).status, 401);
  const session = await fetch(base + '/api/codex/session', { method: 'POST',
    headers: { 'X-DKG-Codex': '1', 'X-DKG-Codex-Bootstrap': 'owner-secret' } });
  const cookie = session.headers.get('set-cookie').split(';')[0];
  assert.match(session.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const authorizedUi = await fetch(base + '/ui/codex', { headers: { Cookie: cookie } });
  assert.match(await authorizedUi.text(), /__DKG_CODEX__/);
  assert.equal((await fetch(base + '/api/codex/status', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(base + '/api/codex/status', { headers: { Cookie: cookie, Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await fetch(base + '/api/codex/select', { method: 'POST', headers: { Cookie: cookie }, body: '{}' })).status, 403);
  assert.equal((await fetch(base + '/api/codex/select', { method: 'POST', headers: { Cookie: cookie, 'X-DKG-Codex': '1' }, body: '{broken' })).status, 400);
  assert.equal((await fetch(base + '/ui/assets/missing.js')).status, 404);
  bridge.events = [{ sequence: 1, method: 'item/agentMessage/delta', params: { threadId: 'other', delta: 'private' } },
    { sequence: 2, method: 'item/agentMessage/delta', params: { threadId: 'selected', delta: 'visible' } }];
  const abort = new AbortController();
  const response = await fetch(base + '/api/codex/events?threadId=selected', { headers: { Cookie: cookie }, signal: abort.signal });
  const first = await response.body.getReader().read();
  const text = new TextDecoder().decode(first.value);
  assert.match(text, /visible/); assert.doesNotMatch(text, /private/);
  abort.abort();
});

test('DKG proxy preserves method, query and body while replacing browser credentials and stripping upstream browser headers', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-codex-proxy-'));
  writeFileSync(join(dir, 'index.html'), '<html><head></head><body>DKG</body></html>');
  writeFileSync(join(dir, 'auth.token'), 'node-secret\n');
  let captured;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      captured = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
      res.writeHead(201, { 'Content-Type': 'application/json', 'Set-Cookie': 'upstream=secret',
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Expose-Headers': 'X-Private' });
      res.end('{"proxied":true}');
    });
  });
  await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
  const dkgPort = upstream.address().port;
  const server = createServer({ bridge: {}, uiDir: dir, dkgHome: dir, port: 19221, dkgPort,
    sessionToken: 'session-secret', bootstrapToken: 'owner-secret' });
  await new Promise((done) => server.listen(19221, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections(); server.close(); upstream.closeAllConnections(); upstream.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:19221';
  const session = await fetch(base + '/api/codex/session', { method: 'POST',
    headers: { 'X-DKG-Codex': '1', 'X-DKG-Codex-Bootstrap': 'owner-secret' } });
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const result = await fetch(base + '/api/query?scope=private', { method: 'POST', body: '{"query":"example"}',
    headers: { Cookie: cookie, Origin: base, Referer: base + '/ui/codex', Authorization: 'Bearer browser-secret', 'Content-Type': 'application/json' } });
  assert.equal(result.status, 201);
  assert.deepEqual(await result.json(), { proxied: true });
  assert.equal(captured.method, 'POST');
  assert.equal(captured.url, '/api/query?scope=private');
  assert.equal(captured.body, '{"query":"example"}');
  assert.equal(captured.headers.authorization, 'Bearer node-secret');
  assert.equal(captured.headers.cookie, undefined);
  assert.equal(captured.headers.origin, undefined);
  assert.equal(captured.headers.referer, undefined);
  assert.equal(result.headers.get('set-cookie'), null);
  assert.equal(result.headers.get('access-control-allow-origin'), null);
  assert.equal(result.headers.get('access-control-allow-credentials'), null);
  assert.equal(result.headers.get('access-control-expose-headers'), null);
  await new Promise((done) => upstream.close(done));
  assert.equal((await fetch(base + '/api/query', { headers: { Cookie: cookie } })).status, 502);
});

test('native memory hook has separate authentication and still rejects cross-origin calls', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-memory-http-'));
  const server = createServer({ bridge: {}, uiDir: dir, dkgHome: dir, port: 19220,
    hookToken: 'hook-secret', nativeMemory: { handle: async (body) => ({ event: body.hook_event_name }) } });
  await new Promise(done => server.listen(19220, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(dir, {recursive:true,force:true}); });
  const url = 'http://127.0.0.1:19220/api/codex/memory/hook';
  assert.equal((await fetch(url, {method:'POST', body:'{}'})).status, 401);
  assert.equal((await fetch(url, {method:'POST', headers:{Authorization:'Bearer hook-secret',Origin:'https://other.example'}, body:'{}'})).status, 403);
  const result = await fetch(url, {method:'POST',headers:{Authorization:'Bearer hook-secret'},body:JSON.stringify({hook_event_name:'Stop'})});
  assert.deepEqual(await result.json(),{event:'Stop'});
});
