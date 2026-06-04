import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import { validateReadOnlySparql } from '../src/sparql-guard.js';

const CONTEXT_GRAPH = 'agent-registry';
const GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}`;
const META = `${GRAPH}/_meta`;
const ENTITY = 'did:dkg:agent:QmImageBot';
const ENTITY_2 = 'did:dkg:agent:QmTextBot';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DKG_SUB_GRAPH = 'http://dkg.io/ontology/SubGraph';
const DKG_ASSERTION_GRAPH = 'http://dkg.io/ontology/assertionGraph';
const DKG_CONTEXT_GRAPH = 'https://dkg.network/ontology#ContextGraph';
const DKG_REGISTRATION_STATUS = 'https://dkg.network/ontology#registrationStatus';
const SCHEMA_NAME = 'http://schema.org/name';
const COUNT_NAME = 'http://example.com/countName';

function q(s: string, p: string, o: string, g = GRAPH): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

function subGraphRegistration(name: string): Quad[] {
  const subGraphUri = `${GRAPH}/${name}`;
  return [
    q(subGraphUri, RDF_TYPE, DKG_SUB_GRAPH, META),
    q(subGraphUri, SCHEMA_NAME, `"${name}"`, META),
    q(subGraphUri, 'http://dkg.io/ontology/createdBy', 'did:dkg:agent:test', META),
  ];
}

function assertionGraphRegistration(graph: string, name: string): Quad {
  return q(`urn:dkg:assertion:${name}`, DKG_ASSERTION_GRAPH, graph, META);
}

describe('DKGQueryEngine', () => {
  let store: OxigraphStore;
  let engine: DKGQueryEngine;

  beforeEach(async () => {
    store = new OxigraphStore();
    engine = new DKGQueryEngine(store);

    // Seed data
    await store.insert([
      q(ENTITY, 'http://schema.org/name', '"ImageBot"'),
      q(ENTITY, 'http://schema.org/description', '"Analyzes images"'),
      q(
        `${ENTITY}/.well-known/genid/o1`,
        'http://ex.org/type',
        '"ImageAnalysis"',
      ),
    ]);
  });

  it('queries context-graph-scoped data', async () => {
    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['name']).toBe('"ImageBot"');
  });

  it('returns all triples for entity', async () => {
    const result = await engine.query(
      `SELECT ?s ?p ?o WHERE { ?s ?p ?o }`,
      { contextGraphId: CONTEXT_GRAPH },
    );
    expect(result.bindings).toHaveLength(3);
  });

  it('resolveKA returns entity data', async () => {
    const ual = 'did:dkg:mock:31337/1';
    // Need metadata in meta graph
    await store.insert([
      {
        subject: `${ual}/1`,
        predicate: 'http://dkg.io/ontology/rootEntity',
        object: ENTITY,
        graph: META,
      },
      {
        subject: `${ual}/1`,
        predicate: 'http://dkg.io/ontology/partOf',
        object: ual,
        graph: META,
      },
      {
        subject: ual,
        predicate: 'http://dkg.io/ontology/contextGraph',
        object: `did:dkg:context-graph:${CONTEXT_GRAPH}`,
        graph: META,
      },
    ]);

    const result = await engine.resolveKA(ual);
    expect(result.rootEntity).toBe(ENTITY);
    expect(result.contextGraphId).toBe(CONTEXT_GRAPH);
    expect(result.quads.length).toBeGreaterThanOrEqual(2);
  });

  it('resolveKA aggregates every member root for a multi-entity KA', async () => {
    const ual = 'did:dkg:mock:31337/42';
    await store.insert([
      q(ENTITY_2, 'http://schema.org/name', '"TextBot"'),
      q(`${ENTITY_2}/.well-known/genid/o1`, 'http://ex.org/type', '"TextAnalysis"'),
      q(`${ual}/1`, 'http://dkg.io/ontology/rootEntity', ENTITY, META),
      q(`${ual}/1`, 'http://dkg.io/ontology/partOf', ual, META),
      q(`${ual}/2`, 'http://dkg.io/ontology/rootEntity', ENTITY_2, META),
      q(`${ual}/2`, 'http://dkg.io/ontology/partOf', ual, META),
      q(ual, 'http://dkg.io/ontology/contextGraph', `did:dkg:context-graph:${CONTEXT_GRAPH}`, META),
    ]);

    const result = await engine.resolveKA(ual);
    expect(result.rootEntity).toBe(ENTITY);
    expect(result.rootEntities).toEqual([ENTITY, ENTITY_2]);
    const subjects = new Set(result.quads.map((quad) => quad.subject));
    expect(subjects).toContain(ENTITY);
    expect(subjects).toContain(`${ENTITY}/.well-known/genid/o1`);
    expect(subjects).toContain(ENTITY_2);
    expect(subjects).toContain(`${ENTITY_2}/.well-known/genid/o1`);
  });

  it('throws on unknown UAL', async () => {
    await expect(engine.resolveKA('did:dkg:mock:9999/99')).rejects.toThrow(
      'KA not found',
    );
  });

  // ───────────────────────────────────────────────────────────────────
  // #789 Codex review: when a user query carries an inner UNION over a
  // multi-graph view, `wrapWithGraphUnion` returns null (a nested
  // UnionNode would crash Blazegraph) and `queryMultipleGraphs` falls
  // back to per-graph execution. The fallback MUST merge results in a
  // FORM-AWARE way — flattening every form into `bindings` silently
  // corrupts CONSTRUCT/DESCRIBE (drops quads), ASK (drops the boolean),
  // and SELECT with solution-set modifiers (LIMIT/ORDER BY/DISTINCT/
  // aggregates can't be reconstructed from per-graph slices).
  //
  // The `verified-memory` view resolves to TWO graphs — the root
  // `<cg>` graph plus every `<cg>/_verified_memory/*` sub-graph — so
  // seeding one VM sub-graph reaches the multi-graph fallback path.
  describe('#789 multi-graph inner-UNION fallback is form-aware', () => {
    const VM_SUB = `${GRAPH}/_verified_memory/vm1`;
    const E1 = 'urn:vm:e1';
    const E2 = 'urn:vm:e2';

    beforeEach(async () => {
      // E1 lives in the root graph (already a VM candidate), E2 only in
      // the VM sub-graph, so a correct cross-graph merge must surface both.
      await store.insert([
        q(E1, 'http://ex.org/p1', '"root-val"', GRAPH),
        q(E2, 'http://ex.org/p2', '"vm-val"', VM_SUB),
      ]);
    });

    it('CONSTRUCT merges quads across graphs (does not drop the quad shape)', async () => {
      const result = await engine.query(
        `CONSTRUCT { ?s <urn:out> ?v } WHERE {
           { ?s <http://ex.org/p1> ?v } UNION { ?s <http://ex.org/p2> ?v }
         }`,
        { contextGraphId: CONTEXT_GRAPH, view: 'verified-memory' },
      );
      expect(result.quads).toBeDefined();
      const subjects = (result.quads ?? []).map((qd) => qd.subject).sort();
      expect(subjects).toEqual([E1, E2]);
    });

    it('ASK returns true when the pattern matches in ANY graph', async () => {
      const result = await engine.query(
        `ASK {
           { ?s <http://ex.org/p1> ?v } UNION { ?s <http://ex.org/p2> ?v }
         }`,
        { contextGraphId: CONTEXT_GRAPH, view: 'verified-memory' },
      );
      expect(result.bindings).toEqual([{ result: 'true' }]);
    });

    it('ASK returns false when the pattern matches in NO graph', async () => {
      const result = await engine.query(
        `ASK {
           { ?s <http://ex.org/nope1> ?v } UNION { ?s <http://ex.org/nope2> ?v }
         }`,
        { contextGraphId: CONTEXT_GRAPH, view: 'verified-memory' },
      );
      expect(result.bindings).toEqual([{ result: 'false' }]);
    });

    it('SELECT without modifiers concatenates bindings across graphs', async () => {
      const result = await engine.query(
        `SELECT ?s ?v WHERE {
           { ?s <http://ex.org/p1> ?v } UNION { ?s <http://ex.org/p2> ?v }
         }`,
        { contextGraphId: CONTEXT_GRAPH, view: 'verified-memory' },
      );
      const subjects = result.bindings.map((b) => b['s']).sort();
      expect(subjects).toEqual([E1, E2]);
    });

    it('SELECT with a solution-set modifier (ORDER BY) is rejected, not silently corrupted', async () => {
      await expect(
        engine.query(
          `SELECT ?s ?v WHERE {
             { ?s <http://ex.org/p1> ?v } UNION { ?s <http://ex.org/p2> ?v }
           } ORDER BY ?v`,
          { contextGraphId: CONTEXT_GRAPH, view: 'verified-memory' },
        ),
      ).rejects.toThrow(/cannot be evaluated across graphs/i);
    });

    it('SELECT with LIMIT is rejected too (per-graph slices would over-count)', async () => {
      await expect(
        engine.query(
          `SELECT ?s ?v WHERE {
             { ?s <http://ex.org/p1> ?v } UNION { ?s <http://ex.org/p2> ?v }
           } LIMIT 1`,
          { contextGraphId: CONTEXT_GRAPH, view: 'verified-memory' },
        ),
      ).rejects.toThrow(/cannot be evaluated across graphs/i);
    });
  });

  it('queries across all contextGraphs', async () => {
    // Add data to another context graph
    await store.insert([
      q('did:dkg:agent:QmTextBot', 'http://schema.org/name', '"TextBot"', 'did:dkg:context-graph:text-tools'),
    ]);

    const result = await engine.queryAllContextGraphs(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
    );
    expect(result.bindings.length).toBe(2);
  });

  it('queries shared memory graph when graphSuffix is _shared_memory', async () => {
    const sharedMemoryGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory`;
    await store.insert([
      q('urn:ws:entity:1', 'http://schema.org/name', '"Workspace Only"', sharedMemoryGraph),
    ]);

    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH, graphSuffix: '_shared_memory' },
    );
    expect(result.bindings.length).toBe(1);
    expect(result.bindings[0]['name']).toBe('"Workspace Only"');
  });

  it('queries union of data and shared memory when includeSharedMemory is true', async () => {
    const sharedMemoryGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory`;
    await store.insert([
      q('urn:ws:entity:union', 'http://schema.org/name', '"In Workspace"', sharedMemoryGraph),
    ]);

    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH, includeSharedMemory: true },
    );
    const names = result.bindings.map((r) => String(r['name']));
    expect(names.some((n) => n.includes('ImageBot'))).toBe(true);
    expect(names.some((n) => n.includes('In Workspace'))).toBe(true);
    expect(result.bindings.length).toBe(2);
  });

  it('dedupes duplicate rows when includeSharedMemory returns same binding from data and shared memory', async () => {
    const sharedMemoryGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory`;
    await store.insert([
      q('urn:dup:entity:1', 'http://schema.org/name', '"Duplicate"', GRAPH),
      q('urn:dup:entity:1', 'http://schema.org/name', '"Duplicate"', sharedMemoryGraph),
    ]);

    const result = await engine.query(
      'SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH, includeSharedMemory: true },
    );

    const duplicates = result.bindings.filter((row) =>
      row['s'] === 'urn:dup:entity:1' && String(row['name']).includes('Duplicate'),
    );
    expect(duplicates.length).toBe(1);
  });

  it('dedupes duplicate quads for includeSharedMemory CONSTRUCT queries', async () => {
    const sharedMemoryGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory`;
    await store.insert([
      q('urn:dup:quad:1', 'http://schema.org/name', '"QuadDup"', GRAPH),
      q('urn:dup:quad:1', 'http://schema.org/name', '"QuadDup"', sharedMemoryGraph),
    ]);

    const result = await engine.query(
      'CONSTRUCT { ?s <http://schema.org/name> ?name } WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH, includeSharedMemory: true },
    );

    const matches = (result.quads ?? []).filter((row) =>
      row.subject === 'urn:dup:quad:1'
        && row.predicate === 'http://schema.org/name'
        && String(row.object).includes('QuadDup'),
    );
    expect(matches.length).toBe(1);
  });

  it('rejects INSERT queries', async () => {
    await expect(
      engine.query('INSERT DATA { <s> <p> <o> }'),
    ).rejects.toThrow('SPARQL rejected');
  });

  it('rejects DELETE queries', async () => {
    await expect(
      engine.query('DELETE WHERE { ?s ?p ?o }'),
    ).rejects.toThrow('SPARQL rejected');
  });

  it('rejects DROP queries', async () => {
    await expect(
      engine.query('DROP GRAPH <http://example.org>'),
    ).rejects.toThrow('SPARQL rejected');
  });

  it('view=verified-memory includes the root content graph (RC11 / PR-A: Codex #671)', async () => {
    // RC11 / PR-A (Codex review fix on #671, comment 3302058969):
    // re-includes the root context-graph alongside `_verified_memory/*`
    // so a successful `/api/shared-memory/publish` is immediately
    // observable via `view: 'verified-memory'` (the pre-PR2 behaviour
    // existing callers, including memory-search, rely on). The
    // tentative-VM leak that PR2 was meant to plug is now fixed at the
    // publisher (root-graph insert deferred to the chain-success
    // branch); see the comment in `dkg-query-engine.ts` for the full
    // rationale.
    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH, view: 'verified-memory' },
    );
    const names = result.bindings.map(r => r['name']);
    expect(names).toContain('"ImageBot"');
  });

  it('view=verified-memory unions root content graph + _verified_memory/ sub-graphs (RC11 / PR-A)', async () => {
    const vmGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_verified_memory/quorum-1`;
    await store.insert([
      q('urn:vm:entity:1', 'http://schema.org/name', '"Quorum Verified"', vmGraph),
    ]);
    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH, view: 'verified-memory' },
    );
    const names = result.bindings.map(r => r['name']);
    // Both the publisher's confirmed root-graph data AND post-`verify`
    // `_verified_memory/*` data must surface — VM is the union of both
    // (Codex #671 review fix).
    expect(names).toContain('"ImageBot"');
    expect(names).toContain('"Quorum Verified"');
  });

  it('view=verified-memory constrains compact GRAPH variables without duplicating multi-graph rows', async () => {
    const vmGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_verified_memory/quorum-1`;
    await store.insert([
      q('urn:vm:entity:1', 'http://schema.org/name', '"Quorum Verified"', vmGraph),
      q('urn:other:entity', 'http://schema.org/name', '"OtherGraph"', 'did:dkg:context-graph:other-agent-registry'),
    ]);

    const result = await engine.query(
      'SELECT ?g ?name WHERE { GRAPH?g { ?s <http://schema.org/name> ?name } } ORDER BY ?name',
      { contextGraphId: CONTEXT_GRAPH, view: 'verified-memory' },
    );

    expect(result.bindings).toEqual([
      { g: GRAPH, name: '"ImageBot"' },
      { g: vmGraph, name: '"Quorum Verified"' },
    ]);
  });

  it('view=verified-memory honors compact explicit GRAPH IRIs without duplicating multi-graph rows', async () => {
    const vmGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_verified_memory/quorum-1`;
    await store.insert([
      q('urn:vm:entity:1', 'http://schema.org/name', '"Quorum Verified"', vmGraph),
    ]);

    const result = await engine.query(
      `SELECT ?name WHERE { GRAPH<${vmGraph}> { ?s <http://schema.org/name> ?name } }`,
      { contextGraphId: CONTEXT_GRAPH, view: 'verified-memory' },
    );

    expect(result.bindings).toEqual([
      { name: '"Quorum Verified"' },
    ]);
  });

  it('view=verified-memory with verifiedGraph scopes to that graph only', async () => {
    const vmGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_verified_memory/team-a`;
    await store.insert([
      q('urn:vm:scoped:1', 'http://schema.org/name', '"Scoped Data"', vmGraph),
    ]);
    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH, view: 'verified-memory', verifiedGraph: 'team-a' },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['name']).toBe('"Scoped Data"');
  });

  it('view=verified-memory excludes _meta and staging graphs', async () => {
    await store.insert([
      q('urn:vm:meta', 'http://schema.org/name', '"Meta Only"', `did:dkg:context-graph:${CONTEXT_GRAPH}/_verified_memory/q1/_meta`),
      q('urn:vm:staging', 'http://schema.org/name', '"Staging Only"', `did:dkg:context-graph:${CONTEXT_GRAPH}/_verified_memory/staging/draft`),
    ]);
    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH, view: 'verified-memory' },
    );
    const names = result.bindings.map(r => r['name']);
    expect(names).not.toContain('"Meta Only"');
    expect(names).not.toContain('"Staging Only"');
  });

  it('view=shared-working-memory does NOT include root content graph', async () => {
    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH, view: 'shared-working-memory' },
    );
    expect(result.bindings).toHaveLength(0);
  });

  it('view requires contextGraphId', async () => {
    await expect(
      engine.query('SELECT ?s WHERE { ?s ?p ?o }', { view: 'verified-memory' }),
    ).rejects.toThrow('requires a contextGraphId');
  });

  it('rejects FROM clauses on context-graph-scoped local queries', async () => {
    await expect(
      engine.query(
        `SELECT ?name FROM <${GRAPH}> WHERE { ?s <http://schema.org/name> ?name }`,
        { contextGraphId: CONTEXT_GRAPH },
      ),
    ).rejects.toThrow(/Scoped query violation: FROM clauses are not allowed/i);
  });

  it('rejects compact FROM clauses on context-graph-scoped local queries', async () => {
    await expect(
      engine.query(
        `SELECT ?name FROM<${GRAPH}> WHERE { ?s <http://schema.org/name> ?name }`,
        { contextGraphId: CONTEXT_GRAPH },
      ),
    ).rejects.toThrow(/Scoped query violation: FROM clauses are not allowed/i);
  });

  it('rejects compact FROM NAMED clauses on context-graph-scoped local queries', async () => {
    await expect(
      engine.query(
        `SELECT ?name FROM NAMED<${GRAPH}> WHERE { GRAPH ?g { ?s <http://schema.org/name> ?name } }`,
        { contextGraphId: CONTEXT_GRAPH },
      ),
    ).rejects.toThrow(/Scoped query violation: FROM clauses are not allowed/i);
  });

  it('allows scoped queries with prefixed names that contain FROM', async () => {
    await store.insert([
      q(ENTITY, 'http://example.com/from', '"FromPredicate"'),
    ]);

    await expect(engine.query(
      `SELECT ?from WHERE { ?s <http://example.com/from> ?from }`,
      { contextGraphId: CONTEXT_GRAPH },
    )).resolves.toMatchObject({
      bindings: [{ from: '"FromPredicate"' }],
    });

    await expect(engine.query(
      `PREFIX ex: <http://example.com/>
       SELECT ?name WHERE { ?s ex:from ?name }`,
      { contextGraphId: CONTEXT_GRAPH },
    )).resolves.toMatchObject({
      bindings: [{ name: '"FromPredicate"' }],
    });
  });

  it('allows scoped queries with a prefix label named from', async () => {
    await store.insert([
      q(ENTITY, 'http://example.com/name', '"FromPrefixPredicate"'),
    ]);

    await expect(engine.query(
      `PREFIX from: <http://example.com/>
       SELECT ?name WHERE { ?s from:name ?name }`,
      { contextGraphId: CONTEXT_GRAPH },
    )).resolves.toMatchObject({ bindings: expect.any(Array) });
  });

  it('allows scoped queries with a prefix label named graph', async () => {
    await store.insert([
      q(ENTITY, 'http://example.com/name', '"GraphPrefixPredicate"'),
    ]);

    await expect(engine.query(
      `PREFIX graph: <http://example.com/>
       SELECT ?name WHERE { ?s graph:name ?name }`,
      { contextGraphId: CONTEXT_GRAPH },
    )).resolves.toMatchObject({ bindings: expect.any(Array) });
  });

  it('allows scoped queries with hyphenated graph/from prefix labels', async () => {
    await store.insert([
      q(ENTITY, 'http://example.com/name', '"HyphenatedPrefixPredicate"'),
    ]);

    await expect(engine.query(
      `PREFIX graph-viz: <http://example.com/>
       SELECT ?name WHERE { ?s graph-viz:name ?name }`,
      { contextGraphId: CONTEXT_GRAPH },
    )).resolves.toMatchObject({ bindings: expect.any(Array) });

    await expect(engine.query(
      `PREFIX from-schema: <http://example.com/>
       SELECT ?name WHERE { ?s from-schema:name ?name }`,
      { contextGraphId: CONTEXT_GRAPH },
    )).resolves.toMatchObject({ bindings: expect.any(Array) });
  });

  it('rejects explicit GRAPH IRIs outside the scoped context graph', async () => {
    const otherGraph = 'did:dkg:context-graph:other-agent-registry';
    await store.insert([
      q('urn:secret:entity', 'http://schema.org/name', '"Secret"', otherGraph),
    ]);

    await expect(
      engine.query(
        `SELECT ?name WHERE { GRAPH <${otherGraph}> { ?s <http://schema.org/name> ?name } }`,
        { contextGraphId: CONTEXT_GRAPH },
      ),
    ).rejects.toThrow(/Scoped query violation: GRAPH <did:dkg:context-graph:other-agent-registry> is outside the allowed graph set/i);
  });

  it('allows explicit GRAPH IRI against the same CG\'s _meta graph', async () => {
    // Regression guard for #774 finding #4 (mis-attributed as a
    // `createContextGraph` regression in the issue body; root cause is
    // here in the query engine). `devnet-test-invite-flow.sh` step 1b
    // queries `GRAPH <…/_meta> { <cg> <dkg:curator> ?owner }` to
    // assert the curator was stamped at create time. Authenticated
    // callers that supplied a `contextGraphId` already have read access
    // to that CG — refusing them visibility into the same CG's `_meta`
    // graph (where curator / allowedAgent / registrationStatus live)
    // broke the invite flow, the CG Overview UI, and downstream sync
    // code. `_meta` is only in the EXPLICIT-IRI allow set, not the
    // graph-variable set, so a `GRAPH ?g` rewrite still cannot iterate
    // into `_meta` and leak the allowedAgent list.
    await store.insert([
      {
        subject: GRAPH,
        predicate: 'https://dkg.network/ontology#curator',
        object: 'did:dkg:agent:0xabc',
        graph: META,
      },
    ]);
    const result = await engine.query(
      `SELECT ?owner WHERE { GRAPH <${META}> { <${GRAPH}> <https://dkg.network/ontology#curator> ?owner } }`,
      { contextGraphId: CONTEXT_GRAPH },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['owner']).toBe('did:dkg:agent:0xabc');
  });

  it('allows explicit GRAPH IRI against the same CG\'s _shared_memory_meta graph', async () => {
    // Regression guard for #774 finding #3 (also mis-attributed in the
    // issue body — diagnosed as "owner-peer not replicated to node 2";
    // the workspaceOwner triple IS in fact replicated, but the scoped
    // query couldn't see it). `devnet-test-swm-ownership-restart.sh`
    // `wait_for_owner_meta` probe queries
    //
    //   GRAPH <…/_shared_memory_meta> {
    //     <root> <http://dkg.io/ontology/workspaceOwner> ?owner
    //   }
    //
    // …with `contextGraphId` scope. Same reasoning as the `_meta`
    // allow: authenticated callers already have read access to the CG;
    // refusing them visibility into the SWM ownership metadata breaks
    // both replica ACL probes and downstream sync code. Add to the
    // EXPLICIT-IRI allow set only; graph-variable expansion stays
    // constrained to data + SWM data so `GRAPH ?g` cannot iterate into
    // `_shared_memory_meta`.
    const swmMetaGraph = `${GRAPH}/_shared_memory_meta`;
    await store.insert([
      {
        subject: 'urn:swm-root:test',
        predicate: 'http://dkg.io/ontology/workspaceOwner',
        object: '"12D3KooWowner"',
        graph: swmMetaGraph,
      },
    ]);
    const result = await engine.query(
      `SELECT ?owner WHERE { GRAPH <${swmMetaGraph}> { <urn:swm-root:test> <http://dkg.io/ontology/workspaceOwner> ?owner } }`,
      { contextGraphId: CONTEXT_GRAPH },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['owner']).toBe('"12D3KooWowner"');
  });

  it('rejects explicit GRAPH IRI against CG _meta when caller narrowed to graphSuffix=_shared_memory (privacy fence)', async () => {
    // Bot review on #776: the `_meta` widening MUST NOT apply when the
    // caller explicitly narrowed routing to SWM-only via
    // `graphSuffix: '_shared_memory'`. `_meta` lives on the CG-data
    // path, not the SWM path, so a SWM-narrowed caller has no business
    // reading it. We pair each meta URI with the corresponding data
    // graph and ONLY widen the explicit-IRI allow set when the
    // matching data graph is in `allowedGraphs`.
    await store.insert([
      {
        subject: GRAPH,
        predicate: 'https://dkg.network/ontology#allowedAgent',
        object: '"0xsecret"',
        graph: META,
      },
    ]);
    await expect(
      engine.query(
        `SELECT ?o WHERE { GRAPH <${META}> { <${GRAPH}> <https://dkg.network/ontology#allowedAgent> ?o } }`,
        { contextGraphId: CONTEXT_GRAPH, graphSuffix: '_shared_memory' },
      ),
    ).rejects.toThrow(/Scoped query violation/i);
  });

  it('allows explicit GRAPH IRI against _shared_memory_meta even on graphSuffix=_shared_memory route', async () => {
    // SWM-only narrowed callers should still see SWM metadata
    // (workspaceOwner / promote-time ACL). The privacy fence drops
    // CG-level `_meta` for SWM-narrowed routes (covered in the next
    // test) but keeps the SWM analogue accessible.
    const swmMetaGraph = `${GRAPH}/_shared_memory_meta`;
    await store.insert([
      {
        subject: 'urn:swm-root:test',
        predicate: 'http://dkg.io/ontology/workspaceOwner',
        object: '"12D3KooWowner"',
        graph: swmMetaGraph,
      },
    ]);
    const result = await engine.query(
      `SELECT ?owner WHERE { GRAPH <${swmMetaGraph}> { <urn:swm-root:test> <http://dkg.io/ontology/workspaceOwner> ?owner } }`,
      { contextGraphId: CONTEXT_GRAPH, graphSuffix: '_shared_memory' },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['owner']).toBe('"12D3KooWowner"');
  });

  it('allows explicit GRAPH IRI against the actual sub-graph _meta location (\u003ccg\u003e/\u003csub\u003e/_meta)', async () => {
    // Bot review on #776: sub-graph metadata is written by
    // `graph-manager.ts` to `did:dkg:context-graph:<cg>/<sub>/_meta`
    // (via `contextGraphSubGraphMetaUri`), NOT to
    // `did:dkg:context-graph:<cg>/context/<sub>/_meta` (which is what
    // `contextGraphMetaUri(cg, sub)` produces). The earlier draft of
    // this fix used the wrong helper and would have left scoped
    // sub-graph metadata reads still rejected; this test pins the
    // correct path.
    const subGraphName = 'code';
    const subGraphMeta = `${GRAPH}/${subGraphName}/_meta`;
    await store.insert([
      {
        subject: GRAPH,
        predicate: 'https://dkg.network/ontology#curator',
        object: 'did:dkg:agent:0xsubgraph',
        graph: subGraphMeta,
      },
    ]);
    const result = await engine.query(
      `SELECT ?owner WHERE { GRAPH <${subGraphMeta}> { <${GRAPH}> <https://dkg.network/ontology#curator> ?owner } }`,
      { contextGraphId: CONTEXT_GRAPH, subGraphName },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['owner']).toBe('did:dkg:agent:0xsubgraph');
  });

  it('GRAPH ?g binds to same-CG _meta on default-routed scoped queries (UI hook regression coverage)', async () => {
    // Codex r2 on #776: `useSwmAttributions`, `useVerifiedMemoryAnchors`
    // and `useVerifiedEntityIdentity` all bind `GRAPH ?g` over
    // CG-scoped metadata. Widening `constrainGraphVariablesToAllowedSet`
    // to the same set as the explicit-IRI allow set restores the
    // CG-level case. Cross-CG `?g` bindings are still rejected by
    // the surrounding scope-rejection tests.
    await store.insert([
      {
        subject: GRAPH,
        predicate: 'https://dkg.network/ontology#curator',
        object: 'did:dkg:agent:0xowner',
        graph: META,
      },
    ]);
    const result = await engine.query(
      `SELECT ?g ?o WHERE { GRAPH ?g { <${GRAPH}> <https://dkg.network/ontology#curator> ?o } }`,
      { contextGraphId: CONTEXT_GRAPH },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['g']).toBe(META);
    expect(result.bindings[0]['o']).toBe('did:dkg:agent:0xowner');
  });

  it('GRAPH ?g over sub-graph SWM meta does NOT bind without a CG-registry-aware allow set (#774 follow-up)', async () => {
    // Codex r5 RED on #776: dynamic sub-graph metadata enumeration
    // is fundamentally unsafe without a CG-registry interface
    // because the URI `<cg>/<seg>/_meta` cannot be disambiguated
    // structurally from the root `_meta` of a separate registered
    // CG `<cg>/<seg>`. We therefore restrict the variable allow set
    // to the static `metaAllowList` (root metas only), which is
    // exactly what #774 F4 + F3 need. UI hooks that enumerate
    // sub-graph SWM metadata via
    // `GRAPH ?g + CONTAINS("_shared_memory_meta")` are a tracked
    // follow-up that requires the CG-registry plumbing to land
    // safely.
    //
    // This test pins the limitation: same-CG sub-graph
    // `_shared_memory_meta` partitions are NOT bound by `GRAPH ?g`
    // under `contextGraphId` scope. Removing this fence in a
    // future PR must come with an authoritative cross-CG
    // disambiguation mechanism, otherwise this test catches the
    // regression.
    const cgRootSwmMeta = `${GRAPH}/_shared_memory_meta`;
    const cgCodeSwmMeta = `${GRAPH}/code/_shared_memory_meta`;
    await store.insert([
      { subject: 'urn:op:root', predicate: 'http://schema.org/agent', object: '"agentRoot"', graph: cgRootSwmMeta },
      { subject: 'urn:op:code', predicate: 'http://schema.org/agent', object: '"agentCode"', graph: cgCodeSwmMeta },
    ]);
    const result = await engine.query(
      `SELECT ?g ?agent WHERE {
        GRAPH ?g {
          ?op <http://schema.org/agent> ?agent .
        }
        FILTER(CONTAINS(STR(?g), "_shared_memory_meta"))
      }`,
      { contextGraphId: CONTEXT_GRAPH },
    );
    const agents = result.bindings.map((b) => b['agent']).sort();
    expect(agents).toEqual(['"agentRoot"']);
    expect(result.bindings.some((b) => b['g'] === cgCodeSwmMeta)).toBe(false);
  });

  it('GRAPH ?g with subGraphName=code DOES bind that exact sub-graph meta (explicit route)', async () => {
    // The static `metaAllowList` for `subGraphName: 'code'` already
    // contains `<cg>/code/_meta` and `<cg>/code/_shared_memory_meta`,
    // so a `GRAPH ?g` query under that scope binds the exact
    // sub-graph the caller asked for. Sibling sub-graphs are not
    // visible (the metaAllowList is exact, not prefixed).
    const codeSwmMeta = `${GRAPH}/code/_shared_memory_meta`;
    const decisionsSwmMeta = `${GRAPH}/decisions/_shared_memory_meta`;
    await store.insert([
      { subject: 'urn:op:in-scope', predicate: 'http://schema.org/agent', object: '"agentCode"', graph: codeSwmMeta },
      { subject: 'urn:op:sibling', predicate: 'http://schema.org/agent', object: '"agentDecisions"', graph: decisionsSwmMeta },
    ]);
    const result = await engine.query(
      `SELECT ?agent WHERE { GRAPH ?g { ?op <http://schema.org/agent> ?agent } }`,
      { contextGraphId: CONTEXT_GRAPH, subGraphName: 'code' },
    );
    const agents = result.bindings.map((b) => b['agent']).sort();
    expect(agents).toEqual(['"agentCode"']);
  });

  it('rejects compact explicit GRAPH IRIs outside the scoped context graph', async () => {
    const otherGraph = 'did:dkg:context-graph:other-agent-registry';
    await store.insert([
      q('urn:secret:entity', 'http://schema.org/name', '"Secret"', otherGraph),
    ]);

    await expect(
      engine.query(
        `SELECT ?name WHERE { GRAPH<${otherGraph}> { ?s <http://schema.org/name> ?name } }`,
        { contextGraphId: CONTEXT_GRAPH },
      ),
    ).rejects.toThrow(/Scoped query violation: GRAPH <did:dkg:context-graph:other-agent-registry> is outside the allowed graph set/i);
  });

  it('allows prefixed explicit GRAPH targets that resolve to the scoped graph', async () => {
    const result = await engine.query(
      `PREFIX cg: <did:dkg:context-graph:>
       SELECT ?name WHERE { GRAPH cg:${CONTEXT_GRAPH} { ?s <http://schema.org/name> ?name } }`,
      { contextGraphId: CONTEXT_GRAPH },
    );

    expect(result.bindings).toEqual([
      { name: '"ImageBot"' },
    ]);
  });

  it('rejects prefixed explicit GRAPH targets outside the scoped graph set', async () => {
    const otherGraph = 'did:dkg:context-graph:other-agent-registry';
    await store.insert([
      q('urn:secret:entity', 'http://schema.org/name', '"Secret"', otherGraph),
    ]);

    await expect(
      engine.query(
        `PREFIX other: <${otherGraph}>
         SELECT ?name WHERE { GRAPH other: { ?s <http://schema.org/name> ?name } }`,
        { contextGraphId: CONTEXT_GRAPH },
      ),
    ).rejects.toThrow(/Scoped query violation: GRAPH <did:dkg:context-graph:other-agent-registry> is outside the allowed graph set/i);
  });

  it('rejects unresolved prefixed GRAPH targets fail-closed', async () => {
    await expect(
      engine.query(
        `SELECT ?name WHERE { GRAPH missing:allowed { ?s <http://schema.org/name> ?name } }`,
        { contextGraphId: CONTEXT_GRAPH },
      ),
    ).rejects.toThrow(/Scoped query violation: GRAPH prefixed target missing:allowed cannot be resolved/i);
  });

  it('allows prefixed explicit GRAPH targets alongside constrained GRAPH variables', async () => {
    await store.insert([
      q('urn:other:entity', 'http://schema.org/name', '"OtherGraph"', 'did:dkg:context-graph:other-agent-registry'),
    ]);

    const result = await engine.query(
      `PREFIX cg: <did:dkg:context-graph:>
       SELECT ?g ?name ?sameName WHERE {
         GRAPH ?g { ?s <http://schema.org/name> ?name }
         GRAPH cg:${CONTEXT_GRAPH} { ?s <http://schema.org/name> ?sameName }
       }`,
      { contextGraphId: CONTEXT_GRAPH },
    );

    expect(result.bindings).toEqual([
      { g: GRAPH, name: '"ImageBot"', sameName: '"ImageBot"' },
    ]);
  });

  it('constrains GRAPH variables to the scoped context graph data graph', async () => {
    await store.insert([
      q('urn:other:entity', 'http://schema.org/name', '"OtherGraph"', 'did:dkg:context-graph:other-agent-registry'),
    ]);

    const result = await engine.query(
      'SELECT ?g ?name WHERE { GRAPH ?g { ?s <http://schema.org/name> ?name } } ORDER BY ?name',
      { contextGraphId: CONTEXT_GRAPH },
    );

    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['g']).toBe(GRAPH);
    expect(result.bindings[0]['name']).toBe('"ImageBot"');
  });

  it('rejects mixed GRAPH-variable and default-graph triple patterns', async () => {
    await expect(
      engine.query(
        `SELECT ?g ?name ?description WHERE {
          GRAPH ?g { ?s <http://schema.org/name> ?name }
          ?s <http://schema.org/description> ?description
        }`,
        { contextGraphId: CONTEXT_GRAPH },
      ),
    ).rejects.toThrow(/Scoped query violation: GRAPH variables cannot be mixed with default-graph triple patterns/i);
  });

  it('constrains GRAPH variables with non-ASCII names to the scoped context graph data graph', async () => {
    await store.insert([
      q('urn:other:entity', 'http://schema.org/name', '"OtherGraph"', 'did:dkg:context-graph:other-agent-registry'),
    ]);

    const result = await engine.query(
      'SELECT ?name WHERE { GRAPH ?é { ?s <http://schema.org/name> ?name } } ORDER BY ?name',
      { contextGraphId: CONTEXT_GRAPH },
    );

    expect(result.bindings).toEqual([
      { name: '"ImageBot"' },
    ]);
  });

  it('constrains GRAPH variables to data and shared memory for includeSharedMemory', async () => {
    const sharedMemoryGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory`;
    await store.insert([
      q('urn:ws:entity:1', 'http://schema.org/name', '"Workspace Only"', sharedMemoryGraph),
      q('urn:other:entity', 'http://schema.org/name', '"OtherGraph"', 'did:dkg:context-graph:other-agent-registry'),
      q('urn:other:ws', 'http://schema.org/name', '"OtherWorkspace"', 'did:dkg:context-graph:other-agent-registry/_shared_memory'),
    ]);

    const result = await engine.query(
      'SELECT ?g ?name WHERE { GRAPH ?g { ?s <http://schema.org/name> ?name } } ORDER BY ?name',
      { contextGraphId: CONTEXT_GRAPH, includeSharedMemory: true },
    );

    expect(result.bindings.map((row) => row['name'])).toEqual(['"ImageBot"', '"Workspace Only"']);
    expect(result.bindings.map((row) => row['g']).sort()).toEqual([GRAPH, sharedMemoryGraph].sort());
  });

  it('keeps legacy GRAPH-variable scans on the selected data graph without partition opt-in', async () => {
    const rootAssertionGraph = `${GRAPH}/assertion/0xAgent/root-draft`;
    const rootVerifiedGraph = `${GRAPH}/_verified_memory/vm-1`;
    const subGraph = `${GRAPH}/code`;
    const subGraphSharedMemoryGraph = `${GRAPH}/code/_shared_memory`;

    await store.insert([
      ...subGraphRegistration('code'),
      assertionGraphRegistration(rootAssertionGraph, 'root-draft'),
      q('urn:root:data', COUNT_NAME, '"RootData"', GRAPH),
      q('urn:root:wm', COUNT_NAME, '"RootWM"', rootAssertionGraph),
      q('urn:root:vm', COUNT_NAME, '"RootVM"', rootVerifiedGraph),
      q('urn:code:data', COUNT_NAME, '"CodeData"', subGraph),
      q('urn:code:swm', COUNT_NAME, '"CodeSWM"', subGraphSharedMemoryGraph),
    ]);

    const result = await engine.query(
      `SELECT ?g ?name WHERE { GRAPH ?g { ?s <${COUNT_NAME}> ?name } } ORDER BY ?name`,
      { contextGraphId: CONTEXT_GRAPH },
    );

    expect(result.bindings).toEqual([
      { g: GRAPH, name: '"RootData"' },
    ]);
  });

  it('keeps includeSharedMemory GRAPH-variable scans on data plus SWM without partition opt-in', async () => {
    const rootSharedMemoryGraph = `${GRAPH}/_shared_memory`;
    const rootAssertionGraph = `${GRAPH}/assertion/0xAgent/root-draft`;
    const rootVerifiedGraph = `${GRAPH}/_verified_memory/vm-1`;
    const subGraph = `${GRAPH}/code`;
    const subGraphSharedMemoryGraph = `${GRAPH}/code/_shared_memory`;

    await store.insert([
      ...subGraphRegistration('code'),
      assertionGraphRegistration(rootAssertionGraph, 'root-draft'),
      q('urn:root:data', COUNT_NAME, '"RootData"', GRAPH),
      q('urn:root:swm', COUNT_NAME, '"RootSWM"', rootSharedMemoryGraph),
      q('urn:root:wm', COUNT_NAME, '"RootWM"', rootAssertionGraph),
      q('urn:root:vm', COUNT_NAME, '"RootVM"', rootVerifiedGraph),
      q('urn:code:data', COUNT_NAME, '"CodeData"', subGraph),
      q('urn:code:swm', COUNT_NAME, '"CodeSWM"', subGraphSharedMemoryGraph),
    ]);

    const result = await engine.query(
      `SELECT ?g ?name WHERE { GRAPH ?g { ?s <${COUNT_NAME}> ?name } } ORDER BY ?name`,
      { contextGraphId: CONTEXT_GRAPH, includeSharedMemory: true },
    );

    expect(result.bindings).toEqual([
      { g: GRAPH, name: '"RootData"' },
      { g: rootSharedMemoryGraph, name: '"RootSWM"' },
    ]);
  });

  it('allows scoped GRAPH variable count scans across registered same-CG content partitions', async () => {
    const rootAssertionGraph = `${GRAPH}/assertion/0xAgent/root-draft`;
    const rootSharedMemoryGraph = `${GRAPH}/_shared_memory`;
    const rootVerifiedGraph = `${GRAPH}/_verified_memory/vm-1`;
    const rootVerifiedStagingGraph = `${GRAPH}/_verified_memory/staging/vm-1`;
    const subGraph = `${GRAPH}/code`;
    const subGraphAssertionGraph = `${GRAPH}/code/assertion/0xAgent/code-draft`;
    const subGraphSharedMemoryGraph = `${GRAPH}/code/_shared_memory`;
    const subGraphVerifiedGraph = `${GRAPH}/code/_verified_memory/vm-1`;
    const subGraphVerifiedStagingGraph = `${GRAPH}/code/_verified_memory/staging/vm-1`;
    const subGraphMeta = `${GRAPH}/code/_meta`;
    const subGraphPrivate = `${GRAPH}/code/_private`;
    const otherGraph = 'did:dkg:context-graph:other-agent-registry/code/_shared_memory';

    await store.insert([
      ...subGraphRegistration('code'),
      assertionGraphRegistration(rootAssertionGraph, 'root-draft'),
      assertionGraphRegistration(subGraphAssertionGraph, 'code-draft'),
      q('urn:root:wm', SCHEMA_NAME, '"RootWM"', rootAssertionGraph),
      q('urn:root:swm', SCHEMA_NAME, '"RootSWM"', rootSharedMemoryGraph),
      q('urn:root:vm', SCHEMA_NAME, '"RootVM"', rootVerifiedGraph),
      q('urn:root:staging', SCHEMA_NAME, '"RootStaging"', rootVerifiedStagingGraph),
      q('urn:code:data', SCHEMA_NAME, '"CodeData"', subGraph),
      q('urn:code:wm', SCHEMA_NAME, '"CodeWM"', subGraphAssertionGraph),
      q('urn:code:swm', SCHEMA_NAME, '"CodeSWM"', subGraphSharedMemoryGraph),
      q('urn:code:vm', SCHEMA_NAME, '"CodeVM"', subGraphVerifiedGraph),
      q('urn:code:staging', SCHEMA_NAME, '"CodeStaging"', subGraphVerifiedStagingGraph),
      q('urn:code:meta', SCHEMA_NAME, '"CodeMeta"', subGraphMeta),
      q('urn:code:private', SCHEMA_NAME, '"CodePrivate"', subGraphPrivate),
      q('urn:other:swm', SCHEMA_NAME, '"OtherSWM"', otherGraph),
    ]);

    const result = await engine.query(
      `SELECT ?g (COUNT(DISTINCT ?s) AS ?entities) (COUNT(*) AS ?triples)
       WHERE { GRAPH ?g { ?s ?p ?o } }
       GROUP BY ?g`,
      { contextGraphId: CONTEXT_GRAPH, includeContextGraphPartitions: true },
    );
    const graphs = new Set(result.bindings.map((row) => row['g']));

    for (const expected of [
      GRAPH,
      META,
      rootAssertionGraph,
      rootSharedMemoryGraph,
      rootVerifiedGraph,
      subGraph,
      subGraphAssertionGraph,
      subGraphSharedMemoryGraph,
      subGraphVerifiedGraph,
    ]) {
      expect(graphs.has(expected)).toBe(true);
    }
    expect(graphs.has(rootVerifiedStagingGraph)).toBe(false);
    expect(graphs.has(subGraphVerifiedStagingGraph)).toBe(false);
    expect(graphs.has(subGraphMeta)).toBe(false);
    expect(graphs.has(subGraphPrivate)).toBe(false);
    expect(graphs.has(otherGraph)).toBe(false);
  });

  it('memoizes same-CG partition discovery across concurrent count scans', async () => {
    const rootSharedMemoryGraph = `${GRAPH}/_shared_memory`;
    const rootVerifiedGraph = `${GRAPH}/_verified_memory/vm-1`;
    const subGraph = `${GRAPH}/code`;
    const subGraphSharedMemoryGraph = `${GRAPH}/code/_shared_memory`;

    await store.insert([
      ...subGraphRegistration('code'),
      q('urn:root:swm', SCHEMA_NAME, '"RootSWM"', rootSharedMemoryGraph),
      q('urn:root:vm', SCHEMA_NAME, '"RootVM"', rootVerifiedGraph),
      q('urn:code:data', SCHEMA_NAME, '"CodeData"', subGraph),
      q('urn:code:swm', SCHEMA_NAME, '"CodeSWM"', subGraphSharedMemoryGraph),
    ]);

    const listGraphsSpy = vi.spyOn(store, 'listGraphs');
    const sparql = `SELECT ?g ?name WHERE { GRAPH ?g { ?s <${SCHEMA_NAME}> ?name } } ORDER BY ?name`;

    const results = await Promise.all([
      engine.query(sparql, { contextGraphId: CONTEXT_GRAPH, includeContextGraphPartitions: true }),
      engine.query(sparql, { contextGraphId: CONTEXT_GRAPH, includeContextGraphPartitions: true }),
      engine.query(sparql, { contextGraphId: CONTEXT_GRAPH, includeContextGraphPartitions: true }),
    ]);

    expect(listGraphsSpy).toHaveBeenCalledTimes(1);
    for (const result of results) {
      const graphs = new Set(result.bindings.map((row) => row['g']));
      expect(graphs.has(rootSharedMemoryGraph)).toBe(true);
      expect(graphs.has(rootVerifiedGraph)).toBe(true);
      expect(graphs.has(subGraph)).toBe(true);
      expect(graphs.has(subGraphSharedMemoryGraph)).toBe(true);
    }
  });

  it('does not reuse partition discovery after an in-flight count scan completes', async () => {
    const codeSubGraph = `${GRAPH}/code`;
    const docsSubGraph = `${GRAPH}/docs`;

    await store.insert([
      ...subGraphRegistration('code'),
      q('urn:code:data', SCHEMA_NAME, '"CodeData"', codeSubGraph),
    ]);

    const listGraphsSpy = vi.spyOn(store, 'listGraphs');
    const sparql = `SELECT ?g ?name WHERE { GRAPH ?g { ?s <${SCHEMA_NAME}> ?name } } ORDER BY ?name`;
    const first = await engine.query(
      sparql,
      { contextGraphId: CONTEXT_GRAPH, includeContextGraphPartitions: true },
    );
    expect(first.bindings.some((row) => row['g'] === codeSubGraph)).toBe(true);
    expect(listGraphsSpy).toHaveBeenCalledTimes(1);

    await store.insert([
      ...subGraphRegistration('docs'),
      q('urn:docs:data', SCHEMA_NAME, '"DocsData"', docsSubGraph),
    ]);

    const second = await engine.query(
      sparql,
      { contextGraphId: CONTEXT_GRAPH, includeContextGraphPartitions: true },
    );
    expect(listGraphsSpy).toHaveBeenCalledTimes(2);
    expect(second.bindings.some((row) => row['g'] === docsSubGraph)).toBe(true);
  });

  it('does not bind same-prefix child context graphs as parent content partitions', async () => {
    const collidingSubGraph = `${GRAPH}/code`;
    const collidingSubGraphSharedMemory = `${collidingSubGraph}/_shared_memory`;
    const collidingSubGraphVerified = `${collidingSubGraph}/_verified_memory/vm-1`;
    const collidingSubGraphMeta = `${collidingSubGraph}/_meta`;
    const collidingRootSharedMemory = `${GRAPH}/_shared_memory`;
    const collidingRootSharedMemoryMeta = `${collidingRootSharedMemory}/_meta`;
    const collidingRootVerified = `${GRAPH}/_verified_memory/vm-1`;
    const collidingRootVerifiedMeta = `${collidingRootVerified}/_meta`;

    await store.insert([
      ...subGraphRegistration('code'),
      q(collidingSubGraph, RDF_TYPE, DKG_CONTEXT_GRAPH, collidingSubGraphMeta),
      q(collidingRootSharedMemory, DKG_REGISTRATION_STATUS, '"unregistered"', collidingRootSharedMemoryMeta),
      q(collidingRootVerified, DKG_REGISTRATION_STATUS, '"unregistered"', collidingRootVerifiedMeta),
      q('urn:child:code', SCHEMA_NAME, '"ChildCodeRoot"', collidingSubGraph),
      q('urn:child:code-swm', SCHEMA_NAME, '"ChildCodeSharedMemory"', collidingSubGraphSharedMemory),
      q('urn:child:code-vm', SCHEMA_NAME, '"ChildCodeVerified"', collidingSubGraphVerified),
      q('urn:child:swm', SCHEMA_NAME, '"ChildSharedMemoryRoot"', collidingRootSharedMemory),
      q('urn:child:vm', SCHEMA_NAME, '"ChildVerifiedRoot"', collidingRootVerified),
    ]);

    const result = await engine.query(
      `SELECT ?g ?name WHERE { GRAPH ?g { ?s <${SCHEMA_NAME}> ?name } } ORDER BY ?name`,
      { contextGraphId: CONTEXT_GRAPH, includeContextGraphPartitions: true },
    );
    const names = new Set(result.bindings.map((row) => row['name']));

    expect(names.has('"ChildCodeRoot"')).toBe(false);
    expect(names.has('"ChildCodeSharedMemory"')).toBe(false);
    expect(names.has('"ChildCodeVerified"')).toBe(false);
    expect(names.has('"ChildSharedMemoryRoot"')).toBe(false);
    expect(names.has('"ChildVerifiedRoot"')).toBe(false);
    expect(result.bindings.some((row) => row['g'] === collidingSubGraph)).toBe(false);
    expect(result.bindings.some((row) => row['g'] === collidingSubGraphSharedMemory)).toBe(false);
    expect(result.bindings.some((row) => row['g'] === collidingSubGraphVerified)).toBe(false);
    expect(result.bindings.some((row) => row['g'] === collidingRootSharedMemory)).toBe(false);
    expect(result.bindings.some((row) => row['g'] === collidingRootVerified)).toBe(false);
  });

  it('does not let non-canonical child-CG type triples hide registered parent partitions', async () => {
    const subGraph = `${GRAPH}/code`;

    await store.insert([
      ...subGraphRegistration('code'),
      // User data can mention `dkg:ContextGraph`; only the candidate's own
      // `/_meta` graph may prove a child context graph during count scans.
      q(subGraph, RDF_TYPE, DKG_CONTEXT_GRAPH, GRAPH),
      q('urn:code:data', COUNT_NAME, '"ParentCode"', subGraph),
    ]);

    const result = await engine.query(
      `SELECT ?g ?name WHERE { GRAPH ?g { ?s <${COUNT_NAME}> ?name } } ORDER BY ?name`,
      { contextGraphId: CONTEXT_GRAPH, includeContextGraphPartitions: true },
    );

    expect(result.bindings).toEqual([
      { g: subGraph, name: '"ParentCode"' },
    ]);
  });

  it('does not treat unregistered same-prefix child graphs as same-CG sub-graph content', async () => {
    const unregisteredSubGraph = `${GRAPH}/code`;
    await store.insert([
      q('urn:child:entity', SCHEMA_NAME, '"UnregisteredPrefixChild"', unregisteredSubGraph),
    ]);

    const result = await engine.query(
      `SELECT ?g ?name WHERE { GRAPH ?g { ?s <${SCHEMA_NAME}> ?name } } ORDER BY ?name`,
      { contextGraphId: CONTEXT_GRAPH, includeContextGraphPartitions: true },
    );

    expect(result.bindings.some((row) => row['g'] === unregisteredSubGraph)).toBe(false);
    expect(result.bindings.some((row) => row['name'] === '"UnregisteredPrefixChild"')).toBe(false);
  });

  it('constrains GRAPH variables to shared memory when graphSuffix is _shared_memory', async () => {
    const sharedMemoryGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory`;
    await store.insert([
      q('urn:ws:entity:1', 'http://schema.org/name', '"Workspace Only"', sharedMemoryGraph),
      q('urn:other:ws', 'http://schema.org/name', '"OtherWorkspace"', 'did:dkg:context-graph:other-agent-registry/_shared_memory'),
    ]);

    const result = await engine.query(
      'SELECT ?g ?name WHERE { GRAPH ?g { ?s <http://schema.org/name> ?name } } ORDER BY ?name',
      { contextGraphId: CONTEXT_GRAPH, graphSuffix: '_shared_memory' },
    );

    expect(result.bindings).toEqual([
      { g: sharedMemoryGraph, name: '"Workspace Only"' },
    ]);
  });

  it('constrains GRAPH variables to the requested legacy sub-graph and shared memory graph', async () => {
    const subGraphName = 'team-a';
    const subGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/${subGraphName}`;
    const subGraphSharedMemory = `did:dkg:context-graph:${CONTEXT_GRAPH}/${subGraphName}/_shared_memory`;
    await store.insert([
      q('urn:team:entity', 'http://schema.org/name', '"Team Data"', subGraph),
      q('urn:team:ws', 'http://schema.org/name', '"Team Workspace"', subGraphSharedMemory),
      q('urn:other-team:entity', 'http://schema.org/name', '"Other Team"', `did:dkg:context-graph:${CONTEXT_GRAPH}/team-b`),
      q('urn:other-team:ws', 'http://schema.org/name', '"Other Team Workspace"', `did:dkg:context-graph:${CONTEXT_GRAPH}/team-b/_shared_memory`),
    ]);

    const result = await engine.query(
      'SELECT ?g ?name WHERE { GRAPH ?g { ?s <http://schema.org/name> ?name } } ORDER BY ?name',
      { contextGraphId: CONTEXT_GRAPH, subGraphName, includeSharedMemory: true },
    );

    expect(result.bindings.map((row) => row['name'])).toEqual(['"Team Data"', '"Team Workspace"']);
    expect(result.bindings.map((row) => row['g']).sort()).toEqual([subGraph, subGraphSharedMemory].sort());
  });

  it('constrains outer shorthand GRAPH variables after a nested SELECT WHERE', async () => {
    await store.insert([
      q('urn:other:entity', 'http://schema.org/name', '"OtherGraph"', 'did:dkg:context-graph:other-agent-registry'),
    ]);

    const result = await engine.query(
      `SELECT ?g ?name {
        {
          SELECT ?x WHERE {
            BIND("keep" AS ?x)
          }
        }
        GRAPH ?g { ?s <http://schema.org/name> ?name }
      } ORDER BY ?name`,
      { contextGraphId: CONTEXT_GRAPH },
    );

    expect(result.bindings).toEqual([
      { g: GRAPH, name: '"ImageBot"' },
    ]);
  });

  it('rejects nested subqueries that would keep GRAPH variables outside the scoped binding', async () => {
    await store.insert([
      q('urn:other:entity', 'http://schema.org/name', '"OtherGraph"', 'did:dkg:context-graph:other-agent-registry'),
    ]);

    await expect(
      engine.query(
        `SELECT ?name WHERE {
          {
            SELECT ?name WHERE {
              GRAPH ?g { ?s <http://schema.org/name> ?name }
            }
          }
        }`,
        { contextGraphId: CONTEXT_GRAPH },
      ),
    ).rejects.toThrow(/Scoped query violation: GRAPH variables inside nested SELECT subqueries/i);
  });

  it('rejects nested GRAPH-variable subqueries even when comparison syntax appears before GRAPH', async () => {
    await store.insert([
      q('urn:other:entity', 'http://schema.org/name', '"OtherGraph"', 'did:dkg:context-graph:other-agent-registry'),
    ]);

    await expect(
      engine.query(
        `SELECT ?name WHERE {
          {
            SELECT ?name WHERE {
              BIND(1 AS ?score)
              FILTER(?score < 10)
              GRAPH ?g { ?s <http://schema.org/name> ?name }
            }
          }
        }`,
        { contextGraphId: CONTEXT_GRAPH },
      ),
    ).rejects.toThrow(/Scoped query violation: GRAPH variables inside nested SELECT subqueries/i);
  });

  it('rejects optional GRAPH-variable patterns instead of changing OPTIONAL semantics', async () => {
    await expect(
      engine.query(
        `SELECT ?name ?g ?nickname WHERE {
          ?s <http://schema.org/name> ?name
          OPTIONAL {
            GRAPH ?g { ?s <http://schema.org/alternateName> ?nickname }
          }
        }`,
        { contextGraphId: CONTEXT_GRAPH },
      ),
    ).rejects.toThrow(/Scoped query violation: GRAPH variables must appear at the top level/i);
  });
});

describe('validateReadOnlySparql', () => {
  it('allows SELECT', () => {
    expect(validateReadOnlySparql('SELECT ?s WHERE { ?s ?p ?o }').safe).toBe(true);
  });

  it('allows CONSTRUCT', () => {
    expect(validateReadOnlySparql('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }').safe).toBe(true);
  });

  it('allows ASK', () => {
    expect(validateReadOnlySparql('ASK { ?s ?p ?o }').safe).toBe(true);
  });

  it('allows DESCRIBE', () => {
    expect(validateReadOnlySparql('DESCRIBE <http://example.org/x>').safe).toBe(true);
  });

  it('rejects INSERT DATA', () => {
    const result = validateReadOnlySparql('INSERT DATA { <s> <p> <o> }');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('SELECT, CONSTRUCT, ASK, or DESCRIBE');
  });

  it('rejects DELETE WHERE', () => {
    const result = validateReadOnlySparql('DELETE WHERE { ?s ?p ?o }');
    expect(result.safe).toBe(false);
  });

  it('rejects CLEAR GRAPH', () => {
    const result = validateReadOnlySparql('CLEAR GRAPH <http://example.org>');
    expect(result.safe).toBe(false);
  });

  it('rejects DROP GRAPH', () => {
    const result = validateReadOnlySparql('DROP GRAPH <http://example.org>');
    expect(result.safe).toBe(false);
  });

  it('rejects LOAD', () => {
    const result = validateReadOnlySparql('LOAD <http://example.org/data>');
    expect(result.safe).toBe(false);
  });

  it('allows comments containing mutating keywords', () => {
    const result = validateReadOnlySparql(
      '# This query does not INSERT anything\nSELECT ?s WHERE { ?s ?p ?o }',
    );
    expect(result.safe).toBe(true);
  });

  it('allows PREFIX declarations before SELECT', () => {
    const result = validateReadOnlySparql(`
      PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
      SELECT ?name WHERE { ?s <http://schema.org/name> ?name }
    `);
    expect(result.safe).toBe(true);
  });

  it('allows inline PREFIX declarations before SELECT', () => {
    const result = validateReadOnlySparql(
      'PREFIX schema: <http://schema.org/> SELECT ?s WHERE { ?s schema:name ?name }',
    );
    expect(result.safe).toBe(true);
  });

  it('allows inline default PREFIX declarations before SELECT', () => {
    const result = validateReadOnlySparql(
      'PREFIX : <http://schema.org/> SELECT ?s WHERE { ?s :name ?name }',
    );
    expect(result.safe).toBe(true);
  });

  it('allows multiple PREFIX declarations', () => {
    const result = validateReadOnlySparql(`
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      PREFIX schema: <http://schema.org/>
      SELECT ?s WHERE { ?s rdf:type schema:Person }
    `);
    expect(result.safe).toBe(true);
  });

  it('allows BASE declaration before SELECT', () => {
    const result = validateReadOnlySparql(`
      BASE <http://example.org/>
      SELECT ?s WHERE { ?s ?p ?o }
    `);
    expect(result.safe).toBe(true);
  });

  // #764 follow-up: the previous `[A-Za-z][A-Za-z0-9_-]*` label charset was
  // stricter than SPARQL's PN_PREFIX grammar and rejected valid read-only
  // queries whose PREFIX label contained a dot or non-ASCII characters.
  it('allows PREFIX labels containing dots (PN_PREFIX)', () => {
    const result = validateReadOnlySparql(
      'PREFIX foaf.core: <http://xmlns.com/foaf/0.1/> SELECT ?s WHERE { ?s foaf.core:name ?n }',
    );
    expect(result.safe).toBe(true);
  });

  it('allows PREFIX labels containing non-ASCII characters', () => {
    const result = validateReadOnlySparql(
      'PREFIX naïve: <http://example.org/> SELECT ?s WHERE { ?s naïve:p ?o }',
    );
    expect(result.safe).toBe(true);
  });

  it('still rejects mutations even with an exotic PREFIX label', () => {
    const result = validateReadOnlySparql(
      'PREFIX foaf.core: <http://xmlns.com/foaf/0.1/> INSERT DATA { <s> <p> <o> }',
    );
    expect(result.safe).toBe(false);
  });
});
