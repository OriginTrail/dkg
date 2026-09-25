// Hermetic tests for lib/edge.mjs — no real SSH, no external network, no fleet.
// A local node:http fake daemon on 127.0.0.1 stands in for the edge; token
// resolution runs against a temp DKG_HOME; runCli runs against stub node scripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EdgeClient,
  runCli,
  makePayload,
  verifyReadback,
  parseNquads,
  resolveEdgeToken,
  tailTruncate,
} from '../lib/edge.mjs';
import { normTerm } from '../lib/util.mjs';

const TOKEN = 'tok-abc123';

function makeDkgHome({ token = TOKEN } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'rfc61-edge-home-'));
  if (token !== null) {
    writeFileSync(
      join(home, 'auth.token'),
      `# DKG node API token — treat this like a password\n\n${token}\n`,
    );
  }
  return home;
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : null;
}

async function waitUntil(label, cond, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitUntil timeout: ${label}`);
}

// ── token resolution ─────────────────────────────────────────────────────────

test('resolveEdgeToken: override > DKG_AUTH_TOKEN env > auth.token file > undefined', () => {
  const home = makeDkgHome();
  assert.equal(resolveEdgeToken(home, { env: {} }), TOKEN);
  assert.equal(resolveEdgeToken(home, { env: { DKG_AUTH_TOKEN: ' env-tok ' } }), 'env-tok');
  assert.equal(resolveEdgeToken(home, { token: 'override', env: { DKG_AUTH_TOKEN: 'env-tok' } }), 'override');
  const empty = makeDkgHome({ token: null });
  assert.equal(resolveEdgeToken(empty, { env: {} }), undefined);
});

test('auth.token parsing skips comments and blank lines (auth.ts contract)', () => {
  const home = mkdtempSync(join(tmpdir(), 'rfc61-edge-home-'));
  writeFileSync(join(home, 'auth.token'), '# comment\n\n# more\nfirst-token\nsecond-token\n');
  assert.equal(resolveEdgeToken(home, { env: {} }), 'first-token');
});

// ── EdgeClient lifecycle against a fake daemon ───────────────────────────────

test('EdgeClient: create / share-async / job poll / publish-async / publisher poll / KA state / query / catchup', async (t) => {
  const home = makeDkgHome();
  const seen = [];
  let sharePolls = 0;
  let publishPolls = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const record = {
      method: req.method,
      path: url.pathname,
      search: Object.fromEntries(url.searchParams),
      auth: req.headers.authorization ?? null,
      body: req.method === 'POST' ? await readBody(req) : null,
    };
    seen.push(record);
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return send(200, { name: 'tn-edge', nodeRole: 'edge', commit: 'deadbeef', uptimeMs: 1 });
    }
    if (req.method === 'POST' && url.pathname === '/api/knowledge-assets') {
      return send(201, { name: record.body.name, assertionUri: 'urn:a', alreadyExists: false, status: 'wm-sealed', merkleRoot: '0xmr' });
    }
    if (req.method === 'POST' && url.pathname === '/api/knowledge-assets/ka-1/swm/share-async') {
      return send(200, { jobId: 'sj-1', state: 'queued' });
    }
    if (req.method === 'GET' && url.pathname === '/api/knowledge-assets/swm/share-jobs/sj-1') {
      sharePolls++;
      if (sharePolls < 3) return send(200, { jobId: 'sj-1', state: 'running' });
      return send(200, { jobId: 'sj-1', state: 'succeeded', result: { promotedCount: 1 } });
    }
    if (req.method === 'POST' && url.pathname === '/api/knowledge-assets/ka-1/vm/publish-async') {
      return send(202, { jobId: 'pj-1', status: 'accepted', contextGraphId: record.body.contextGraphId, name: 'ka-1' });
    }
    if (req.method === 'GET' && url.pathname === '/api/publisher/job') {
      publishPolls++;
      if (publishPolls < 2) return send(200, { job: { jobId: url.searchParams.get('id'), status: 'broadcast' } });
      return send(200, { job: { jobId: url.searchParams.get('id'), status: 'finalized', ual: 'did:dkg:base:84532/0xabc/7', txHash: '0xtx' } });
    }
    if (req.method === 'GET' && url.pathname === '/api/knowledge-assets/ka-1') {
      return send(200, { name: 'ka-1', memoryLayer: 'VM', publishedUal: 'did:dkg:base:84532/0xabc/7', reservedUal: 'did:dkg:reserved', events: [{ toLayer: 'VM' }] });
    }
    if (req.method === 'POST' && url.pathname === '/api/query') {
      return send(200, { result: { bindings: [{ s: 'urn:x', o: '"y"' }] }, phases: { execute: 1, serverTotal: 2 } });
    }
    if (req.method === 'GET' && url.pathname === '/api/sync/catchup-status') {
      return send(200, { jobId: 'cu-1', state: 'done', bytesReceived: 42 });
    }
    return send(404, { error: `unexpected ${req.method} ${url.pathname}` });
  });
  const port = await listen(server);
  t.after(() => server.close());

  const edge = new EdgeClient({ dkgHome: home, apiPort: port, label: 'driver', env: {} });

  // status() is the PUBLIC route — must not send Authorization (api-client.ts auth:false).
  const status = await edge.status();
  assert.equal(status.name, 'tn-edge');
  assert.equal(seen.at(-1).auth, null);

  // create: N-Quads string converted to writable-quad objects; finalize passthrough.
  const payload = makePayload({ runId: 'r1', lane: 'public', index: 3, controlFixtureEvery: 10 });
  const created = await edge.createKnowledgeAsset({ name: 'ka-1', cg: '0xADDR/cg-pub', quads: payload.quads, finalize: true });
  assert.equal(created.status, 'wm-sealed');
  const createReq = seen.at(-1);
  assert.equal(createReq.auth, `Bearer ${TOKEN}`);
  assert.equal(createReq.body.contextGraphId, '0xADDR/cg-pub');
  assert.equal(createReq.body.finalize, true);
  assert.ok(Array.isArray(createReq.body.quads), 'quads must be the array shape the route accepts');
  assert.deepEqual(createReq.body.quads, [{
    subject: payload.subject,
    predicate: 'http://schema.org/name',
    object: payload.expectedObject,
  }]);

  // share-async → waitShareJob (terminal 'succeeded', non-terminal 'running' polled through).
  const share = await edge.shareAsync({ name: 'ka-1', cg: '0xADDR/cg-pub' });
  assert.deepEqual(share, { jobId: 'sj-1', state: 'queued' });
  assert.equal(seen.at(-1).body.contextGraphId, '0xADDR/cg-pub');
  const shareDone = await edge.waitShareJob({ jobId: 'sj-1', timeoutMs: 3000, intervalMs: 10 });
  assert.equal(shareDone.job.state, 'succeeded');
  assert.equal(shareDone.pollIntervalMs, 10);
  assert.equal(sharePolls, 3);

  // publish-async → waitPublishJob (terminal 'finalized' with ual+txHash).
  const pub = await edge.publishAsync({ name: 'ka-1', cg: '0xADDR/cg-pub' });
  assert.equal(pub.jobId, 'pj-1');
  assert.equal(pub.status, 'accepted');
  const pubDone = await edge.waitPublishJob({ jobId: 'pj-1', timeoutMs: 3000, intervalMs: 10 });
  assert.equal(pubDone.job.status, 'finalized');
  assert.equal(pubDone.job.ual, 'did:dkg:base:84532/0xabc/7');
  assert.equal(pubDone.job.txHash, '0xtx');
  assert.equal(pubDone.pollIntervalMs, 10);

  // knowledgeAssetState — the §6 recovery authority.
  const state = await edge.knowledgeAssetState({ name: 'ka-1', cg: '0xADDR/cg-pub' });
  assert.equal(state.memoryLayer, 'VM');
  assert.equal(state.publishedUal, 'did:dkg:base:84532/0xabc/7');
  assert.equal(seen.at(-1).search.contextGraphId, '0xADDR/cg-pub');

  // query — body field is `sparql` (NOT `query`), view + contextGraphId forwarded.
  const q = await edge.query({ sparql: 'SELECT ?s WHERE { ?s ?p ?o }', view: 'verifiable-memory', cg: '0xADDR/cg-pub' });
  assert.ok(Array.isArray(q.result.bindings));
  const queryReq = seen.at(-1);
  assert.equal(queryReq.body.sparql, 'SELECT ?s WHERE { ?s ?p ?o }');
  assert.equal(queryReq.body.view, 'verifiable-memory');
  assert.equal(queryReq.body.contextGraphId, '0xADDR/cg-pub');
  assert.equal(queryReq.auth, `Bearer ${TOKEN}`);

  // catchup-status.
  const cu = await edge.catchupStatus({ cg: '0xADDR/cg-pub' });
  assert.equal(cu.state, 'done');
  assert.equal(seen.at(-1).search.contextGraphId, '0xADDR/cg-pub');
});

test('EdgeClient: non-2xx responses throw with status attached; waitShareJob times out on a never-terminal job', async (t) => {
  const home = makeDkgHome();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST') await readBody(req);
    if (url.pathname.startsWith('/api/knowledge-assets/swm/share-jobs/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ jobId: 'sj-stuck', state: 'failed_retrying' }));
    }
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Promote job already active', existingJobId: 'sj-0' }));
  });
  const port = await listen(server);
  t.after(() => server.close());
  const edge = new EdgeClient({ dkgHome: home, apiPort: port, label: 'driver', env: {} });

  await assert.rejects(
    edge.shareAsync({ name: 'ka-1', cg: 'cg' }),
    (err) => err.status === 409 && err.body.existingJobId === 'sj-0',
  );
  // failed_retrying is NOT terminal (async-promote-queue-types.ts) — must poll to deadline.
  await assert.rejects(
    edge.waitShareJob({ jobId: 'sj-stuck', timeoutMs: 80, intervalMs: 10 }),
    (err) => err.timedOut === true && /failed_retrying/.test(err.message),
  );
});

// ── SSE events: parse, auth, forced disconnect → gap + auto-reconnect ────────

test('events(): parses SSE frames, records disconnect gap, reconnects automatically', async (t) => {
  const home = makeDkgHome();
  const connections = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    assert.equal(url.pathname, '/api/events');
    connections.push({ auth: req.headers.authorization ?? null, accept: req.headers.accept, res });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    // Exact daemon greeting + broadcast shape (lifecycle.ts:3457, 2921-2927).
    res.write('event: connected\ndata: {}\n\n');
    res.write(': heartbeat\n\n');
    const n = connections.length;
    res.write(`event: memory_graph_changed\ndata: ${JSON.stringify({ contextGraphId: 'cg-1', operation: 'assertion_promoted', conn: n })}\n\n`);
  });
  const port = await listen(server);
  t.after(() => server.close());

  const edge = new EdgeClient({ dkgHome: home, apiPort: port, label: 'observer', env: {} });
  const received = [];
  const handle = await edge.events({ onEvent: (e) => received.push(e), retryMs: 25, connectTimeoutMs: 2000 });
  t.after(() => handle.close());

  await waitUntil('first connection events', () => received.filter((e) => e.event === 'memory_graph_changed').length >= 1);
  assert.equal(connections.length, 1);
  assert.equal(connections[0].auth, `Bearer ${TOKEN}`);
  assert.equal(connections[0].accept, 'text/event-stream');
  assert.equal(received[0].event, 'connected');
  assert.deepEqual(received[0].data, {});
  const mgc = received.find((e) => e.event === 'memory_graph_changed');
  assert.equal(mgc.data.contextGraphId, 'cg-1');
  assert.equal(mgc.data.conn, 1);
  assert.equal(typeof mgc.ts, 'number');
  // No gap yet — the stream has never dropped.
  assert.deepEqual(handle.gaps(), []);

  // Forced disconnect (§4.3 SSE reliability): daemon side kills the socket.
  connections[0].res.destroy();
  await waitUntil('reconnect + second stream events', () =>
    received.filter((e) => e.event === 'memory_graph_changed').length >= 2);
  assert.equal(connections.length, 2, 'client must reconnect automatically');
  assert.equal(received.filter((e) => e.event === 'memory_graph_changed').at(-1).data.conn, 2);

  const gaps = handle.gaps();
  assert.equal(gaps.length, 1, 'exactly one disconnect gap recorded');
  assert.equal(typeof gaps[0].fromTs, 'number');
  assert.equal(typeof gaps[0].toTs, 'number');
  assert.ok(gaps[0].fromTs <= gaps[0].toTs, 'gap interval must be ordered');

  handle.close();
  const countAfterClose = connections.length;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(connections.length, countAfterClose, 'close() must stop reconnecting');
});

test('events(): rejects when no connection within connectTimeoutMs', async () => {
  const home = makeDkgHome();
  // Grab a port and close the server so nothing listens there.
  const server = createServer(() => {});
  const port = await listen(server);
  await new Promise((r) => server.close(r));
  const edge = new EdgeClient({ dkgHome: home, apiPort: port, label: 'observer', env: {} });
  await assert.rejects(
    edge.events({ onEvent: () => {}, retryMs: 20, connectTimeoutMs: 120 }),
    /no SSE connection within 120ms/,
  );
});

// ── makePayload determinism + fixture cadence ────────────────────────────────

test('makePayload: deterministic, urn:rfc61 subject scheme, control fixtures every Nth', () => {
  const a = makePayload({ runId: 'run-1', lane: 'private', index: 7, controlFixtureEvery: 10 });
  const b = makePayload({ runId: 'run-1', lane: 'private', index: 7, controlFixtureEvery: 10 });
  assert.deepEqual(a, b, 'same inputs must produce identical payloads');
  assert.equal(a.subject, 'urn:rfc61:private:run-1:7');
  assert.equal(a.controlFixture, false);
  assert.equal(a.expectedObject, JSON.stringify('rfc61 private run-1 #7'));
  assert.equal(a.quads, `<urn:rfc61:private:run-1:7> <http://schema.org/name> ${a.expectedObject} .\n`);

  // Cadence: indices 0 and 10 are control fixtures with controlFixtureEvery=10; 1..9 are not.
  for (let i = 0; i <= 10; i++) {
    const p = makePayload({ runId: 'run-1', lane: 'public', index: i, controlFixtureEvery: 10 });
    assert.equal(p.controlFixture, i % 10 === 0, `index ${i}`);
  }
  // Control fixture carries the rfc59 Unicode/control-char set: café / Δ / \n / \t / \u0001.
  const cf = makePayload({ runId: 'run-1', lane: 'public', index: 20, controlFixtureEvery: 10 });
  const literal = JSON.parse(cf.expectedObject);
  assert.ok(literal.includes('café'));
  assert.ok(literal.includes('Δ'));
  assert.ok(literal.includes('\n'));
  assert.ok(literal.includes('\t'));
  assert.ok(literal.includes('\u0001'));
  assert.ok(cf.expectedObject.includes('\\n') && cf.expectedObject.includes('\\t') && cf.expectedObject.includes('\\u0001'),
    'expectedObject must be the escaped term form');
  // Disabled cadence.
  assert.equal(makePayload({ runId: 'r', lane: 'l', index: 0, controlFixtureEvery: 0 }).controlFixture, false);

  // The generated N-Quads round-trip through the route-shape converter.
  assert.deepEqual(parseNquads(cf.quads), [{
    subject: cf.subject,
    predicate: 'http://schema.org/name',
    object: cf.expectedObject,
  }]);
});

