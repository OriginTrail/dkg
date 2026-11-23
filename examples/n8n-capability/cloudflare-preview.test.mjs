import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreviewHandler } from './cloudflare-preview.mjs';
import { streamedBodyOverflow } from './test-support/http-body-overflow.mjs';

const prefix = '/spike/ka/accounts/account-a/capabilities';
function fixture(options) {
  const state = mkdtempSync(join(tmpdir(), 'preview-gateway-'));
  writeFileSync(join(state, 'public-origin'), 'http://127.0.0.1:4621');
  return { handle: createPreviewHandler(state, options), close: () => rmSync(state, { recursive: true, force: true }) };
}
function request(path = prefix + '/studio/run', method = 'POST', headers = {}) {
  let reads = 0;
  const req = { method, url: path, headers: { host: '127.0.0.1:4621', authorization: 'Bearer l1-owner-a', ...headers },
    async *[Symbol.asyncIterator]() { reads++; yield Buffer.from('{}'); } };
  Object.defineProperty(req, 'bodyReads', { get: () => reads });
  return req;
}

test('preview returns HTTP 413 for an unfinished chunked upload without forwarding it', async () => {
  let forwards = 0;
  const f = fixture({ send: async () => { forwards++; return Response.json({}); } });
  try {
    const res = await streamedBodyOverflow(f.handle, { path: prefix + '/studio/run',
      headers: { host: '127.0.0.1:4621', authorization: 'Bearer l1-owner-a' } });
    assert.equal(res.status, 413); assert.deepEqual(res.body, { error: 'Input too large' });
    assert.equal(res.destroyedBeforeResponse, false); assert.equal(res.headers.connection, 'close');
    assert.equal(forwards, 0);
  } finally { f.close(); }
});
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
    ]) { const res = response(); await f.handle(req, res); assert.equal(res.status, status); assert.equal(req.bodyReads, 0); }
    assert.equal(calls, 0);
  } finally { f.close(); }
});

test('preview forwards unchanged bytes and keeps body failures separate from overflow', async () => {
  const forwarded = [], f = fixture({ send: async (_url, options) => { forwarded.push(options.body); return Response.json({}); } });
  try {
    const text = 'Ébavurer — 鋼 🔧', bytes = Buffer.from(text);
    for (const chunks of [[], [text], Array.from(bytes, byte => Buffer.from([byte])), [new Uint8Array(bytes)]]) {
      const req = request(), res = response();
      req[Symbol.asyncIterator] = async function* () { yield* chunks; };
      await f.handle(req, res);
      assert.equal(res.status, 200);
      assert.deepEqual(forwarded.at(-1), chunks.length ? bytes : Buffer.alloc(0));
    }
    const before = forwarded.length, overflow = request(), tooLarge = response();
    overflow[Symbol.asyncIterator] = async function* () { yield '€'.repeat(5462); };
    await f.handle(overflow, tooLarge);
    assert.equal(tooLarge.status, 413); assert.deepEqual(JSON.parse(tooLarge.body), { error: 'Input too large' });
    const broken = request(), failed = response();
    broken[Symbol.asyncIterator] = async function* () { yield Buffer.from('{'); throw new Error('Stream failed'); };
    await f.handle(broken, failed);
    assert.equal(failed.status, 502); assert.deepEqual(JSON.parse(failed.body), { error: 'Preview service unavailable' });
    assert.equal(forwarded.length, before);
  } finally { f.close(); }
});

test('preview uses explicit policies for every capability route and keeps internal routes private', async () => {
  const forwarded = [], key = 'fictional-export-header';
  const f = fixture({ send: async (url, options) => { forwarded.push({ url, options }); return Response.json({}); } });
  try {
    for (const [suffix, method, exportHeader] of [['', 'GET', false], ['/invoke', 'POST', true], ['/inspect', 'GET', false],
      ['/workflows', 'GET', false], ['/workflows/save', 'POST', true], ['/workflows/run', 'POST', true], ['/studio', 'GET', false],
      ['/studio/save', 'POST', true], ['/studio/run', 'POST', true], ['/studio/invoke', 'POST', true], ['/studio/activation', 'POST', true],
      ['/studio/history', 'GET', true]]) {
      for (const role of ['owner', 'viewer']) {
        const res = response(), before = forwarded.length;
        const req = request(prefix + suffix, method, { authorization: 'Bearer l1-' + role + '-a', 'x-dkg-export-token': key });
        await f.handle(req, res);
        assert.equal(res.status, role === 'viewer' && method === 'POST' ? 403 : 200, suffix);
        if (res.status === 403) { assert.equal(forwarded.length, before); assert.equal(req.bodyReads, 0); }
        else assert.equal(forwarded.at(-1).options.headers['x-dkg-export-token'], exportHeader && role === 'owner' ? key : undefined, suffix);
      }
      const res = response(), before = forwarded.length;
      await f.handle(request(prefix + suffix, method === 'POST' ? 'GET' : 'POST'), res);
      assert.equal(res.status, 405, suffix); assert.equal(forwarded.length, before);
    }
    const event = '/spike/ka/events/11223344-1234-4234-8234-123456789abc', res = response();
    await f.handle(request(event, 'POST', { authorization: undefined, 'x-dkg-export-token': key }), res);
    assert.equal(res.status, 200); assert.equal(forwarded.at(-1).options.headers.authorization, undefined);
    assert.equal(forwarded.at(-1).options.headers['x-dkg-export-token'], undefined);
    for (const path of ['/spike/ka/demo-data', '/spike/ka/internal/dkg-component', prefix + '/studio/invoke/extra', prefix.replace('account-a', 'account-b')]) {
      const denied = response(), before = forwarded.length; await f.handle(request(path), denied);
      assert.equal(denied.status, 404, path); assert.equal(forwarded.length, before);
    }
  } finally { f.close(); }
});

test('preview enforces the route byte limit before forwarding or reading an oversized declared body', async () => {
  const forwarded = [], f = fixture({ send: async (url, options) => { forwarded.push({ url, options }); return Response.json({}); } });
  try {
    for (const path of [prefix + '/studio/invoke', '/spike/ka/events/11223344-1234-4234-8234-123456789abc']) {
      const req = request(path), res = response(), bytes = Buffer.alloc(16384, ' ');
      req[Symbol.asyncIterator] = async function* () { yield bytes; };
      await f.handle(req, res); assert.equal(res.status, 200); assert.equal(forwarded.at(-1).options.body.length, 16384);
      const before = forwarded.length, overflow = request(path), rejected = response();
      overflow[Symbol.asyncIterator] = async function* () { yield bytes; yield Buffer.from(' '); };
      await f.handle(overflow, rejected); assert.equal(rejected.status, 413); assert.equal(forwarded.length, before);
      const declared = request(path, 'POST', { 'content-length': '16385' }), denied = response();
      await f.handle(declared, denied); assert.equal(denied.status, 413); assert.equal(declared.bodyReads, 0); assert.equal(forwarded.length, before);
    }
  } finally { f.close(); }
});
