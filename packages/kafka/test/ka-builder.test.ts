import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  buildKafkaEndpointKnowledgeAsset,
  buildKafkaEndpointRevocationMutation,
} from '../src/ka-builder.js';

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

describe('buildKafkaEndpointRevocationMutation', () => {
  it('produces the canonical revocation-mutation KA shape (golden)', async () => {
    const actual = buildKafkaEndpointRevocationMutation(
      'urn:dkg:kafka-endpoint:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd:33b58f60595c766739f72b29e4ee417888d1a46af8339a4b5bdb1c3a5692f652',
      '2026-05-05T09:30:00.000Z',
    );

    const fixtureUrl = new URL('./fixtures/endpoint-ka-revocation.json', import.meta.url);
    const expected = JSON.parse(await readFile(fixtureUrl, 'utf8'));

    expect(actual).toEqual(expected);
  });

  it('emits dkg:status "revoked" as a literal string', () => {
    const actual = buildKafkaEndpointRevocationMutation(
      'urn:dkg:kafka-endpoint:owner:hash',
      '2026-05-05T09:30:00.000Z',
    );

    expect((actual as Record<string, unknown>)['dkg:status']).toBe('revoked');
  });

  it('emits dkg:revokedAt as a typed xsd:dateTime literal', () => {
    const actual = buildKafkaEndpointRevocationMutation(
      'urn:dkg:kafka-endpoint:owner:hash',
      '2026-05-05T09:30:00.000Z',
    );

    expect((actual as Record<string, unknown>)['dkg:revokedAt']).toEqual({
      '@value': '2026-05-05T09:30:00.000Z',
      '@type': 'xsd:dateTime',
    });
  });

  it('uses the supplied URI as the @id (no normalization)', () => {
    const actual = buildKafkaEndpointRevocationMutation(
      'urn:dkg:kafka-endpoint:0xMixedCase:abc',
      '2026-05-05T09:30:00.000Z',
    );

    // The mutation builder is a presentation-layer helper; case-folding happens
    // upstream when the URI is minted. Round-trip parity with the original KA
    // matters more than re-applying owner normalisation here.
    expect((actual as Record<string, unknown>)['@id']).toBe('urn:dkg:kafka-endpoint:0xMixedCase:abc');
  });
});
