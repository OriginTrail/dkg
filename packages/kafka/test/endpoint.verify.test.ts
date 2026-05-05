import { describe, expect, it } from 'vitest';
import { verifyKafkaEndpoint } from '../src/endpoint.js';
import type { KafkaEndpointProbeOutcome } from '../src/endpoint.js';

interface CapturedUpdate {
  contextGraphId: string;
  uri: string;
  ka: any;
}

// Canonical-shape URI: matches the strict `assertValidKafkaEndpointUri`
// regex (`urn:dkg:kafka-endpoint:<owner>:<sha256-hex-64>`).
const URI = `urn:dkg:kafka-endpoint:0xowner:${'a'.repeat(64)}`;
const MISSING_URI = `urn:dkg:kafka-endpoint:owner:${'b'.repeat(64)}`;

const ACTIVE_BINDINGS = {
  broker: '"kafka.example.com:9092"',
  topic: '"orders.created"',
  messageFormat: '"application/json"',
  publisher: '<urn:dkg:agent:0xowner>',
  endpointUrl: '<kafka://kafka.example.com:9092/orders.created>',
  issued: '"2026-05-04T12:34:56.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
  verificationStatus: '"unattempted"',
};

function makePublisher() {
  const updateCalls: CapturedUpdate[] = [];
  const publisher = {
    async publish() {
      throw new Error('verify must use update, not publish');
    },
    async update(contextGraphId: string, uri: string, ka: any) {
      updateCalls.push({ contextGraphId, uri, ka });
      return {};
    },
  };
  return { publisher, updateCalls };
}

function makeQueryEngine(rows: Array<Record<string, string>>) {
  const queryEngine = {
    async query() {
      return { bindings: rows };
    },
  };
  return { queryEngine };
}

const VERIFIED_PROBE: KafkaEndpointProbeOutcome = {
  status: 'verified',
  probedAt: '2026-05-05T10:00:00.000Z',
};

const FAILED_PROBE: KafkaEndpointProbeOutcome = {
  status: 'failed',
  probedAt: '2026-05-05T10:00:00.000Z',
  error: 'KafkaJSSASLAuthenticationError',
};

