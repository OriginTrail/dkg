import { afterEach, describe, it, expect } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { sparqlString } from '@origintrail-official/dkg-core';
import { buildListQuery, buildCountQuery, buildSingleByUalQuery, buildPageContentQuery, bindingsToKa } from '../src/discovery.js';
import { createRegistryEntry } from '../src/registry.js';

const cg = 'urn:registry:test';
const base = `did:dkg:context-graph:${cg}`;
const streams = 'https://ontology.dkg.io/streams#';
const schema = 'https://schema.org/';
const dkg = 'http://dkg.io/ontology/';
const store = new OxigraphStore();
afterEach(async () => { await store.deleteByPattern({}); });

async function seed(id: number, provider: string, options: { legacy?: boolean; status?: string; otherGraph?: boolean } = {}) {
  const scope = options.otherGraph ? base + '-other' : base;
  const ual = `did:dkg:31337/0x${'a'.repeat(40)}/${id}`;
  const root = `urn:stream:${id}`;
  const publicGraph = options.legacy ? scope : `${scope}/_verifiable_memory/0x${'a'.repeat(40)}/${id}`;
  const privateGraph = options.legacy ? scope + '/_private' : publicGraph.replace('/_verifiable_memory/', '/_private/') + '/assertions/1';
  const quads: Array<{ subject: string; predicate: string; object: string; graph: string }> = [];
  const meta = (p: string, o: string) => quads.push({ subject: ual, predicate: dkg + p, object: o, graph: scope + '/_meta' });
  meta('status', sparqlString(options.status ?? 'confirmed'));
  meta('publishedAt', `"2026-10-26T10:00:0${id}Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>`);
  quads.push({ subject: ual, predicate: 'http://www.w3.org/ns/prov#wasAttributedTo', object: `did:dkg:agent:${provider}`, graph: scope + '/_meta' });
  if (options.legacy) meta('rootEntity', root);
  else {
    meta('contentScopeVersion', '"2"^^<http://www.w3.org/2001/XMLSchema#integer>');
    meta('kaUal', ual); meta('assertionGraph', publicGraph);
    meta('assertionVersion', '"1"^^<http://www.w3.org/2001/XMLSchema#integer>');
    meta('privateTripleCount', '"10"^^<http://www.w3.org/2001/XMLSchema#integer>');
  }
  quads.push({ subject: root, predicate: dkg + 'privateDataAnchor', object: '"true"', graph: publicGraph });
  const data = (p: string, o: string) => quads.push({ subject: root, predicate: p, object: o, graph: privateGraph });
  data('http://www.w3.org/1999/02/22-rdf-syntax-ns#type', streams + 'KafkaStream');
  data(schema + 'name', sparqlString(`${provider} application events`));
  data(schema + 'description', '"Generic operational records"');
  data(streams + 'kafkaBootstrapUrl', '"kafka://broker.example:9094"');
  data(streams + 'kafkaTopicName', '"events"');
  data(streams + 'dataFormat', '"JSON"');
  data(streams + 'providerIri', `urn:provider:${provider}`);
  data(streams + 'schemaIri', 'urn:schema:events');
  data(streams + 'registeredByAgentAddress', sparqlString('0x' + (provider === 'alpha' ? 'a' : 'b').repeat(40)));
  if (provider === 'alpha') { data(schema + 'about', 'urn:app:one'); data(schema + 'about', 'urn:app:two'); }
  await store.insert(quads);
  return ual;
}
async function select(query: string) {
  const result = await store.query(query);
  if (result.type !== 'bindings') throw new Error('Expected SELECT');
  return result.bindings;
}

describe('real RDF registry discovery across legacy and V2 layouts', () => {
  it('filters before pagination, counts the same set and retains entries without device links', async () => {
    const first = await seed(1, 'alpha', { legacy: true });
    const second = await seed(2, 'beta');
    const newest = await seed(3, 'alpha');
    await seed(4, 'alpha', { status: 'pending' });
    await seed(5, 'alpha', { otherGraph: true });
    const filters = { provider: 'urn:provider:alpha', about: 'urn:app:one', publisher: 'did:dkg:agent:alpha',
      registeredBy: '0x' + 'a'.repeat(40), schema: 'urn:schema:events', dataFormat: 'JSON', q: 'OPERATIONAL' };
    const count = await select(buildCountQuery({ contextGraphId: cg, filters }));
    expect(Number(count[0].count.replace(/^"|".*$/g, ''))).toBe(2);
    const page = await select(buildListQuery({ contextGraphId: cg, limit: 1, offset: 1, filters }));
    expect(page.map(row => row.ual)).toEqual([first]);
    const latest = await select(buildListQuery({ contextGraphId: cg, limit: 1, offset: 0, filters }));
    expect(latest.map(row => row.ual)).toEqual([newest]);
    const beta = await select(buildSingleByUalQuery({ contextGraphId: cg, ual: second }));
    const ka = bindingsToKa(beta.map(row => ({ ...row, ual: second })))!;
    expect(createRegistryEntry(ka, second, cg).descriptor.about).toBeUndefined();
  });
  it('round-trips entity IRIs through actual page and by-UAL queries', async () => {
    const ual = await seed(1, 'alpha');
    const page = await select(buildListQuery({ contextGraphId: cg, limit: 20, offset: 0 }));
    const rows = await select(buildPageContentQuery(page.map(row => ({ ual: row.ual, root: row.root, contentGraph: row.contentGraph }))));
    const ka = bindingsToKa(rows)!;
    expect(ka['schema:about']).toEqual([{ '@id': 'urn:app:one' }, { '@id': 'urn:app:two' }]);
    const entry = createRegistryEntry(ka, ual, cg);
    expect(entry.descriptor.providerIri).toBe('urn:provider:alpha');
    expect(entry.descriptor.schemaIri).toBe('urn:schema:events');
    const single = await select(buildSingleByUalQuery({ contextGraphId: cg, ual }));
    expect(createRegistryEntry(bindingsToKa(single.map(row => ({ ...row, ual })))!, ual, cg).descriptorHash).toBe(entry.descriptorHash);
  });
  it('treats query-like search text as text, not executable SPARQL', async () => {
    await seed(1, 'alpha');
    const filters = { q: '" } UNION { ?s ?p ?o } #' };
    expect(await select(buildListQuery({ contextGraphId: cg, limit: 20, offset: 0, filters }))).toEqual([]);
    expect(await select(buildSingleByUalQuery({ contextGraphId: cg, ual: 'urn:absent' }))).toEqual([]);
  });
});
