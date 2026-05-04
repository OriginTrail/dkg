import { createHash } from 'node:crypto';

/**
 * Identity tuple for a Kafka topic endpoint URI: the (owner, broker, topic)
 * triple is what the URI uniquely names.
 */
export interface KafkaEndpointIdentity {
  owner: string;
  broker: string;
  topic: string;
}

function hashBrokerAndTopic(broker: string, topic: string): string {
  return createHash('sha256')
    .update(`${broker.toLowerCase()}|${topic}`)
    .digest('hex');
}

/**
 * Build the deterministic URI for a Kafka topic endpoint. Owner is
 * lowercased; (broker, topic) are sha256-hashed so the URI is stable across
 * topology rewrites and casing variations.
 */
export function buildKafkaEndpointUri(identity: KafkaEndpointIdentity): string {
  const owner = identity.owner.toLowerCase();
  const hash = hashBrokerAndTopic(identity.broker, identity.topic);
  return `urn:dkg:kafka-endpoint:${owner}:${hash}`;
}
