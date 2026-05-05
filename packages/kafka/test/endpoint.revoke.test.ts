import { describe, expect, it } from 'vitest';
import { KafkaEndpointPublisherFormatError, revokeKafkaEndpoint } from '../src/endpoint.js';

interface CapturedUpdate {
  contextGraphId: string;
  uri: string;
  ka: any;
}

interface QueryCall {
  sparql: string;
  contextGraphId: string;
}

const ENDPOINT_URI =
  'urn:dkg:kafka-endpoint:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd:33b58f60595c766739f72b29e4ee417888d1a46af8339a4b5bdb1c3a5692f652';

const ACTIVE_BINDINGS = {
  broker: '"kafka.example.com:9092"',
  topic: '"orders.created"',
  messageFormat: '"application/json"',
  publisher: '<urn:dkg:agent:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd>',
  endpointUrl: '<kafka://kafka.example.com:9092/orders.created>',
  issued: '"2026-05-04T12:34:56.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
  verificationStatus: '"verified"',
  verifiedAt: '"2026-05-04T12:35:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
  securityProtocol: '"SASL_SSL"',
};

function makePublisher() {
  const publishCalls: any[] = [];
  const updateCalls: CapturedUpdate[] = [];
  const publisher = {
    async publish(cgId: string, ka: any) {
      publishCalls.push({ cgId, ka });
      return {};
    },
    async update(contextGraphId: string, uri: string, ka: any) {
      updateCalls.push({ contextGraphId, uri, ka });
      return {};
    },
  };
  return { publisher, publishCalls, updateCalls };
}

function makeQueryEngine(bindings: Array<Record<string, string>>) {
  const calls: QueryCall[] = [];
  const queryEngine = {
    async query(sparql: string, contextGraphId: string) {
      calls.push({ sparql, contextGraphId });
      return { bindings };
    },
  };
  return { queryEngine, calls };
}

