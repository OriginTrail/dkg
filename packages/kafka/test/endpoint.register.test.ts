import { describe, expect, it } from 'vitest';
import { registerKafkaEndpoint } from '../src/endpoint.js';

describe('registerKafkaEndpoint', () => {
  it('publishes the Kafka endpoint KA into the named context graph (shared scope)', async () => {
    const calls: Array<{ contextGraphId: string; content: unknown }> = [];
    const publisher = {
      async publish(contextGraphId: string, content: unknown) {
        calls.push({ contextGraphId, content });
        return { ual: 'did:dkg:test/1', kcId: '1', status: 'confirmed' as const };
      },
    };

    const result = await registerKafkaEndpoint({
      selection: { kind: 'shared', contextGraphId: 'devnet-test' },
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
      cgScope: 'shared',
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
      },
    });
  });

  it('publishes into the resolved local CG when selection.kind is "local"', async () => {
    const calls: Array<{ contextGraphId: string; content: unknown }> = [];
    const publisher = {
      async publish(contextGraphId: string, content: unknown) {
        calls.push({ contextGraphId, content });
        return { ual: 'did:dkg:test/1', kcId: '1', status: 'confirmed' as const };
      },
    };
    let ensureCalls = 0;
    const ensureLocalCg = async (): Promise<string> => {
      ensureCalls += 1;
      return 'kafka-local';
    };

    const result = await registerKafkaEndpoint({
      selection: { kind: 'local' },
      owner: '0xAbCDEFabcdefABCDEFabcdefABCDEFabcdefABCD',
      broker: 'kafka.example.com:9092',
      topic: 'orders.created',
      messageFormat: 'application/json',
      issuedAt: '2026-05-04T12:34:56.000Z',
      publisher,
      ensureLocalCg,
    });

    expect(ensureCalls).toBe(1);
    expect(result).toEqual({
      uri: 'urn:dkg:kafka-endpoint:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd:' +
        '33b58f60595c766739f72b29e4ee417888d1a46af8339a4b5bdb1c3a5692f652',
      contextGraphId: 'kafka-local',
      cgScope: 'local',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.contextGraphId).toBe('kafka-local');
  });

  it('throws when selection.kind is "local" but ensureLocalCg is not provided', async () => {
    const publisher = {
      async publish() {
        return { ual: 'did:dkg:test/1', kcId: '1', status: 'confirmed' as const };
      },
    };

    await expect(
      registerKafkaEndpoint({
        selection: { kind: 'local' },
        owner: '0xAbCDEFabcdefABCDEFabcdefABCDEFabcdefABCD',
        broker: 'kafka.example.com:9092',
        topic: 'orders.created',
        messageFormat: 'application/json',
        publisher,
      }),
    ).rejects.toThrow(/ensureLocalCg/);
  });

  it('defaults issuedAt to "now" when caller omits it', async () => {
    const calls: Array<{ contextGraphId: string; content: unknown }> = [];
    const publisher = {
      async publish(contextGraphId: string, content: unknown) {
        calls.push({ contextGraphId, content });
        return { ual: 'did:dkg:test/1', kcId: '1', status: 'confirmed' as const };
      },
    };

    const before = Date.now();
    await registerKafkaEndpoint({
      selection: { kind: 'shared', contextGraphId: 'devnet-test' },
      owner: '0xAbCDEFabcdefABCDEFabcdefABCDEFabcdefABCD',
      broker: 'kafka.example.com:9092',
      topic: 'orders.created',
      messageFormat: 'application/json',
      publisher,
    });
    const after = Date.now();

    // Verify the default-issuedAt branch by reading the timestamp the
    // builder actually stamped onto the published KA, not by re-asserting
    // wall-clock monotonicity. The KA carries it as a typed xsd:dateTime
    // literal at `dct:issued.@value` — see ka-builder.ts.
    expect(calls).toHaveLength(1);
    const content = calls[0]!.content as { 'dct:issued': { '@value': string } };
    const issuedMs = Date.parse(content['dct:issued']['@value']);
    expect(Number.isNaN(issuedMs)).toBe(false);
    expect(issuedMs).toBeGreaterThanOrEqual(before);
    expect(issuedMs).toBeLessThanOrEqual(after);
  });
});
