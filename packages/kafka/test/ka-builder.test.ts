import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildKafkaEndpointKnowledgeAsset } from '../src/ka-builder.js';

describe('buildKafkaEndpointKnowledgeAsset', () => {
  it('builds the full Kafka endpoint KA shape with verification metadata', async () => {
    const actual = buildKafkaEndpointKnowledgeAsset({
      owner: '0xAbCDEFabcdefABCDEFabcdefABCDEFabcdefABCD',
      broker: 'kafka.example.com:9092',
      topic: 'orders.created',
      messageFormat: 'application/json',
      issuedAt: '2026-05-04T12:34:56.000Z',
      verificationStatus: 'verified',
      verifiedAt: '2026-05-04T12:35:00.000Z',
      securityProtocol: 'SASL_SSL',
    });

    const fixtureUrl = new URL('./fixtures/endpoint-ka.json', import.meta.url);
    const expected = JSON.parse(await readFile(fixtureUrl, 'utf8'));

    expect(actual).toEqual(expected);
  });

  it('omits verification metadata when no probe-related fields are passed (slice-01 shape)', () => {
    const actual = buildKafkaEndpointKnowledgeAsset({
      owner: '0xAbCDEFabcdefABCDEFabcdefABCDEFabcdefABCD',
      broker: 'kafka.example.com:9092',
      topic: 'orders.created',
      messageFormat: 'application/json',
      issuedAt: '2026-05-04T12:34:56.000Z',
    });

    expect(actual).not.toHaveProperty('dkg:verificationStatus');
    expect(actual).not.toHaveProperty('dkg:verifiedAt');
    expect(actual).not.toHaveProperty('dkg:securityProtocol');
  });

  it('emits verificationStatus and securityProtocol but omits verifiedAt when probe did not run', () => {
    const actual = buildKafkaEndpointKnowledgeAsset({
      owner: '0xAbCDEFabcdefABCDEFabcdefABCDEFabcdefABCD',
      broker: 'kafka.example.com:9092',
      topic: 'orders.created',
      messageFormat: 'application/json',
      issuedAt: '2026-05-04T12:34:56.000Z',
      verificationStatus: 'unattempted',
      securityProtocol: 'PLAINTEXT',
    });

    expect((actual as Record<string, unknown>)['dkg:verificationStatus']).toBe('unattempted');
    expect((actual as Record<string, unknown>)['dkg:securityProtocol']).toBe('PLAINTEXT');
    expect(actual).not.toHaveProperty('dkg:verifiedAt');
  });

  it('emits verifiedAt as a typed xsd:dateTime literal', () => {
    const actual = buildKafkaEndpointKnowledgeAsset({
      owner: '0xAbCDEFabcdefABCDEFabcdefABCDEFabcdefABCD',
      broker: 'kafka.example.com:9092',
      topic: 'orders.created',
      messageFormat: 'application/json',
      issuedAt: '2026-05-04T12:34:56.000Z',
      verificationStatus: 'failed',
      verifiedAt: '2026-05-04T12:35:00.000Z',
      securityProtocol: 'SASL_PLAINTEXT',
    });

    expect((actual as Record<string, unknown>)['dkg:verifiedAt']).toEqual({
      '@value': '2026-05-04T12:35:00.000Z',
      '@type': 'xsd:dateTime',
    });
  });
});
