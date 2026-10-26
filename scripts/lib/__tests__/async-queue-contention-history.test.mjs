// Shape of the seeded share-queue history of the async queue contention benchmark (OT-RFC-73 P2a). Uses the real built dist: run pnpm run build:packages first.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { EXIT_REFUSED_BACKEND, loadDist, provenance, resolveEndpoint } from '../../repro/async-queue-contention/backend.mjs';
import { AGENT, CG_ID } from '../../repro/async-queue-contention/fixture.mjs';
import { historyBatches, historyJob, loadGenerated, loadSeedFile, parseCount, writeSeedFile } from '../../repro/async-queue-contention/history.mjs';

const BASE = 1_790_000_000_000;
let deps, dir;
before(async () => { deps = await loadDist(); dir = mkdtempSync(path.join(tmpdir(), 'aqc-history-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

const jobOf = (j, baseTime = BASE) => historyJob(j, { baseTime, formatVersion: deps.pub.ASYNC_PROMOTE_QUEUE_FORMAT_VERSION });
const quadsOf = (j, baseTime = BASE) => deps.utils.serializeJobRecord(jobOf(j, baseTime), deps.utils.DEFAULT_PROMOTE_CONTROL_GRAPH_URI).jobQuads;
const objectOf = (quads, predicate) => quads.find((q) => q.predicate === predicate).object;
const sha = (text) => createHash('sha256').update(text).digest('hex');

test('parseCount reads 10k, 50k and plain numbers', () => {
  assert.deepEqual(['0', '10k', '50K', '123'].map(parseCount), [0, 10_000, 50_000, 123]);
  assert.equal(parseCount(undefined), 0);
  assert.throws(() => parseCount('lots'), /not a count/);
});

test('historyJob: distinct keys, old enough, about 750 B, the real format version', () => {
  const jobs = Array.from({ length: 50 }, (_, j) => jobOf(j));
  assert.equal(new Set(jobs.map((j) => j.request.assertionName)).size, 50);
  assert.equal(new Set(jobs.map((j) => j.jobId)).size, 50);
  const keys = Array.from({ length: 50 }, (_, j) => objectOf(quadsOf(j), deps.utils.PROMOTE_UNIQUENESS_KEY));
  assert.equal(new Set(keys).size, 50);
  for (let j = 0; j < 50; j++) {
    assert.ok(jobs[j].enqueuedAt <= BASE - 3_600_000, 'at least an hour old');
    if (j > 0) assert.ok(jobs[j].enqueuedAt < jobs[j - 1].enqueuedAt, 'strictly decreasing');
    const len = JSON.stringify(jobs[j]).length;
    assert.ok(len >= 700 && len <= 800, `payload ${len} B`);
    assert.equal(jobs[j].formatVersion, deps.pub.ASYNC_PROMOTE_QUEUE_FORMAT_VERSION);
    assert.equal(jobs[j].state, 'succeeded');
    assert.deepEqual([jobs[j].request.contextGraphId, jobs[j].request.agentAddress], [CG_ID, AGENT]);
  }
});

test('the payload quad round-trips through the product classifier', () => {
  for (const j of [0, 1, 37]) {
    const verdict = deps.utils.classifyJobPayload(objectOf(quadsOf(j), deps.utils.PROMOTE_PAYLOAD));
    assert.equal(verdict.kind, 'job');
    assert.equal(verdict.job.jobId, jobOf(j).jobId);
  }
});

test('8 quads per job, ASCII N-Quads ending in a newline', () => {
  const batches = [...historyBatches(deps, 7, { baseTime: BASE, batchJobs: 3 })];
  assert.deepEqual(batches.map((b) => b.length), [24, 24, 8], 'batches of 3, 3 and 1 jobs');
  const text = `${deps.storage.quadsToNQuads(batches.flat())}\n`;
  assert.ok(text.endsWith('\n'));
  assert.equal(Buffer.byteLength(text), text.length, 'ASCII only');
  assert.equal(text.split('\n').length - 1, 56);
  assert.ok(batches.flat().every((q) => q.graph === deps.utils.DEFAULT_PROMOTE_CONTROL_GRAPH_URI));
});

test('the history is deterministic given (jobs, baseTime)', () => {
  const hash = (baseTime) => sha(deps.storage.quadsToNQuads([...historyBatches(deps, 5, { baseTime })].flat()));
  assert.equal(hash(BASE), hash(BASE));
  assert.notEqual(hash(BASE), hash(BASE + 1));
});

test('writeSeedFile writes the manifest and the bytes it hashes, plain and gzipped', async () => {
  const jobs = 12;
  const plain = await writeSeedFile(deps, { jobs, baseTime: BASE, path: path.join(dir, 'seed.nq') });
  const gz = await writeSeedFile(deps, { jobs, baseTime: BASE, path: path.join(dir, 'seed.nq.gz') });
  for (const m of [plain, gz]) {
    assert.deepEqual([m.schema, m.kind, m.jobs, m.quads, m.baseTime, m.formatVersion], [1, 'share', jobs, jobs * 8, BASE, deps.pub.ASYNC_PROMOTE_QUEUE_FORMAT_VERSION]);
    assert.equal(m.graph, deps.utils.DEFAULT_PROMOTE_CONTROL_GRAPH_URI);
  }
  assert.equal(plain.sha256, gz.sha256);
  const raw = readFileSync(path.join(dir, 'seed.nq'));
  assert.equal(sha(raw), plain.sha256);
  assert.equal(raw.length, plain.bytes);
  assert.equal(sha(gunzipSync(readFileSync(path.join(dir, 'seed.nq.gz')))), plain.sha256);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'seed.nq.json'), 'utf8')), plain);
  assert.equal(typeof plain.git.dirty === 'boolean' || plain.git.sha === null, true);
});

