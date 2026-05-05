import { describe, expect, it } from 'vitest';
import {
  assertValidKafkaEndpointUri,
  buildKafkaEndpointUri,
  isValidKafkaEndpointUri,
} from '../src/uri.js';

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

describe('isValidKafkaEndpointUri', () => {
  // The validator is the first line of defence against SPARQL injection at
  // every URI interpolation site (route adapter + package SPARQL queries).
  // The shape is fully constrained by `buildKafkaEndpointUri`'s output:
  // `urn:dkg:kafka-endpoint:<owner>:<sha256-hex-64>`.

  it('accepts the canonical builder output (0xhex owner + 64 hex hash)', () => {
    const uri = buildKafkaEndpointUri({
      owner: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      broker: 'kafka.example.com:9092',
      topic: 'orders.created',
    });
    expect(isValidKafkaEndpointUri(uri)).toBe(true);
  });

  it('accepts owners with `.`, `_`, `-` (URN-safe punctuation)', () => {
    const hash = 'a'.repeat(64);
    expect(
      isValidKafkaEndpointUri(`urn:dkg:kafka-endpoint:bare-owner_1.0:${hash}`),
    ).toBe(true);
  });

  it('rejects non-string inputs', () => {
    expect(isValidKafkaEndpointUri(undefined as unknown as string)).toBe(false);
    expect(isValidKafkaEndpointUri(null as unknown as string)).toBe(false);
    expect(isValidKafkaEndpointUri(123 as unknown as string)).toBe(false);
  });

  it('rejects URIs without the `urn:dkg:kafka-endpoint:` prefix', () => {
    const hash = 'a'.repeat(64);
    expect(isValidKafkaEndpointUri(`urn:dkg:other:owner:${hash}`)).toBe(false);
    expect(isValidKafkaEndpointUri(`http://example.com/${hash}`)).toBe(false);
    expect(isValidKafkaEndpointUri('')).toBe(false);
  });

  it('rejects an empty owner segment', () => {
    const hash = 'a'.repeat(64);
    expect(isValidKafkaEndpointUri(`urn:dkg:kafka-endpoint::${hash}`)).toBe(false);
  });

  it('rejects a missing or wrong-length hash', () => {
    expect(
      isValidKafkaEndpointUri('urn:dkg:kafka-endpoint:owner:'),
    ).toBe(false);
    // 63 hex chars (one short)
    expect(
      isValidKafkaEndpointUri(`urn:dkg:kafka-endpoint:owner:${'a'.repeat(63)}`),
    ).toBe(false);
    // 65 hex chars (one over)
    expect(
      isValidKafkaEndpointUri(`urn:dkg:kafka-endpoint:owner:${'a'.repeat(65)}`),
    ).toBe(false);
  });

  it('rejects a hash with non-lowercase or non-hex chars', () => {
    expect(
      isValidKafkaEndpointUri(`urn:dkg:kafka-endpoint:owner:${'A'.repeat(64)}`),
    ).toBe(false);
    expect(
      isValidKafkaEndpointUri(`urn:dkg:kafka-endpoint:owner:${'g'.repeat(64)}`),
    ).toBe(false);
  });

  it('rejects every SPARQL-IRI-breaking character in the owner segment', () => {
    const hash = 'a'.repeat(64);
    // Sample of chars that break out of an `<…>` IRI position in SPARQL.
    for (const ch of ['>', '<', '"', '\\', '{', '}', '|', '^', '`', ' ', '\n', '\t', '\r', '\0']) {
      expect(
        isValidKafkaEndpointUri(`urn:dkg:kafka-endpoint:own${ch}er:${hash}`),
      ).toBe(false);
    }
  });

  it('rejects the canonical injection payload from the review brief', () => {
    // The review's worked example: a URI that closes the IRI early and
    // splices a UNION graph-pattern. The validator must reject before it
    // ever reaches a SPARQL interpolation site.
    const payload =
      'urn:dkg:kafka-endpoint:foo:bar> } UNION { ?ka <p> ?o BIND(<x';
    expect(isValidKafkaEndpointUri(payload)).toBe(false);
  });
});

describe('assertValidKafkaEndpointUri', () => {
  it('throws on invalid input', () => {
    expect(() => assertValidKafkaEndpointUri('not-a-uri')).toThrow(/invalid kafka endpoint uri/i);
  });

  it('returns the URI unchanged on valid input (handy for inline use)', () => {
    const hash = 'b'.repeat(64);
    const uri = `urn:dkg:kafka-endpoint:owner:${hash}`;
    expect(assertValidKafkaEndpointUri(uri)).toBe(uri);
  });
});
