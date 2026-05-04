// Test-only helper. Production code never imports testcontainers.
//
// Brings up a single-broker Confluent Kafka via @testcontainers/kafka
// (KRaft mode for cp-kafka >= 8.x), and surfaces the broker bootstrap
// string as `host:mappedPort`.
//
// The image tag is duplicated in `test/fixtures/docker-compose.yml`. If you
// change one, change the other so manual debugging matches CI.

import { KafkaContainer, type StartedKafkaContainer } from '@testcontainers/kafka';

/**
 * Image used by the testcontainers helper AND by the
 * `test/fixtures/docker-compose.yml` manual-debug fixture. Keep them in sync.
 */
export const KAFKA_IMAGE = 'confluentinc/cp-kafka:7.5.0';

export interface PlaintextKafka {
  bootstrap: string;
  container: StartedKafkaContainer;
  stop(): Promise<void>;
}

export async function startPlaintextKafka(): Promise<PlaintextKafka> {
  const container = await new KafkaContainer(KAFKA_IMAGE).start();
  // The PLAINTEXT external listener is bound to container port 9093 by
  // @testcontainers/kafka. We map it onto a free host port at start time.
  const bootstrap = `${container.getHost()}:${container.getMappedPort(9093)}`;
  return {
    bootstrap,
    container,
    stop: () => container.stop(),
  };
}
