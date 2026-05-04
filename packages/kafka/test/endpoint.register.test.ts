import { describe, expect, it } from 'vitest';
import { registerKafkaEndpoint } from '../src/endpoint.js';

describe('registerKafkaEndpoint', () => {
  it('publishes the Kafka endpoint KA into the named context graph', async () => {
    const calls: Array<{ contextGraphId: string; content: unknown }> = [];
    const publisher = {
      async publish(contextGraphId: string, content: unknown) {
        calls.push({ contextGraphId, content });
        return { ual: 'did:dkg:test/1', kcId: '1', status: 'confirmed' as const };
      },
    };

    const result = await registerKafkaEndpoint({
      contextGraphId: 'devnet-test',
      owner: '0xAbCDEFabcdefABCDEFabcdefABCDEFabcdefABCD',
      broker: 'kafka.example.com:9092',
      topic: 'orders.created',
      messageFormat: 'application/json',
      issuedAt: '2026-05-04T12:34:56.000Z',
      publisher,
    });

    expect(result).toEqual({
      uri: 'urn:dkg:kafka-endpoint:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd:' +
        '33b58f60595c766739f72b29e4ee417888d1a46af8339a4b5bdb1c3a5692f652',
      contextGraphId: 'devnet-test',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      contextGraphId: 'devnet-test',
      content: {
        public: {
          '@context': {
            dcat: 'http://www.w3.org/ns/dcat#',
            dct: 'http://purl.org/dc/terms/',
            dkg: 'https://ontology.dkg.io/dkg#',
            xsd: 'http://www.w3.org/2001/XMLSchema#',
          },
          '@id': result.uri,
          '@type': ['dkg:KafkaTopicEndpoint', 'dcat:DataService'],
          'dcat:endpointURL': {
            '@id': 'kafka://kafka.example.com:9092/orders.created',
          },
          'dkg:broker': 'kafka.example.com:9092',
          'dkg:topic': 'orders.created',
          'dkg:messageFormat': 'application/json',
          'dct:publisher': {
            '@id': 'urn:dkg:agent:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
          },
          'dct:issued': {
            '@value': '2026-05-04T12:34:56.000Z',
            '@type': 'xsd:dateTime',
          },
        },
      },
    });
  });
});
