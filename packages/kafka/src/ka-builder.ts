import { buildKafkaEndpointUri } from './uri.js';

const KAFKA_ENDPOINT_CONTEXT = {
  dcat: 'http://www.w3.org/ns/dcat#',
  dct: 'http://purl.org/dc/terms/',
  dkg: 'https://ontology.dkg.io/dkg#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
} as const;

export interface BuildKafkaEndpointKnowledgeAssetInput {
  owner: string;
  broker: string;
  topic: string;
  messageFormat: string;
  issuedAt: string;
}

export interface KafkaEndpointKnowledgeAsset {
  '@context': typeof KAFKA_ENDPOINT_CONTEXT;
  '@id': string;
  '@type': readonly [string, string];
  'dcat:endpointURL': { '@id': string };
  'dkg:broker': string;
  'dkg:topic': string;
  'dkg:messageFormat': string;
  'dct:publisher': { '@id': string };
  'dct:issued': { '@value': string; '@type': 'xsd:dateTime' };
}

export function buildKafkaEndpointKnowledgeAsset(
  input: BuildKafkaEndpointKnowledgeAssetInput,
): KafkaEndpointKnowledgeAsset {
  const owner = input.owner.toLowerCase();

  return {
    '@context': KAFKA_ENDPOINT_CONTEXT,
    '@id': buildKafkaEndpointUri(input),
    '@type': ['dkg:KafkaTopicEndpoint', 'dcat:DataService'],
    'dcat:endpointURL': {
      '@id': `kafka://${input.broker}/${input.topic}`,
    },
    'dkg:broker': input.broker,
    'dkg:topic': input.topic,
    'dkg:messageFormat': input.messageFormat,
    'dct:publisher': {
      '@id': `urn:dkg:agent:${owner}`,
    },
    'dct:issued': {
      '@value': input.issuedAt,
      '@type': 'xsd:dateTime',
    },
  };
}
