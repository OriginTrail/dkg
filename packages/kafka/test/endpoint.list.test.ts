import { describe, expect, it } from 'vitest';
import { listKafkaEndpoints } from '../src/endpoint.js';

interface QueryCall {
  sparql: string;
  contextGraphId: string;
}

const ACTIVE_URI = 'urn:dkg:kafka-endpoint:0xowner:active-hash';
const REVOKED_URI = 'urn:dkg:kafka-endpoint:0xowner:revoked-hash';

const ACTIVE_ROW = {
  endpoint: `<${ACTIVE_URI}>`,
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

const REVOKED_ROW = {
  endpoint: `<${REVOKED_URI}>`,
  broker: '"kafka.example.com:9092"',
  topic: '"orders.removed"',
  messageFormat: '"application/json"',
  publisher: '<urn:dkg:agent:0xowner>',
  endpointUrl: '<kafka://kafka.example.com:9092/orders.removed>',
  issued: '"2026-05-04T11:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
  verificationStatus: '"unattempted"',
  status: '"revoked"',
  revokedAt: '"2026-05-05T08:30:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
};

function makeQueryEngine(byPattern: (sparql: string) => Array<Record<string, string>>) {
  const calls: QueryCall[] = [];
  const queryEngine = {
    async query(sparql: string, contextGraphId: string) {
      calls.push({ sparql, contextGraphId });
      return { bindings: byPattern(sparql) };
    },
  };
  return { queryEngine, calls };
}

describe('listKafkaEndpoints', () => {
  it('defaults to status=active and excludes revoked KAs via FILTER NOT EXISTS', async () => {
    const { queryEngine, calls } = makeQueryEngine((sparql) => {
      // The package's contract: when status is 'active' (default), the SPARQL
      // must filter out KAs with dkg:status "revoked". The mock asserts the
      // filter shape is present, then returns only the active row.
      expect(sparql).toContain('FILTER NOT EXISTS');
      expect(sparql).toContain('"revoked"');
      return [ACTIVE_ROW];
    });

    const result = await listKafkaEndpoints({
      contextGraphId: 'devnet-test',
      queryEngine,
    });

    expect(result.contextGraphId).toBe('devnet-test');
    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0].uri).toBe(ACTIVE_URI);
    expect(result.endpoints[0].broker).toBe('kafka.example.com:9092');
    expect(result.endpoints[0].topic).toBe('orders.created');
    expect(calls[0].contextGraphId).toBe('devnet-test');
  });

  it('with status=revoked, returns only revoked endpoints with status + revokedAt fields', async () => {
    const { queryEngine } = makeQueryEngine((sparql) => {
      // The 'revoked' branch must positively bind dkg:status "revoked".
      expect(sparql).toContain('"revoked"');
      expect(sparql).not.toContain('FILTER NOT EXISTS');
      return [REVOKED_ROW];
    });

    const result = await listKafkaEndpoints({
      contextGraphId: 'devnet-test',
      queryEngine,
      status: 'revoked',
    });

    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0].uri).toBe(REVOKED_URI);
    expect(result.endpoints[0].status).toBe('revoked');
    expect(result.endpoints[0].revokedAt).toBe('2026-05-05T08:30:00.000Z');
  });

  it('with status=all, applies no status filter and returns both', async () => {
    const { queryEngine } = makeQueryEngine((sparql) => {
      expect(sparql).not.toContain('FILTER NOT EXISTS');
      // The 'all' branch must NOT positively assert dkg:status "revoked".
      expect(sparql).not.toMatch(/dkg:status\s+"revoked"/);
      return [ACTIVE_ROW, REVOKED_ROW];
    });

    const result = await listKafkaEndpoints({
      contextGraphId: 'devnet-test',
      queryEngine,
      status: 'all',
    });

    expect(result.endpoints).toHaveLength(2);
    expect(result.endpoints.map((e) => e.uri).sort()).toEqual(
      [ACTIVE_URI, REVOKED_URI].sort(),
    );
  });

  it('filters meaningful: in a CG with both active + revoked KAs, default status excludes the revoked one', async () => {
    // This is the load-bearing "default-active" test. The mock simulates
    // a real store: rows include dkg:status "revoked" only on the revoked
    // KA, and the package's default-active SPARQL must drop that row.
    const { queryEngine } = makeQueryEngine((sparql) => {
      const isActiveBranch = sparql.includes('FILTER NOT EXISTS');
      // Real-store semantic: active branch returns only the active row;
      // 'all' branch returns both. The test pretends the store filters
      // server-side, mirroring what a real SPARQL engine would do.
      return isActiveBranch ? [ACTIVE_ROW] : [ACTIVE_ROW, REVOKED_ROW];
    });

    const defaultListing = await listKafkaEndpoints({
      contextGraphId: 'devnet-test',
      queryEngine,
    });
    expect(defaultListing.endpoints.map((e) => e.uri)).toEqual([ACTIVE_URI]);

    const fullListing = await listKafkaEndpoints({
      contextGraphId: 'devnet-test',
      queryEngine,
      status: 'all',
    });
    expect(fullListing.endpoints.map((e) => e.uri).sort()).toEqual(
      [ACTIVE_URI, REVOKED_URI].sort(),
    );
  });

  it('returns an empty array when the CG has no Kafka endpoints', async () => {
    const { queryEngine } = makeQueryEngine(() => []);

    const result = await listKafkaEndpoints({
      contextGraphId: 'devnet-test',
      queryEngine,
    });

    expect(result.endpoints).toEqual([]);
  });

  it('uses GRAPH ?g so the daemon engine targets named per-CG graphs', async () => {
    // The repo convention (commit 348ffd19): SPARQL against per-CG named
    // graphs MUST wrap the WHERE in `GRAPH ?g { ... }` — the daemon's
    // query-engine treats unwrapped queries as default-graph, returning
    // empty bindings. Pin the convention.
    const { queryEngine, calls } = makeQueryEngine(() => []);
    await listKafkaEndpoints({ contextGraphId: 'devnet-test', queryEngine });
    expect(calls[0].sparql).toMatch(/GRAPH\s+\?g\s*\{/);
  });

  it('returns endpoints with publisher in the legacy did:dkg:agent: shape (defensive parsing)', async () => {
    // Cross-network / legacy callers may have published with a `did:dkg:agent:`
    // publisher URI instead of the canonical `urn:`. The list parser must
    // surface either shape verbatim — downstream consumers strip the prefix.
    const didRow = {
      ...ACTIVE_ROW,
      publisher: '<did:dkg:agent:0xowner>',
    };
    const { queryEngine } = makeQueryEngine(() => [didRow]);

    const result = await listKafkaEndpoints({
      contextGraphId: 'devnet-test',
      queryEngine,
    });
    expect(result.endpoints[0].publisher).toBe('did:dkg:agent:0xowner');
  });

  it('returns endpoints whose binding values lack RDF delimiters as-is (raw passthrough)', async () => {
    // A SPARQL HTTP client could, in principle, hand us already-stripped
    // values. The strip helpers must be idempotent on bare strings — this
    // pins the contract.
    const bareRow = {
      endpoint: 'urn:dkg:kafka-endpoint:bare:hash',
      broker: 'kafka.bare:9092',
      topic: 'bare.topic',
      messageFormat: 'application/json',
      publisher: 'urn:dkg:agent:bareowner',
      endpointUrl: 'kafka://bare/topic',
      issued: '2026-05-04T00:00:00.000Z',
    };
    const { queryEngine } = makeQueryEngine(() => [bareRow]);

    const result = await listKafkaEndpoints({
      contextGraphId: 'devnet-test',
      queryEngine,
    });
    expect(result.endpoints[0]).toMatchObject({
      uri: 'urn:dkg:kafka-endpoint:bare:hash',
      broker: 'kafka.bare:9092',
      publisher: 'urn:dkg:agent:bareowner',
      endpointUrl: 'kafka://bare/topic',
    });
  });

  it('survives a sparse binding row with every field missing (every defensive `?? ""` fallback fires)', async () => {
    // The SPARQL engine binds every required variable on a successful BGP
    // match — but we still defend against malformed proxies / engines that
    // drop a column. Pin the per-field fallbacks so a future regression that
    // assumes "field is always set" gets caught.
    const { queryEngine } = makeQueryEngine(() => [{}]);

    const result = await listKafkaEndpoints({
      contextGraphId: 'devnet-test',
      queryEngine,
    });
    expect(result.endpoints).toHaveLength(1);
    const row = result.endpoints[0];
    expect(row.uri).toBe('');
    expect(row.broker).toBe('');
    expect(row.topic).toBe('');
    expect(row.messageFormat).toBe('');
    expect(row.publisher).toBe('');
    expect(row.endpointUrl).toBe('');
    expect(row.issued).toBe('');
    expect(row.verificationStatus).toBeUndefined();
    expect(row.verifiedAt).toBeUndefined();
    expect(row.securityProtocol).toBeUndefined();
    expect(row.status).toBeUndefined();
    expect(row.revokedAt).toBeUndefined();
  });
});