test('parseNquads: IRI objects unwrap to bare IRIs, graphs and datatypes survive, junk throws', () => {
  assert.deepEqual(parseNquads('<urn:s> <urn:p> <urn:o> .'), [
    { subject: 'urn:s', predicate: 'urn:p', object: 'urn:o' },
  ]);
  assert.deepEqual(parseNquads('<urn:s> <urn:p> "v"^^<http://www.w3.org/2001/XMLSchema#integer> <urn:g> .'), [
    { subject: 'urn:s', predicate: 'urn:p', object: '"v"^^<http://www.w3.org/2001/XMLSchema#integer>', graph: 'urn:g' },
  ]);
  assert.deepEqual(parseNquads('<urn:s> <urn:p> "v"@en .'), [
    { subject: 'urn:s', predicate: 'urn:p', object: '"v"@en' },
  ]);
  assert.throws(() => parseNquads('bare junk line'), /unparseable N-Quads line/);
  assert.throws(() => parseNquads('\n# only a comment\n'), /no quads/);
});

// ── runCli (rfc59 publishOne child_process mechanics) ────────────────────────

test('runCli: spawns node <cliPath> with DKG_HOME, captures output, reports duration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rfc61-cli-'));
  const script = join(dir, 'ok.mjs');
  writeFileSync(script, [
    "console.log('HOME=' + process.env.DKG_HOME);",
    "console.log('ARGS=' + JSON.stringify(process.argv.slice(2)));",
    "console.error('warn-line');",
    'process.exit(0);',
  ].join('\n'));
  const home = join(dir, 'dkg-home');
  const r = await runCli({ cliPath: script, dkgHome: home, args: ['ka', 'create', 'x'], timeoutMs: 10_000 });
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
  assert.equal(r.signal, null);
  assert.equal(r.timedOut, false);
  assert.ok(r.stdout.includes(`HOME=${home}`), 'DKG_HOME must be injected into the child env');
  assert.ok(r.stdout.includes('ARGS=["ka","create","x"]'));
  assert.equal(r.stderr, 'warn-line');
  assert.ok(Number.isFinite(r.durationMs) && r.durationMs >= 0);
});

