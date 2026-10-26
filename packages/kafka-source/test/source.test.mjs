import { test, vi, onTestFinished } from 'vitest';
import { canonicalizeRdfObjectTerm } from '@origintrail-official/dkg-rdf-utils';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSourceWorkerOnce } from '../../agent/src/source-worker.ts';
import { createHandler } from '../src/handler.mjs';
import { createDkgSink } from '../src/dkg-sink.mjs';
import { Journal } from '../src/journal.mjs';
import { hash, buildAsset } from '../src/asset.mjs';

const owner = '0x' + 'a'.repeat(40);
const source = { id: 'kafka-test', kind: 'kafka', clusterId: 'local-poc', brokers: ['localhost:19092'],
  groupId: 'dkg-kafka-poc', topic: 'dkg-source-test', ssl: false, agentAddress: owner,
  contextGraphId: owner + '/kafka-source-poc', mapping: [{ field: 'orderNo', predicate: 'https://example.com/production/orderNumber' }] };
const message = (offset = '0') => ({ topic: source.topic, partition: 0, offset, timestamp: '1700000000000',
  keyBase64: null, valueBase64: Buffer.from(JSON.stringify({ orderNo: 'SYNTHETIC-1', kWh: 12 })).toString('base64'),
  headers: {}, fetchedAt: '2026-10-20T10:00:00.000Z' });

// HTTP lifecycle contract double, deliberately NOT claimed as a live DKG node.
function daemon() {
  const assets = new Map(); let writes = 0; let loseResponse = false; let corrupt = false; let invisible = false;
  let rejection, descriptor = {}, normalize = false, changedLiteral = false, posts = 0;
  let cooldownUntil = 0, requests = 0, readThrottle;
  const fetch = async (url, options) => {
    requests++;
    if (Date.now() < cooldownUntil) return Response.json({ error: 'Too many requests' }, {
      status: 429, headers: { 'Retry-After': String(Math.ceil((cooldownUntil - Date.now()) / 1000)) },
    });
    const path = new URL(url).pathname;
    if (readThrottle?.path === path && writes >= readThrottle.afterWrites) {
      readThrottle = undefined;
      cooldownUntil = Date.now() + 60000;
      return Response.json({ error: 'unclassified read throttling' }, {
        status: 429, headers: { 'Retry-After': '60' },
      });
    }
    if (path === '/api/context-graph/list') return Response.json({contextGraphs: [{id: source.contextGraphId, accessPolicy: 'private'}]});
    if (path === '/api/query') {
      const graph = JSON.parse(options.body).sparql.match(/GRAPH <([^>]+)>/)[1];
      const asset = [...assets.values()].find(a => graph.endsWith('/' + hash(a)));
      let quads = corrupt ? [] : asset?.quads ?? [];
      if (changedLiteral) quads = quads.map(quad => quad.predicate === source.mapping[0].predicate ?
        { ...quad, object: '"different value"' } : quad);
      if (normalize) quads = quads.map(quad => ({ ...quad,
        object: canonicalizeRdfObjectTerm(quad.object).replace(/\\u000B/g, '\\u000b') }));
      return Response.json({ result: { type: 'quads', quads } });
    }
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      assert.equal(body.finalize, true);
      assert.equal(body.alsoShareSwm, false);
      assert.equal(body.alsoPublishVm, false);
      posts++;
      if (rejection) {
        const response = rejection; rejection = undefined;
        if (response.cooldownMs) cooldownUntil = Date.now() + response.cooldownMs;
        return Response.json(response.body, { status: response.status, headers: response.headers });
      }
      writes++; assets.set(body.name, body);
      if (loseResponse) throw new Error('simulated lost response');
      return Response.json({ status: 'wm-sealed' }, { status: 201 });
    }
    const name = decodeURIComponent(path.split('/')[3]);
    const asset = assets.get(name);
    if (!asset || invisible) return Response.json({}, { status: 404 });
    if (path.endsWith('/quads')) return Response.json({ quads: corrupt ? [] : asset.quads });
    return Response.json({ name, contextGraphId: source.contextGraphId, agentAddress: owner,
      status: 'wm-sealed', wmCurrentAssertion: hash(asset),
      assertionGraph: `did:dkg:context-graph:${source.contextGraphId}/_working_memory/${owner}/${hash(asset)}`, ...descriptor });
  };
  return { fetch, assets, get writes() { return writes; }, lose() { loseResponse = true; },
    corrupt(value = true) { corrupt = value; }, invisible(value = true) { invisible = value; },
    throttleRead(path, afterWrites = 0) { readThrottle = { path, afterWrites }; },
    rejectNext(status = 429, body = { error: 'Too many requests' }, headers = { 'Retry-After': '0' }, cooldownMs = 0) {
      rejection = { status, body, headers, cooldownMs };
    },
    get requests() { return requests; },
    get posts() { return posts; }, descriptor(value) { descriptor = value; }, normalize() { normalize = true; }, changeLiteral() { changedLiteral = true; } };
}

