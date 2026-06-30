import { describe, it, expect } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';

const CG = 'finalization-chain-e2e';
const ROOT = `did:dkg:context-graph:${CG}`;
const PER_CGID = `${ROOT}/context/7`;            // <cg>/context/<ctxGraphId>
const VM = `${ROOT}/_verifiable_memory/0xAA/1`;  // per-KA VM
const ENTITY = 'urn:finalization-chain:entity:1';
const NAME = 'http://schema.org/name';

function q(s: string, p: string, o: string, g: string): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

const SPARQL = `SELECT ?name WHERE { <${ENTITY}> <${NAME}> ?name }`;

// #1270: a scoped read-both query unions the canonical root graph with the
// per-cgId and per-KA …/_verifiable_memory partitions. Finalization intentionally
// DUAL-HOMES the same triple (PR #1098 + the canonical mirror), so the union must
// collapse identical rows to ONE binding — else the e2e-finalization "B promotes"
// query returns 2. wrapWithGraphUnion now emits SELECT DISTINCT for this reason.
describe('scoped read-both query dedups dual-homed triples (#1270)', () => {
  it('root + per-cgId partition', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    await store.insert([
      q(ENTITY, NAME, '"Finalization Chain Draft"', ROOT),
      q(ENTITY, NAME, '"Finalization Chain Draft"', PER_CGID),
    ]);
    const r = await engine.query(SPARQL, { contextGraphId: CG });
    expect(r.bindings.length).toBe(1); // dual-homed triple collapses to ONE binding
    expect(r.bindings[0]['name']).toBe('"Finalization Chain Draft"');
  });

  it('root + per-KA VM partition', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    await store.insert([
      q(ENTITY, NAME, '"Finalization Chain Draft"', ROOT),
      q(ENTITY, NAME, '"Finalization Chain Draft"', VM),
    ]);
    const r = await engine.query(SPARQL, { contextGraphId: CG });
    expect(r.bindings.length).toBe(1); // dual-homed triple collapses to ONE binding
    expect(r.bindings[0]['name']).toBe('"Finalization Chain Draft"');
  });

  it('root only', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    await store.insert([
      q(ENTITY, NAME, '"Finalization Chain Draft"', ROOT),
    ]);
    const r = await engine.query(SPARQL, { contextGraphId: CG });
    expect(r.bindings.length).toBe(1); // dual-homed triple collapses to ONE binding
    expect(r.bindings[0]['name']).toBe('"Finalization Chain Draft"');
  });

  it('per-cgId + per-KA VM (no root)', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    await store.insert([
      q(ENTITY, NAME, '"Finalization Chain Draft"', PER_CGID),
      q(ENTITY, NAME, '"Finalization Chain Draft"', VM),
    ]);
    const r = await engine.query(SPARQL, { contextGraphId: CG });
    expect(r.bindings.length).toBe(1); // dual-homed triple collapses to ONE binding
    expect(r.bindings[0]['name']).toBe('"Finalization Chain Draft"');
  });
});
