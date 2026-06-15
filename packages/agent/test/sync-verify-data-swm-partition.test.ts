/**
 * Regression for the data-sync union-corruption fix (#1191).
 *
 * The DATA sync responder over-serves the whole `_shared_memory` subtree under a
 * CG prefix; a blind streaming-apply insert of those quads UNIONS a reconnecting
 * private-CG member into {old,new} for single-valued roots. `parseAndFilterNQuads`
 * now EXCLUDES `_shared_memory` quads from a NON-SWM (durable data/meta) request,
 * while a shared-memory request stays a NO-OP (the dedicated SWM-sync path keeps
 * the base bucket + per-KA subgraphs exactly as before).
 */
import { describe, it, expect } from 'vitest';
import { parseAndFilterNQuads } from '../src/sync-verify-worker-impl.js';

const CG = '0xabc/cg';
const dataGraph = `did:dkg:context-graph:${CG}/context/data`;
const otherData = `did:dkg:context-graph:${CG}/context/other`;
const swmBase = `did:dkg:context-graph:${CG}/_shared_memory`;
const swmPerKa = `did:dkg:context-graph:${CG}/_shared_memory/0xKA/1`;

const nq = (graph: string, s: string) => `<${s}> <urn:p> <urn:o> <${graph}> .`;
// One quad in each graph kind, all under the CG prefix.
const input = [
  nq(dataGraph, 'urn:s1'),
  nq(otherData, 'urn:s2'),
  nq(swmBase, 'urn:s3'),
  nq(swmPerKa, 'urn:s4'),
].join('\n');

const graphsOf = (text: string, graphUri: string) =>
  parseAndFilterNQuads(text, graphUri, CG).quads.map((q) => q.graph);

describe('parseAndFilterNQuads — data/SWM partition (#1191 union-corruption guard)', () => {
  it('a DATA request DROPS _shared_memory quads (no {old,new} union on reconnect)', () => {
    const result = parseAndFilterNQuads(input, dataGraph, CG);
    expect(result.totalQuads).toBe(4); // totalQuads reports the pre-filter count
    const graphs = result.quads.map((q) => q.graph);
    expect(graphs).toContain(dataGraph); // the request graph is kept
    expect(graphs).toContain(otherData); // other (non-SWM) data subgraph kept
    expect(graphs).not.toContain(swmBase); // base _shared_memory dropped
    expect(graphs).not.toContain(swmPerKa); // per-KA _shared_memory dropped
  });

  it('a meta DATA request also drops _shared_memory (any non-SWM graphUri)', () => {
    const metaGraph = `did:dkg:context-graph:${CG}/_meta`;
    const graphs = graphsOf([...input.split('\n'), nq(metaGraph, 'urn:s5')].join('\n'), metaGraph);
    expect(graphs).toContain(metaGraph);
    expect(graphs).not.toContain(swmBase);
    expect(graphs).not.toContain(swmPerKa);
  });

  it('a SWM request is a NO-OP — keeps the base bucket AND per-KA _shared_memory subgraphs', () => {
    const graphs = graphsOf(input, swmBase);
    expect(graphs).toContain(swmBase); // request graph
    expect(graphs).toContain(swmPerKa); // per-KA SWM subgraph kept (the no-op invariant)
  });

  it('a per-KA SWM request keeps both that subgraph and the base bucket (swmRequest=true)', () => {
    const graphs = graphsOf(input, swmPerKa);
    expect(graphs).toContain(swmPerKa);
    expect(graphs).toContain(swmBase);
  });
});