async function fixture(t = { onTestFinished }, sources = [source]) {
  const dir = await mkdtemp(join(tmpdir(), 'dkg-kafka-source-test-'));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const config = { sources, stateFile: join(dir, 'source-state.json'), daemonUrl: 'http://localhost:9200', daemonToken: 'test' };
  const api = daemon();
  let queue = [message()], commits = [], closed = 0, rejectCommit = false, readError, drain = false;
  const read = async ref => {
    if (readError && ref.id === source.id) throw new Error(readError);
    return { records: [...queue], async commit(record) {
    if (rejectCommit) throw new Error('KAFKA_COMMIT_FAILED');
    commits.push(record.offset);
    if (drain) queue = queue.filter(item => item.offset !== record.offset);
  }, async close() { closed++; } }; };
  const createHooks = () => createHandler({ read, sinkFactory: () => createDkgSink(config, api.fetch) })
    .createSourceWorkerDeps({ config });
  let hooks = await createHooks();
  const run = () => runSourceWorkerOnce(config.sources, config.stateFile,
    { ...hooks, now: () => new Date().toISOString(), getJobStatus() { throw new Error('No chain publisher permitted'); } });
  return { config, api, run, async restart() { hooks = await createHooks(); },
    readFailure(value) { readError = value; }, drain() { drain = true; }, setQueue(records) { queue = records; },
    failCommit(value) { rejectCommit = value; }, get commits() { return commits; }, get closed() { return closed; } };
}

test('native DKG Source Worker persists receipt and acknowledges only verified KA', async t => {
  const f = await fixture(t);
  const state = await f.run();
  assert.equal(state.sources[source.id].lastStatus, 'completed');
  assert.equal(state.sources[source.id].kafka.created, 1);
  assert.deepEqual(f.commits, ['0']);
  assert.equal(f.closed, 1);
  assert.equal(f.api.writes, 1);
});

test('replayed offset reuses the same KA and original fetch time', async t => {
  const f = await fixture(t);
  await f.run();
  f.setQueue([{ ...message(), fetchedAt: '2030-01-01T00:00:00Z' }]);
  const state = await f.run();
  assert.equal(f.api.writes, 1);
  assert.equal(state.sources[source.id].kafka.reused, 1);
});

test('lost create response recovers exact readback without a second create', async t => {
  const f = await fixture(t); f.api.lose();
  const state = await f.run();
  assert.equal(state.sources[source.id].lastStatus, 'completed');
  assert.equal(f.api.writes, 1);
  assert.deepEqual(f.commits, ['0']);
});

test('failure after sealing but before offset commit resumes using existing KA', async t => {
  const f = await fixture(t); f.failCommit(true);
  assert.equal((await f.run()).sources[source.id].lastStatus, 'failed');
  assert.equal(f.api.writes, 1); assert.deepEqual(f.commits, []);
  f.failCommit(false);
  const state = await f.run();
  assert.equal(state.sources[source.id].lastStatus, 'completed');
  assert.equal(state.sources[source.id].kafka.reused, 1);
  assert.equal(f.api.writes, 1);
});