test('runCli: timeout SIGKILLs the child and reports timedOut', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rfc61-cli-'));
  const script = join(dir, 'hang.mjs');
  writeFileSync(script, "console.log('started'); setTimeout(() => {}, 60_000);");
  const started = Date.now();
  const r = await runCli({ cliPath: script, dkgHome: dir, args: [], timeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.equal(r.signal, 'SIGKILL');
  assert.ok(Date.now() - started < 5000, 'must not wait for the child’s own exit');
});

test('runCli: output is tail-truncated to 16k chars (rfc59 commandOutput)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rfc61-cli-'));
  const script = join(dir, 'big.mjs');
  writeFileSync(script, "process.stdout.write('x'.repeat(20000) + 'TAILMARK');");
  const r = await runCli({ cliPath: script, dkgHome: dir, args: [], timeoutMs: 10_000 });
  assert.equal(r.ok, true);
  assert.equal(r.stdout.length, 16_000);
  assert.ok(r.stdout.endsWith('TAILMARK'), 'truncation must keep the TAIL');
  // Direct helper check as well.
  assert.equal(tailTruncate('  ab  '), 'ab');
  assert.equal(tailTruncate('y'.repeat(17_000)).length, 16_000);
});

test('runCli: spawn failure resolves ok:false with error instead of rejecting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rfc61-cli-'));
  const r = await runCli({
    cliPath: 'whatever.mjs',
    dkgHome: dir,
    args: [],
    timeoutMs: 2000,
    execPath: join(dir, 'no-such-binary'),
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, null);
  assert.ok(r.error.length > 0);
});

