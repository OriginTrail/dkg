import { test } from 'vitest';
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
  const fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/api/context-graph/list') return Response.json({contextGraphs: [{id: source.contextGraphId, accessPolicy: 'private'}]});
    if (path === '/api/query') {
      const graph = JSON.parse(options.body).sparql.match(/GRAPH <([^>]+)>/)[1];
      const asset = [...assets.values()].find(a => graph.endsWith('/' + hash(a)));
      return Response.json({ result: { type: 'quads', quads: corrupt ? [] : asset?.quads ?? [] } });
    }
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      assert.equal(body.finalize, true);
      assert.equal(body.alsoShareSwm, false);
      assert.equal(body.alsoPublishVm, false);
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
      assertionGraph: `did:dkg:context-graph:${source.contextGraphId}/_working_memory/${owner}/${hash(asset)}` });
  };
  return { fetch, assets, get writes() { return writes; }, lose() { loseResponse = true; },
    corrupt() { corrupt = true; }, invisible() { invisible = true; } };
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dkg-kafka-source-test-'));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const config = { sources: [source], stateFile: join(dir, 'source-state.json'), daemonUrl: 'http://localhost:9200', daemonToken: 'test' };
  const api = daemon();
  let queue = [message()], commits = [], closed = 0, rejectCommit = false;
  const read = async () => ({ records: queue, async commit(record) {
    if (rejectCommit) throw new Error('KAFKA_COMMIT_FAILED');
    commits.push(record.offset);
  }, async close() { closed++; } });
  const hooks = await createHandler({ read, sinkFactory: () => createDkgSink(config, api.fetch) })
    .createSourceWorkerDeps({ config });
  const run = () => runSourceWorkerOnce([source], config.stateFile,
    { ...hooks, now: () => new Date().toISOString(), getJobStatus() { throw new Error('No chain publisher permitted'); } });
  return { config, api, run, setQueue(records) { queue = records; },
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
  await assert.rejects(f.run(), /KAFKA_RECORD_CHANGED/);
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
  await assert.rejects(sink.ensure(source, buildAsset(source, message()), {}, {}), /DKG_PRIVATE_GRAPH_REQUIRED/);
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
