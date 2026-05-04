import { describe, expect, it } from 'vitest';
import {
  KafkaEndpointProbeFailedError,
  registerKafkaEndpoint,
  toKafkaEndpointProbeOutcome,
} from '../src/endpoint.js';

interface CapturedPublish {
  contextGraphId: string;
  content: any;
}

function makePublisher() {
  const calls: CapturedPublish[] = [];
  const publisher = {
    async publish(contextGraphId: string, content: unknown) {
      calls.push({ contextGraphId, content });
      return { ual: 'did:dkg:test/1', kcId: '1', status: 'confirmed' as const };
    },
  };
  return { publisher, calls };
}

const BASE_INPUT = {
  contextGraphId: 'devnet-test',
  owner: '0xAbCDEFabcdefABCDEFabcdefABCDEFabcdefABCD',
  broker: 'kafka.example.com:9092',
  topic: 'orders.created',
  messageFormat: 'application/json',
  issuedAt: '2026-05-04T12:34:56.000Z',
};

const EXPECTED_URI =
  'urn:dkg:kafka-endpoint:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd:' +
  '33b58f60595c766739f72b29e4ee417888d1a46af8339a4b5bdb1c3a5692f652';

describe('registerKafkaEndpoint — slice-01 backwards compat', () => {
  it('publishes the Kafka endpoint KA into the named context graph', async () => {
    const { publisher, calls } = makePublisher();

    const result = await registerKafkaEndpoint({
      ...BASE_INPUT,
      publisher,
    });

    expect(result).toEqual({
      uri: EXPECTED_URI,
      contextGraphId: 'devnet-test',
      verificationStatus: 'unattempted',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      contextGraphId: 'devnet-test',
      content: {
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
        // Verification metadata always lands on the KA — `unattempted` is
        // the canonical no-probe value (see ADR 0002).
        'dkg:verificationStatus': 'unattempted',
      },
    });
  });

  it('falls back to "now" when issuedAt is omitted', async () => {
    // The default `issuedAt` is `new Date().toISOString()`. We assert the KA
    // carries a fresh, well-formed ISO-8601 timestamp without dictating the
    // exact moment — wall-clock equality is brittle.
    const { publisher, calls } = makePublisher();
    const before = new Date();

    const { issuedAt: _drop, ...inputWithoutIssuedAt } = BASE_INPUT;
    void _drop;
    const result = await registerKafkaEndpoint({
      ...inputWithoutIssuedAt,
      publisher,
    });

    expect(result.verificationStatus).toBe('unattempted');
    const ka = calls[0].content as Record<string, { '@value': string; '@type': string }>;
    const issued = ka['dct:issued'];
    expect(issued['@type']).toBe('xsd:dateTime');
    const issuedDate = new Date(issued['@value']);
    expect(Number.isNaN(issuedDate.getTime())).toBe(false);
    // The default branch must produce a timestamp at or after the moment we
    // entered the call. Allow 5 s of slack for slow CI clocks.
    expect(issuedDate.getTime()).toBeGreaterThanOrEqual(before.getTime() - 5_000);
  });
});

