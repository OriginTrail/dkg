/**
 * `includeProvenance` — per-row source provenance on the local SELECT path.
 *
 * A discovery `SELECT` normally returns triples with no link back to the KA /
 * publisher they came from (the source named graph is dropped). With
 * `includeProvenance: true` the engine wraps the query in `GRAPH ?<reserved>`,
 * lets the existing scope guard constrain it, and lifts the bound source graph
 * out of each row into `result.provenance` — the handle a consumer follows to
 * the assertion seal / on-chain merkle root to verify the fact.
 *
 * Hermetic: in-memory OxigraphStore, zero mocks, zero chain.
 */
import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';

const CG = 'prov-cg';
const ADDR_A = '0xaaa0000000000000000000000000000000000001';
const ADDR_B = '0xbbb0000000000000000000000000000000000002';
const NAME = 'http://schema.org/name';

const vmGraphA = `did:dkg:context-graph:${CG}/_verifiable_memory/${ADDR_A}/5`;
const vmGraphB = `did:dkg:context-graph:${CG}/_verifiable_memory/${ADDR_B}/9`;
const metaGraph = `did:dkg:context-graph:${CG}/_meta`;
const assertionUri = `did:dkg:context-graph:${CG}/assertion/${ADDR_A}/myassertion`;

function q(subject: string, predicate: string, object: string, graph: string) {
  return { subject, predicate, object, graph };
}

async function fixture() {
  const store = new OxigraphStore();
  const engine = new DKGQueryEngine(store);
  await store.insert([
    q('https://example.org/a', NAME, '"FromKA_A"', vmGraphA),
    q('https://example.org/b', NAME, '"FromKA_B"', vmGraphB),
    // A seal row in `_meta` — must NOT bleed into a content read.
    q(assertionUri, 'http://dkg.io/ontology/authorAddress', '"0xAUTHOR"', metaGraph),
  ]);
  return engine;
}

