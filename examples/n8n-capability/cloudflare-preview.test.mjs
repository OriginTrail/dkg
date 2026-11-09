import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createPreviewHandler } from './cloudflare-preview.mjs';

const prefix = '/spike/ka/accounts/account-a/capabilities';
function fixture(options) {
  const state = mkdtempSync(join(tmpdir(), 'preview-gateway-'));
  writeFileSync(join(state, 'public-origin'), 'http://127.0.0.1:4621');
  return { handle: createPreviewHandler(state, options), close: () => rmSync(state, { recursive: true, force: true }) };
}
function request(path = prefix + '/studio/run', method = 'POST', headers = {}) {
  return Object.assign(Readable.from([Buffer.from('{}')]), { method, url: path,
    headers: { host: '127.0.0.1:4621', authorization: 'Bearer l1-owner-a', ...headers } });
}
function response(onEnd = () => {}) {
  return { status: 0, headersSent: false, writeHead(status) { this.status = status; this.headersSent = true; },
    end(body) { this.body = body; onEnd(); } };
}

test('preview reserves at most twenty concurrent writes before awaiting bodies', { timeout: 5000 }, async () => {
  let now = 1_000_000, upstream = 0, ready = 0, release, allReady;
  const held = new Promise(resolve => { release = resolve; });
  const admitted = new Promise(resolve => { allReady = resolve; });
  const f = fixture({ clock: () => now, send: async () => { upstream++; return Response.json({ ok: true }); } });
  try {
    const calls = Array.from({ length: 25 }, () => {
      const req = request(); let marked = false;
      const mark = () => { if (!marked) { marked = true; if (++ready === 25) allReady(); } };
      req[Symbol.asyncIterator] = async function* () { mark(); await held; yield Buffer.from('{}'); };
      const res = response(mark);
      return { res, done: f.handle(req, res) };
    });
    await admitted; assert.equal(upstream, 0); release();
    await Promise.all(calls.map(c => c.done));
    assert.equal(calls.filter(c => c.res.status === 200).length, 20);
    assert.equal(calls.filter(c => c.res.status === 429).length, 5);
    assert.equal(upstream, 20);
    const blocked = response(); await f.handle(request(), blocked); assert.equal(blocked.status, 429);
    now += 60_001;
    const next = response(); await f.handle(request(), next); assert.equal(next.status, 200); assert.equal(upstream, 21);
  } finally { release(); f.close(); }
});

test('preview only forwards export keys on owner history or invocation routes', async () => {
  const forwarded = [], key = 'fictional-export-header';
  const f = fixture({ send: async (url, options) => { forwarded.push({ url, options }); return Response.json({}); } });
  try {
    for (const [path, method, role, expected] of [
      [prefix + '/studio/history?kaRef=urn:test', 'GET', 'owner', key],
      [prefix + '/studio/history?kaRef=urn:test', 'GET', 'viewer', undefined],
      [prefix + '/studio', 'GET', 'owner', undefined],
      ['/v1/accounts', 'GET', 'owner', undefined],
      [prefix + '/studio/run', 'POST', 'owner', key],
      ['/spike/ka/events/11223344-1234-4234-8234-123456789abc', 'POST', 'owner', undefined],
    ]) {
      const res = response();
      await f.handle(request(path, method, { authorization: 'Bearer l1-' + role + '-a', 'x-dkg-export-token': key }), res);
      assert.equal(res.status, 200);
      assert.equal(forwarded.at(-1).options.headers['x-dkg-export-token'], expected);
      assert.ok(forwarded.at(-1).url.endsWith(path));
    }
  } finally { f.close(); }
});

test('preview denies invalid host, foreign origin, viewer writes and unexpected methods before dispatch', async () => {
  let calls = 0;
  const f = fixture({ send: async () => { calls++; return Response.json({}); } });
  try {
    for (const [req, status] of [
      [request(undefined, undefined, { host: 'foreign.example' }), 403],
      [request(undefined, undefined, { origin: 'https://foreign.example' }), 403],
      [request(undefined, undefined, { authorization: 'Bearer l1-viewer-a' }), 403],
      [request(prefix + '/studio/run', 'GET'), 405],
      [request(prefix + '/studio/history', 'POST'), 405],
    ]) { const res = response(); await f.handle(req, res); assert.equal(res.status, status); }
    assert.equal(calls, 0);
  } finally { f.close(); }
});
