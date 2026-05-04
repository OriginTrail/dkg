import { buildKafkaEndpointKnowledgeAsset } from './ka-builder.js';
import { buildKafkaEndpointUri } from './uri.js';

export interface KafkaEndpointPublisher {
  publish(contextGraphId: string, content: unknown): Promise<unknown>;
}

export interface RegisterKafkaEndpointInput {
  contextGraphId: string;
  owner: string;
  broker: string;
  topic: string;
  messageFormat: string;
  issuedAt?: string;
  publisher: KafkaEndpointPublisher;
}

export interface RegisterKafkaEndpointResult {
  uri: string;
  contextGraphId: string;
}

export async function registerKafkaEndpoint(
  input: RegisterKafkaEndpointInput,
): Promise<RegisterKafkaEndpointResult> {
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const uri = buildKafkaEndpointUri(input);
  const knowledgeAsset = buildKafkaEndpointKnowledgeAsset({
    owner: input.owner,
    broker: input.broker,
    topic: input.topic,
    messageFormat: input.messageFormat,
    issuedAt,
  });

  await input.publisher.publish(input.contextGraphId, { public: knowledgeAsset });

  return {
    uri,
    contextGraphId: input.contextGraphId,
  };
}
