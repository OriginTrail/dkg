import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readKafka } from '../src/kafka.mjs';
import { Journal } from '../src/journal.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { runSourceWorkerOnce } from '../../agent/src/source-worker.ts';
import { createHandler } from '../src/handler.mjs';
import { hash } from '../src/asset.mjs';
const require = createRequire(import.meta.url);
// Exercise the installed KafkaJS recovery path, not a replacement of its reset.
const ConsumerGroup = require('kafkajs/src/consumer/consumerGroup.js');
const OffsetManager = require('kafkajs/src/consumer/offsetManager');
const { KafkaJSOffsetOutOfRange } = require('kafkajs/src/errors');
async function expireFetch(autoOffsetReset, commits) {
  const group = Object.create(ConsumerGroup.prototype);
  Object.assign(group, { autoOffsetReset, preferredReadReplicasPerTopicPartition: {}, logger: { error() {} },
    offsetManager: new OffsetManager({ autoCommit: false, groupId: 'controlled-expiration',
      cluster: { defaultOffset: () => '-1', committedOffsets: () => ({ 'test-topic': { 2: '5' } }) },
      coordinator: { isConnected: () => true, offsetCommit: async request => { commits.push(request); } },
      memberAssignment: { 'test-topic': [2] }, topicConfigurations: { 'test-topic': { fromBeginning: false } },
      instrumentationEmitter: { emit() {} },
    }) });
  await group.recoverFromFetch(new KafkaJSOffsetOutOfRange({ message: 'expired after admin bounds', type: 'OFFSET_OUT_OF_RANGE', code: 1 },
    { topic: 'test-topic', partition: 2 }));
}
let journal, directory;
const read = source => readKafka(source, journal);

// Only the broker transport is doubled here. Real broker + DKG lifecycle
// evidence remains in the opt-in broker.integration.mjs test.
const broker = vi.hoisted(() => ({ messages: [], stale: false, running: true }));
vi.mock('kafkajs', () => ({
  logLevel: { NOTHING: 0 },
  Kafka: class {
    constructor(config) { broker.config = config; }
    admin() {
      return {
        connect: async () => { if (broker.error) throw new Error(broker.error); },
        disconnect: async () => {},
        fetchTopicOffsets: async () => broker.partitions.map(partition => ({ partition, low: '0',
          high: broker.high ?? '9223372036854775807' })),
        fetchOffsets: async () => [{ topic: 'test-topic', partitions: broker.partitions.map(partition =>
          ({ partition, offset: broker.committed.get(partition) ?? '-1' })) }],
      };
    }
    consumer(config) {
      broker.consumerConfig = config;
      broker.disconnect = vi.fn(async () => { await broker.batchTask; });
      broker.commit = vi.fn(async offsets => {
        if (broker.failCommit) throw new Error('simulated commit failure');
        for (const entry of offsets) broker.committed.set(entry.partition, entry.offset);
      });
      broker.resolveOffset = vi.fn();
      broker.unsubscribe = vi.fn();
      broker.subscribe = vi.fn(async () => {});
      const starts = new Map(); let paused = [];
      return {
        autoOffsetReset: broker.missingGuard ? undefined : config.autoOffsetReset,
        events: { CRASH: 'crash', GROUP_JOIN: 'group-join' },
        on: (event, listener) => {
          if (event === 'group-join') broker.join = listener;
          else broker.crash = listener;
          return broker.unsubscribe;
        },
        connect: async () => { if (broker.error) throw new Error(broker.error); },
        subscribe: broker.subscribe,
        pause: entries => { paused = entries[0].partitions; },
        resume: () => {},
        seek: ({ partition, offset }) => starts.set(partition, offset),
        run: async options => {
          broker.runOptions = options;
          if (broker.joinDelayMs) await new Promise(resolve => setTimeout(resolve, broker.joinDelayMs));
          broker.join({ payload: { memberAssignment: { 'test-topic': broker.partitions } } });
          if (broker.expireAfterBounds) {
            try { await expireFetch(config.autoOffsetReset, broker.resetCommits); }
            catch (error) { broker.crash({ payload: { error } }); }
            return;
          }
          for (const partition of broker.partitions) {
            if (paused.includes(partition)) continue;
            const messages = broker.messages.filter(message => (message.partition ?? 2) === partition &&
              BigInt(message.offset) >= BigInt(starts.get(partition)));
            if (messages.length) broker.batchTask = options.eachBatch({
              batch: { topic: 'test-topic', partition, messages },
              heartbeat: async () => {}, resolveOffset: broker.resolveOffset,
              isStale: () => broker.stale, isRunning: () => broker.running,
            });
          }
        },
        disconnect: broker.disconnect,
        commitOffsets: broker.commit,
      };
    }
  },
}));
const source = { brokers: ['test.example:9094'], groupId: 'isolated-test',
  topic: 'test-topic', readTimeoutMs: 5, fromBeginning: true };
