import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readKafka } from '../src/kafka.mjs';

// Only the broker transport is doubled here. Real broker + DKG lifecycle
// evidence remains in the opt-in broker.integration.mjs test.
const broker = vi.hoisted(() => ({ messages: [], stale: false, running: true }));
vi.mock('kafkajs', () => ({
  logLevel: { NOTHING: 0 },
  Kafka: class {
    constructor(config) { broker.config = config; }
    consumer(config) {
      broker.consumerConfig = config;
      broker.disconnect = vi.fn(async () => { await broker.batchTask; });
      broker.commit = vi.fn(async () => {});
      broker.resolveOffset = vi.fn();
      broker.unsubscribe = vi.fn();
      broker.subscribe = vi.fn(async () => {});
      return {
        events: { CRASH: 'crash' },
        on: (_event, listener) => { broker.crash = listener; return broker.unsubscribe; },
        connect: async () => { if (broker.error) throw new Error(broker.error); },
        subscribe: broker.subscribe,
        run: async options => {
          broker.runOptions = options;
          if (broker.messages.length) broker.batchTask = options.eachBatch({
            batch: { topic: 'test-topic', partition: 2, messages: broker.messages },
            heartbeat: async () => {}, resolveOffset: broker.resolveOffset,
            isStale: () => broker.stale, isRunning: () => broker.running,
          });
        },
        disconnect: broker.disconnect,
        commitOffsets: broker.commit,
      };
    }
  },
}));
const source = { brokers: ['test.example:9094'], groupId: 'isolated-test',
  topic: 'test-topic', readTimeoutMs: 5 };
const message = (offset = '0') => ({ offset, timestamp: '1700000000000',
  key: Buffer.from('key'), value: Buffer.from('value'),
  headers: { one: Buffer.from('one'), many: [Buffer.from('two'), Buffer.from('three')] } });

beforeEach(() => {
  Object.assign(broker, { messages: [], stale: false, running: true, error: undefined, batchTask: undefined });
});
afterEach(() => vi.unstubAllEnvs());

test('bounded delivery preserves bytes and commits the exact next offset only on request', async () => {
  broker.messages = [message('9007199254740993'), message('9007199254740994'), message('9007199254740995')];
  const delivery = await readKafka({ ...source, maxMessages: 2 });
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
  expect(broker.unsubscribe).toHaveBeenCalledOnce();
});

test('SASL credentials come from environment and TLS remains enabled', async () => {
  vi.stubEnv('KAFKA_TEST_USER', 'synthetic-user');
  vi.stubEnv('KAFKA_TEST_PASS', 'synthetic-password');
  const delivery = await readKafka({ ...source, saslMechanism: 'scram-sha-512',
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
  await expect(readKafka(secured)).rejects.toThrow('KAFKA_CREDENTIALS_REQUIRED');
  vi.stubEnv('KAFKA_TEST_USER', 'user'); vi.stubEnv('KAFKA_TEST_PASS', 'password');
  await expect(readKafka({ ...secured, ssl: false })).rejects.toThrow('KAFKA_SASL_REQUIRES_TLS');
});

test('stale or stopped delivery never acknowledges an offset', async () => {
  broker.messages = [message()];
  const delivery = await readKafka(source);
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
  const delivery = await readKafka({ ...source, maxBatchBytes: 300 });
  try {
    expect(delivery.records).toHaveLength(1);
    expect(delivery.records[0]).toMatchObject({ keyBase64: null, valueBase64: null });
  } finally { await delivery.close(); }
});

test('oversize records and broker errors close the connection without leaking details', async () => {
  broker.messages = [message()];
  await expect(readKafka({ ...source, maxBatchBytes: 1 })).rejects.toThrow('KAFKA_RECORD_TOO_LARGE');
  expect(broker.disconnect).toHaveBeenCalledOnce();
  broker.messages = []; broker.batchTask = undefined; broker.error = 'sensitive broker error';
  await expect(readKafka(source)).rejects.toThrow(/^KAFKA_READ_FAILED$/);
  expect(broker.disconnect).toHaveBeenCalledOnce();
});