test('mismatched readback never acknowledges a Kafka offset', async t => {
  const f = await fixture(t); f.api.corrupt();
  const state = await f.run();
  assert.equal(state.sources[source.id].lastError, 'DKG_READBACK_MISMATCH');
  assert.deepEqual(f.commits, []);
});

test('unknown write stays blocked on replay and never writes a duplicate', async t => {
  const f = await fixture(t); f.api.lose(); f.api.invisible();
  assert.equal((await f.run()).sources[source.id].lastError, 'DKG_WRITE_OUTCOME_UNKNOWN');
  await f.run();
  assert.equal(f.api.writes, 1); assert.deepEqual(f.commits, []);
});

test('empty topic and a Kafka tombstone remain distinct', async t => {
  const f = await fixture(t); f.setQueue([]);
  assert.equal((await f.run()).sources[source.id].lastStatus, 'no-matching-rows');
  f.setQueue([{ ...message(), valueBase64: null }]);
  assert.equal((await f.run()).sources[source.id].kafka.created, 1);
  assert.deepEqual(f.commits, ['0']);
});

test('same Kafka position with changed payload is rejected before DKG write', async t => {
  const f = await fixture(t); await f.run();
  f.setQueue([{ ...message(), valueBase64: Buffer.from('different').toString('base64') }]);
  assert.equal((await f.run()).sources[source.id].lastError, 'KAFKA_RECORD_CHANGED');
  assert.equal(f.api.writes, 1);
});

test('large Kafka offsets retain exact decimal identity', () => {
  const asset = buildAsset(source, message('9223372036854775806'));
  assert.ok(asset.quads.some(q => q.object === '"9223372036854775806"'));
});

test('changed source scope cannot reuse an existing journal', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dkg-kafka-scope-'));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'journal.sqlite');
  new Journal(path, 'original').close();
  assert.throws(() => new Journal(path, 'different'), /KAFKA_JOURNAL_SCOPE_CHANGED/);
});

test('a public graph is rejected before any Kafka event is written', async () => {
  let creates = 0;
  const sink = createDkgSink({daemonUrl: 'http://localhost:9200', daemonToken: 'test'}, async (url, options) => {
    if (options.method === 'POST') creates++;
    return Response.json({contextGraphs: [{id: source.contextGraphId, accessPolicy: 'open'}]});
  });
  await assert.rejects(sink.ensure(source, buildAsset(source, message()), {}, {
    rejection: () => undefined, httpRetryAt: () => undefined,
  }), /DKG_PRIVATE_GRAPH_REQUIRED/);
  assert.equal(creates, 0);
});

test('non-JSON messages retain original bytes when no mapping is configured', () => {
  const bytes = Buffer.from([0, 255, 1, 2]);
  const record = {...message(), valueBase64: bytes.toString('base64')};
  const asset = buildAsset({...source, mapping: []}, record);
  const payloadQuad = asset.quads.find(q => q.predicate.endsWith('sourceRecordJson'));
  const envelope = JSON.parse(JSON.parse(payloadQuad.object));
  assert.deepEqual(Buffer.from(envelope.valueBase64, 'base64'), bytes);
});

test('mapping errors report a code without exposing source bytes or acknowledging', async t => {
  const f = await fixture(t);
  f.setQueue([{...message(), valueBase64: Buffer.from('sensitive invalid JSON').toString('base64')}]);
  const state = await f.run();
  assert.equal(state.sources[source.id].lastError, 'KAFKA_MAPPING_JSON_REQUIRED');
  assert.deepEqual(f.commits, []); assert.equal(f.api.writes, 0);
});


