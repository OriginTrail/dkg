/**
 * Liveness/regression tests for two sub-graph query-scoping bugs.
 *
 *  GH #184 — "Enable subGraphName scoping with view-based routing in the query
 *            engine". The engine throws outright when `subGraphName` is combined
 *            with a `view`, so there is no way to read a named sub-graph through
 *            the WM/SWM/VM views. https://github.com/OriginTrail/dkg/issues/184
 *
 *  GH #675 — "dkg_query view:'working-memory' does not include data from
 *            sub-graphs". A `view:'working-memory'` read (without subGraphName)
 *            only scans the context-graph-root WM partition and silently
 *            excludes assertions that live in a named sub-graph.
 *            https://github.com/OriginTrail/dkg/issues/675
 *
 * Both are encoded as `it.fails` — the assertion of the CORRECT behaviour fails
 * today (bug live). When the engine learns to scope/include sub-graph WM data,
 * these flip to passing → `it.fails` turns RED → drop `.fails`, make them plain
 * `it(...)`, and close #184 / #675.
 *
 * Hermetic: in-memory OxigraphStore seeded with the exact uniform-layout WM
 * graph URIs (`contextGraphLayerUri`), zero mocks, zero chain.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { contextGraphLayerUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';

// Opt-in gate: these repros assert post-fix behaviour, so they are RED while
// the bug is live. They are EXCLUDED from the default test lane (which must stay
// green / mergeable) and run only under `RUN_ISSUE_LIVENESS=1` (the dedicated
// issue-liveness CI lane). See package.json `test:issue-liveness`.
const LIVENESS_ENABLED = process.env.RUN_ISSUE_LIVENESS === '1';


const CG = 'subgraph-view-cg';
const ADDR = '0x1111111111111111111111111111111111111111';
const SUB = 'research-alpha';
const NAME = 'http://schema.org/name';

const ROOT_ENTITY = 'https://example.org/root-entity';
const SUB_ENTITY = 'https://example.org/subgraph-entity';

// Root-level WM partition:    …/_working_memory/{addr}/1
// Sub-graph WM partition:     …/{sub}/_working_memory/{addr}/2
const ROOT_WM_GRAPH = contextGraphLayerUri(CG, MemoryLayer.WorkingMemory, ADDR, 1);
const SUB_WM_GRAPH = contextGraphLayerUri(CG, MemoryLayer.WorkingMemory, ADDR, 2, SUB);

function q(s: string, p: string, o: string, g: string) {
  return { subject: s, predicate: p, object: o, graph: g };
}

describe.runIf(LIVENESS_ENABLED)('GH #184 / #675 — sub-graph scoping in view-based WM reads', () => {
  let store: OxigraphStore;
  let engine: DKGQueryEngine;

  beforeEach(async () => {
    store = new OxigraphStore();
    engine = new DKGQueryEngine(store);
    await store.insert([
      q(ROOT_ENTITY, NAME, '"RootEntity"', ROOT_WM_GRAPH),
      q(SUB_ENTITY, NAME, '"SubGraphEntity"', SUB_WM_GRAPH),
    ]);
  });

  // Control: proves the seed + WM-view query path actually work, so the
  // it.fails below cannot pass for the wrong reason.
  it('CONTROL: WM view returns the context-graph-root entity', async () => {
    const result = await engine.query(
      `SELECT ?s ?o WHERE { ?s <${NAME}> ?o }`,
      { contextGraphId: CG, view: 'working-memory', agentAddress: ADDR },
    );
    const subjects = result.bindings.map((b) => b['s']);
    expect(subjects).toContain(ROOT_ENTITY);
  });

  it(
    'GH #675: WM view (no subGraphName) ALSO includes sub-graph WM data',
    async () => {
      const result = await engine.query(
        `SELECT ?s ?o WHERE { ?s <${NAME}> ?o }`,
        { contextGraphId: CG, view: 'working-memory', agentAddress: ADDR },
      );
      const subjects = result.bindings.map((b) => b['s']);
      expect(subjects).toContain(SUB_ENTITY);
    },
  );

  it(
    'GH #184: WM view + subGraphName scopes to the sub-graph instead of throwing',
    async () => {
      const result = await engine.query(
        `SELECT ?s ?o WHERE { ?s <${NAME}> ?o }`,
        {
          contextGraphId: CG,
          view: 'working-memory',
          agentAddress: ADDR,
          subGraphName: SUB,
        },
      );
      const subjects = result.bindings.map((b) => b['s']);
      expect(subjects).toContain(SUB_ENTITY);
      expect(subjects).not.toContain(ROOT_ENTITY);
    },
  );
});
