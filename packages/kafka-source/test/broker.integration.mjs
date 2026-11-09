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
import { Journal } from '../src/journal.mjs';
import { createHash } from 'node:crypto';

if (!process.env.DKG_KAFKA_TEST_CONFIG) throw new Error('DKG_KAFKA_TEST_CONFIG required');
const config = JSON.parse(await readFile(process.env.DKG_KAFKA_TEST_CONFIG, 'utf8'));
const pollingOnly = process.argv.includes('--polling-only');
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
  let replayed = 0, tailRecovery = [], fairness;
  const iterations = [];
  if (!pollingOnly) {
    await producer.send({ topic: source.topic, messages: Array.from({ length: 5 }, (_, i) => ({
      partition: i % 2, key: `synthetic-${i}`, value: JSON.stringify({ exampleId: `SYNTHETIC-${i}\u000b\u001b`, value: i + 1 }),
      headers: { 'test-data': 'synthetic' },
    })) });
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
    tailRecovery = [];
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
    fairness = { boundedPolls: 2, partitionZeroStillBacklogged: true,
      committedNextOffsets: fairOffsets.map(({ partition, offset }) => ({ partition, offset })) };
  }
  // Real broker retention race: return a valid bounds snapshot, but truncate
  // its first record before the consumer fetches. Only this disposable topic
  // is affected. The production adapter and installed KafkaJS remain unchanged.
  const expiredTopic = `dkg-source-expired-${runId}`;
  await admin.createTopics({ topics: [{ topic: expiredTopic, numPartitions: 1, replicationFactor: 1 }], waitForLeaders: true });
  await producer.send({ topic: expiredTopic, messages: Array.from({ length: 3 }, (_, i) =>
    ({ partition: 0, value: JSON.stringify({ exampleId: `retention-${i}` }) })) });
  const expiredSource = { ...source, id: 'expired', topic: expiredTopic, groupId: expiredTopic, fromBeginning: false };
  const expiredCfg = { ...workerConfig, sources: [expiredSource], stateFile: join(directory, 'expired-state.json') };
  const expiredJournalPath = join(directory, `kafka-${hash(expiredSource.id).slice(0, 16)}.sqlite`);
  const seed = new Journal(expiredJournalPath, hash(expiredSource));
  seed.checkpoint(expiredTopic, 0, '0'); seed.close();
  await admin.setOffsets({ groupId: expiredTopic, topic: expiredTopic, partitions: [{ partition: 0, offset: '0' }] });
  const originalAdmin = Kafka.prototype.admin;
  let expiredSnapshot;
  const priorCreates = createRequests;
  try {
    Kafka.prototype.admin = function (...args) {
      const client = originalAdmin.apply(this, args);
      const fetchBounds = client.fetchTopicOffsets.bind(client);
      client.fetchTopicOffsets = async topic => {
        const snapshot = await fetchBounds(topic);
        if (topic === expiredTopic) {
          expiredSnapshot = snapshot;
          await admin.deleteTopicRecords({ topic, partitions: [{ partition: 0, offset: '1' }] });
        }
        return snapshot;
      };
      return client;
    };
    const sinkFactory = pollingOnly
      ? () => ({ ensure() { throw new Error('DKG_WRITE_FORBIDDEN_IN_POLLING_TEST'); } })
      : cfg => createDkgSink(cfg, requestFetch);
    const deps = await createHandler({ sinkFactory }).createSourceWorkerDeps({ config: expiredCfg });
    const state = await runSourceWorkerOnce([expiredSource], expiredCfg.stateFile,
      { ...deps, now: () => new Date().toISOString(), getJobStatus() { throw new Error('Unexpected publisher'); } });
    assert.equal(state.sources.expired.lastStatus, 'failed');
    assert.equal(state.sources.expired.lastError, 'KAFKA_OFFSET_OUT_OF_RANGE');
  } finally { Kafka.prototype.admin = originalAdmin; }
  const retainedBounds = await admin.fetchTopicOffsets(expiredTopic);
  assert.equal(expiredSnapshot[0].low, '0'); assert.equal(retainedBounds[0].low, '1');
  const expiredOffsets = (await admin.fetchOffsets({ groupId: expiredTopic, topics: [expiredTopic] }))[0].partitions;
  assert.equal(expiredOffsets[0].offset, '0', 'fetch failure must not commit the latest/reset sentinel');
  assert.equal(createRequests, priorCreates);
  const retainedJournal = new Journal(expiredJournalPath, hash(expiredSource));
  try {
    assert.equal(retainedJournal.startPosition(expiredTopic, 0, '3'), '0');
    assert.equal(retainedJournal.db.prepare('SELECT COUNT(*) AS n FROM scheduling').get().n, 0);
  } finally { retainedJournal.close(); }
  const fetchExpiration = { boundsBeforeFetch: expiredSnapshot[0].low, lowAtFetch: retainedBounds[0].low,
    lastError: 'KAFKA_OFFSET_OUT_OF_RANGE', brokerCommittedOffset: expiredOffsets[0].offset,
    brokerOffsetBeforeFetch: '0', journalNextOffset: '0', newKAs: createRequests - priorCreates, partitionMarkedDone: false };

  const delayedTopic = `dkg-source-delayed-${runId}`;
  await admin.createTopics({ topics: [{ topic: delayedTopic, numPartitions: 1, replicationFactor: 1 }], waitForLeaders: true });
  await producer.send({ topic: delayedTopic, messages: [{ value: JSON.stringify({ exampleId: 'delayed-join' }) }] });
  const delayedSource = { ...source, id: 'delayed', topic: delayedTopic, groupId: delayedTopic, readTimeoutMs: 20 };
  const delayedCfg = { ...workerConfig, sources: [delayedSource], stateFile: join(directory, 'delayed-state.json') };
  const originalConsumer = Kafka.prototype.consumer;
  let startupDelayMs;
  try {
    Kafka.prototype.consumer = function (...args) {
      const consumer = originalConsumer.apply(this, args);
      const run = consumer.run.bind(consumer);
      consumer.run = async (...options) => {
        const start = Date.now();
        await new Promise(resolve => setTimeout(resolve, 80));
        await run(...options);
        startupDelayMs = Date.now() - start;
      };
      return consumer;
    };
    if (pollingOnly) {
      // Verify delivery without manufacturing a DKG receipt or acknowledging it.
      const journal = new Journal(join(directory, 'delayed-polling.sqlite'), hash(delayedSource));
      try {
        const delivery = await readKafka(delayedSource, journal);
        try { assert.equal(delivery.records.length, 1); assert.equal(delivery.records[0].offset, '0'); }
        finally { await delivery.close(); }
        assert.equal(journal.db.prepare('SELECT COUNT(*) AS n FROM scheduling').get().n, 0);
      } finally { journal.close(); }
    } else {
      const deps = await createHandler().createSourceWorkerDeps({ config: delayedCfg });
      const state = await runSourceWorkerOnce([delayedSource], delayedCfg.stateFile,
        { ...deps, now: () => new Date().toISOString(), getJobStatus() { throw new Error('Unexpected publisher'); } });
      assert.equal(state.sources.delayed.lastStatus, 'completed');
      assert.equal(state.sources.delayed.kafka.processed, 1);
    }
    assert.ok(startupDelayMs >= 80);
  } finally { Kafka.prototype.consumer = originalConsumer; }
  const delayedOffsets = (await admin.fetchOffsets({ groupId: delayedTopic, topics: [delayedTopic] }))[0].partitions;
  assert.equal(delayedOffsets[0].offset, pollingOnly ? '-1' : '1');
  const delayedJoin = { startupDelayMs, readTimeoutMs: delayedSource.readTimeoutMs,
    delivered: 1, acknowledged: !pollingOnly, brokerCommittedOffset: delayedOffsets[0].offset, emptyStartupReported: false };

  const sourceFilesSha256 = hash(await Promise.all(['asset.mjs', 'dkg-sink.mjs', 'handler.mjs', 'journal.mjs', 'kafka.mjs']
    .map(async path => [path, await readFile(resolve('src', path), 'utf8')])));
  const kafkaJsPatchSha256 = createHash('sha256').update(await readFile(resolve('../../patches/kafkajs@2.2.4.patch'))).digest('hex');
  const proof = { sourceFilesSha256, kafkaJsPatchSha256, pollingOnly, fetchExpiration, delayedJoin, verifiedAt: new Date().toISOString(), nativeSourceWorker: native,
    broker: 'real local Kafka-compatible broker', dkg: pollingOnly ? 'not invoked; no graph writes' : 'real HTTP lifecycle on an isolated mock-chain node',
    contextGraphId: source.contextGraphId, messages: pollingOnly ? 0 : 5, partitions: 2, distinctKAs: pollingOnly ? 0 : 5,
    tailRecovery, fairness, nativeRdfControlCharacters: pollingOnly ? null : true,
    replayedWithoutNewKAs: replayed, lostResponseRecovered: pollingOnly ? null : !loseFirstCreateResponse,
    failedOffsetCommitRecovered: pollingOnly ? null : !failFirstCommit, iterations, receipts,
    sourceStateFile: workerConfig.stateFile, sourceDefinition: source };
  await writeFile(join(directory, 'worker.private.json'), JSON.stringify({ ...workerConfig,
    handlerModule: resolve('src/handler.mjs'), pollIntervalMs: 5000 }), { mode: 0o600 });
  const proofPath = process.env.DKG_KAFKA_PROOF ?? join(directory, 'proof.json');
  await writeFile(proofPath, JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ proofPath, pollingOnly, distinctKAs: proof.distinctKAs, replayedWithoutNewKAs: replayed, tailRecovery, fairness, fetchExpiration, delayedJoin }));
} finally {
  await producer.disconnect(); await admin.disconnect();
}
