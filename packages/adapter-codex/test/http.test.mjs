import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createServer } from '../src/server.mjs';

test('UI cookie authorizes requests, cross-origin and missing CSRF fail, SSE stays scoped', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-codex-http-'));
  writeFileSync(join(dir, 'index.html'), '<html><head></head><body>DKG</body></html>');
  const bridge = new EventEmitter();
  bridge.events = [];
  bridge.status = async () => ({ connected: true });
  bridge.select = async () => ({ ok: true });
  // Match the loopback listener and the accepted Host port.
  const server = createServer({ bridge, uiDir: dir, dkgHome: dir, port: 19219, sessionToken: 'a'.repeat(64) });
  await new Promise((done) => server.listen(19219, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:19219';
  assert.equal((await fetch(base + '/api/codex/status')).status, 401);
  const ui = await fetch(base + '/ui/codex');
  assert.equal(ui.status, 200);
  assert.match(await ui.text(), /__DKG_CODEX__/);
  const cookie = ui.headers.get('set-cookie').split(';')[0];
  assert.match(ui.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
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
