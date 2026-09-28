import { createHash } from 'node:crypto';

import { DKGQueryEngine } from '@origintrail-official/dkg-query';
import type { SemanticQueryOutputSchema, SemanticSparqlReadGrant } from '@origintrail-official/dkg-semantic-runtime';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { queryOutputSchemaSha256 } from '../src/semantic-runtime-query-pins.js';
import { assertSparqlReadOutput, createSparqlReadAdapter, validateSparqlReadGrant } from '../src/semantic-runtime-sparql-adapter.js';

const executor = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const cg = 'dmaast-kamstrup';
const root = `did:dkg:context-graph:${cg}`;
const graph = { wm: `${root}/_working_memory/${executor}/1`, swm: `${root}/_shared_memory/${executor}/1`, vm: `${root}/_verifiable_memory/${executor}/1` };
const term: SemanticQueryOutputSchema = { type: 'string', maxLength: 4096 };
const schema: SemanticQueryOutputSchema = {
  type: 'object', additionalProperties: false, required: ['bindings'], properties: {
    bindings: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false, required: [],
      properties: { s: term, p: term, o: term, g: term, result: term, n: term } } },
    quads: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false, required: ['subject', 'predicate', 'object', 'graph'],
      properties: { subject: term, predicate: term, object: term, graph: term } } },
  },
};
function grant(layer: 'wm' | 'swm' | 'vm' = 'wm'): SemanticSparqlReadGrant {
  return { toolIri: 'urn:sr:tool:sparql-read', layer, timeoutMs: 5000, maxResultItems: 100, maxOutputBytes: 65_536,
    outputSchema: schema, outputSchemaSha256: queryOutputSchemaSha256(schema) };
}
function fixture(approved = grant()) {
  const agent = { canReadContextGraph: vi.fn(async () => true), canUseSharedMemoryForContextGraph: vi.fn(async () => true),
    query: vi.fn(async (_sparql: string, _opts: any): Promise<any> => ({ bindings: [{ o: '"WM"' }] })) };
  const authorized = vi.fn(async () => {});
  const adapter = createSparqlReadAdapter(agent as any, cg, executor, approved, authorized);
  const run = (sparql = 'SELECT ?o WHERE { <urn:kamstrup:device:W10> <urn:dmaast:status> ?o }') => adapter.dispatch({} as any, { sparql });
  return { adapter, agent, authorized, run };
}
afterEach(() => vi.useRealTimers());

