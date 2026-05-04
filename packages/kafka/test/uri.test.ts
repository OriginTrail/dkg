import { describe, expect, it } from 'vitest';
import { buildKafkaEndpointUri } from '../src/uri.js';

describe('buildKafkaEndpointUri', () => {
  it('builds a deterministic URN from owner, broker, and topic', () => {
    expect(
      buildKafkaEndpointUri({
        owner: '0xAbCDEFabcdefABCDEFabcdefABCDEFabcdefABCD',
        broker: 'Kafka.EXAMPLE.com:9092',
        topic: 'orders.created',
      }),
    ).toBe(
      'urn:dkg:kafka-endpoint:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd:' +
      '33b58f60595c766739f72b29e4ee417888d1a46af8339a4b5bdb1c3a5692f652',
    );
  });

  it('changes the URN when the topic changes', () => {
    const left = buildKafkaEndpointUri({
      owner: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      broker: 'kafka.example.com:9092',
      topic: 'orders.created',
    });

    const right = buildKafkaEndpointUri({
      owner: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      broker: 'kafka.example.com:9092',
      topic: 'orders.updated',
    });

    expect(left).not.toBe(right);
  });

  it('normalizes broker and owner casing before hashing', () => {
    const left = buildKafkaEndpointUri({
      owner: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      broker: 'kafka.example.com:9092',
      topic: 'orders.created',
    });

    const right = buildKafkaEndpointUri({
      owner: '0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD',
      broker: 'KAFKA.EXAMPLE.COM:9092',
      topic: 'orders.created',
    });

    expect(left).toBe(right);
  });
});