// ── verifyReadback (chunked VALUES SELECT + normTerm) ────────────────────────

function readbackServer(behavior) {
  const queries = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    assert.equal(url.pathname, '/api/query');
    const body = await readBody(req);
    queries.push(body);
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const subjects = [...body.sparql.matchAll(/<([^>]+)>/g)]
      .map((m) => m[1])
      .filter((iri) => iri.startsWith('urn:rfc61:'));
    const out = behavior(subjects, body);
    if (out.status) return send(out.status, out.body ?? { error: 'boom' });
    return send(200, { result: { bindings: out.bindings }, phases: { execute: 1, serverTotal: 1 } });
  });
  return { server, queries };
}

test('verifyReadback: byte-exact matches, missing + mismatch classification, chunking', async (t) => {
  const home = makeDkgHome();
  const items = Array.from({ length: 5 }, (_, i) =>
    makePayload({ runId: 'rb', lane: 'public', index: i, controlFixtureEvery: 3 }));
  const wrongSubject = items[3].subject;
  const missingSubject = items[4].subject;
  const { server, queries } = readbackServer((subjects) => ({
    bindings: subjects
      .filter((s) => s !== missingSubject)
      .map((s) => ({
        s,
        o: s === wrongSubject ? '"tampered"' : items.find((it) => it.subject === s).expectedObject,
      })),
  }));
  const port = await listen(server);
  t.after(() => server.close());
  const edge = new EdgeClient({ dkgHome: home, apiPort: port, label: 'driver', env: {} });

  const result = await verifyReadback(edge, {
    items,
    cg: '0xADDR/cg-pub',
    view: 'verifiable-memory',
    chunkSize: 2,
  });
  assert.equal(result.matched, 3);
  assert.deepEqual(result.mismatches, [
    { subject: wrongSubject, kind: 'mismatch' },
    { subject: missingSubject, kind: 'missing' },
  ]);
  // 5 items at chunkSize 2 → 3 VALUES queries, each carrying view + cg.
  assert.equal(queries.length, 3);
  for (const q of queries) {
    assert.ok(q.sparql.startsWith('SELECT ?s ?o WHERE { VALUES ?s {'));
    assert.ok(q.sparql.includes('<http://schema.org/name>'));
    assert.equal(q.view, 'verifiable-memory');
    assert.equal(q.contextGraphId, '0xADDR/cg-pub');
  }
  assert.ok(queries[0].sparql.includes(`<${items[0].subject}> <${items[1].subject}>`));
});

