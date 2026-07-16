import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { contextGraphLayerUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';

const CG_ID = 'dkg-v10-dev';
const ROOT_GRAPH = `did:dkg:context-graph:${CG_ID}`;
const CODE_GRAPH = `did:dkg:context-graph:${CG_ID}/code`;
const DECISIONS_GRAPH = `did:dkg:context-graph:${CG_ID}/decisions`;

function q(s: string, p: string, o: string, g: string): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

describe('sub-graph query scoping', () => {
  let store: OxigraphStore;
  let engine: DKGQueryEngine;

  beforeEach(async () => {
    store = new OxigraphStore();
    engine = new DKGQueryEngine(store);

    await store.insert([
      q('urn:fn:main', 'http://ex.org/type', '"Function"', ROOT_GRAPH),
      q('urn:fn:main', 'http://ex.org/name', '"main"', ROOT_GRAPH),

      q('urn:fn:parse', 'http://ex.org/type', '"Function"', CODE_GRAPH),
      q('urn:fn:parse', 'http://ex.org/signature', '"parse(input: string)"', CODE_GRAPH),

      q('urn:decision:1', 'http://ex.org/type', '"Decision"', DECISIONS_GRAPH),
      q('urn:decision:1', 'http://ex.org/title', '"Use TypeScript"', DECISIONS_GRAPH),
    ]);
  });

  it('queries root data graph without subGraphName', async () => {
    const result = await engine.query(
      'SELECT ?s ?name WHERE { ?s <http://ex.org/name> ?name }',
      { contextGraphId: CG_ID },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['name']).toBe('"main"');
  });

  it('queries code sub-graph with subGraphName', async () => {
    const result = await engine.query(
      'SELECT ?s ?sig WHERE { ?s <http://ex.org/signature> ?sig }',
      { contextGraphId: CG_ID, subGraphName: 'code' },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['sig']).toBe('"parse(input: string)"');
  });

  it('queries decisions sub-graph with subGraphName', async () => {
    const result = await engine.query(
      'SELECT ?s ?title WHERE { ?s <http://ex.org/title> ?title }',
      { contextGraphId: CG_ID, subGraphName: 'decisions' },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['title']).toBe('"Use TypeScript"');
  });

  it('sub-graph isolation: code query does not see decisions', async () => {
    const result = await engine.query(
      'SELECT ?s ?p ?o WHERE { ?s ?p ?o }',
      { contextGraphId: CG_ID, subGraphName: 'code' },
    );
    const subjects = result.bindings.map(b => b['s']);
    expect(subjects).toContain('urn:fn:parse');
    expect(subjects).not.toContain('urn:decision:1');
  });

  it('sub-graph isolation: decisions query does not see code', async () => {
    const result = await engine.query(
      'SELECT ?s ?p ?o WHERE { ?s ?p ?o }',
      { contextGraphId: CG_ID, subGraphName: 'decisions' },
    );
    const subjects = result.bindings.map(b => b['s']);
    expect(subjects).toContain('urn:decision:1');
    expect(subjects).not.toContain('urn:fn:parse');
  });

  it('empty sub-graph returns no results', async () => {
    const result = await engine.query(
      'SELECT ?s ?p ?o WHERE { ?s ?p ?o }',
      { contextGraphId: CG_ID, subGraphName: 'nonexistent' },
    );
    expect(result.bindings).toHaveLength(0);
  });

  // GH #184 / #675 — view-based routing now scopes to / includes sub-graphs.
  describe('GH #184 / #675 — sub-graph scoping under view-based routing', () => {
    const ADDR = '0x1111111111111111111111111111111111111111';
    const NAME = 'http://schema.org/name';
    const ROOT_ENTITY = 'https://example.org/root-entity';
    const SUB_ENTITY = 'https://example.org/subgraph-entity';
    const ROOT_WM = contextGraphLayerUri(CG_ID, MemoryLayer.WorkingMemory, ADDR, 1);
    const SUB_WM = contextGraphLayerUri(CG_ID, MemoryLayer.WorkingMemory, ADDR, 2, 'code');
    const META = `did:dkg:context-graph:${CG_ID}/_meta`;
    const SUBGRAPH_URN = `urn:dkg:subgraph:${CG_ID}:code`;

    beforeEach(async () => {
      await store.insert([
        { subject: ROOT_ENTITY, predicate: NAME, object: '"RootEntity"', graph: ROOT_WM },
        { subject: SUB_ENTITY, predicate: NAME, object: '"SubGraphEntity"', graph: SUB_WM },
        // Register the `code` sub-graph in `_meta` (the authoritative registry
        // the engine fans out over for #675).
        { subject: SUBGRAPH_URN, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph', graph: META },
        { subject: SUBGRAPH_URN, predicate: 'http://schema.org/name', object: '"code"', graph: META },
      ]);
    });

    it('#675: WM view (no subGraphName) includes BOTH root and sub-graph data', async () => {
      const result = await engine.query(
        `SELECT ?s ?o WHERE { ?s <${NAME}> ?o }`,
        { contextGraphId: CG_ID, view: 'working-memory', agentAddress: ADDR },
      );
      const subjects = result.bindings.map((b) => b['s']);
      expect(subjects).toContain(ROOT_ENTITY);
      expect(subjects).toContain(SUB_ENTITY);
    });

    it('#184: WM view + subGraphName scopes to the sub-graph (no throw)', async () => {
      const result = await engine.query(
        `SELECT ?s ?o WHERE { ?s <${NAME}> ?o }`,
        { contextGraphId: CG_ID, view: 'working-memory', agentAddress: ADDR, subGraphName: 'code' },
      );
      const subjects = result.bindings.map((b) => b['s']);
      expect(subjects).toContain(SUB_ENTITY);
      expect(subjects).not.toContain(ROOT_ENTITY);
    });

    // Codex review on PR #1132: the by-name WM read must be sub-graph aware end
    // to end — both the `dkg:kaId` lifecycle lookup (root `_meta`, sub-aware
    // URN) and the single-graph URI (uniform layout + legacy fallback).
    describe('by-name WM read (assertionName) is sub-graph aware', () => {
      const ASSERTION = 'sub-note';

      it('resolves the kaNumber from the sub-aware lifecycle URN and reads the per-KA sub-graph layer', async () => {
        // Writer shape (`assertionFinalize`): kaId stamped in ROOT `_meta`,
        // keyed by `urn:dkg:assertion:{cg}:{sub}:{addr}:{name}`; data in
        // `…/{sub}/_working_memory/{addr}/{number}`.
        const SUB_BYNAME_WM = contextGraphLayerUri(CG_ID, MemoryLayer.WorkingMemory, ADDR, 7, 'code');
        await store.insert([
          { subject: 'https://example.org/byname', predicate: NAME, object: '"ByNameSub"', graph: SUB_BYNAME_WM },
          {
            subject: `urn:dkg:assertion:${CG_ID}:code:${ADDR}:${ASSERTION}`,
            predicate: 'http://dkg.io/ontology/kaId',
            object: '"7"^^<http://www.w3.org/2001/XMLSchema#integer>',
            graph: META,
          },
        ]);
        const result = await engine.query(
          `SELECT ?s ?o WHERE { ?s <${NAME}> ?o }`,
          { contextGraphId: CG_ID, view: 'working-memory', agentAddress: ADDR, subGraphName: 'code', assertionName: ASSERTION },
        );
        expect(result.bindings.map((b) => b['s'])).toEqual(['https://example.org/byname']);
      });

      it('falls back to the sub-graph name-keyed assertion graph when no kaId stamp exists', async () => {
        const LEGACY_SUB_ASSERTION = `did:dkg:context-graph:${CG_ID}/code/assertion/${ADDR}/${ASSERTION}`;
        await store.insert([
          { subject: 'https://example.org/legacy', predicate: NAME, object: '"LegacySub"', graph: LEGACY_SUB_ASSERTION },
        ]);
        const result = await engine.query(
          `SELECT ?s ?o WHERE { ?s <${NAME}> ?o }`,
          { contextGraphId: CG_ID, view: 'working-memory', agentAddress: ADDR, subGraphName: 'code', assertionName: ASSERTION },
        );
        expect(result.bindings.map((b) => b['s'])).toEqual(['https://example.org/legacy']);
      });

      it('does NOT leak the ROOT assertion of the same name into a sub-graph by-name read', async () => {
        // Same assertion name exists at the ROOT (different lifecycle URN +
        // graph). The sub-graph read must not return it.
        const ROOT_BYNAME_WM = contextGraphLayerUri(CG_ID, MemoryLayer.WorkingMemory, ADDR, 9);
        await store.insert([
          { subject: 'https://example.org/root-byname', predicate: NAME, object: '"ByNameRoot"', graph: ROOT_BYNAME_WM },
          {
            subject: `urn:dkg:assertion:${CG_ID}:${ADDR}:${ASSERTION}`,
            predicate: 'http://dkg.io/ontology/kaId',
            object: '"9"^^<http://www.w3.org/2001/XMLSchema#integer>',
            graph: META,
          },
        ]);
        const result = await engine.query(
          `SELECT ?s ?o WHERE { ?s <${NAME}> ?o }`,
          { contextGraphId: CG_ID, view: 'working-memory', agentAddress: ADDR, subGraphName: 'code', assertionName: ASSERTION },
        );
        expect(result.bindings.map((b) => b['s'])).not.toContain('https://example.org/root-byname');
      });
    });
  });

  // Codex #1132 review — verifiable-memory sub-graph scoping fixes.
  describe('Codex #1132 — verifiable-memory sub-graph scoping', () => {
    const VADDR = '0x2222222222222222222222222222222222222222';
    const VNAME = 'http://schema.org/name';
    const VMETA = `did:dkg:context-graph:${CG_ID}/_meta`;
    const VSUBGRAPH_URN = `urn:dkg:subgraph:${CG_ID}:code`;
    const SUB_ROOT = `did:dkg:context-graph:${CG_ID}/code`; // sub-graph ROOT graph
    const SUB_VM = contextGraphLayerUri(CG_ID, MemoryLayer.VerifiableMemory, VADDR, 1, 'code');

    beforeEach(async () => {
      await store.insert([
        // Register `code` so the #675 fan-out would discover it when it runs.
        { subject: VSUBGRAPH_URN, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph', graph: VMETA },
        { subject: VSUBGRAPH_URN, predicate: 'http://schema.org/name', object: '"code"', graph: VMETA },
        // Confirmed / intentional-local sub-graph publishes land in the sub-graph ROOT graph.
        { subject: 'urn:vm:sub-root', predicate: VNAME, object: '"SubRootVM"', graph: SUB_ROOT },
        // A sub-graph VM partition — what the fan-out would union in.
        { subject: 'urn:vm:sub-partition', predicate: VNAME, object: '"SubPartitionVM"', graph: SUB_VM },
      ]);
    });

    it('A: VM view + subGraphName includes the sub-graph ROOT graph (previously graphs:[] → missed confirmed data)', async () => {
      const result = await engine.query(
        `SELECT ?s ?o WHERE { ?s <${VNAME}> ?o }`,
        { contextGraphId: CG_ID, view: 'verifiable-memory', subGraphName: 'code' },
      );
      expect(result.bindings.map((b) => b['s'])).toContain('urn:vm:sub-root');
    });

    it('C: VM view + verifiedGraph does NOT fan out across sub-graph VM partitions', async () => {
      const result = await engine.query(
        `SELECT ?s ?o WHERE { ?s <${VNAME}> ?o }`,
        { contextGraphId: CG_ID, view: 'verifiable-memory', verifiedGraph: 'team-a' },
      );
      expect(result.bindings.map((b) => b['s'])).not.toContain('urn:vm:sub-partition');
    });
  });
});
