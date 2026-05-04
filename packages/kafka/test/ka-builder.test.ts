import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildKafkaEndpointKnowledgeAsset } from '../src/ka-builder.js';

describe('buildKafkaEndpointKnowledgeAsset', () => {
  it('builds the minimum Kafka endpoint KA shape', async () => {
    const actual = buildKafkaEndpointKnowledgeAsset({
      owner: '0xAbCDEFabcdefABCDEFabcdefABCDEFabcdefABCD',
      broker: 'kafka.example.com:9092',
      topic: 'orders.created',
      messageFormat: 'application/json',
      issuedAt: '2026-05-04T12:34:56.000Z',
    });

    const fixtureUrl = new URL('./fixtures/endpoint-ka.json', import.meta.url);
    const expected = JSON.parse(await readFile(fixtureUrl, 'utf8'));

    expect(actual).toEqual(expected);
  });
});