describe('verifyKafkaEndpoint', () => {
  it('verified probe → updates KA with verificationStatus="verified" and verifiedAt=probedAt', async () => {
    const { publisher, updateCalls } = makePublisher();
    const { queryEngine } = makeQueryEngine([ACTIVE_BINDINGS]);

    const result = await verifyKafkaEndpoint({
      contextGraphId: 'devnet-test',
      uri: URI,
      queryEngine,
      publisher,
      probe: VERIFIED_PROBE,
    });

    expect(result).toEqual({
      uri: URI,
      contextGraphId: 'devnet-test',
      verificationStatus: 'verified',
      verifiedAt: '2026-05-05T10:00:00.000Z',
    });
    expect(updateCalls).toHaveLength(1);
    const newKa = updateCalls[0].ka;
    expect(newKa['dkg:verificationStatus']).toBe('verified');
    expect(newKa['dkg:verifiedAt']).toEqual({
      '@value': '2026-05-05T10:00:00.000Z',
      '@type': 'xsd:dateTime',
    });
    // Existing properties are preserved.
    expect(newKa['dkg:broker']).toBe('kafka.example.com:9092');
    expect(newKa['dkg:topic']).toBe('orders.created');
  });

  it('failed probe → records verificationStatus="failed" with verifiedAt=probedAt; never throws (caller asked for re-verify, not register)', async () => {
    // ADR 0002: verify is on-demand. Failure is recorded on the KA, not
    // surfaced as a registration-block. Mirrors register's force=true
    // behaviour (failed status persisted), but without the force flag —
    // the verb's contract is "tell me what the broker says, write it down".
    const { publisher, updateCalls } = makePublisher();
    const { queryEngine } = makeQueryEngine([ACTIVE_BINDINGS]);

    const result = await verifyKafkaEndpoint({
      contextGraphId: 'devnet-test',
      uri: URI,
      queryEngine,
      publisher,
      probe: FAILED_PROBE,
    });

    expect(result.verificationStatus).toBe('failed');
    expect(result.verifiedAt).toBe('2026-05-05T10:00:00.000Z');
    expect(updateCalls[0].ka['dkg:verificationStatus']).toBe('failed');
    expect(updateCalls[0].ka['dkg:verifiedAt']['@value']).toBe('2026-05-05T10:00:00.000Z');
  });

  it('unreachable probe → also recorded as verificationStatus="failed" (collapse on the wire)', async () => {
    // The KA only records "we ran a probe and it didn't verify"; the granular
    // failed-vs-unreachable distinction is route-level diagnostics, not a
    // wire contract.
    const { publisher, updateCalls } = makePublisher();
    const { queryEngine } = makeQueryEngine([ACTIVE_BINDINGS]);

    const result = await verifyKafkaEndpoint({
      contextGraphId: 'devnet-test',
      uri: URI,
      queryEngine,
      publisher,
      probe: {
        status: 'unreachable',
        probedAt: '2026-05-05T10:00:00.000Z',
        error: 'KafkaJSConnectionError',
      },
    });

    expect(result.verificationStatus).toBe('failed');
    expect(updateCalls[0].ka['dkg:verificationStatus']).toBe('failed');
  });

  it('throws when the endpoint URI is not present in the CG', async () => {
    const { publisher, updateCalls } = makePublisher();
    const { queryEngine } = makeQueryEngine([]);

    await expect(
      verifyKafkaEndpoint({
        contextGraphId: 'devnet-test',
        uri: MISSING_URI,
        queryEngine,
        publisher,
        probe: VERIFIED_PROBE,
      }),
    ).rejects.toThrow(/not found/i);
    expect(updateCalls).toHaveLength(0);
  });

  it('rejects malformed URIs before issuing any SPARQL or publisher.update', async () => {
    const { publisher, updateCalls } = makePublisher();
    const { queryEngine } = makeQueryEngine([]);

    await expect(
      verifyKafkaEndpoint({
        contextGraphId: 'devnet-test',
        uri: 'urn:dkg:kafka-endpoint:foo:bar> } UNION { ?ka <p> ?o BIND(<x',
        queryEngine,
        publisher,
        probe: VERIFIED_PROBE,
      }),
    ).rejects.toThrow(/invalid kafka endpoint uri/i);
    expect(updateCalls).toHaveLength(0);
  });

  it('preserves a prior revocation (does not silently un-revoke a revoked endpoint)', async () => {
    // Re-verifying a revoked endpoint is a meaningful diagnostic action — a
    // caller may want to confirm whether the original broker creds still
    // work — but it must NOT silently un-revoke. Existing dkg:status /
    // revokedAt must survive the verify mutation.
    const { publisher, updateCalls } = makePublisher();
    const revokedBindings = {
      ...ACTIVE_BINDINGS,
      verificationStatus: '"verified"',
      status: '"revoked"',
      revokedAt: '"2026-05-05T08:30:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
    };
    const { queryEngine } = makeQueryEngine([revokedBindings]);

    await verifyKafkaEndpoint({
      contextGraphId: 'devnet-test',
      uri: URI,
      queryEngine,
      publisher,
      probe: VERIFIED_PROBE,
    });

    expect(updateCalls[0].ka['dkg:status']).toBe('revoked');
    expect(updateCalls[0].ka['dkg:revokedAt']['@value']).toBe('2026-05-05T08:30:00.000Z');
    // Verification fields still updated.
    expect(updateCalls[0].ka['dkg:verificationStatus']).toBe('verified');
    expect(updateCalls[0].ka['dkg:verifiedAt']['@value']).toBe('2026-05-05T10:00:00.000Z');
  });

  it('uses the caller-supplied `existing` snapshot and skips the queryEngine read (Bug 1 / I6)', async () => {
    // The verify route already loads the existing KA to compute effective
    // probe inputs (broker / topic / securityProtocol defaulting). Passing
    // `existing` through avoids a second SPARQL round-trip. The package must
    // honour it: zero queryEngine.query calls, the supplied snapshot is the
    // sole basis for the composed update.
    const { publisher, updateCalls } = makePublisher();
    let queryCount = 0;
    const queryEngine = {
      async query() {
        queryCount += 1;
        // Return something distinct from `existing` so a regression that
        // re-fetches anyway would either fail this test (queryCount > 0) or
        // surface a wrong-broker mutation in the assertions below.
        return { bindings: [] };
      },
    };

    const existing = {
      uri: URI,
      contextGraphId: 'devnet-test',
      broker: 'caller.supplied:9092',
      topic: 'caller-supplied-topic',
      messageFormat: 'application/cloudevents+json',
      publisher: 'urn:dkg:agent:0xowner',
      endpointUrl: 'kafka://caller.supplied:9092/caller-supplied-topic',
      issued: '2026-05-04T12:34:56.000Z',
      verificationStatus: 'verified',
      verifiedAt: '2026-05-04T12:35:00.000Z',
    };

    await verifyKafkaEndpoint({
      contextGraphId: 'devnet-test',
      uri: URI,
      queryEngine,
      publisher,
      probe: VERIFIED_PROBE,
      existing,
    });

    expect(queryCount).toBe(0);
    expect(updateCalls).toHaveLength(1);
    // The composed update used the caller-supplied broker/topic/messageFormat,
    // proving the function did not re-fetch (which would have returned an
    // empty bindings array and surfaced as a "not found" throw).
    expect(updateCalls[0].ka['dkg:broker']).toBe('caller.supplied:9092');
    expect(updateCalls[0].ka['dkg:topic']).toBe('caller-supplied-topic');
    expect(updateCalls[0].ka['dkg:messageFormat']).toBe('application/cloudevents+json');
  });
});