describe('explicit raw SPARQL read capability', () => {
  it.each([null, {}, { ...grant(), layer: 'all' }, { ...grant(), layer: ['wm'] }, { ...grant(), timeoutMs: 30_001 }, { ...grant(), maxResultItems: 1001 },
    { ...grant(), maxOutputBytes: 1_048_577 }, { ...grant(), contextGraphId: 'jpb' }, { ...grant(), outputSchemaSha256: '0'.repeat(64) }])('rejects invalid or widened approval %j', (value) => {
    expect(() => validateSparqlReadGrant(value)).toThrow();
  });
  it.each([{}, { sparql: '' }, { sparql: 'ASK {}', layer: 'vm' }, { sparql: 'ASK {}', contextGraphId: 'jpb' }, { sparql: 'x'.repeat(65_537) }])('rejects invalid input and caller scope overrides %j', async (value) => {
    const f = fixture();
    await expect(f.adapter.dispatch({} as any, value as any)).rejects.toThrow();
    expect(f.agent.query).not.toHaveBeenCalled();
  });
  it.each([
    'INSERT DATA { <urn:a> <urn:b> <urn:c> }', 'DELETE WHERE { ?s ?p ?o }', 'CLEAR ALL', 'LOAD <https://example.test>',
    'SELECT * WHERE {} ; DROP ALL', 'SELECT * WHERE { SERVICE <https://example.test> { ?s ?p ?o } }',
    'SELECT * FROM <urn:jpb> WHERE { ?s ?p ?o }', 'SELECT * FROM NAMED <urn:jpb> WHERE { GRAPH ?g { ?s ?p ?o } }',
    String.raw`SELECT * WHERE { S\u0045RVICE <https://example.test> { ?s ?p ?o } }`,
    String.raw`SELECT * FR\u004FM <urn:jpb> WHERE { ?s ?p ?o }`,
    String.raw`D\u0052OP ALL`, String.raw`SELECT * WHERE { \u005Cu0053ERVICE <urn:x> {} }`,
    'SELECT * WHERE { ?s ?p ?o', 'SELECT * WHERE { ?s ?p "unterminated }',
  ])('rejects unsafe SPARQL before dispatch: %s', async (query) => {
    const f = fixture(); await expect(f.run(query)).rejects.toThrow(); expect(f.agent.query).not.toHaveBeenCalled();
  });
  it('does not mistake quoted, prefixed or variable names for active forbidden keywords', () => {
    const query = 'PREFIX ex: <urn:ex:> SELECT ?SERVICE WHERE { ?s ex:INSERT ?SERVICE . FILTER(?SERVICE = "SERVICE DROP FROM") } # LOAD\n';
    expect(fixture().adapter.validateInput({ sparql: query })).toEqual({ sparql: query });
  });
  it.each(['wm', 'swm', 'vm'] as const)('fixes graph, executor and %s view independently of the query text', async (layer) => {
    const f = fixture(grant(layer)); const outcome = await f.run();
    const opts = f.agent.query.mock.calls[0][1];
    expect(opts).toMatchObject({ contextGraphId: cg, callerAgentAddress: executor,
      view: { wm: 'working-memory', swm: 'shared-working-memory', vm: 'verifiable-memory' }[layer], signal: expect.any(AbortSignal) });
    expect(opts.agentAddress).toBe(layer === 'wm' ? executor : undefined);
    const output = JSON.parse(outcome.output as string);
    expect(output).toMatchObject({ kind: 'sparql-read', contextGraphId: cg, layer,
      querySha256: createHash('sha256').update(f.agent.query.mock.calls[0][0]).digest('hex') });
    expect(() => assertSparqlReadOutput(grant(layer), cg, outcome.output as string)).not.toThrow();
    expect(() => assertSparqlReadOutput(grant(layer), 'dmaast-jpb', outcome.output as string)).toThrow('SPARQL_OUTPUT_SCOPE_MISMATCH');
  });
  it('rechecks tenant approval and graph authority after the read', async () => {
    const f = fixture(); f.agent.query.mockImplementation(async () => { f.agent.canReadContextGraph.mockResolvedValue(false); return { bindings: [] }; });
    await expect(f.run()).rejects.toThrow('SPARQL_CONTEXT_GRAPH_ACCESS_DENIED');
    const revoked = fixture(); revoked.agent.query.mockImplementation(async () => { revoked.authorized.mockRejectedValue(new Error('REVOKED')); return { bindings: [] }; });
    await expect(revoked.run()).rejects.toThrow('REVOKED');
  });
  it('fails closed before dispatch if access or SWM admission is unavailable', async () => {
    const f = fixture(); f.agent.canReadContextGraph.mockResolvedValue(false);
    await expect(f.run()).rejects.toThrow('SPARQL_CONTEXT_GRAPH_ACCESS_DENIED'); expect(f.agent.query).not.toHaveBeenCalled();
    const swm = fixture(grant('swm')); swm.agent.canUseSharedMemoryForContextGraph.mockResolvedValue(false);
    await expect(swm.run()).rejects.toThrow('SPARQL_SHARED_MEMORY_UNAVAILABLE'); expect(swm.agent.query).not.toHaveBeenCalled();
  });
  it.each([
    { bindings: Array(101).fill({}) }, { bindings: [], quads: Array(101).fill({}) },
    { bindings: [{ unapproved: 'secret' }] }, { bindings: [{ o: 'x'.repeat(4097) }] }, null,
  ])('rejects excessive or unapproved returned data %j', async (result) => {
    const f = fixture(); f.agent.query.mockResolvedValue(result); await expect(f.run()).rejects.toThrow();
  });
  it('bounds the complete serialized envelope and applies the same checks to replay', async () => {
    const f = fixture({ ...grant(), maxOutputBytes: 20 }); await expect(f.run()).rejects.toThrow();
    const output = JSON.stringify({ kind: 'sparql-read', contextGraphId: cg, layer: 'wm', querySha256: '0'.repeat(64), result: { bindings: [{ secret: 'not approved' }] } });
    expect(() => assertSparqlReadOutput(grant(), cg, output)).toThrow('SEMANTIC_QUERY_OUTPUT_SCHEMA_MISMATCH');
  });
  it('aborts an overdue query and never returns a late result', async () => {
    vi.useFakeTimers(); const f = fixture({ ...grant(), timeoutMs: 100 });
    let release!: (value: unknown) => void;
    f.agent.query.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const outcome = expect(f.run()).rejects.toThrow('SPARQL_QUERY_TIMEOUT');
    await vi.advanceTimersByTimeAsync(100); await outcome;
    expect(f.agent.query.mock.calls[0][1].signal.aborted).toBe(true);
    release({ bindings: [] }); await Promise.resolve();
  });
  it('does not dispatch after an authorization check exceeds the deadline', async () => {
    vi.useFakeTimers(); const f = fixture({ ...grant(), timeoutMs: 100 });
    let release!: () => void; f.authorized.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const outcome = expect(f.run()).rejects.toThrow('SPARQL_QUERY_TIMEOUT');
    await vi.advanceTimersByTimeAsync(100); await outcome; release();
    await vi.advanceTimersByTimeAsync(1); expect(f.agent.query).not.toHaveBeenCalled();
  });
});

