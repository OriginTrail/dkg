import { describe, expect, it } from 'vitest';
import { getKafkaEndpoint } from '../src/endpoint.js';

const URI = 'urn:dkg:kafka-endpoint:0xowner:abc123';

const ACTIVE_BINDINGS = {
  broker: '"kafka.example.com:9092"',
  topic: '"orders.created"',
  messageFormat: '"application/json"',
  publisher: '<urn:dkg:agent:0xowner>',
  endpointUrl: '<kafka://kafka.example.com:9092/orders.created>',
  issued: '"2026-05-04T12:34:56.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
  verificationStatus: '"verified"',
  verifiedAt: '"2026-05-04T12:35:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
  securityProtocol: '"SASL_SSL"',
};

const REVOKED_BINDINGS = {
  ...ACTIVE_BINDINGS,
  status: '"revoked"',
  revokedAt: '"2026-05-05T08:30:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
};

function makeQueryEngine(rows: Array<Record<string, string>>) {
  const calls: Array<{ sparql: string; contextGraphId: string }> = [];
  const queryEngine = {
    async query(sparql: string, contextGraphId: string) {
      calls.push({ sparql, contextGraphId });
      return { bindings: rows };
    },
  };
  return { queryEngine, calls };
}

describe('getKafkaEndpoint', () => {
  it('returns the matching endpoint with all current properties stripped of RDF delimiters', async () => {
    const { queryEngine } = makeQueryEngine([ACTIVE_BINDINGS]);

    const result = await getKafkaEndpoint({
      contextGraphId: 'devnet-test',
      uri: URI,
      queryEngine,
    });

    expect(result).toEqual({
      uri: URI,
      contextGraphId: 'devnet-test',
      broker: 'kafka.example.com:9092',
      topic: 'orders.created',
      messageFormat: 'application/json',
      publisher: 'urn:dkg:agent:0xowner',
      endpointUrl: 'kafka://kafka.example.com:9092/orders.created',
      issued: '2026-05-04T12:34:56.000Z',
      verificationStatus: 'verified',
      verifiedAt: '2026-05-04T12:35:00.000Z',
      securityProtocol: 'SASL_SSL',
    });
  });

  it('returns revoked endpoints, including dkg:status and dkg:revokedAt', async () => {
    // A revoked endpoint must remain fetchable by URI — the status filter
    // applies only to list, not to the single-URI fetch.
    const { queryEngine } = makeQueryEngine([REVOKED_BINDINGS]);

    const result = await getKafkaEndpoint({
      contextGraphId: 'devnet-test',
      uri: URI,
      queryEngine,
    });

    expect(result?.uri).toBe(URI);
    expect(result?.status).toBe('revoked');
    expect(result?.revokedAt).toBe('2026-05-05T08:30:00.000Z');
  });

  it('returns null when no matching endpoint exists', async () => {
    const { queryEngine } = makeQueryEngine([]);
    const result = await getKafkaEndpoint({
      contextGraphId: 'devnet-test',
      uri: 'urn:dkg:kafka-endpoint:owner:missing',
      queryEngine,
    });
    expect(result).toBeNull();
  });

  it('uses GRAPH ?g and binds the URI literal into the SPARQL', async () => {
    const { queryEngine, calls } = makeQueryEngine([]);
    await getKafkaEndpoint({
      contextGraphId: 'devnet-test',
      uri: URI,
      queryEngine,
    });
    expect(calls[0].sparql).toMatch(/GRAPH\s+\?g\s*\{/);
    expect(calls[0].sparql).toContain(`<${URI}>`);
  });
});