const message = (offset = '0') => ({ offset, timestamp: '1700000000000',
  key: Buffer.from('key'), value: Buffer.from('value'),
  headers: { one: Buffer.from('one'), many: [Buffer.from('two'), Buffer.from('three')] } });

beforeEach(async () => {
  Object.assign(broker, { messages: [], stale: false, running: true, error: undefined, batchTask: undefined,
    partitions: [2], committed: new Map(), high: undefined, failCommit: false,
    joinDelayMs: 0, expireAfterBounds: false, resetCommits: [], missingGuard: false });
  directory = await mkdtemp(join(tmpdir(), 'kafka-transport-'));
  journal = new Journal(join(directory, 'journal.sqlite'), 'transport-test');
});
afterEach(async () => { vi.unstubAllEnvs(); journal.close(); await rm(directory, { recursive: true, force: true }); });

test('bounded delivery preserves bytes and commits the exact next offset only on request', async () => {
  broker.messages = [message('9007199254740993'), message('9007199254740994'), message('9007199254740995')];
  const delivery = await read({ ...source, maxMessages: 2 });
  try {
    expect(delivery.records).toHaveLength(2);
    expect(broker.runOptions.autoCommit).toBe(false);
    expect(broker.runOptions.eachBatchAutoResolve).toBe(false);
    expect(broker.consumerConfig.allowAutoTopicCreation).toBe(false);
    expect(broker.commit).not.toHaveBeenCalled();
    const record = delivery.records[0];
    expect(record).toMatchObject({ topic: source.topic, partition: 2,
      offset: '9007199254740993', keyBase64: 'a2V5', valueBase64: 'dmFsdWU=',
      headers: { one: 'b25l', many: ['dHdv', 'dGhyZWU='] } });
    await delivery.commit(record);
    expect(broker.commit).toHaveBeenCalledWith([{ topic: source.topic,
      partition: 2, offset: '9007199254740994' }]);
    expect(broker.resolveOffset).toHaveBeenCalledWith(record.offset);
  } finally { await delivery.close(); }
  expect(broker.disconnect).toHaveBeenCalledOnce();
  expect(broker.unsubscribe).toHaveBeenCalledTimes(2);
});

test('SASL credentials come from environment and TLS remains enabled', async () => {
  vi.stubEnv('KAFKA_TEST_USER', 'synthetic-user');
  vi.stubEnv('KAFKA_TEST_PASS', 'synthetic-password');
  const delivery = await read({ ...source, saslMechanism: 'scram-sha-512',
    usernameEnv: 'KAFKA_TEST_USER', passwordEnv: 'KAFKA_TEST_PASS', fromBeginning: true });
  try {
    expect(broker.config.ssl).toBe(true);
    expect(broker.config.sasl).toEqual({ mechanism: 'scram-sha-512',
      username: 'synthetic-user', password: 'synthetic-password' });
    expect(broker.subscribe).toHaveBeenCalledWith({ topics: [source.topic], fromBeginning: true });
    expect(delivery.records).toEqual([]);
  } finally { await delivery.close(); }
});

test('missing credentials and plaintext SASL fail before opening a connection', async () => {
  vi.stubEnv('KAFKA_TEST_USER', ''); vi.stubEnv('KAFKA_TEST_PASS', '');
  const secured = { ...source, saslMechanism: 'plain', usernameEnv: 'KAFKA_TEST_USER', passwordEnv: 'KAFKA_TEST_PASS' };
  await expect(read(secured)).rejects.toThrow('KAFKA_CREDENTIALS_REQUIRED');
  vi.stubEnv('KAFKA_TEST_USER', 'user'); vi.stubEnv('KAFKA_TEST_PASS', 'password');
  await expect(read({ ...secured, ssl: false })).rejects.toThrow('KAFKA_SASL_REQUIRES_TLS');
});