test('a definite pre-mutation 429 retries to exactly one sealed KA and acknowledgement', async t => {
  const f = await fixture(t); f.api.rejectNext();
  assert.equal((await f.run()).sources[source.id].lastError, 'DKG_HTTP_429');
  assert.equal(f.api.writes, 0); assert.deepEqual(f.commits, []);
  assert.equal((await f.run()).sources[source.id].lastStatus, 'completed');
  assert.equal(f.api.posts, 2); assert.equal(f.api.writes, 1); assert.deepEqual(f.commits, ['0']);
});

test('daemon-wide Retry-After cooldown survives handler restarts without HTTP requests or retry exhaustion', async t => {
  let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  t.onTestFinished(() => clock.mockRestore());
  const f = await fixture(t); f.api.rejectNext(429, { error: 'Too many requests' }, { 'Retry-After': '60' }, 60000);
  const initial = (await f.run()).sources[source.id];
  assert.equal(initial.lastError, 'DKG_HTTP_429'); assert.equal(initial.attemptCount, 1);
  const requests = f.api.requests;
  for (let i = 0; i < 5; i++) {
    now += 5000;
    await f.restart();
    const result = (await f.run()).sources[source.id];
    assert.equal(result.lastStatus, 'retry-wait'); assert.equal(result.attemptCount, 1);
    assert.notEqual(result.manualReviewRequired, true);
    assert.equal(f.api.requests, requests);
  }
  assert.equal(f.api.posts, 1); assert.deepEqual(f.commits, []);
  now += 35001;
  await f.restart();
  assert.equal((await f.run()).sources[source.id].lastStatus, 'completed');
  assert.equal(f.api.posts, 2); assert.equal(f.api.writes, 1); assert.deepEqual(f.commits, ['0']);
});

const descriptorPath = `/api/knowledge-assets/${encodeURIComponent(buildAsset(source, message()).name)}/wm`;
test.each([
  ['graph preflight', '/api/context-graph/list', 0],
  ['descriptor preflight', descriptorPath, 0],
  ['descriptor readback', descriptorPath, 1],
  ['query readback', '/api/query', 1],
])('%s 429 persists cooldown across restarts without spending retries or duplicate creates', async (_name, path, afterWrites) => {
  let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  onTestFinished(() => clock.mockRestore());
  const f = await fixture(); f.api.throttleRead(path, afterWrites);
  const initial = (await f.run()).sources[source.id];
  assert.equal(initial.lastStatus, 'retry-wait'); assert.equal(initial.attemptCount, 0);
  assert.equal(initial.retryAt, now + 60000);
  const requests = f.api.requests;
  for (let i = 0; i < 10; i++) {
    now += 5000; await f.restart();
    const state = (await f.run()).sources[source.id];
    assert.equal(state.lastStatus, 'retry-wait'); assert.equal(state.attemptCount, 0);
    assert.notEqual(state.manualReviewRequired, true);
    assert.equal(f.api.requests, requests); assert.deepEqual(f.commits, []);
    assert.equal(f.api.posts, afterWrites);
  }
  now += 10001; await f.restart();
  assert.equal((await f.run()).sources[source.id].lastStatus, 'completed');
  assert.equal(f.api.posts, 1); assert.equal(f.api.writes, 1); assert.deepEqual(f.commits, ['0']);
});

test('readback cooldown retains an uncertain write intent even while the asset is invisible', async t => {
  let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  t.onTestFinished(() => clock.mockRestore());
  const f = await fixture(t); f.api.lose(); f.api.invisible(); f.api.throttleRead(descriptorPath, 1);
  assert.equal((await f.run()).sources[source.id].lastStatus, 'retry-wait');
  const requests = f.api.requests;
  for (let i = 0; i < 5; i++) {
    now += 5000; await f.restart();
    assert.equal((await f.run()).sources[source.id].lastStatus, 'retry-wait');
    assert.equal(f.api.requests, requests);
  }
  now += 35001; await f.restart();
  assert.equal((await f.run()).sources[source.id].lastError, 'DKG_WRITE_OUTCOME_UNKNOWN');
  assert.equal(f.api.posts, 1); assert.equal(f.api.writes, 1); assert.deepEqual(f.commits, []);
  f.api.invisible(false); await f.restart();
  assert.equal((await f.run()).sources[source.id].lastStatus, 'completed');
  assert.equal(f.api.posts, 1); assert.deepEqual(f.commits, ['0']);
});

