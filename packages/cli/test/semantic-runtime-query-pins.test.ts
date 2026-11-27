import { beforeEach, describe, expect, it, vi } from 'vitest';

import { decodeQueryCatalogBindings, type QueryCatalogItem } from '@origintrail-official/dkg-core/query-catalog';
import type { SemanticQueryOutputSchema } from '@origintrail-official/dkg-semantic-runtime';

import { readContextGraphQueryCatalogBindings } from '../src/daemon/query-catalog-service.js';
import { createDkgQueryAdapter } from '../src/semantic-runtime-query-adapter.js';
import {
  createSemanticQueryPin,
  queryCatalogDefinitionSha256,
  validateSemanticQueryPins,
} from '../src/semantic-runtime-query-pins.js';

vi.mock('../src/daemon/query-catalog-service.js', () => ({ readContextGraphQueryCatalogBindings: vi.fn() }));

const contextGraphId = 'private-equipment';
const caller = '0x2222222222222222222222222222222222222222';
const selector = 'maintenance-count';
const queryIri = `urn:dkg:profile:${contextGraphId}:query:${selector}`;
const numericSchema: SemanticQueryOutputSchema = {
  type: 'object', additionalProperties: false, required: ['bindings'],
  properties: {
    type: { type: 'string', maxLength: 8, enum: ['bindings'] },
    bindings: {
      type: 'array', minItems: 1, maxItems: 1,
      items: {
        type: 'object', additionalProperties: false, required: ['total'],
        properties: { total: { type: 'integer', minimum: 0 } },
      },
    },
  },
};

function catalogRows(): Array<Record<string, unknown>> {
  return [{
    q: queryIri, name: 'Maintenance count',
    scopeGraph: `did:dkg:context-graph:${contextGraphId}/equipment`,
    catalog: `urn:dkg:profile:${contextGraphId}:catalog:maintenance`,
    catalogName: 'Maintenance',
    sparql: 'SELECT (COUNT(?machine) AS ?total) WHERE { ?machine <urn:needsMaintenance> true }',
    executionView: 'verifiable-memory', resultColumn: 'total',
  }];
}

function setup(result: unknown = { bindings: [{ total: 3 }] }) {
  const rows = catalogRows();
  vi.mocked(readContextGraphQueryCatalogBindings).mockImplementation(async () => rows);
  const item = decodeQueryCatalogBindings(rows, { contextGraphId })[0];
  const pin = createSemanticQueryPin(selector, item, numericSchema);
  const agent = {
    canReadContextGraph: vi.fn(async () => true),
    query: vi.fn(async () => result),
  } as any;
  return { rows, item, pin, agent };
}