test('stale or stopped delivery never acknowledges an offset', async () => {
  broker.messages = [message()];
  const delivery = await read(source);
  try {
    broker.stale = true;
    await expect(delivery.commit(delivery.records[0])).rejects.toThrow('KAFKA_DELIVERY_STALE');
    broker.stale = false; broker.running = false;
    await expect(delivery.commit(delivery.records[0])).rejects.toThrow('KAFKA_DELIVERY_STALE');
    expect(broker.commit).not.toHaveBeenCalled();
  } finally { await delivery.close(); }
});

test('byte budget bounds a delivery and preserves Kafka tombstones', async () => {
  broker.messages = [{ ...message(), key: null, value: null }, message('1')];
  const delivery = await read({ ...source, maxBatchBytes: 300 });
  try {
    expect(delivery.records).toHaveLength(1);
    expect(delivery.records[0]).toMatchObject({ keyBase64: null, valueBase64: null });
  } finally { await delivery.close(); }
});

test('oversize records and broker errors close the connection without leaking details', async () => {
  broker.messages = [message()];
  await expect(read({ ...source, maxBatchBytes: 1 })).rejects.toThrow('KAFKA_RECORD_TOO_LARGE');
  expect(broker.disconnect).toHaveBeenCalledOnce();
  broker.messages = []; broker.batchTask = undefined; broker.error = 'sensitive broker error';
  await expect(read(source)).rejects.toThrow(/^KAFKA_READ_FAILED$/);
  expect(broker.disconnect).toHaveBeenCalledOnce();
});


test.each(['write', 'commit'])('new tail group resumes its first failed %s across a journal restart', async failure => {
  broker.high = '100';
  const tail = { ...source, fromBeginning: false };
  const empty = await read(tail); await empty.close();
  expect(broker.commit).not.toHaveBeenCalled();
  broker.high = '101'; broker.messages = [message('100')];
  const first = await read(tail);
  expect(first.records.map(record => record.offset)).toEqual(['100']);
  if (failure === 'commit') {
    broker.failCommit = true;
    await expect(first.commit(first.records[0])).rejects.toThrow('simulated commit failure');
  }
  await first.close();
  journal.close(); journal = new Journal(join(directory, 'journal.sqlite'), 'transport-test');
  broker.failCommit = false; broker.high = '102'; broker.messages.push(message('101'));
  const resumed = await read(tail);
  try {
    expect(resumed.records.map(record => record.offset)).toEqual(['100', '101']);
    for (const record of resumed.records) await resumed.commit(record);
    expect(broker.committed.get(2)).toBe('102');
  } finally { await resumed.close(); }
});

test('empty first tail poll retains records arriving between successive empty polls', async () => {
  broker.high = '100';
  const tail = { ...source, fromBeginning: false };
  for (let i = 0; i < 2; i++) { const delivery = await read(tail); await delivery.close(); }
  broker.high = '101'; broker.messages = [message('100')];
  const delivery = await read(tail);
  try { expect(delivery.records.map(record => record.offset)).toEqual(['100']); }
  finally { await delivery.close(); }
});

test('persisted round-robin advances another partition under continuous first-partition backlog', async () => {
  broker.partitions = [0, 1]; broker.high = '1000';
  broker.messages = [...Array.from({ length: 10 }, (_, i) => ({ ...message(String(i)), partition: 0 })),
    { ...message(), partition: 1 }];
  const seen = [];
  for (let i = 0; i < 4; i++) {
    const delivery = await read({ ...source, maxMessages: 1 });
    for (const record of delivery.records) { seen.push([record.partition, record.offset]); await delivery.commit(record);
      journal.checkpoint(record.topic, record.partition, (BigInt(record.offset) + 1n).toString()); }
    await delivery.close();
    journal.close(); journal = new Journal(join(directory, 'journal.sqlite'), 'transport-test');
  }
  expect(seen).toEqual([[0, '0'], [1, '0'], [0, '1']]);
  expect(broker.committed.get(0)).toBe('2'); expect(broker.committed.get(1)).toBe('1');
});

