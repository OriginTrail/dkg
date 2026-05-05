/**
 * Bug B integration test — kafka endpoint queries must scope to the
 * requested context graph, not silently scan every named graph in the
 * store.
 *
 * `getKafkaEndpoint` / `listKafkaEndpoints` previously wrapped every BGP
 * in `GRAPH ?g { ... }`, which suppresses `DKGQueryEngine`'s auto-wrap
 * (the engine's `wrapWithGraph` checks for "graph " in the SPARQL and
 * bails). Result: the query scanned every named graph in the store, and
 * for the same broker/topic registered in two different CGs (which
 * collapse to the same `urn:dkg:kafka-endpoint:` URI by content-
 * addressing), the package returned whichever the store enumerated first.
 *
 * This test sets up the failure scenario directly: an in-memory
 * `OxigraphStore` with the same endpoint URI present in two per-CG named
 * graphs, then calls `getKafkaEndpoint(uri, contextGraphId: 'cg-a')`
 * through a `KafkaEndpointQueryEngine` adapter that delegates to the
 * real `DKGQueryEngine`. After Bug B's fix, only A's row may come back.
 *
 * No daemon, no chain, no kafkajs — just the SPARQL plumbing the bug
 * lives in. Mirrors the route adapter's wiring shape
 * (`buildKafkaEndpointQueryEngine` in
 * `packages/cli/src/daemon/routes/kafka.ts`) so we exercise the same code
 * path the production code does.
 */
import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '@origintrail-official/dkg-query';
import {
  getKafkaEndpoint,
  listKafkaEndpoints,
  type KafkaEndpointQueryEngine,
} from '../../src/index.js';

const URI = `urn:dkg:kafka-endpoint:0xowner:${'a'.repeat(64)}`;
const URI_B = `urn:dkg:kafka-endpoint:0xowner:${'b'.repeat(64)}`;

const CG_A = 'cg-a';
const CG_B = 'cg-b';

const dataGraphFor = (cg: string) => `did:dkg:context-graph:${cg}`;

function buildAdapter(engine: DKGQueryEngine): KafkaEndpointQueryEngine {
  return {
    async query(sparql: string, contextGraphId: string) {
      const result = await engine.query(sparql, { contextGraphId });
      return { bindings: (result.bindings ?? []) as Array<Record<string, string>> };
    },
  };
}

/**
 * Insert a complete kafka endpoint KA into the per-CG data graph. Mirrors
 * the on-wire shape `buildKafkaEndpointKnowledgeAsset` produces (after
 * JSON-LD → quads conversion). We hand-roll quads here to avoid pulling in
 * `agent.publish`'s full V10 chain plumbing for a SPARQL test.
 */
async function insertEndpointKa(
  store: OxigraphStore,
  contextGraphId: string,
  uri: string,
  broker: string,
  topic: string,
): Promise<void> {
  const graph = dataGraphFor(contextGraphId);
  const dcat = 'http://www.w3.org/ns/dcat#';
  const dct = 'http://purl.org/dc/terms/';
  const dkg = 'https://ontology.dkg.io/dkg#';
  const xsd = 'http://www.w3.org/2001/XMLSchema#';
  const rdf = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

  await store.insert([
    { subject: uri, predicate: `${rdf}type`, object: `${dkg}KafkaTopicEndpoint`, graph },
    { subject: uri, predicate: `${rdf}type`, object: `${dcat}DataService`, graph },
    { subject: uri, predicate: `${dcat}endpointURL`, object: `kafka://${broker}/${topic}`, graph },
    { subject: uri, predicate: `${dkg}broker`, object: `"${broker}"`, graph },
    { subject: uri, predicate: `${dkg}topic`, object: `"${topic}"`, graph },
    { subject: uri, predicate: `${dkg}messageFormat`, object: `"application/json"`, graph },
    { subject: uri, predicate: `${dct}publisher`, object: 'urn:dkg:agent:0xowner', graph },
    {
      subject: uri,
      predicate: `${dct}issued`,
      object: `"2026-05-04T12:34:56.000Z"^^<${xsd}dateTime>`,
      graph,
    },
  ]);
}

describe('kafka endpoint queries — CG isolation (Bug B)', () => {
  it('getKafkaEndpoint returns ONLY the requested CG\'s row when the same URI exists in two CGs', async () => {
    const store = new OxigraphStore();
    try {
      // Same content-addressed URI registered in two CGs — possible only
      // when an operator publishes the same broker/topic combo into two
      // CGs (e.g. via the slice 05 register endpoint twice with different
      // `--cg` values). The URI collapses to one value by definition.
      await insertEndpointKa(store, CG_A, URI, 'kafka.cg-a:9092', 'topic-a');
      await insertEndpointKa(store, CG_B, URI, 'kafka.cg-b:9092', 'topic-b');

      const engine = new DKGQueryEngine(store);
      const queryEngine = buildAdapter(engine);

      const result = await getKafkaEndpoint({
        contextGraphId: CG_A,
        uri: URI,
        queryEngine,
      });

      // Load-bearing assertion: the row must be A's, never B's. Pre-fix,
      // the package SPARQL's `GRAPH ?g { ... }` suppressed the engine's
      // auto-wrap and the store enumeration order picked one arbitrarily.
      expect(result).not.toBeNull();
      expect(result!.broker).toBe('kafka.cg-a:9092');
      expect(result!.topic).toBe('topic-a');
    } finally {
      await store.close();
    }
  }, 30_000);

  it('listKafkaEndpoints returns ONLY the requested CG\'s rows', async () => {
    const store = new OxigraphStore();
    try {
      await insertEndpointKa(store, CG_A, URI, 'kafka.cg-a:9092', 'topic-a');
      // Different URI in B (so list output ordering can\'t accidentally
      // pass — we want a FAIL-then-FIX assertion, not a flaky one).
      await insertEndpointKa(store, CG_B, URI_B, 'kafka.cg-b:9092', 'topic-b');

      const engine = new DKGQueryEngine(store);
      const queryEngine = buildAdapter(engine);

      const result = await listKafkaEndpoints({
        contextGraphId: CG_A,
        queryEngine,
      });

      // Pre-fix this returned 2 rows — A's + B's — because the `GRAPH ?g`
      // wildcard scanned every named graph in the store.
      expect(result.endpoints).toHaveLength(1);
      expect(result.endpoints[0].broker).toBe('kafka.cg-a:9092');
      expect(result.endpoints[0].topic).toBe('topic-a');
    } finally {
      await store.close();
    }
  }, 30_000);

  it('getKafkaEndpoint against an unrelated CG returns null even if the URI exists in some other CG', async () => {
    // Negative companion to the first test: querying a CG with no kafka
    // data must NOT bleed in matches from neighbouring CGs. Pre-fix this
    // returned the foreign CG's row and pretended it belonged to the
    // queried one.
    const store = new OxigraphStore();
    try {
      await insertEndpointKa(store, CG_B, URI, 'kafka.cg-b:9092', 'topic-b');

      const engine = new DKGQueryEngine(store);
      const queryEngine = buildAdapter(engine);

      const result = await getKafkaEndpoint({
        contextGraphId: CG_A, // empty in this store
        uri: URI,
        queryEngine,
      });

      expect(result).toBeNull();
    } finally {
      await store.close();
    }
  }, 30_000);
});
