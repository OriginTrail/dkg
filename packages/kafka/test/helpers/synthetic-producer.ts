// Test-only helper. Creates a topic on the broker and (optionally) produces a
// single message so the kafka-probe has something concrete to find via
// `fetchTopicMetadata`. The probe never reads message content; one message
// is sent purely to nudge `auto.create.topics.enable=true` semantics on the
// rare image where it matters.

import { Kafka, logLevel } from 'kafkajs';

export interface SyntheticProducerOptions {
  bootstrap: string;
  topic: string;
  /** Produce a single message after creating the topic. Defaults to true. */
  produce?: boolean;
}

export async function createTopicAndProduce(opts: SyntheticProducerOptions): Promise<void> {
  const kafka = new Kafka({
    clientId: 'synthetic-producer',
    brokers: [opts.bootstrap],
    logLevel: logLevel.NOTHING,
    retry: { retries: 2 },
  });
  const admin = kafka.admin();
  try {
    await admin.connect();
    await admin.createTopics({
      topics: [{ topic: opts.topic, numPartitions: 1, replicationFactor: 1 }],
      waitForLeaders: true,
    });
  } finally {
    await admin.disconnect();
  }

  if (opts.produce ?? true) {
    const producer = kafka.producer();
    try {
      await producer.connect();
      await producer.send({
        topic: opts.topic,
        messages: [{ value: 'synthetic' }],
      });
    } finally {
      await producer.disconnect();
    }
  }
}