describe('raw read adapter through the real DKG query engine', () => {
  async function real(layer: 'wm' | 'swm' | 'vm' = 'wm') {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const locations = [...Object.entries(graph), ['OTHER_AGENT', `${root}/_working_memory/${other}/1`],
      ['OTHER_TENANT', 'did:dkg:context-graph:dmaast-jpb/_working_memory/' + executor + '/1'], ['META', `${root}/_meta`]];
    await store.insert(locations.map(([label, at]) => ({ graph: at, subject: 'urn:kamstrup:device:W10', predicate: 'urn:dmaast:status', object: JSON.stringify(label) })));
    const f = fixture(grant(layer)); f.agent.query.mockImplementation((query, opts) => engine.query(query, opts));
    return f;
  }
  it.each(['wm', 'swm', 'vm'] as const)('returns only the approved %s content from a mixed tenant/layer store', async (layer) => {
    const f = await real(layer); const value = await f.run();
    expect(JSON.parse(value.output as string).result.bindings).toEqual([{ o: JSON.stringify(layer) }]);
    const variableGraph = await f.run('SELECT ?g ?o WHERE { GRAPH ?g { <urn:kamstrup:device:W10> <urn:dmaast:status> ?o } }');
    expect(JSON.parse(variableGraph.output as string).result.bindings).toEqual([{ g: graph[layer], o: JSON.stringify(layer) }]);
  });
  it.each([graph.swm, graph.vm, `${root}/_working_memory/${other}/1`, `${root}/_meta`, 'did:dkg:context-graph:dmaast-jpb'])('blocks explicit or nested GRAPH escape to %s', async (forbidden) => {
    const f = await real();
    for (const query of [
      `SELECT ?o WHERE { GRAPH <${forbidden}> { ?s ?p ?o } }`,
      `SELECT ?o WHERE { { SELECT ?o WHERE { GRAPH <${forbidden}> { ?s ?p ?o } } } }`,
      `PREFIX secret: <${forbidden}> SELECT ?o WHERE { GRAPH secret: { ?s ?p ?o } }`,
    ]) await expect(f.run(query)).rejects.toThrow();
  });
  it.each([
    'ASK { <urn:kamstrup:device:W10> <urn:dmaast:status> "wm" }',
    'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
    'DESCRIBE <urn:kamstrup:device:W10>',
    'SELECT (COUNT(?o) AS ?n) WHERE { ?s ?p ?o }',
  ])('supports scoped read form %s', async (query) => {
    const f = await real(); const outcome = await f.run(query);
    expect(outcome.status).toBe('succeeded');
    expect(outcome.output).not.toMatch(/OTHER_AGENT|OTHER_TENANT|META|"swm"|"vm"/);
    const result = JSON.parse(outcome.output as string).result;
    if (query.startsWith('CONSTRUCT') || query.startsWith('DESCRIBE')) expect(result.quads).toHaveLength(1);
    else expect(result.bindings).toHaveLength(1);
  });
});
