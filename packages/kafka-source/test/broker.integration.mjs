// Opt-in integration: real Kafka broker + real DKG lifecycle HTTP endpoints.
// The caller provisions an isolated private Context Graph and supplies its
// daemon URL/token/agent in a mode-0600 JSON file; there are no customer defaults.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runSourceWorkerOnce } from '../../agent/src/source-worker.ts';
import { Kafka, logLevel } from 'kafkajs';
import { createHandler } from '../src/handler.mjs';
import { createDkgSink } from '../src/dkg-sink.mjs';
import { readKafka } from '../src/kafka.mjs';
import { hash } from '../src/asset.mjs';

if (!process.env.DKG_KAFKA_TEST_CONFIG) throw new Error('DKG_KAFKA_TEST_CONFIG required');
const config = JSON.parse(await readFile(process.env.DKG_KAFKA_TEST_CONFIG, 'utf8'));
const native = resolve('../agent/src/source-worker.ts');
const directory = await mkdtemp(join(tmpdir(), 'dkg-kafka-integration-'));
const runId = Date.now().toString(36);
const source = { id: 'kafka-integration', kind: 'kafka', clusterId: 'local-kafka-poc',
  brokers: config.brokers, topic: `dkg-source-poc-${runId}`, groupId: `dkg-source-poc-${runId}`,
  ssl: false, fromBeginning: true, maxMessages: 2, maxBatchBytes: 24000, readTimeoutMs: 5000,
  agentAddress: config.agentAddress, contextGraphId: config.contextGraphId,
  mapping: [{ field: 'exampleId', predicate: 'https://example.com/test/exampleId' }] };
const workerConfig = { ...config, sources: [source], stateFile: join(directory, 'source-state.json') };
const kafka = new Kafka({ brokers: config.brokers, logLevel: logLevel.NOTHING });
const admin = kafka.admin();
const producer = kafka.producer({ allowAutoTopicCreation: false });
const receipts = [];
let createRequests = 0, loseFirstCreateResponse = true, failFirstCommit = true;
const requestFetch = async (url, options) => {
  const response = await fetch(url, options);
  if (options.method === 'POST' && new URL(url).pathname === '/api/knowledge-assets') {
    createRequests++;
    if (loseFirstCreateResponse && response.ok) {
      loseFirstCreateResponse = false;
      await response.arrayBuffer();
      throw new Error('simulated lost response after real DKG write');
    }
  }
  return response;
};
const hooks = await createHandler({ sinkFactory: cfg => createDkgSink(cfg, requestFetch),
  read: async (src, journal) => {
    const delivery = await readKafka(src, journal);
    return { ...delivery, async commit(record) {
      if (failFirstCommit) { failFirstCommit = false; throw new Error('KAFKA_COMMIT_FAILED'); }
      return delivery.commit(record);
    } };
  },
}).createSourceWorkerDeps({ config: workerConfig });