describe('includeProvenance — per-row source provenance', () => {
  it('attaches a parsed UAL-identity handle to each row and keeps bindings clean', async () => {
    const engine = await fixture();
    const r = await engine.query(`SELECT ?s ?o WHERE { ?s <${NAME}> ?o }`, {
      contextGraphId: CG,
      view: 'verifiable-memory',
      includeProvenance: true,
    });

    expect(r.bindings).toHaveLength(2);
    // The reserved provenance variable must NOT leak into user bindings.
    for (const row of r.bindings) {
      expect(Object.keys(row).sort()).toEqual(['o', 's']);
    }
    expect(r.provenance).toHaveLength(2);

    // Provenance is aligned 1:1 with bindings; match by row content.
    const byObject = new Map(
      r.bindings.map((row, i) => [row['o'], r.provenance![i]]),
    );
    const provA = byObject.get('"FromKA_A"')!;
    expect(provA.sourceGraph).toBe(vmGraphA);
    expect(provA.contextGraphId).toBe(CG);
    expect(provA.memoryLayer).toBe('verifiable-memory');
    expect(provA.author).toBe(ADDR_A);
    expect(provA.kaNumber).toBe('5');

    const provB = byObject.get('"FromKA_B"')!;
    expect(provB.author).toBe(ADDR_B);
    expect(provB.kaNumber).toBe('9');
  });

  it('does not widen access — the `_meta` seal graph is not unioned into the read', async () => {
    const engine = await fixture();
    const r = await engine.query(`SELECT ?s ?o WHERE { ?s ?p ?o }`, {
      contextGraphId: CG,
      view: 'verifiable-memory',
      includeProvenance: true,
    });
    const objects = r.bindings.map((b) => b['o']);
    expect(objects).not.toContain('"0xAUTHOR"');
    for (const p of r.provenance ?? []) {
      expect(p.sourceGraph).not.toContain('/_meta');
    }
  });

  it('does not leak _meta seal rows on the default (no-view) path — content rows only, annotated', async () => {
    // The default `dkg_query` path omits `view` → legacy routing, whose
    // GRAPH-variable allow-set includes the CG `_meta` graph. Pre-fix, the
    // provenance rewrite surfaced the seal rows (authorAddress / merkleRoot)
    // as content; the lift step must drop them so the result equals the plain
    // query's rows, just annotated.
    const engine = await fixture();
    const r = await engine.query(`SELECT ?s ?o WHERE { ?s ?p ?o }`, {
      contextGraphId: CG,
      includeProvenance: true,
    });
    const objects = r.bindings.map((b) => b['o']);
    expect(objects).toContain('"FromKA_A"');
    expect(objects).toContain('"FromKA_B"');
    // The _meta seal row must NOT appear (it would, pre-fix).
    expect(objects).not.toContain('"0xAUTHOR"');
    expect(r.provenance).toBeDefined();
    expect(r.provenance!).toHaveLength(r.bindings.length);
    for (const p of r.provenance!) {
      expect(p.sourceGraph).not.toContain('_meta');
      expect(p.sourceGraph.endsWith('/_private')).toBe(false);
    }
  });

  it('returns a sourceGraph-only handle for non-per-KA content graphs (per-cgId /context/{id})', async () => {
    // Chain-reconcile / per-cgId materialisation writes confirmed VM data to
    // `…/context/{onChainId}` (see GH #1098), which is NOT the per-KA layout.
    // The handle is honest: sourceGraph is set, identity fields are absent.
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const perCgId = `did:dkg:context-graph:${CG}/context/7`;
    await store.insert([q('https://example.org/c', NAME, '"FromPerCgId"', perCgId)]);
    const r = await engine.query(`SELECT ?s ?o WHERE { ?s <${NAME}> ?o }`, {
      contextGraphId: CG,
      view: 'verifiable-memory',
      includeProvenance: true,
    });
    const idx = r.bindings.findIndex((b) => b['o'] === '"FromPerCgId"');
    expect(idx).toBeGreaterThanOrEqual(0);
    const p = r.provenance![idx];
    expect(p.sourceGraph).toBe(perCgId);
    expect(p.author).toBeUndefined();
    expect(p.kaNumber).toBeUndefined();
  });

  it('handles SELECT * by stripping the reserved variable from each row', async () => {
    const engine = await fixture();
    const r = await engine.query(`SELECT * WHERE { ?s <${NAME}> ?o }`, {
      contextGraphId: CG,
      view: 'verifiable-memory',
      includeProvenance: true,
    });
    expect(r.bindings).toHaveLength(2);
    for (const row of r.bindings) {
      expect(Object.keys(row).some((k) => k.includes('dkgSourceGraph'))).toBe(false);
    }
    expect(r.provenance).toHaveLength(2);
    expect(r.provenance!.every((p) => p.author && p.kaNumber)).toBe(true);
  });

  it('is a no-op for aggregate queries (per-row provenance is meaningless)', async () => {
    const engine = await fixture();
    const r = await engine.query(`SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }`, {
      contextGraphId: CG,
      view: 'verifiable-memory',
      includeProvenance: true,
    });
    expect(r.provenance).toBeUndefined();
    expect(r.bindings).toHaveLength(1);
    expect(r.bindings[0]['n']).toContain('2');
  });

  it('is a no-op when the caller already uses an explicit GRAPH clause', async () => {
    const engine = await fixture();
    const r = await engine.query(`SELECT ?s ?o ?g WHERE { GRAPH ?g { ?s <${NAME}> ?o } }`, {
      contextGraphId: CG,
      view: 'verifiable-memory',
      includeProvenance: true,
    });
    // The user's own ?g projection is honoured; no parallel provenance array.
    expect(r.provenance).toBeUndefined();
    expect(r.bindings.every((row) => typeof row['g'] === 'string')).toBe(true);
  });

  it('omits provenance entirely when not requested (back-compat default off)', async () => {
    const engine = await fixture();
    const r = await engine.query(`SELECT ?s ?o WHERE { ?s <${NAME}> ?o }`, {
      contextGraphId: CG,
      view: 'verifiable-memory',
    });
    expect(r.provenance).toBeUndefined();
    expect(r.bindings).toHaveLength(2);
  });
});