test('expired durable positions fail closed instead of accepting Kafka offset reset', async () => {
  journal.checkpoint(source.topic, 2, '100'); broker.high = '50';
  await expect(read(source)).rejects.toThrow('KAFKA_OFFSET_OUT_OF_RANGE');
});


test('installed KafkaJS makes fetch-time expiration non-retriable without a reset commit', async () => {
  const { Kafka, logLevel } = await vi.importActual('kafkajs');
  const kafka = new Kafka({ brokers: ['localhost:19092'], logLevel: logLevel.NOTHING });
  expect(kafka.consumer({ groupId: 'guard-check', autoOffsetReset: false }).autoOffsetReset).toBe(false);
  expect(kafka.consumer({ groupId: 'legacy-check' }).autoOffsetReset).toBe(true);
  const commits = [];
  await expect(expireFetch(false, commits)).rejects.toMatchObject({ message: 'KAFKA_OFFSET_OUT_OF_RANGE', retriable: false });
  expect(commits).toEqual([]);
  // Existing consumers retain the default behavior; only explicit opt-in changes.
  await expireFetch(true, commits);
  expect(commits).toHaveLength(1);
  expect(commits[0].topics[0].partitions).toEqual([{ partition: 2, offset: '-1' }]);
});

test('fetch expiration after accepted bounds persists source failure without resetting or advancing', async () => {
  broker.expireAfterBounds = true;
  const owner = '0x' + 'a'.repeat(40);
  const definition = { ...source, id: 'expiry', kind: 'kafka', clusterId: 'controlled-test',
    agentAddress: owner, contextGraphId: owner + '/expiry' };
  const stateFile = join(directory, 'worker.json');
  let writes = 0;
  const hooks = await createHandler({ sinkFactory: () => ({ ensure() { writes++; throw new Error('No write expected'); } }) })
    .createSourceWorkerDeps({ config: { sources: [definition], stateFile } });
  const state = await runSourceWorkerOnce([definition], stateFile,
    { ...hooks, now: () => new Date().toISOString(), getJobStatus() { throw new Error('No publisher expected'); } });
  expect(state.sources.expiry).toMatchObject({ lastStatus: 'failed', lastError: 'KAFKA_OFFSET_OUT_OF_RANGE', attemptCount: 1 });
  const saved = new Journal(join(directory, `kafka-${hash(definition.id).slice(0, 16)}.sqlite`), hash(definition));
  try {
    expect(saved.startPosition(source.topic, 2, '100')).toBe('0');
    expect(saved.db.prepare('SELECT * FROM scheduling').all()).toEqual([]);
    expect(saved.db.prepare('SELECT * FROM messages').all()).toEqual([]);
  } finally { saved.close(); }
  expect(writes).toBe(0); expect(broker.resetCommits).toEqual([]);
  expect(broker.commit).not.toHaveBeenCalled();
  expect(broker.disconnect).toHaveBeenCalledOnce();
});

test('an unpatched transport is refused before opening its consumer', async () => {
  broker.missingGuard = true;
  await expect(read(source)).rejects.toThrow('KAFKA_OFFSET_RESET_GUARD_REQUIRED');
  expect(broker.subscribe).not.toHaveBeenCalled();
  expect(broker.commit).not.toHaveBeenCalled();
});

test('queued records remain deliverable when every group join exceeds the read timeout', async () => {
  broker.joinDelayMs = 40;
  broker.messages = [message('0')];
  for (let i = 0; i < 3; i++) {
    const delivery = await read({ ...source, readTimeoutMs: 10 });
    expect(delivery.records.map(record => record.offset)).toEqual(['0']);
    expect(journal.db.prepare('SELECT * FROM scheduling').all()).toEqual([]);
    // No acknowledgement: even a completed startup cannot mark this batch done.
    await delivery.close();
  }
  expect(broker.commit).not.toHaveBeenCalled();
  expect(journal.db.prepare('SELECT * FROM scheduling').all()).toEqual([]);
});

test('an actually idle assigned partition starts its empty-poll budget after delayed startup', async () => {
  broker.joinDelayMs = 40;
  const delivery = await read({ ...source, readTimeoutMs: 10 });
  expect(delivery.records).toEqual([]);
  await delivery.close();
  expect(journal.db.prepare('SELECT lastPartition FROM scheduling').get().lastPartition).toBe(2);
  expect(broker.commit).not.toHaveBeenCalled();
});
