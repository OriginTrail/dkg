import { Kafka, logLevel } from 'kafkajs';

function encode(value) { return value === null ? null : Buffer.from(value).toString('base64'); }
function envelope(topic, partition, message) {
  return { topic, partition, offset: message.offset, timestamp: message.timestamp,
    keyBase64: encode(message.key), valueBase64: encode(message.value),
    headers: Object.fromEntries(Object.entries(message.headers ?? {}).map(([key, values]) =>
      [key, Array.isArray(values) ? values.map(encode) : encode(values)])),
    fetchedAt: new Date().toISOString() };
}

// One bounded delivery per DKG Source Worker iteration. Keep the group session
// alive while the handler writes/verifies DKG, then explicitly commit offsets.
export async function readKafka(source, journal) {
  const username = source.usernameEnv ? process.env[source.usernameEnv] : undefined;
  const password = source.passwordEnv ? process.env[source.passwordEnv] : undefined;
  if (source.saslMechanism && (!username || !password)) throw new Error('KAFKA_CREDENTIALS_REQUIRED');
  if (source.saslMechanism && source.ssl === false) throw new Error('KAFKA_SASL_REQUIRES_TLS');
  const kafka = new Kafka({ clientId: source.clientId ?? 'dkg-source-kafka', brokers: source.brokers,
    ssl: source.ssl ?? true,
    ...(source.saslMechanism ? { sasl: { mechanism: source.saslMechanism, username, password } } : {}),
    logLevel: logLevel.NOTHING, connectionTimeout: 5000, requestTimeout: 15000,
    retry: { retries: 1 } });
  const admin = kafka.admin();
  const starts = new Map();
  // Resolve a new group's tail once, durably, before opening its first poll.
  // There is deliberately no broker commit until DKG readback succeeds.
  try {
    await admin.connect();
    const bounds = await admin.fetchTopicOffsets(source.topic);
    const groups = await admin.fetchOffsets({ groupId: source.groupId, topics: [source.topic] });
    const committed = new Map((groups.find(group => group.topic === source.topic)?.partitions ?? [])
      .map(item => [item.partition, item.offset]));
    for (const item of bounds) {
      const brokerOffset = committed.get(item.partition) ?? '-1';
      const fallback = BigInt(brokerOffset) >= 0n ? brokerOffset : (source.fromBeginning ? item.low : item.high);
      let offset = journal.startPosition(source.topic, item.partition, fallback);
      // An explicit operator rewind is safe: exact KA readback deduplicates it.
      if (BigInt(brokerOffset) >= 0n && BigInt(brokerOffset) < BigInt(offset)) offset = brokerOffset;
      if (BigInt(offset) < BigInt(item.low) || BigInt(offset) > BigInt(item.high)) throw new Error('KAFKA_OFFSET_OUT_OF_RANGE');
      starts.set(item.partition, offset);
    }
  } catch (error) {
    throw new Error(/^KAFKA_[A-Z_]+$/.test(error.message) ? error.message : 'KAFKA_READ_FAILED');
  } finally { await admin.disconnect().catch(() => {}); }
  const consumer = kafka.consumer({ groupId: source.groupId, allowAutoTopicCreation: false,
    sessionTimeout: 60000, maxBytesPerPartition: 1024 * 1024 });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let finish, reject, selected = false, active;
  const ready = new Promise((resolve, fail) => { finish = resolve; reject = fail; });
  let delivered, acknowledged = 0;
  const close = async () => {
    release();
    await consumer.disconnect();
    if (delivered && acknowledged === delivered.length && target !== undefined) journal.partitionDone(source.topic, target);
  };
  let target;
  const offJoin = consumer.on(consumer.events.GROUP_JOIN, ({ payload }) => {
    if (selected) { active = undefined; return; }
    const assigned = payload.memberAssignment[source.topic] ?? [];
    if (assigned.some(partition => !starts.has(partition))) {
      reject(new Error('KAFKA_ASSIGNMENT_CHANGED'));
      return;
    }
    target = journal.selectPartition(source.topic, assigned);
    // Pick one assigned partition per poll in persisted round-robin order.
    // Pausing the others before fetching prevents a hot first batch winning
    // every reconnect. Empty partitions also advance the scheduling cursor.
    if (target !== undefined) consumer.resume([{ topic: source.topic, partitions: [target] }]);
    consumer.pause([{ topic: source.topic, partitions: assigned.filter(partition => partition !== target) }]);
    for (const partition of assigned) consumer.seek({ topic: source.topic, partition, offset: starts.get(partition) });
  });
  const off = consumer.on(consumer.events.CRASH, () => reject(new Error('KAFKA_CONSUMER_FAILED')));
  let timer;
  try {
    await consumer.connect();
    await consumer.subscribe({ topics: [source.topic], fromBeginning: source.fromBeginning ?? false });
    timer = setTimeout(() => finish([]), source.readTimeoutMs ?? 10000);
    await consumer.run({ autoCommit: false, eachBatchAutoResolve: false, partitionsConsumedConcurrently: 1,
      eachBatch: async ({ batch, heartbeat, resolveOffset, isStale, isRunning }) => {
        if (selected || batch.partition !== target || isStale() || !isRunning()) return;
        selected = true;
        const records = [];
        let bytes = 0;
        for (const message of batch.messages) {
          const item = envelope(batch.topic, batch.partition, message);
          const size = Buffer.byteLength(JSON.stringify(item));
          if (size > (source.maxBatchBytes ?? 24000)) {
            if (!records.length) reject(new Error('KAFKA_RECORD_TOO_LARGE'));
            break;
          }
          if (records.length && bytes + size > (source.maxBatchBytes ?? 24000)) break;
          records.push(item); bytes += size;
          if (records.length >= (source.maxMessages ?? 10)) break;
        }
        active = { resolveOffset, isStale, isRunning };
        clearTimeout(timer);
        finish(records);
        const pulse = setInterval(() => { void heartbeat().catch(() => { active = undefined; }); }, 1500);
        try { await held; } finally { clearInterval(pulse); }
      },
    });
    delivered = await ready;
    return {
      records: delivered,
      async commit(record) {
        if (!active || active.isStale() || !active.isRunning()) throw new Error('KAFKA_DELIVERY_STALE');
        await consumer.commitOffsets([{ topic: record.topic, partition: record.partition,
          offset: (BigInt(record.offset) + 1n).toString() }]);
        active.resolveOffset(record.offset);
        acknowledged++;
      },
      async close() { clearTimeout(timer); off(); offJoin(); await close(); },
    };
  } catch (error) {
    clearTimeout(timer); off(); offJoin(); await close().catch(() => {});
    // Never include broker errors that might echo credentials or payloads.
    throw new Error(/^KAFKA_[A-Z_]+$/.test(error.message) ? error.message : 'KAFKA_READ_FAILED');
  }
}
