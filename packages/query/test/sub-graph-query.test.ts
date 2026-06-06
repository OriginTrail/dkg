import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  contextGraphAssertionUri,
  contextGraphDataUri,
  contextGraphMetaUri,
  contextGraphSharedMemoryUri,
  contextGraphSubGraphUri,
} from '@origintrail-official/dkg-core';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';

const CG_ID = 'dkg-v10-dev';
const AGENT = '0xAbC0000000000000000000000000000000000001';
const OTHER_AGENT = '0xDeAd000000000000000000000000000000000002';
const ROOT_GRAPH = contextGraphDataUri(CG_ID);
const CODE_GRAPH = contextGraphSubGraphUri(CG_ID, 'code');
const DECISIONS_GRAPH = contextGraphSubGraphUri(CG_ID, 'decisions');
const ROOT_WM_GRAPH = contextGraphAssertionUri(CG_ID, AGENT, 'probe-root');
const CODE_WM_GRAPH = contextGraphAssertionUri(CG_ID, AGENT, 'probe', 'code');
const CODE_WM_SIBLING_GRAPH = contextGraphAssertionUri(CG_ID, AGENT, 'probe-sibling', 'code');
const DECISIONS_WM_GRAPH = contextGraphAssertionUri(CG_ID, AGENT, 'probe', 'decisions');
const OTHER_AGENT_CODE_WM_GRAPH = contextGraphAssertionUri(CG_ID, OTHER_AGENT, 'probe', 'code');
const ROOT_SWM_GRAPH = contextGraphSharedMemoryUri(CG_ID);
const CODE_SWM_GRAPH = contextGraphSharedMemoryUri(CG_ID, 'code');
const DECISIONS_SWM_GRAPH = contextGraphSharedMemoryUri(CG_ID, 'decisions');
const VIEW_NAME = 'http://ex.org/viewName';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const CONTEXT_GRAPH_TYPE = 'https://dkg.network/ontology#ContextGraph';

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

      q('urn:view:vm-root', VIEW_NAME, '"VMRoot"', ROOT_GRAPH),
      q('urn:view:vm-code', VIEW_NAME, '"VMCode"', CODE_GRAPH),
      q('urn:view:vm-decisions', VIEW_NAME, '"VMDecisions"', DECISIONS_GRAPH),

      q('urn:view:wm-root', VIEW_NAME, '"WMRoot"', ROOT_WM_GRAPH),
      q('urn:view:wm-code', VIEW_NAME, '"WMCode"', CODE_WM_GRAPH),
      q('urn:view:wm-code-sibling', VIEW_NAME, '"WMSiblingAssertion"', CODE_WM_SIBLING_GRAPH),
      q('urn:view:wm-decisions', VIEW_NAME, '"WMDecisions"', DECISIONS_WM_GRAPH),
      q('urn:view:wm-other-agent', VIEW_NAME, '"WMOtherAgent"', OTHER_AGENT_CODE_WM_GRAPH),

      q('urn:view:swm-root', VIEW_NAME, '"SWMRoot"', ROOT_SWM_GRAPH),
      q('urn:view:swm-code', VIEW_NAME, '"SWMCode"', CODE_SWM_GRAPH),
      q('urn:view:swm-decisions', VIEW_NAME, '"SWMDecisions"', DECISIONS_SWM_GRAPH),
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

  it('queries a sub-graph working-memory view without leaking root, sibling, or other-agent WM', async () => {
    const result = await engine.query(
      `SELECT ?name WHERE { ?s <${VIEW_NAME}> ?name }`,
      { contextGraphId: CG_ID, view: 'working-memory', agentAddress: AGENT, subGraphName: 'code' },
    );
    expect(result.bindings.map((b) => b['name']).sort()).toEqual([
      '"WMCode"',
      '"WMSiblingAssertion"',
    ]);
  });

  it('queries a sub-graph shared-working-memory view without root or sibling sub-graph leakage', async () => {
    const result = await engine.query(
      `SELECT ?name WHERE { ?s <${VIEW_NAME}> ?name }`,
      { contextGraphId: CG_ID, view: 'shared-working-memory', subGraphName: 'code' },
    );
    expect(result.bindings.map((b) => b['name'])).toEqual(['"SWMCode"']);
  });

  it('queries a sub-graph verified-memory view without root or sibling sub-graph leakage', async () => {
    const result = await engine.query(
      `SELECT ?name WHERE { ?s <${VIEW_NAME}> ?name }`,
      { contextGraphId: CG_ID, view: 'verified-memory', subGraphName: 'code' },
    );
    expect(result.bindings.map((b) => b['name'])).toEqual(['"VMCode"']);
  });

  it('queries one sub-graph WM assertion when subGraphName and assertionName are both supplied', async () => {
    const result = await engine.query(
      `SELECT ?name WHERE { ?s <${VIEW_NAME}> ?name }`,
      {
        contextGraphId: CG_ID,
        view: 'working-memory',
        agentAddress: AGENT,
        subGraphName: 'code',
        assertionName: 'probe',
      },
    );
    expect(result.bindings.map((b) => b['name'])).toEqual(['"WMCode"']);
  });

  it('constrains GRAPH patterns to the selected sub-graph WM assertion', async () => {
    const result = await engine.query(
      `SELECT ?g ?name WHERE { GRAPH ?g { ?s <${VIEW_NAME}> ?name } }`,
      {
        contextGraphId: CG_ID,
        view: 'working-memory',
        agentAddress: AGENT,
        subGraphName: 'code',
        assertionName: 'probe',
      },
    );
    expect(result.bindings).toEqual([
      { g: CODE_WM_GRAPH, name: '"WMCode"' },
    ]);
  });

  it('constrains GRAPH patterns to the selected sub-graph SWM graph', async () => {
    const result = await engine.query(
      `SELECT ?g ?name WHERE { GRAPH ?g { ?s <${VIEW_NAME}> ?name } }`,
      { contextGraphId: CG_ID, view: 'shared-working-memory', subGraphName: 'code' },
    );
    expect(result.bindings).toEqual([
      { g: CODE_SWM_GRAPH, name: '"SWMCode"' },
    ]);
  });

  it('constrains GRAPH patterns to the selected sub-graph VM graph', async () => {
    const result = await engine.query(
      `SELECT ?g ?name WHERE { GRAPH ?g { ?s <${VIEW_NAME}> ?name } }`,
      { contextGraphId: CG_ID, view: 'verified-memory', subGraphName: 'code' },
    );
    expect(result.bindings).toEqual([
      { g: CODE_GRAPH, name: '"VMCode"' },
    ]);
  });

  it('rejects view-routed sub-graph scope that aliases a known child context graph', async () => {
    const childContextGraphId = `${CG_ID}/code`;
    const childContextGraphUri = contextGraphDataUri(childContextGraphId);
    await store.insert([
      q(childContextGraphUri, RDF_TYPE, CONTEXT_GRAPH_TYPE, contextGraphMetaUri(childContextGraphId)),
    ]);

    await expect(engine.query(
      `SELECT ?name WHERE { ?s <${VIEW_NAME}> ?name }`,
      { contextGraphId: CG_ID, view: 'working-memory', agentAddress: AGENT, subGraphName: 'code' },
    )).rejects.toThrow(/known child context graph/);
    await expect(engine.query(
      `SELECT ?name WHERE { ?s <${VIEW_NAME}> ?name }`,
      { contextGraphId: CG_ID, view: 'shared-working-memory', subGraphName: 'code' },
    )).rejects.toThrow(/known child context graph/);
    await expect(engine.query(
      `SELECT ?name WHERE { ?s <${VIEW_NAME}> ?name }`,
      { contextGraphId: CG_ID, view: 'verified-memory', subGraphName: 'code' },
    )).rejects.toThrow(/known child context graph/);
  });
});
