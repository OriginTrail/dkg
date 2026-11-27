import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const app = fileURLToPath(new URL('../../examples/docs/http-app.mjs', import.meta.url));
const contextGraphId = 'docs-test-graph';
const name = 'atlas-app';
const ka = `/api/knowledge-assets/${name}`;
const token = 'test-only-token';

function runClient(url, args, preload) {
  return new Promise(resolve => {
    execFile(process.execPath, [...(preload ? ['--import', preload] : []), app, ...args], {
      env: { ...process.env, DKG_NODE_URL: url, DKG_CONTEXT_GRAPH: contextGraphId,
        DKG_KA_NAME: name, DKG_AUTH_TOKEN: token },
      timeout: 10_000, encoding: 'utf8',
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
}

async function responder(t, respond) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    const request = { method: req.method, path: req.url, authorization: req.headers.authorization,
      body: text ? JSON.parse(text) : undefined };
    requests.push(request);
    const reply = respond(request, requests.length);
    if (reply.disconnect) { res.destroy(); return; }
    res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...reply.headers });
    res.end(JSON.stringify(reply.body ?? {}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const run = (...args) => runClient(url, args);
  return { requests, run, url };
}

function assertStopped(result, status) {
  assert.equal(result.error?.code, 1, result.stderr);
  assert.match(result.stderr, new RegExp(`Node operation incomplete \\(HTTP ${status}\\)`));
  assert.equal(result.stdout, '');
}

test('remote plaintext HTTP is rejected before invoking fetch', async () => {
  // Trap fetch in the child so even a broken guard cannot reach an external host.
  const preload = `data:text/javascript,${encodeURIComponent(
    "globalThis.fetch = () => { console.error('UNEXPECTED_NETWORK_REQUEST'); throw new Error('fetch must not run'); };"
  )}`;
  const result = await runClient('http://dkg.example.invalid', ['write'], preload);
  assert.equal(result.error?.code, 1, result.stderr);
  assert.match(result.stderr, /Use HTTPS for a remote node/);
  assert.ok(!result.stderr.includes('UNEXPECTED_NETWORK_REQUEST'));
  assert.equal(result.stdout, '');
});

for (const [status, destination] of [[302, 'same origin'], [307, 'another origin']]) {
  test(`HTTP ${status} to ${destination} stops without following the redirect`, async t => {
    const target = await responder(t, () => ({ body: { created: true } }));
    const source = await responder(t, request => request.path === '/redirected'
      ? { body: { created: true } }
      : { status, headers: { Location: destination === 'same origin'
        ? '/redirected' : `${target.url}/redirected` } });
    const result = await source.run('write');
    assert.equal(result.error?.code, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(source.requests, [{ method: 'POST', path: '/api/knowledge-assets',
      authorization: `Bearer ${token}`, body: { contextGraphId, name } }]);
    assert.deepEqual(target.requests, [], 'No request or credential may reach the redirect target');
  });
}

for (const [label, reply] of [
  ['HTTP 207 without an error field', { status: 207, body: { created: true } }],
  ['HTTP 200 with error entries', { body: { errors: { share: 'server-private-detail' } } }],
  ['HTTP 200 with an error array', { body: { errors: ['server-private-detail'] } }],
  ['HTTP 200 with a singular error', { body: { error: 'server-private-detail' } }],
  ['HTTP 409', { status: 409, body: {} }],
]) {
  test(`write stops after incomplete create: ${label}`, async t => {
    const { requests, run } = await responder(t, () => reply);
    const result = await run('write');
    assertStopped(result, reply.status ?? 200);
    assert.deepEqual(requests, [{ method: 'POST', path: '/api/knowledge-assets',
      authorization: `Bearer ${token}`, body: { contextGraphId, name } }]);
    assert.ok(!result.stderr.includes('server-private-detail'));
  });
}

test('write stops after an incomplete WM write without reading or retrying', async t => {
  const { requests, run } = await responder(t, (_request, count) => count === 1
    ? { body: { created: true } } : { status: 207, body: { written: 2 } });
  assertStopped(await run('write'), 207);
  assert.deepEqual(requests.map(r => r.path), ['/api/knowledge-assets', `${ka}/wm/write`]);
});

test('complete write accepts empty error collections and reads the stored draft', async t => {
  const { requests, run } = await responder(t, (_request, count) => ({ body:
    count === 1 ? { errors: {} } : count === 2 ? { errors: [] } : { count: 5 } }));
  const result = await run('write');
  assert.equal(result.error, null, result.stderr);
  assert.equal(JSON.parse(result.stdout).count, 5);
  assert.deepEqual(requests.map(r => r.path), ['/api/knowledge-assets', `${ka}/wm/write`,
    `${ka}/wm/quads?contextGraphId=${contextGraphId}`]);
});

for (const swmShared of [false, undefined]) {
  test(`share rejects HTTP 200 without confirmed completion: swmShared=${swmShared}`, async t => {
    const { requests, run } = await responder(t, () => ({ body: { swmShared, promotedCount: 0 } }));
    const result = await run('share');
    assert.equal(result.error?.code, 1, result.stderr);
    assert.match(result.stderr, /Share did not complete/);
    assert.equal(result.stdout, '');
    assert.deepEqual(requests, [{ method: 'POST', path: `${ka}/swm/share`,
      authorization: `Bearer ${token}`, body: { contextGraphId, entities: 'all' } }]);
  });
}

for (const outcome of ['success', 'lost response', 'partial response', 'bookkeeping error']) {
  test(`explicit share retry resumes the same committed operation after ${outcome}`, async t => {
    let wmTriples = 5;
    let commits = 0;
    const shareOperationId = 'share-operation-1';
    const { requests, run } = await responder(t, request => {
      // Model the server lifecycle: finalize rejects an empty WM; share replays
      // the committed operation. This reproduces the old client's retry failure.
      if (request.path === `${ka}/wm/finalize`) return wmTriples
        ? { body: { sealed: true } }
        : { status: 409, body: { error: 'ASSERTION_EMPTY' } };
      if (request.path !== `${ka}/swm/share`) return { status: 404, body: {} };
      const firstShare = wmTriples > 0;
      if (firstShare) { wmTriples = 0; commits++; }
      if (firstShare && outcome === 'lost response') return { disconnect: true };
      if (firstShare && outcome === 'partial response') return { status: 207, body: { shareOperationId } };
      if (firstShare && outcome === 'bookkeeping error') return { status: 503, body: { error: 'pointer maintenance failed' } };
      return { body: { swmShared: true, sealed: true, publishReady: true,
        promotedCount: firstShare ? 5 : 0, shareOperationId } };
    });
    const first = await run('share');
    if (outcome === 'success') assert.equal(first.error, null, first.stderr);
    else assert.equal(first.error?.code, 1, first.stderr);
    assert.equal(wmTriples, 0);
    assert.equal(requests.length, 1, 'The client must not automatically retry');

    const replay = await run('share');
    assert.equal(replay.error, null, replay.stderr);
    const result = JSON.parse(replay.stdout).result;
    assert.equal(result.swmShared, true);
    assert.equal(result.promotedCount, 0);
    assert.equal(result.shareOperationId, shareOperationId);
    assert.equal(commits, 1);
    assert.deepEqual(requests, Array.from({ length: 2 }, () => ({ method: 'POST',
      path: `${ka}/swm/share`, authorization: `Bearer ${token}`,
      body: { contextGraphId, entities: 'all' } })));
  });
}