test('read throttling at the last available attempt preserves its prior failure count', async t => {
  let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  t.onTestFinished(() => clock.mockRestore());
  const f = await fixture(t); f.api.corrupt();
  for (let attempt = 1; attempt <= 2; attempt++) {
    const state = (await f.run()).sources[source.id];
    assert.equal(state.lastError, 'DKG_READBACK_MISMATCH'); assert.equal(state.attemptCount, attempt);
  }
  f.api.throttleRead('/api/context-graph/list');
  assert.equal((await f.run()).sources[source.id].lastStatus, 'retry-wait');
  const requests = f.api.requests;
  for (let i = 0; i < 5; i++) {
    now += 5000; await f.restart();
    const state = (await f.run()).sources[source.id];
    assert.equal(state.lastStatus, 'retry-wait'); assert.equal(state.attemptCount, 2);
    assert.equal(f.api.requests, requests); assert.deepEqual(f.commits, []);
  }
  now += 35001; f.api.corrupt(false); await f.restart();
  assert.equal((await f.run()).sources[source.id].lastStatus, 'completed');
  assert.equal(f.api.posts, 1); assert.deepEqual(f.commits, ['0']);
});

test.each([500, 429])('unclassified HTTP %s remains ambiguous and cannot issue another create', async (status, t) => {
  const f = await fixture(t); f.api.rejectNext(status, { error: 'unspecified failure' });
  for (let i = 0; i < 2; i++) assert.equal((await f.run()).sources[source.id].lastError, 'DKG_WRITE_OUTCOME_UNKNOWN');
  assert.equal(f.api.posts, 1); assert.equal(f.api.writes, 0); assert.deepEqual(f.commits, []);
});

test('equivalent independent RDF escape normalization passes sealed readback', async t => {
  const f = await fixture(t); f.api.normalize();
  f.setQueue([{ ...message(), valueBase64: Buffer.from(JSON.stringify({ orderNo: 'control\u000b\u001b\n"\\😀' })).toString('base64') }]);
  assert.equal((await f.run()).sources[source.id].lastStatus, 'completed');
  assert.deepEqual(f.commits, ['0']);
});

test.each([
  { status: 'wm-draft' }, { swmCurrentAssertion: 'shared' }, { vmCurrentAssertion: 'published' },
  { agentAddress: '0x' + 'b'.repeat(40) }, { contextGraphId: owner + '/other' },
  { wmCurrentAssertion: null }, { assertionGraph: 'urn:wrong-graph' },
  { assertionGraph: `did:dkg:context-graph:${source.contextGraphId}/_working_memory/${owner}/bad>graph` },
  { assertionGraph: `did:dkg:context-graph:${source.contextGraphId}/_working_memory/${owner}/bad\u0001graph` },
  { assertionGraph: `did:dkg:context-graph:${source.contextGraphId}/_working_memory/${owner.toUpperCase()}/1` },
  { assertionGraph: `did:dkg:context-graph:${source.contextGraphId}/_shared_working_memory/${owner}/1` },
])('invalid private sealed descriptor %j never acknowledges', async (override, t) => {
  const f = await fixture(t); f.api.descriptor(override);
  const result = (await f.run()).sources[source.id];
  assert.match(result.lastError, /DKG_PRIVATE_SEAL_REQUIRED|DKG_ASSERTION_GRAPH_MISMATCH/);
  assert.deepEqual(f.commits, []);
});