test('loadSeedFile posts line-aligned N-Quads chunks that add up to the file', async () => {
  const jobs = 20;
  await writeSeedFile(deps, { jobs, baseTime: BASE, path: path.join(dir, 'load.nq.gz') });
  const posts = [];
  const server = createServer((req, res) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => { posts.push({ type: req.headers['content-type'], body: Buffer.concat(parts).toString('utf8') }); res.end('ok'); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/bigdata/namespace/x/sparql`;
    const result = await loadSeedFile(url, path.join(dir, 'load.nq.gz'), { chunkBytes: 20_000 });
    assert.ok(result.chunks > 2, `${result.chunks} chunks`);
    assert.equal(result.quads, jobs * 8);
    assert.ok(posts.every((p) => p.type === 'text/x-nquads' && p.body.endsWith('\n') && p.body.length <= 20_000 + 1500));
    assert.equal(posts.map((p) => p.body).join(''), gunzipSync(readFileSync(path.join(dir, 'load.nq.gz'))).toString('utf8'));
  } finally { server.close(); }
});

test('loadSeedFile reports a rejected load', async () => {
  const server = createServer((req, res) => { req.resume(); res.statusCode = 400; res.end('bad quads'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(loadSeedFile(`http://127.0.0.1:${server.address().port}/s`, path.join(dir, 'seed.nq')), /HTTP 400 bad quads/);
  } finally { server.close(); }
});

test('loadGenerated inserts every batch with at most two in flight', async () => {
  let inflight = 0, peak = 0;
  const inserted = [];
  const store = { async insert(quads, options) { inflight++; peak = Math.max(peak, inflight); await new Promise((r) => setTimeout(r, 5)); inflight--; inserted.push({ n: quads.length, source: options.source }); } };
  const result = await loadGenerated(store, deps, { jobs: 6000, baseTime: BASE });
  assert.equal(result.jobs, 6000);
  assert.deepEqual(inserted.map((i) => i.n).sort((x, y) => x - y), [8000, 20_000, 20_000], 'batches of 2500, 2500 and 1000 jobs');
  assert.ok(inserted.every((i) => i.source === 'bench.seedHistory'));
  assert.equal(peak, 2);
});

test('resolveEndpoint refuses anything that is not a loopback http(s) URL unless told otherwise', () => {
  const ok = 'http://127.0.0.1:19554/bigdata/namespace/kb/sparql';
  assert.equal(resolveEndpoint({ url: ok }), ok);
  assert.equal(resolveEndpoint({ url: 'http://localhost:9999/bigdata/namespace/kb/sparql' }), 'http://localhost:9999/bigdata/namespace/kb/sparql');
  assert.equal(resolveEndpoint({ url: 'http://[::1]:9999/bigdata/namespace/kb/sparql' }), 'http://[::1]:9999/bigdata/namespace/kb/sparql');
  for (const url of ['http://blazegraph.example.org:9999/bigdata/namespace/kb/sparql', 'http://10.1.2.3:9999/x', 'ftp://127.0.0.1/x', 'not a url']) {
    assert.throws(() => resolveEndpoint({ url }), (e) => e.exitCode === EXIT_REFUSED_BACKEND, url);
  }
  assert.equal(resolveEndpoint({ url: 'http://10.1.2.3:9999/x', allowRemote: true }), 'http://10.1.2.3:9999/x');
  assert.throws(() => resolveEndpoint({ url: undefined }), /BLAZEGRAPH_TEST_URL/);
});

test('provenance hashes the script bytes and records the DKG_STORE_ environment', () => {
  const file = path.join(dir, 'a.mjs');
  writeFileSync(file, 'one');
  const first = provenance([file]);
  writeFileSync(file, 'two');
  const second = provenance([file]);
  assert.match(first.scriptSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(first.scriptSha256, second.scriptSha256);
  assert.equal(second.node, process.version);
  assert.equal(typeof second.distStaleSuspected, 'boolean');
  assert.ok(Object.keys(second.env).every((k) => k.startsWith('DKG_STORE_')));
});