describe('registerKafkaEndpoint — opportunistic verification (ADR 0002)', () => {
  it('creds absent → no probe → status "unattempted", no verifiedAt; advertised securityProtocol still lands', async () => {
    const { publisher, calls } = makePublisher();

    const result = await registerKafkaEndpoint({
      ...BASE_INPUT,
      publisher,
      securityProtocol: 'PLAINTEXT',
      // probe omitted → caller did not supply credentials
    });

    expect(result.verificationStatus).toBe('unattempted');
    expect(result.verifiedAt).toBeUndefined();

    const ka = calls[0].content;
    expect(ka['dkg:verificationStatus']).toBe('unattempted');
    expect(ka['dkg:securityProtocol']).toBe('PLAINTEXT');
    expect(ka['dkg:verifiedAt']).toBeUndefined();
  });

  it('creds present + probe verified → status "verified", verifiedAt set to probedAt', async () => {
    const { publisher, calls } = makePublisher();

    const result = await registerKafkaEndpoint({
      ...BASE_INPUT,
      publisher,
      securityProtocol: 'SASL_SSL',
      probe: { status: 'verified', probedAt: '2026-05-04T12:35:00.000Z' },
    });

    expect(result).toMatchObject({
      verificationStatus: 'verified',
      verifiedAt: '2026-05-04T12:35:00.000Z',
    });

    const ka = calls[0].content;
    expect(ka['dkg:verificationStatus']).toBe('verified');
    expect(ka['dkg:verifiedAt']).toEqual({
      '@value': '2026-05-04T12:35:00.000Z',
      '@type': 'xsd:dateTime',
    });
    expect(ka['dkg:securityProtocol']).toBe('SASL_SSL');
  });

  it('creds present + probe verified + force=true → identical to force=false on success (force ignored)', async () => {
    // ADR 0002: `force` is only consulted when the probe did NOT verify. On a
    // successful probe, the flag is irrelevant — the resulting KA must be
    // bit-identical to the force=false verified case. Guards against a future
    // change that lets `force=true` mutate the recorded `verificationStatus`
    // when there's nothing to override.
    const { publisher, calls } = makePublisher();

    const result = await registerKafkaEndpoint({
      ...BASE_INPUT,
      publisher,
      securityProtocol: 'SASL_SSL',
      probe: { status: 'verified', probedAt: '2026-05-04T12:35:00.000Z' },
      force: true,
    });

    expect(result).toMatchObject({
      verificationStatus: 'verified',
      verifiedAt: '2026-05-04T12:35:00.000Z',
    });

    const ka = calls[0].content;
    expect(ka['dkg:verificationStatus']).toBe('verified');
    expect(ka['dkg:verifiedAt']).toEqual({
      '@value': '2026-05-04T12:35:00.000Z',
      '@type': 'xsd:dateTime',
    });
    expect(ka['dkg:securityProtocol']).toBe('SASL_SSL');
  });

  it('creds present + probe failed (no force) → throws KafkaEndpointProbeFailedError; no KA published', async () => {
    const { publisher, calls } = makePublisher();

    await expect(
      registerKafkaEndpoint({
        ...BASE_INPUT,
        publisher,
        securityProtocol: 'SASL_PLAINTEXT',
        probe: { status: 'failed', probedAt: '2026-05-04T12:36:00.000Z' },
      }),
    ).rejects.toBeInstanceOf(KafkaEndpointProbeFailedError);

    expect(calls).toHaveLength(0);
  });

  it('creds present + probe unreachable (no force) → throws; no KA published', async () => {
    const { publisher, calls } = makePublisher();

    await expect(
      registerKafkaEndpoint({
        ...BASE_INPUT,
        publisher,
        securityProtocol: 'SASL_PLAINTEXT',
        probe: { status: 'unreachable', probedAt: '2026-05-04T12:37:00.000Z' },
      }),
    ).rejects.toBeInstanceOf(KafkaEndpointProbeFailedError);

    expect(calls).toHaveLength(0);
  });

  it('creds present + probe failed + force=true → status "failed", verifiedAt set, KA published', async () => {
    const { publisher, calls } = makePublisher();

    const result = await registerKafkaEndpoint({
      ...BASE_INPUT,
      publisher,
      securityProtocol: 'SASL_PLAINTEXT',
      probe: { status: 'failed', probedAt: '2026-05-04T12:38:00.000Z' },
      force: true,
    });

    expect(result).toMatchObject({
      verificationStatus: 'failed',
      verifiedAt: '2026-05-04T12:38:00.000Z',
    });

    const ka = calls[0].content;
    expect(ka['dkg:verificationStatus']).toBe('failed');
    expect(ka['dkg:verifiedAt']).toEqual({
      '@value': '2026-05-04T12:38:00.000Z',
      '@type': 'xsd:dateTime',
    });
    expect(ka['dkg:securityProtocol']).toBe('SASL_PLAINTEXT');
  });

  it('creds present + probe unreachable + force=true → status "failed", KA published', async () => {
    const { publisher, calls } = makePublisher();

    const result = await registerKafkaEndpoint({
      ...BASE_INPUT,
      publisher,
      securityProtocol: 'SSL',
      probe: { status: 'unreachable', probedAt: '2026-05-04T12:39:00.000Z' },
      force: true,
    });

    // Both `failed` and `unreachable` collapse to the published
    // `verificationStatus: "failed"` value — the KA only records "we ran a
    // probe and it didn't verify". The granular distinction stays in the
    // log, not on the wire.
    expect(result.verificationStatus).toBe('failed');
    expect(calls).toHaveLength(1);
  });

  it('KA never includes raw credential fields under any branch', async () => {
    // Smoke check that `endpoint.register` doesn't accidentally pull a
    // credential field through from somewhere; the input type doesn't
    // accept one, but defence-in-depth doesn't hurt.
    const { publisher, calls } = makePublisher();
    await registerKafkaEndpoint({
      ...BASE_INPUT,
      publisher,
      securityProtocol: 'SASL_SSL',
      probe: { status: 'verified', probedAt: '2026-05-04T12:40:00.000Z' },
    });
    const blob = JSON.stringify(calls[0].content);
    expect(blob).not.toMatch(/password/i);
    expect(blob).not.toMatch(/username/i);
    expect(blob).not.toMatch(/BEGIN [A-Z ]+/);
  });
});

describe('toKafkaEndpointProbeOutcome', () => {
  it('passes through status and probedAt on a verified result (no error)', () => {
    expect(
      toKafkaEndpointProbeOutcome({
        status: 'verified',
        securityProtocol: 'SASL_SSL',
        probedAt: '2026-05-04T12:40:00.000Z',
      }),
    ).toEqual({
      status: 'verified',
      probedAt: '2026-05-04T12:40:00.000Z',
    });
  });

  it('includes the error field when the probe carries one', () => {
    expect(
      toKafkaEndpointProbeOutcome({
        status: 'failed',
        securityProtocol: 'PLAINTEXT',
        probedAt: '2026-05-04T12:41:00.000Z',
        error: 'KafkaJSProtocolError',
      }),
    ).toEqual({
      status: 'failed',
      probedAt: '2026-05-04T12:41:00.000Z',
      error: 'KafkaJSProtocolError',
    });
  });

  it('omits the error field when the probe result has no error string', () => {
    const out = toKafkaEndpointProbeOutcome({
      status: 'verified',
      securityProtocol: 'PLAINTEXT',
      probedAt: '2026-05-04T12:42:00.000Z',
    });
    expect('error' in out).toBe(false);
  });
});
