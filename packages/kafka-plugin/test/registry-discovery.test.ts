import { afterEach, describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { sparqlString } from '@origintrail-official/dkg-core';
import { buildListQuery, buildCountQuery, buildSingleByUalQuery, buildPageContentQuery, buildPublisherQuery, bindingsToKa } from '../src/discovery.js';
import { createRegistryEntry } from '../src/registry.js';
import { createHandler, type KafkaPluginCtx } from '../src/handler.js';
import { attachRequest } from './_helpers/daemon-ctx.js';
import { jsonLdToQuads } from '../../agent/src/dkg-agent-utils.js';

const cg = 'urn:registry:test';
const base = `did:dkg:context-graph:${cg}`;
const streams = 'https://ontology.dkg.io/streams#';
const schema = 'https://schema.org/';
const attacker = '0x' + 'b'.repeat(40);
const dkg = 'http://dkg.io/ontology/';
const store = new OxigraphStore();
afterEach(async () => { await store.deleteByPattern({}); });

async function seed(id: number, provider: string, options: {
  legacy?: boolean; status?: string; otherGraph?: boolean; publishers?: string[];
  registrar?: string; schemaIri?: string; dataFormat?: string;
} = {}) {
  const scope = options.otherGraph ? base + '-other' : base;
  const ual = `did:dkg:31337/0x${'a'.repeat(40)}/${id}`;
  const root = `urn:stream:${id}`;
  const publicGraph = options.legacy ? scope : `${scope}/_verifiable_memory/0x${'a'.repeat(40)}/${id}`;
  const privateGraph = options.legacy ? scope + '/_private' : publicGraph.replace('/_verifiable_memory/', '/_private/') + '/assertions/1';
  const quads: Array<{ subject: string; predicate: string; object: string; graph: string }> = [];
  const meta = (p: string, o: string) => quads.push({ subject: ual, predicate: dkg + p, object: o, graph: scope + '/_meta' });
  meta('status', sparqlString(options.status ?? 'confirmed'));
  meta('publishedAt', `"2026-10-26T10:00:0${id}Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>`);
  for (const publisher of options.publishers ?? [`did:dkg:agent:${provider}`]) {
    quads.push({ subject: ual, predicate: 'http://www.w3.org/ns/prov#wasAttributedTo', object: publisher, graph: scope + '/_meta' });
  }
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
  data(streams + 'dataFormat', sparqlString(options.dataFormat ?? 'JSON'));
  data(streams + 'providerIri', `urn:provider:${provider}`);
  data(streams + 'schemaIri', options.schemaIri ?? 'urn:schema:events');
  data(streams + 'registeredByAgentAddress', sparqlString(options.registrar ?? '0x' + (provider === 'alpha' ? 'a' : 'b').repeat(40)));
  if (provider === 'alpha') { data(schema + 'about', 'urn:app:one'); data(schema + 'about', 'urn:app:two'); }
  await store.insert(quads);
  return ual;
}
async function select(query: string) {
  const result = await store.query(query);
  if (result.type !== 'bindings') throw new Error('Expected SELECT');
  return result.bindings;
}

// Real conversion and store queries behind the route; no daemon or broker is implied.
async function request(path: string, fragment?: Record<string, unknown>) {
  const posted = fragment !== undefined;
  const req = Readable.from(posted ? [Buffer.from(JSON.stringify({ name: 'Events', kafkaBootstrapUrl: 'kafka://broker:9094', kafkaTopicName: 'events' }))] : []) as IncomingMessage;
  req.method = posted ? 'POST' : 'GET'; req.url = path;
  let status = 0;
  let body: any;
  let content: any;
  const res = { writeHead(code: number) { status = code; }, end(json: string) { body = JSON.parse(json); } } as unknown as ServerResponse;
  const ctx = {
    agent: {
      query: async (sparql: string, options: Record<string, unknown>) => {
        expect(options).toMatchObject({ contextGraphId: cg, callerAgentAddress: '0x' + 'a'.repeat(40), includePrivate: true });
        return { bindings: await select(sparql) };
      },
      publishAsync: async (_cg: string, value: unknown) => { content = value; return { captureID: 'capture' }; },
    },
    config: {}, requestAgentAddress: '0x' + 'a'.repeat(40),
    publisherState: { runtime: { walletIds: ['publisher'] } },
  } as unknown as KafkaPluginCtx;
  await createHandler({ basePath: '/streams', contextGraphId: cg,
    ...(posted ? { extension: { schema: z.object({}), augment: () => fragment! } } : {}),
  })(attachRequest(ctx, req, res));
  return { status, body, content };
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

  it.each([
    ['registeredBy', { registrar: '0x' + 'b'.repeat(40) }, '0x' + 'a'.repeat(40)],
    ['schema', { schemaIri: 'urn:schema:other' }, 'urn:schema:events'],
    ['dataFormat', { dataFormat: 'AVRO' }, 'JSON'],
  ] as const)('independently excludes a differing %s from totals and every page', async (field, changed, value) => {
    const oldest = await seed(1, 'alpha', { legacy: true });
    await seed(2, 'alpha', changed);
    const newest = await seed(3, 'alpha');
    for (const [offset, selected] of [[0, [newest]], [1, [oldest]], [2, []]] as const) {
      const result = await request(`/streams?${field}=${encodeURIComponent(value)}&limit=1&offset=${offset}`);
      expect(result.status).toBe(200);
      expect(result.body.total).toBe(2);
      expect(result.body.items.map((item: any) => item['@id'])).toEqual(selected);
    }
  });

  it.each([true, false])('pages registrations independently of publisher cardinality (legacy=%s)', async legacy => {
    const oldest = await seed(1, 'alpha', { legacy });
    const ambiguous = await seed(2, 'alpha', { legacy, publishers: ['urn:a', 'urn:b'] });
    const newest = await seed(3, 'alpha', { legacy });
    for (const limit of [1, 2, 3]) {
      for (let offset = 0; offset <= 3; offset++) {
        const result = await request(`/streams?limit=${limit}&offset=${offset}`);
        expect(result.status).toBe(200);
        expect(result.body.total).toBe(3);
        expect(result.body.items.map((item: any) => item['@id'])).toEqual([newest, ambiguous, oldest].slice(offset, offset + limit));
        for (const item of result.body.items) expect(item['schema:name']).toBe('alpha application events');
      }
    }
    const filtered = await request('/streams?publisher=urn:a&limit=1');
    expect(filtered.body.total).toBe(1);
    expect(filtered.body.items.map((item: any) => item['@id'])).toEqual([ambiguous]);
    expect((await request('/streams?publisher=urn:a&limit=1&offset=1')).body.items).toEqual([]);
    const single = await request('/streams/' + encodeURIComponent(ambiguous));
    expect(single.status).toBe(200);
    expect(single.body['schema:name']).toBe('alpha application events');
    // Binding reconstruction is also robust if an adapter repeats payload triples.
    const rows = await select(buildSingleByUalQuery({ contextGraphId: cg, ual: ambiguous }));
    expect(bindingsToKa([...rows, ...rows])!['schema:name']).toBe('alpha application events');
    expect((await select(buildPublisherQuery(cg, [ambiguous, ambiguous]))).map(row => row.publisher).sort()).toEqual(['urn:a', 'urn:b']);
    for (const path of [
      '/streams?includeRegistry=true&limit=1&offset=1',
      '/streams?includeRegistry=true&limit=2',
      '/streams?includeRegistry=true&publisher=urn:a&limit=1',
      '/streams?includeRegistry=true&publisher=urn:b&limit=2',
      '/streams/' + encodeURIComponent(ambiguous) + '?includeRegistry=true',
    ]) {
      const result = await request(path);
      expect(result.status, path).toBe(503);
      expect(result.body).toEqual({ error: 'RegistryDescriptorInvalid' });
    }
    const valid = await request('/streams?includeRegistry=true&limit=1');
    expect(valid.status).toBe(200);
    expect(valid.body.items[0].registry.publisherIri).toBe('did:dkg:agent:alpha');
  });

  it.each([
    { [`${streams}registeredByAgentAddress`]: attacker },
    { '@context': { alias: streams }, 'alias:registeredByAgentAddress': attacker },
    { '@context': { '@vocab': streams }, registeredByAgentAddress: attacker },
    { '@context': { who: streams + 'registeredByAgentAddress' }, who: attacker },
    { '@context': { who: 'dkg-streams:registeredByAgentAddress' }, who: attacker },
    { who: attacker, '@context': { who: 'next', next: 'dkg-streams:registeredByAgentAddress' } },
    { '@context': { alias: 'dkg-streams:', who: 'alias:registeredByAgentAddress' }, who: attacker },
    { '@context': { '@vocab': 'dkg-streams:' }, registeredByAgentAddress: attacker },
    { '@context': { 'dkg-streams:registeredByAgentAddress': 'urn:forged' } },
  ])('publishes exactly the authenticated registrar after real JSON-LD conversion: %j', async fragment => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const registration = await request('/streams/register', { ...fragment,
        '@context': { ...fragment['@context'], vendor: 'urn:extension:', note: 'vendor:note' }, note: 'kept',
      });
      expect(registration.status).toBe(202);
      const { publicQuads, privateQuads } = await jsonLdToQuads(registration.content);
      const registrar = '0x' + 'a'.repeat(40);
      expect(privateQuads.filter(q => q.predicate === streams + 'registeredByAgentAddress').map(q => q.object)).toEqual([sparqlString(registrar)]);
      expect(privateQuads.some(q => q.predicate === 'urn:extension:note' && q.object === '"kept"')).toBe(true);
      const ual = await seed(1, 'alpha');
      await store.deleteByPattern({ subject: 'urn:stream:1' });
      const publicGraph = `${base}/_verifiable_memory/0x${'a'.repeat(40)}/1`;
      const privateGraph = publicGraph.replace('/_verifiable_memory/', '/_private/') + '/assertions/1';
      await store.insert([...publicQuads.map(q => ({ ...q, graph: publicGraph })), ...privateQuads.map(q => ({ ...q, graph: privateGraph }))]);
      const selected = await request('/streams?includeRegistry=true&registeredBy=' + registrar);
      expect(selected.status).toBe(200);
      expect(selected.body.total).toBe(1);
      expect(selected.body.items[0].registry.descriptor.registeredByAgentAddress).toBe(registrar);
      const rejected = await request('/streams?registeredBy=0x' + 'b'.repeat(40));
      expect(rejected.body.total).toBe(0);
      expect(rejected.body.items).toEqual([]);
      const single = await request('/streams/' + encodeURIComponent(ual) + '?includeRegistry=true');
      expect(single.status).toBe(200);
      expect(single.body.registry.descriptor.registeredByAgentAddress).toBe(registrar);
    } finally { warn.mockRestore(); }
  });
});