try {
  await admin.connect();
  await admin.createTopics({ topics: [{ topic: source.topic, numPartitions: 2, replicationFactor: 1 }], waitForLeaders: true });
  await producer.connect();
  await producer.send({ topic: source.topic, messages: Array.from({ length: 5 }, (_, i) => ({
    partition: i % 2, key: `synthetic-${i}`, value: JSON.stringify({ exampleId: `SYNTHETIC-${i}\u000b\u001b`, value: i + 1 }),
    headers: { 'test-data': 'synthetic' },
  })) });
  const iterations = [];
  for (let i = 0; i < 10; i++) {
    const state = await runSourceWorkerOnce([source], workerConfig.stateFile,
      { ...hooks, now: () => new Date().toISOString(), getJobStatus() { throw new Error('No chain publisher expected'); } });
    const result = state.sources[source.id];
    iterations.push({ status: result.lastStatus, error: result.lastError,
      processed: result.kafka?.processed, created: result.kafka?.created, reused: result.kafka?.reused });
    if (result.lastStatus === 'completed') receipts.push(...result.kafka.receipts);
    if (result.lastStatus === 'failed' && result.lastError !== 'KAFKA_COMMIT_FAILED')
      throw new Error(result.lastError);
    if (receipts.length === 5) break;
  }
  assert.equal(receipts.length, 5);
  assert.equal(new Set(receipts.map(receipt => receipt.name)).size, 5);
  assert.equal(createRequests, 5, 'recovery must not create another KA');
  const offsets = await admin.fetchOffsets({ groupId: source.groupId, topics: [source.topic] });
  assert.deepEqual(offsets[0].partitions.map(p => p.offset).sort(), ['2', '3']);
  // Broker replay with the SAME handler identity and journal must reuse all KAs.
  await admin.setOffsets({ groupId: source.groupId, topic: source.topic,
    partitions: [{ partition: 0, offset: '0' }, { partition: 1, offset: '0' }] });
  let replayed = 0;
  for (let i = 0; i < 12 && replayed < 5; i++) {
    const state = await runSourceWorkerOnce([source], workerConfig.stateFile,
      { ...hooks, now: () => new Date().toISOString(), getJobStatus() { throw new Error('Unexpected publisher'); } });
    const result = state.sources[source.id];
    if (result.lastStatus === 'no-matching-rows') continue;
    assert.equal(result.lastStatus, 'completed');
    assert.equal(result.kafka.created, 0);
    replayed += result.kafka.reused;
  }
  assert.equal(replayed, 5); assert.equal(createRequests, 5);
  const tailRecovery = [];
  for (const failure of ['write', 'commit']) {
    const topic = `dkg-source-tail-${failure}-${runId}`;
    await admin.createTopics({ topics: [{ topic, numPartitions: 1, replicationFactor: 1 }], waitForLeaders: true });
    const tail = { ...source, id: `tail-${failure}`, topic, groupId: topic, fromBeginning: false };
    const cfg = { ...workerConfig, sources: [tail], stateFile: join(directory, `${failure}-state.json`) };
    let failNext = true;
    const postCount = createRequests;
    const invoke = async () => {
      // Rebuild the handler each iteration: only disk journal + broker survive.
      const deps = await createHandler({
        sinkFactory: settings => {
          const sink = createDkgSink(settings, requestFetch);
          return { async ensure(...args) {
            if (failure === 'write' && failNext) { failNext = false; throw new Error('DKG_TEST_WRITE_FAILED'); }
            return sink.ensure(...args);
          } };
        },
        read: async (definition, journal) => {
          const delivery = await readKafka(definition, journal);
          return { ...delivery, async commit(record) {
            if (failure === 'commit' && failNext) { failNext = false; throw new Error('KAFKA_COMMIT_FAILED'); }
            return delivery.commit(record);
          } };
        },
      }).createSourceWorkerDeps({ config: cfg });
      const state = await runSourceWorkerOnce([tail], cfg.stateFile,
        { ...deps, now: () => new Date().toISOString(), getJobStatus() { throw new Error('Unexpected publisher'); } });
      return state.sources[tail.id];
    };
    const send = value => producer.send({ topic, messages: [{ partition: 0, value: JSON.stringify({ exampleId: value }) }] });
    await send('before-first-poll');
    assert.equal((await invoke()).lastStatus, 'no-matching-rows');
    assert.equal((await admin.fetchOffsets({ groupId: topic, topics: [topic] }))[0].partitions[0].offset, '-1');
    await send('first-delivery\u000b\u001b');
    assert.equal((await invoke()).lastStatus, 'failed');
    assert.equal((await admin.fetchOffsets({ groupId: topic, topics: [topic] }))[0].partitions[0].offset, '-1');
    await send('after-failure');
    const recovered = await invoke();
    assert.equal(recovered.lastStatus, 'completed');
    assert.equal(recovered.kafka.processed, 2);
    assert.equal(createRequests - postCount, 2);
    assert.equal((await admin.fetchOffsets({ groupId: topic, topics: [topic] }))[0].partitions[0].offset, '3');
    tailRecovery.push({ failure, firstPollEmpty: true, brokerOffsetAbsentDuringFailure: true,
      restartRecoveredOffsets: ['1', '2'], distinctKAs: 2, createRequests: createRequests - postCount,
      reusedAfterFailure: recovered.kafka.reused });
  }
  const fairTopic = `dkg-source-fair-${runId}`;
  await admin.createTopics({ topics: [{ topic: fairTopic, numPartitions: 2, replicationFactor: 1 }], waitForLeaders: true });
  await producer.send({ topic: fairTopic, messages: [
    ...Array.from({ length: 8 }, (_, i) => ({ partition: 0, value: JSON.stringify({ exampleId: `busy-${i}` }) })),
    { partition: 1, value: JSON.stringify({ exampleId: 'waiting-partition' }) },
  ] });
  const fairSource = { ...source, id: 'fair', topic: fairTopic, groupId: fairTopic, maxMessages: 1 };
  const fairCfg = { ...workerConfig, sources: [fairSource], stateFile: join(directory, 'fair-state.json') };
  for (let i = 0; i < 2; i++) {
    // Keep partition zero supplied while verifying bounded progress of one.
    await producer.send({ topic: fairTopic, messages: [{ partition: 0, value: JSON.stringify({ exampleId: `new-${i}` }) }] });
    const deps = await createHandler().createSourceWorkerDeps({ config: fairCfg });
    const state = await runSourceWorkerOnce([fairSource], fairCfg.stateFile,
      { ...deps, now: () => new Date().toISOString(), getJobStatus() { throw new Error('Unexpected publisher'); } });
    assert.equal(state.sources.fair.lastStatus, 'completed');
  }
  const fairOffsets = (await admin.fetchOffsets({ groupId: fairTopic, topics: [fairTopic] }))[0].partitions;
  assert.deepEqual(fairOffsets.map(entry => entry.offset), ['1', '1']);
  const fairness = { boundedPolls: 2, partitionZeroStillBacklogged: true,
    committedNextOffsets: fairOffsets.map(({ partition, offset }) => ({ partition, offset })) };
  const sourceFilesSha256 = hash(await Promise.all(['asset.mjs', 'dkg-sink.mjs', 'handler.mjs', 'journal.mjs', 'kafka.mjs']
    .map(async path => [path, await readFile(resolve('src', path), 'utf8')])));
  const proof = { sourceFilesSha256, verifiedAt: new Date().toISOString(), nativeSourceWorker: native,
    broker: 'real local Kafka-compatible broker', dkg: 'real HTTP lifecycle on an isolated mock-chain node',
    contextGraphId: source.contextGraphId, messages: 5, partitions: 2, distinctKAs: 5,
    tailRecovery, fairness, nativeRdfControlCharacters: true,
    replayedWithoutNewKAs: replayed, lostResponseRecovered: !loseFirstCreateResponse,
    failedOffsetCommitRecovered: !failFirstCommit, iterations, receipts,
    sourceStateFile: workerConfig.stateFile, sourceDefinition: source };
  await writeFile(join(directory, 'worker.private.json'), JSON.stringify({ ...workerConfig,
    handlerModule: resolve('src/handler.mjs'), pollIntervalMs: 5000 }), { mode: 0o600 });
  const proofPath = process.env.DKG_KAFKA_PROOF ?? join(directory, 'proof.json');
  await writeFile(proofPath, JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ proofPath, messages: 5, distinctKAs: 5, replayedWithoutNewKAs: 5, tailRecovery, fairness }));
} finally {
  await producer.disconnect(); await admin.disconnect();
}