describe('revokeKafkaEndpoint', () => {
  it('reads existing KA, composes revocation mutation, and calls publisher.update with the full new KA', async () => {
    const { publisher, updateCalls } = makePublisher();
    const { queryEngine } = makeQueryEngine([ACTIVE_BINDINGS]);

    const result = await revokeKafkaEndpoint({
      contextGraphId: 'devnet-test',
      uri: ENDPOINT_URI,
      queryEngine,
      publisher,
      revokedAt: '2026-05-05T09:30:00.000Z',
    });

    expect(result).toEqual({
      uri: ENDPOINT_URI,
      contextGraphId: 'devnet-test',
      revokedAt: '2026-05-05T09:30:00.000Z',
      status: 'revoked',
    });

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].contextGraphId).toBe('devnet-test');
    expect(updateCalls[0].uri).toBe(ENDPOINT_URI);
    const newKa = updateCalls[0].ka;
    // Existing properties survive the soft-revoke (mutate-by-add-only).
    expect(newKa['@id']).toBe(ENDPOINT_URI);
    expect(newKa['@type']).toEqual(['dkg:KafkaTopicEndpoint', 'dcat:DataService']);
    expect(newKa['dkg:broker']).toBe('kafka.example.com:9092');
    expect(newKa['dkg:topic']).toBe('orders.created');
    expect(newKa['dkg:messageFormat']).toBe('application/json');
    expect(newKa['dcat:endpointURL']).toEqual({
      '@id': 'kafka://kafka.example.com:9092/orders.created',
    });
    expect(newKa['dct:publisher']).toEqual({
      '@id': 'urn:dkg:agent:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
    expect(newKa['dct:issued']).toEqual({
      '@value': '2026-05-04T12:34:56.000Z',
      '@type': 'xsd:dateTime',
    });
    expect(newKa['dkg:verificationStatus']).toBe('verified');
    expect(newKa['dkg:verifiedAt']).toEqual({
      '@value': '2026-05-04T12:35:00.000Z',
      '@type': 'xsd:dateTime',
    });
    expect(newKa['dkg:securityProtocol']).toBe('SASL_SSL');
    // Revocation properties are added.
    expect(newKa['dkg:status']).toBe('revoked');
    expect(newKa['dkg:revokedAt']).toEqual({
      '@value': '2026-05-05T09:30:00.000Z',
      '@type': 'xsd:dateTime',
    });
  });

  it('uses publisher.update — never publisher.publish — so we go through the V10 update flow (not delete+recreate)', async () => {
    const { publisher, publishCalls, updateCalls } = makePublisher();
    const { queryEngine } = makeQueryEngine([ACTIVE_BINDINGS]);

    await revokeKafkaEndpoint({
      contextGraphId: 'devnet-test',
      uri: ENDPOINT_URI,
      queryEngine,
      publisher,
      revokedAt: '2026-05-05T09:30:00.000Z',
    });

    expect(publishCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(1);
  });

  it('falls back to "now" when revokedAt is omitted', async () => {
    const { publisher, updateCalls } = makePublisher();
    const { queryEngine } = makeQueryEngine([ACTIVE_BINDINGS]);
    const before = Date.now();

    await revokeKafkaEndpoint({
      contextGraphId: 'devnet-test',
      uri: ENDPOINT_URI,
      queryEngine,
      publisher,
    });

    const newKa = updateCalls[0].ka;
    const stamp = newKa['dkg:revokedAt']['@value'];
    const stampMs = Date.parse(stamp);
    expect(Number.isNaN(stampMs)).toBe(false);
    expect(stampMs).toBeGreaterThanOrEqual(before - 1_000);
    expect(stampMs).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it('throws when the endpoint URI is not present in the CG', async () => {
    const { publisher, updateCalls } = makePublisher();
    const { queryEngine } = makeQueryEngine([]);

    await expect(
      revokeKafkaEndpoint({
        contextGraphId: 'devnet-test',
        uri: `urn:dkg:kafka-endpoint:0xowner:${'c'.repeat(64)}`,
        queryEngine,
        publisher,
      }),
    ).rejects.toThrow(/not found/i);
    expect(updateCalls).toHaveLength(0);
  });

  it('rejects malformed URIs before issuing any SPARQL or publisher.update', async () => {
    const { publisher, updateCalls } = makePublisher();
    const { queryEngine } = makeQueryEngine([]);

    await expect(
      revokeKafkaEndpoint({
        contextGraphId: 'devnet-test',
        uri: 'urn:dkg:kafka-endpoint:foo:bar> } UNION { ?ka <p> ?o BIND(<x',
        queryEngine,
        publisher,
      }),
    ).rejects.toThrow(/invalid kafka endpoint uri/i);
    expect(updateCalls).toHaveLength(0);
  });

  it('extracts owner from a did:dkg:agent: publisher URI (legacy shape)', async () => {
    // Canonical publisher is `urn:dkg:agent:<addr>`; some legacy KAs use
    // `did:dkg:agent:<addr>`. The compose helper must extract the address
    // and feed it to the canonical builder, which lower-cases it and
    // re-emits the urn: form on the new KA.
    const { publisher, updateCalls } = makePublisher();
    const didBindings = {
      ...ACTIVE_BINDINGS,
      publisher: '<did:dkg:agent:0xLegacyOwner>',
    };
    const { queryEngine } = makeQueryEngine([didBindings]);

    await revokeKafkaEndpoint({
      contextGraphId: 'devnet-test',
      uri: ENDPOINT_URI,
      queryEngine,
      publisher,
      revokedAt: '2026-05-05T09:30:00.000Z',
    });

    expect(updateCalls[0].ka['dct:publisher']).toEqual({
      '@id': 'urn:dkg:agent:0xlegacyowner',
    });
  });

  it('Bug 3: throws KafkaEndpointPublisherFormatError on an unrecognised publisher URN (silent-mutation hole)', async () => {
    // The earlier "defensive fallback" behaviour silently mangled the rebuilt
    // KA's `@id`: a publisher URN that didn't match `urn:dkg:agent:` or
    // `did:dkg:agent:` was handed through verbatim, then `buildKafkaEndpoint
    // KnowledgeAsset` produced `urn:dkg:kafka-endpoint:<wrong-owner>:<hash>`
    // — different from `existing.uri`. `agent.update(existing.uri, ...)`
    // would still resolve to the original kcId and write the new triples
    // there, but the triples carried a DIFFERENT subject URI. Original
    // subject's triples got orphaned; new subject's triples coexisted
    // confusingly inside the original kcId. Failing closed eliminates the
    // hole entirely.
    const { publisher, updateCalls } = makePublisher();
    const oddBindings = {
      ...ACTIVE_BINDINGS,
      publisher: '<urn:other:scheme:owner>',
    };
    const { queryEngine } = makeQueryEngine([oddBindings]);

    await expect(
      revokeKafkaEndpoint({
        contextGraphId: 'devnet-test',
        uri: ENDPOINT_URI,
        queryEngine,
        publisher,
        revokedAt: '2026-05-05T09:30:00.000Z',
      }),
    ).rejects.toBeInstanceOf(KafkaEndpointPublisherFormatError);
    // No publisher.update call — we throw before composing the new KA.
    expect(updateCalls).toHaveLength(0);
  });

  it('Bug 3: KafkaEndpointPublisherFormatError message names the offending publisher value', async () => {
    // The publisher URN is non-secret, so the throw message can echo it for
    // operator debugging. (Compare credentials, which the package never
    // logs — see the slice 04 secret-substring tests.)
    const { publisher } = makePublisher();
    const oddBindings = {
      ...ACTIVE_BINDINGS,
      publisher: '<urn:other:scheme:owner>',
    };
    const { queryEngine } = makeQueryEngine([oddBindings]);

    try {
      await revokeKafkaEndpoint({
        contextGraphId: 'devnet-test',
        uri: ENDPOINT_URI,
        queryEngine,
        publisher,
        revokedAt: '2026-05-05T09:30:00.000Z',
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(KafkaEndpointPublisherFormatError);
      const e = err as KafkaEndpointPublisherFormatError;
      expect(e.message).toContain('urn:other:scheme:owner');
      expect(e.publisher).toBe('urn:other:scheme:owner');
    }
  });

  it('is idempotent: revoking an already-revoked KA succeeds and re-stamps revokedAt', async () => {
    // The simplest sane behaviour: a second revoke is not an error. The KA is
    // re-published with the same dkg:status "revoked" and a fresh revokedAt
    // timestamp. Useful when an operator double-clicks revoke or two ops
    // race the request.
    const { publisher, updateCalls } = makePublisher();
    const revokedBindings = {
      ...ACTIVE_BINDINGS,
      status: '"revoked"',
      revokedAt: '"2026-05-05T08:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
    };
    const { queryEngine } = makeQueryEngine([revokedBindings]);

    const result = await revokeKafkaEndpoint({
      contextGraphId: 'devnet-test',
      uri: ENDPOINT_URI,
      queryEngine,
      publisher,
      revokedAt: '2026-05-05T09:30:00.000Z',
    });

    expect(result.status).toBe('revoked');
    expect(result.revokedAt).toBe('2026-05-05T09:30:00.000Z');
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].ka['dkg:status']).toBe('revoked');
    expect(updateCalls[0].ka['dkg:revokedAt']['@value']).toBe('2026-05-05T09:30:00.000Z');
  });
});
