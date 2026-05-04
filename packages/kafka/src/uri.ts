import { createHash } from 'node:crypto';

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

export function buildKafkaEndpointUri(identity: KafkaEndpointIdentity): string {
  const owner = identity.owner.toLowerCase();
  const hash = hashBrokerAndTopic(identity.broker, identity.topic);
  return `urn:dkg:kafka-endpoint:${owner}:${hash}`;
}
