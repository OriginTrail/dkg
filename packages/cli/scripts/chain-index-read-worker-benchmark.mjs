#!/usr/bin/env node
// Local-only benchmark. Build CLI + workspace dependencies first, then run:
// node --expose-gc packages/cli/scripts/chain-index-read-worker-benchmark.mjs
// Optional: CHAIN_INDEX_BENCH_CAPTURE=/path/to/captured-sqlite-rows.jsonl
// CHAIN_INDEX_BENCH_COUNTS=35963,359630 CHAIN_INDEX_BENCH_SAMPLES=100 CHAIN_INDEX_BENCH_COLD_SAMPLES=5
// CHAIN_INDEX_BENCH_OUTPUT=/tmp/worker-benchmark.json
// Captures are never copied into the repository. All SQLite fixtures are temporary.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, get } from 'node:http';
import { cpus, platform, arch, tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { serialize } from 'node:v8';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { Interface } from 'ethers';
import { DashboardDB, SqliteChainEventLogStore } from '@origintrail-official/dkg-node-ui';
import { ChainIndexReadWorker } from '../dist/daemon/worker/chain-index-read-worker.js';

const counts = (process.env.CHAIN_INDEX_BENCH_COUNTS ?? '35963,359630').split(',').map(Number);
const samples = Number(process.env.CHAIN_INDEX_BENCH_SAMPLES ?? 100);
const coldSamples = Number(process.env.CHAIN_INDEX_BENCH_COLD_SAMPLES ?? 5);
assert(counts.length > 0 && counts.every((count) => Number.isSafeInteger(count) && count > 1));
assert(Number.isSafeInteger(samples) && samples > 0);
assert(Number.isSafeInteger(coldSamples) && coldSamples > 0);
const capturePath = process.env.CHAIN_INDEX_BENCH_CAPTURE;
const abi = new Interface(JSON.parse(readFileSync(new URL('../../chain/abi/ContextGraphStorage.json', import.meta.url), 'utf8')));
const registrationTopic = abi.getEvent('KnowledgeAssetRegisteredToContextGraph').topicHash.toLowerCase();
const scope = 'local-chain-index-worker-benchmark';
const hash = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`;
const address = `0x${'12'.repeat(20)}`;

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return { samples: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95),
    p99Ms: percentile(0.99), maxMs: sorted.at(-1) };
}

async function* capturedRows(path) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    yield {
      blockNumber: row.block_number, blockHash: row.block_hash, logIndex: row.log_index,
      transactionHash: row.tx_hash, address: row.address,
      topics: [row.topic0, row.topic1, row.topic2, row.topic3].filter((topic) => typeof topic === 'string' && topic.length > 0),
      data: row.data, settled: row.settled === 1,
    };
  }
}

async function* generatedRows(count) {
  const created = abi.encodeEventLog(abi.getEvent('ContextGraphCreated'), [
    1n, address, hash(1), [], 0n, 0, 0, address, 0n,
  ]);
  yield { blockNumber: 1, blockHash: hash(1), logIndex: 0, transactionHash: hash(1),
    address, topics: created.topics, data: created.data, settled: true };
  // A single large graph deliberately stresses ordinal materialization. KA IDs
  // remain unique uint256 values, encoded exactly like the indexed event ABI.
  for (let i = 1; i < count; i++) {
    yield { blockNumber: 1 + Math.floor(i / 100), blockHash: hash(1 + Math.floor(i / 100)),
      logIndex: i % 100, transactionHash: hash(i + 1), address,
      topics: [registrationTopic, hash(1), hash(i)], data: '0x', settled: true };
  }
}

async function seed(store, rows) {
  let revision;
  let count = 0;
  let minBlock = Infinity;
  let maxBlock = 0;
  let chunk = [];
  let storageAddress;
  const points = [];
  const graphs = new Map();
  const emitters = new Set();
  const commit = async () => {
    if (chunk.length === 0) return;
    const now = Date.now();
    revision = await store.commit(scope, revision, {
      cursor: { lineage: hash(1), deploymentBlockNumber: minBlock,
        settledBlockNumber: maxBlock, settledBlockHash: hash(maxBlock),
        head: { number: maxBlock, hash: hash(maxBlock), timestampSeconds: Math.floor(now / 1000), fetchedAtMs: now },
        topicSetVersion: 'local-benchmark-v1' },
      rows: chunk,
      coverage: [...emitters].flatMap((emitter) => ['context-graph-authority', 'context-graph-ka'].map((family) => ({
        family, address: emitter, coveredFromBlock: minBlock, coveredThroughBlock: maxBlock, floorBlock: minBlock,
      }))),
    });
    assert(revision !== undefined, 'fixture commit failed');
    chunk = [];
  };
  for await (const row of rows) {
    count++;
    minBlock = Math.min(minBlock, row.blockNumber);
    maxBlock = Math.max(maxBlock, row.blockNumber);
    emitters.add(row.address);
    if (row.topics[0] === registrationTopic) {
      storageAddress ??= row.address;
      assert.equal(row.address, storageAddress, 'benchmark supports one ContextGraphStorage emitter');
      const graph = row.topics[1];
      graphs.set(graph, (graphs.get(graph) ?? 0) + 1);
      if (points.length < samples) points.push({ kaId: BigInt(row.topics[2]), contextGraphId: BigInt(graph) });
    }
    chunk.push(row);
    if (chunk.length === 1_000) await commit();
  }
  await commit();
  assert(points.length > 0, 'fixture contains no KA registrations');
  const [largestGraph, registrationsInLargestGraph] = [...graphs].sort((a, b) => b[1] - a[1])[0];
  return { count, storageAddress, points, graphId: BigInt(largestGraph),
    graphCount: graphs.size, registrationsInLargestGraph, minBlock, maxBlock };
}

function containsArray(value) {
  if (Array.isArray(value)) return true;
  return value !== null && typeof value === 'object' && Object.values(value).some(containsArray);
}

function createClient(dbPath, store, modelOptions, boundary, diagnostics) {
  const client = new ChainIndexReadWorker(dbPath, {
    load: (key) => { boundary.mainStateLoads++; return store.load(key); },
    readEvents: () => { boundary.mainHistoryReads++; throw new Error('history read on main thread'); },
  }, {
    onDiagnostic: (event) => diagnostics.push(event),
    workerFactory: () => {
      const worker = new Worker(new URL('../dist/daemon/worker/chain-index-read-worker-entry.js', import.meta.url), {
        workerData: { dbPath }, resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
      worker.on('message', (message) => {
        boundary.responses++;
        boundary.maxResponseBytes = Math.max(boundary.maxResponseBytes, serialize(message).byteLength);
        if (containsArray(message)) boundary.responsesWithArrays++;
        if ('rows' in message || 'history' in message) boundary.responsesWithHistory++;
      });
      return worker;
    },
  });
  return { client, model: client.createReadModel(modelOptions) };
}

async function pointRead(model, point) {
  const start = performance.now();
  const answer = await model.readContextGraphForKa(point.kaId, { view: 'latest' });
  const duration = performance.now() - start;
  if (answer !== undefined) assert.equal(answer.contextGraphId, point.contextGraphId);
  return { duration, served: answer !== undefined };
}

function healthRequest(port) {
  const start = performance.now();
  return new Promise((resolve) => {
    const request = get({ hostname: '127.0.0.1', port, path: '/health' }, (response) => {
      response.resume();
      response.on('end', () => resolve({ duration: performance.now() - start, ok: response.statusCode === 200 }));
    });
    request.setTimeout(500, () => request.destroy(new Error('health timeout')));
    request.on('error', () => resolve({ duration: performance.now() - start, ok: false }));
  });
}

async function mixedReadResponsiveness(model, fixture, diagnostics) {
  const health = [];
  const httpPending = [];
  const server = createServer((_request, response) => { response.writeHead(200); response.end('ok'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const poll = () => httpPending.push(healthRequest(port).then((sample) => health.push(sample)));
  const timer = setInterval(poll, 20);
  poll();
  await delay(40);
  const start = performance.now();
  const firstDiagnostic = diagnostics.length;
  const ordinalPending = [];
  const readOrdinal = () => ordinalPending.push(model.readContextGraphKaAt(
    fixture.graphId, BigInt(fixture.registrationsInLargestGraph - 1), { view: 'latest' },
  ));
  readOrdinal();
  const ordinalTimer = setInterval(readOrdinal, 50);
  try {
    const points = [];
    // Keep sending indexed requests while the worker captures/decodes the bulk
    // snapshot. Refusals are counted as RPC fallbacks; this script makes no RPC.
    for (let i = 0; i < samples; i++) {
      points.push(pointRead(model, fixture.points[i % fixture.points.length]));
      await delay(5);
    }
    clearInterval(ordinalTimer);
    const [ordinalAnswers, pointAnswers] = await Promise.all([Promise.all(ordinalPending), Promise.all(points)]);
    await delay(50);
    clearInterval(timer);
    await Promise.all(httpPending);
    const mixedDiagnostics = diagnostics.slice(firstDiagnostic);
    const ordinalDiagnostics = mixedDiagnostics.filter((event) => event.method === 'ordinal');
    return {
      durationMs: performance.now() - start,
      pointLatency: summary(pointAnswers.map((answer) => answer.duration)),
      pointsServed: pointAnswers.filter((answer) => answer.served).length,
      pointFallbacks: pointAnswers.filter((answer) => !answer.served).length,
      ordinalsRequested: ordinalAnswers.length,
      ordinalsServed: ordinalAnswers.filter((answer) => answer !== undefined).length,
      ordinalFallbacks: ordinalAnswers.filter((answer) => answer === undefined).length,
      ordinalLatency: summary(ordinalDiagnostics.map((event) => event.durationMs)),
      ordinalReasons: [...new Set(ordinalDiagnostics.map((event) => event.reason))],
      ordinalRowsRead: [...new Set(ordinalDiagnostics.map((event) => event.rowsRead))],
      healthLatency: summary(health.map((sample) => sample.duration)),
      healthFailures: health.filter((sample) => !sample.ok).length,
      eventLoopDelayMs: { p50: loop.percentile(50) / 1e6, p95: loop.percentile(95) / 1e6,
        p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 },
    };
  } finally {
    clearInterval(timer);
    clearInterval(ordinalTimer);
    await Promise.all(httpPending);
    loop.disable();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runCase(count, captured) {
  const directory = mkdtempSync(join(tmpdir(), 'dkg-chain-index-worker-bench-'));
  const dashboard = new DashboardDB({ dataDir: directory });
  const store = new SqliteChainEventLogStore(dashboard);
  const boundary = { responses: 0, maxResponseBytes: 0, responsesWithArrays: 0,
    responsesWithHistory: 0, mainStateLoads: 0, mainHistoryReads: 0 };
  const diagnostics = [];
  let warmClient;
  try {
    const setupStarted = performance.now();
    const fixture = await seed(store, captured ? capturedRows(capturePath) : generatedRows(count));
    const setupMs = performance.now() - setupStarted;
    global.gc?.();
    const modelOptions = { scope, contextGraphStorageAddress: fixture.storageAddress,
      contextGraphStorageAbi: abi.formatJson(), maxHeadAgeMs: 300_000 };
    const dbPath = join(directory, 'node-ui.db');
    const cold = [];
    let coldServed = 0;
    for (let i = 0; i < coldSamples; i++) {
      const { client, model } = createClient(dbPath, store, modelOptions, boundary, diagnostics);
      try {
        const answer = await pointRead(model, fixture.points[i % fixture.points.length]);
        if (answer.served) coldServed++;
        cold.push(answer.duration);
      } finally { await client.close(); }
      console.error(`${captured ? 'captured' : 'generated'} ${fixture.count}: cold ${i + 1}/${coldSamples}`);
    }
    const { client, model } = createClient(dbPath, store, modelOptions, boundary, diagnostics);
    warmClient = client;
    const warmUpDeadline = Date.now() + 12_000;
    while (!(await pointRead(model, fixture.points[0])).served) {
      assert(Date.now() < warmUpDeadline, 'worker failed to become ready for warm reads');
      await delay(20);
    }
    const warm = [];
    for (let i = 0; i < samples; i++) {
      const answer = await pointRead(model, fixture.points[i % fixture.points.length]);
      assert(answer.served, 'warm point read unexpectedly refused');
      warm.push(answer.duration);
    }
    const pointDiagnostics = [...diagnostics];
    const servedPointDiagnostics = pointDiagnostics.filter((event) => event.reason === 'served');
    assert(servedPointDiagnostics.every((event) => event.method === 'binding' && event.rowsRead === 1),
      'indexed point lookup did not select exactly one registration');
    console.error(JSON.stringify({ phase: 'point-reads', fixture: captured ? 'captured' : 'generated-single-graph',
      rows: fixture.count, cold: summary(cold), coldServed, coldFallbacks: coldSamples - coldServed,
      warm: summary(warm) }));
    const mixed = await mixedReadResponsiveness(model, fixture, diagnostics);
    await client.close();
    warmClient = undefined;
    assert.equal(boundary.mainHistoryReads, 0);
    assert.equal(boundary.responsesWithArrays, 0, 'historical array crossed worker boundary');
    assert.equal(boundary.responsesWithHistory, 0, 'historical rows crossed worker boundary');
    return { fixture: captured ? 'captured' : 'generated-single-graph', rows: fixture.count,
      graphCount: fixture.graphCount, registrationsInLargestGraph: fixture.registrationsInLargestGraph,
      setupMs, cold: summary(cold), coldServed, coldFallbacks: coldSamples - coldServed, warm: summary(warm),
      indexedPointRowsRead: [...new Set(servedPointDiagnostics.map((event) => event.rowsRead))],
      mixed, boundary };
  } finally {
    await warmClient?.close();
    dashboard.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const report = {
  capturedAt: new Date().toISOString(),
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(new URL('../../..', import.meta.url)), encoding: 'utf8' }).trim(),
  machine: { cpu: cpus()[0]?.model, platform: platform(), arch: arch(), node: process.version },
  builtArtifactSha256: Object.fromEntries([
    '../dist/daemon/worker/chain-index-read-worker.js',
    '../dist/daemon/worker/chain-index-read-worker-entry.js',
    '../dist/daemon/worker/chain-index-read-worker-handler.js',
    '../dist/daemon/worker/chain-index-read-worker-protocol.js',
    '../../node-ui/dist/chain-event-log-store.js',
    '../../chain/dist/chain-index/knowledge-asset-read-model.js',
    '../../chain/dist/chain-index/knowledge-asset-read-model-snapshot.js',
    '../../chain/dist/chain-index/knowledge-asset-read-contract.js',
    '../../chain/dist/internal/chain-index-worker.js',
  ].map((path) => [path, createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex')])),
  configuration: { counts, samples, coldSamples, workerTimeoutMs: 1500, workerHeapMb: 256,
    captureSha256: capturePath ? createHash('sha256').update(readFileSync(capturePath)).digest('hex') : undefined },
  methodology: 'Cold = a fresh worker per read; warm = one ready worker, sequential reads. OS file cache is not flushed. Fixture setup is excluded. Synthetic fixture is one graph to stress bulk reads. HTTP is local /health; refusals are counted without calling any RPC.',
  cases: [],
};
for (const [index, count] of counts.entries()) {
  const result = await runCase(count, index === 0 && capturePath !== undefined);
  report.cases.push(result);
  // Preserve completed cases even if a later native-addon regression aborts
  // the process before JavaScript can run its cleanup/final output.
  if (process.env.CHAIN_INDEX_BENCH_OUTPUT) {
    writeFileSync(process.env.CHAIN_INDEX_BENCH_OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.error(JSON.stringify(result));
}
const json = `${JSON.stringify(report, null, 2)}\n`;
if (process.env.CHAIN_INDEX_BENCH_OUTPUT) writeFileSync(process.env.CHAIN_INDEX_BENCH_OUTPUT, json);
console.log(json);