test('preparation outage persists per-source failure, continues unrelated sources and later recovers', async t => {
  const other = { ...source, id: 'unrelated' };
  const f = await fixture(t, [source, other]); f.readFailure('KAFKA_READ_FAILED');
  const first = await f.run();
  assert.equal(first.sources[source.id].lastError, 'KAFKA_READ_FAILED');
  assert.equal(first.sources[source.id].attemptCount, 1);
  assert.equal(first.sources[other.id].lastStatus, 'completed');
  f.readFailure(undefined);
  assert.equal((await f.run()).sources[source.id].lastStatus, 'completed');
  assert.equal(f.api.writes, 2);
});

test('oversize preparation failure reaches manual review without aborting other sources', async t => {
  const other = { ...source, id: 'healthy' };
  const f = await fixture(t, [source, other]); f.readFailure('KAFKA_RECORD_TOO_LARGE');
  let result;
  for (let i = 0; i < 4; i++) result = await f.run();
  assert.equal(result.sources[source.id].manualReviewRequired, true);
  assert.equal(result.sources[other.id].lastStatus, 'completed');
  assert.equal(f.api.writes, 1);
});

test('partial poison batch acknowledges only its valid prefix through retry exhaustion', async t => {
  const f = await fixture(t); f.drain();
  f.setQueue([message('0'), { ...message('1'), valueBase64: Buffer.from('invalid JSON').toString('base64') }, message('2')]);
  let state;
  for (let i = 0; i < 6; i++) state = await f.run();
  assert.equal(state.sources[source.id].manualReviewRequired, true);
  assert.deepEqual(f.commits, ['0']); assert.equal(f.api.writes, 1);
});

test.each([false, true])('alternating poison replay and broker outages exhaust retries across restarts (outage first: %s)', async (outageFirst, t) => {
  const f = await fixture(t);
  f.setQueue([{ ...message(), valueBase64: Buffer.from('invalid JSON').toString('base64') }]);
  let fingerprint, state, failures = 0;
  for (let poll = 0; poll < 10; poll++) {
    const outage = poll % 2 === (outageFirst ? 0 : 1);
    f.readFailure(outage ? 'KAFKA_READ_FAILED' : undefined); await f.restart();
    state = (await f.run()).sources[source.id];
    if (!outage && !fingerprint) fingerprint = state.fingerprint;
    if (fingerprint) assert.equal(state.fingerprint, fingerprint);
    if (state.lastStatus === 'failed' && fingerprint) {
      failures++;
      assert.equal(state.attemptCount, failures);
      assert.equal(state.lastError, outage ? 'KAFKA_READ_FAILED' : 'KAFKA_MAPPING_JSON_REQUIRED');
    }
    assert.deepEqual(f.commits, []); assert.equal(f.api.writes, 0);
  }
  assert.equal(failures, 3);
  assert.equal(state.manualReviewRequired, true); assert.equal(state.attemptCount, 4);
});

test('new delivery content retains a fresh retry budget after a preparation outage', async t => {
  const f = await fixture(t);
  const poison = offset => ({ ...message(offset), valueBase64: Buffer.from('invalid JSON').toString('base64') });
  f.setQueue([poison('0')]);
  const first = (await f.run()).sources[source.id];
  f.readFailure('KAFKA_READ_FAILED'); await f.restart();
  const outage = (await f.run()).sources[source.id];
  assert.equal(outage.fingerprint, first.fingerprint); assert.equal(outage.attemptCount, 2);
  f.readFailure(undefined); f.setQueue([poison('1')]); await f.restart();
  const changed = (await f.run()).sources[source.id];
  assert.notEqual(changed.fingerprint, first.fingerprint); assert.equal(changed.attemptCount, 1);
  assert.deepEqual(f.commits, []); assert.equal(f.api.writes, 0);
});


test('a genuinely changed RDF literal still prevents acknowledgement', async t => {
  const f = await fixture(t); f.api.normalize(); f.api.changeLiteral();
  assert.equal((await f.run()).sources[source.id].lastError, 'DKG_READBACK_MISMATCH');
  assert.deepEqual(f.commits, []);
});
