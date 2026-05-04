import { buildKafkaEndpointKnowledgeAsset } from './ka-builder.js';
import { buildKafkaEndpointUri } from './uri.js';

/**
 * Dependency-inversion boundary: the kafka package needs something that can
 * publish a JSON-LD knowledge asset. The package hands the bare KA across this
 * interface; envelope wrapping (e.g. `{ public: ... }`) belongs to the caller.
 */
export type KafkaEndpointKnowledgeAsset = ReturnType<typeof buildKafkaEndpointKnowledgeAsset>;

export interface KafkaEndpointPublisher {
  publish(
    contextGraphId: string,
    knowledgeAsset: KafkaEndpointKnowledgeAsset,
  ): Promise<unknown>;
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

  await input.publisher.publish(input.contextGraphId, knowledgeAsset);

  return {
    uri,
    contextGraphId: input.contextGraphId,
  };
}