describe('pinned Program query pins and output contracts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs an unchanged approved definition and validates the actual result with the original caller', async () => {
    const { agent, item, pin } = setup();
    const adapter = createDkgQueryAdapter(agent, contextGraphId, caller, [pin]);
    const result = await adapter.dispatch({} as any, { selector });
    expect(JSON.parse(result.output)).toEqual({ queryIri, result: { bindings: [{ total: 3 }] } });
    expect(agent.canReadContextGraph).toHaveBeenCalledWith(contextGraphId, { callerAgentAddress: caller });
    expect(readContextGraphQueryCatalogBindings).toHaveBeenCalledWith(agent, contextGraphId, {
      callerAgentAddress: caller, source: 'semantic-runtime-query-catalog',
    });
    expect(agent.query).toHaveBeenCalledWith(item.sparql, {
      contextGraphId, callerAgentAddress: caller, source: 'semantic-runtime-dkg-query',
      subGraphName: 'equipment', view: 'verifiable-memory',
    });
  });

  it('blocks a catalog semantic mutation under the same Program and query identity before querying data', async () => {
    const { agent, rows, pin } = setup();
    const adapter = createDkgQueryAdapter(agent, contextGraphId, caller, [pin]);
    rows[0].sparql = 'SELECT ?total WHERE { <urn:private-payroll> <urn:salary> ?total }';
    await expect(adapter.dispatch({} as any, { selector })).rejects.toThrow('SEMANTIC_QUERY_DEFINITION_NOT_PINNED');
    expect(agent.query).not.toHaveBeenCalled();
  });

  it.each([
    ['view', { view: 'working-memory' }],
    ['scope', { subGraph: 'payroll', scopeGraph: `did:dkg:context-graph:${contextGraphId}/payroll` }],
    ['parameter', { parameters: [{ name: 'machine', type: 'iri', defaultValue: 'urn:private-machine' }] }],
    ['result column', { resultColumn: 'private' }],
  ])('binds %s semantics into the catalog digest', (_label, change) => {
    const { item } = setup();
    expect(queryCatalogDefinitionSha256({ ...item, ...change } as QueryCatalogItem)).not.toBe(queryCatalogDefinitionSha256(item));
  });

  it('ignores presentation-only catalog edits in the definition digest', () => {
    const { item } = setup();
    expect(queryCatalogDefinitionSha256({ ...item, description: 'New description', catalogName: 'New title', rank: 10 }))
      .toBe(queryCatalogDefinitionSha256(item));
  });

  it.each([
    { bindings: [{ total: 'salary-secret' }] },
    { bindings: [{ total: { private: 'salary-secret' } }] },
    { bindings: [{ total: 3, private: 'salary-secret' }] },
    { bindings: [{}] },
    { bindings: [{ total: -1 }] },
    { bindings: [{ total: 3.5 }] },
  ])('rejects output outside the approved scalar and field contract: %j', async (result) => {
    const { agent, pin } = setup(result);
    const adapter = createDkgQueryAdapter(agent, contextGraphId, caller, [pin]);
    await expect(adapter.dispatch({} as any, { selector })).rejects.toThrow('SEMANTIC_QUERY_OUTPUT_SCHEMA_MISMATCH');
    expect(agent.query).toHaveBeenCalledOnce();
  });

  it('checks RDF integer datatype and lexical form, not merely that the binding is a string', async () => {
    const { agent, item } = setup({ bindings: [{ total: '"3"^^<http://www.w3.org/2001/XMLSchema#integer>' }] });
    const schema = structuredClone(numericSchema);
    if (schema.type !== 'object' || schema.properties.bindings.type !== 'array'
      || schema.properties.bindings.items.type !== 'object') throw new Error('fixture');
    schema.properties.bindings.items.properties.total = { type: 'string', format: 'rdf-integer', maxLength: 128 };
    const pin = createSemanticQueryPin(selector, item, schema);
    const adapter = createDkgQueryAdapter(agent, contextGraphId, caller, [pin]);
    await expect(adapter.dispatch({} as any, { selector })).resolves.toMatchObject({ status: 'succeeded' });
    agent.query.mockResolvedValueOnce({ bindings: [{ total: '"salary-secret"' }] });
    await expect(adapter.dispatch({} as any, { selector })).rejects.toThrow('SEMANTIC_QUERY_OUTPUT_SCHEMA_MISMATCH');
  });

  it('rejects a changed output schema unless the operator also updates its digest', () => {
    const { pin } = setup();
    pin.outputSchema = { type: 'string', maxLength: 1000 };
    expect(() => validateSemanticQueryPins([pin])).toThrow('SEMANTIC_QUERY_SCHEMA_PIN_MISMATCH');
  });

  it('fails closed for an unpinned query in pinned mode while leaving direct mode unchanged', async () => {
    const { agent } = setup();
    await expect(createDkgQueryAdapter(agent, contextGraphId, caller, []).dispatch({} as any, { selector }))
      .rejects.toThrow('SEMANTIC_QUERY_DEFINITION_NOT_PINNED');
    expect(agent.query).not.toHaveBeenCalled();
    await expect(createDkgQueryAdapter(agent, contextGraphId, caller).dispatch({} as any, { selector }))
      .resolves.toMatchObject({ status: 'succeeded' });
  });

  it('denies graph access before looking up the catalog or running the query', async () => {
    const { agent, pin } = setup();
    agent.canReadContextGraph.mockResolvedValue(false);
    await expect(createDkgQueryAdapter(agent, contextGraphId, caller, [pin]).dispatch({} as any, { selector }))
      .rejects.toThrow('QUERY_CONTEXT_GRAPH_ACCESS_DENIED');
    expect(readContextGraphQueryCatalogBindings).not.toHaveBeenCalled();
    expect(agent.query).not.toHaveBeenCalled();
  });
});