test('verifyReadback: structured SPARQL-JSON cells normalize via normTerm (control fixture incl.)', async (t) => {
  const home = makeDkgHome();
  const items = [
    makePayload({ runId: 'rb2', lane: 'private', index: 0, controlFixtureEvery: 1 }), // control fixture
    makePayload({ runId: 'rb2', lane: 'private', index: 1, controlFixtureEvery: 0 }),
  ];
  const { server } = readbackServer((subjects) => ({
    bindings: subjects.map((s) => ({
      s: { type: 'uri', value: s },
      o: { type: 'literal', value: JSON.parse(items.find((it) => it.subject === s).expectedObject) },
    })),
  }));
  const port = await listen(server);
  t.after(() => server.close());
  const edge = new EdgeClient({ dkgHome: home, apiPort: port, label: 'driver', env: {} });
  const result = await verifyReadback(edge, { items, cg: 'cg', view: 'shared-working-memory' });
  assert.equal(result.matched, 2);
  assert.deepEqual(result.mismatches, []);
});

test('verifyReadback: a failed chunk query marks every chunk item query_error, other chunks still score', async (t) => {
  const home = makeDkgHome();
  const items = Array.from({ length: 4 }, (_, i) =>
    makePayload({ runId: 'rb3', lane: 'public', index: i, controlFixtureEvery: 0 }));
  let call = 0;
  const { server } = readbackServer((subjects) => {
    call++;
    if (call === 1) return { status: 500 };
    return { bindings: subjects.map((s) => ({ s, o: items.find((it) => it.subject === s).expectedObject })) };
  });
  const port = await listen(server);
  t.after(() => server.close());
  const edge = new EdgeClient({ dkgHome: home, apiPort: port, label: 'driver', env: {} });
  const result = await verifyReadback(edge, { items, cg: 'cg', view: 'verifiable-memory', chunkSize: 2 });
  assert.equal(result.matched, 2);
  assert.deepEqual(result.mismatches, [
    { subject: items[0].subject, kind: 'query_error' },
    { subject: items[1].subject, kind: 'query_error' },
  ]);
});

// Seam guard: verifyReadback's default normalizer is util.normTerm — these
// vectors lock the semantics verifyReadback depends on (term-string
// passthrough, lang tags, datatype rendering with xsd:string elision,
// structured uri cells canonicalized to <iri> which unwrapIri then strips).
test('util normTerm satisfies the verifyReadback normalization contract', () => {
  assert.equal(normTerm('"already-a-term"'), '"already-a-term"');
  assert.equal(normTerm({ type: 'uri', value: 'urn:x' }), '<urn:x>');
  assert.equal(normTerm({ type: 'literal', value: 'v', 'xml:lang': 'en' }), '"v"@en');
  assert.equal(
    normTerm({ type: 'literal', value: '5', datatype: 'http://www.w3.org/2001/XMLSchema#integer' }),
    '"5"^^<http://www.w3.org/2001/XMLSchema#integer>',
  );
  assert.equal(
    normTerm({ type: 'literal', value: 'plain', datatype: 'http://www.w3.org/2001/XMLSchema#string' }),
    '"plain"',
  );
  assert.equal(normTerm(undefined), '');
});
