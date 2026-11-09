import { describe, expect, it, vi } from 'vitest';
import { DkgClient } from '../src/client.js';
import { registerReadTools } from '../src/tools.js';
import { FakeServer, makeConfig, type ToolResult } from './harness.js';

const text = (result: ToolResult) => result.content.map((part) => part.text).join('\n');
const bindings = (rows: Record<string, unknown>[]) => ({
  result: { type: 'bindings', bindings: rows },
});
function harness(defaultProject: string | null = 'team') {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(bindings([])));
  const config = makeConfig({ defaultProject });
  const client = new DkgClient({ config, fetcher });
  const server = new FakeServer();
  registerReadTools(server.asMcpServer(), client, config);
  const replies = (...values: unknown[]) => {
    for (const value of values) fetcher.mockResolvedValueOnce(Response.json(value));
  };
  const bodies = () =>
    fetcher.mock.calls
      .filter(([, init]) => init?.body)
      .map(([, init]) => JSON.parse(String(init?.body)));
  return { server, fetcher, replies, bodies };
}
const calls: Array<[string, Record<string, unknown>]> = [
  ['dkg_list_context_graphs', {}],
  ['dkg_sub_graph_list', {}],
  ['dkg_query', { sparql: 'SELECT * WHERE { ?s ?p ?o }' }],
  ['dkg_get_entity', { uri: 'urn:entity' }],
  ['dkg_get_entity_sources', { uri: 'urn:entity' }],
  ['dkg_list_activity', {}],
  ['dkg_get_agent', { agentUri: 'urn:agent' }],
];

describe('read tool errors remain recoverable MCP responses', () => {
  it.each(calls.filter(([name]) => name !== 'dkg_list_context_graphs'))(
    '%s requires a project before querying',
    async (name, input) => {
      const h = harness(null);
      const result = await h.server.call(name, input);
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/project|context.graph/i);
      expect(h.fetcher).not.toHaveBeenCalled();
    },
  );
  it.each(calls)(
    '%s reports an HTTP error without a success-shaped answer',
    async (name, input) => {
      const h = harness();
      h.fetcher.mockImplementation(async () =>
        Response.json({ error: 'daemon offline' }, { status: 503 }),
      );
      const result = await h.server.call(name, input);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('503');
      expect(text(result)).toContain('daemon offline');
    },
  );
  it('handles non-Error transport failures without losing the diagnostic', async () => {
    const h = harness();
    h.fetcher.mockRejectedValue('connection closed');
    const result = await h.server.call('dkg_list_context_graphs');
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('connection closed');
  });
});

describe('project discovery', () => {
  it('renders pinned membership and optional metadata, including zero entity counts', async () => {
    const h = harness();
    h.replies(
      {
        contextGraphs: [
          {
            id: 'team',
            name: 'Team',
            role: 'writer',
            layer: 'public',
            description: 'Shared notes',
          },
          { id: 'other' },
        ],
      },
      {
        subGraphs: [
          { name: 'empty', entityCount: 0, description: 'Ready' },
          { name: 'unreported' },
        ],
      },
    );
    const list = text(await h.server.call('dkg_list_context_graphs'));
    for (const expected of ['team** ★', 'Team', 'writer', 'public', 'Shared notes', '(unnamed)'])
      expect(list).toContain(expected);
    const sub = text(await h.server.call('dkg_sub_graph_list', { projectId: 'other team' }));
    expect(sub).toContain('0 entities');
    expect(sub).toContain('Ready');
    expect(sub).toContain('unreported');
    expect(h.fetcher.mock.calls[1][0]).toBe(
      'http://localhost:9200/api/sub-graph/list?contextGraphId=other%20team',
    );
  });
  it('distinguishes no projects from no subgraphs and tolerates absent list fields', async () => {
    const h = harness(null);
    h.replies({}, {}, { contextGraphs: [{ id: 'team' }] });
    expect(text(await h.server.call('dkg_list_context_graphs'))).toContain('No context graphs');
    expect(text(await h.server.call('dkg_sub_graph_list', { projectId: 'team' }))).toContain(
      'no sub-graphs',
    );
    expect(text(await h.server.call('dkg_list_context_graphs'))).not.toContain('★');
  });
});

describe('query rendering', () => {
  it.each(['bindings', 'quads'] as const)(
    'caps %s for display without changing the query sent to the daemon',
    async (kind) => {
      const h = harness();
      h.replies(
        kind === 'bindings'
          ? bindings([{ value: 'first' }, { value: 'second' }])
          : {
              result: {
                type: 'quads',
                quads: [
                  { subject: 'urn:first', predicate: 'urn:p', object: '"first"' },
                  { subject: 'urn:second', predicate: 'urn:p', object: 'urn:o', graph: 'urn:g' },
                ],
              },
            },
      );
      const sparql =
        kind === 'bindings'
          ? 'SELECT * WHERE { ?s ?p ?o }'
          : 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }';
      const result = text(await h.server.call('dkg_query', { sparql, limit: 1 }));
      expect(result).toContain('first');
      expect(result).not.toContain('second');
      expect(result).toContain('showing 1 of 2');
      expect(h.bodies()[0].sparql).toContain(sparql);
      expect(h.bodies()[0].sparql).not.toContain('LIMIT');
    },
  );
});

describe('entity views', () => {
  it('deduplicates edges across private and shared memory and preserves typed/language values', async () => {
    const h = harness();
    const outgoing = { p: 'http://schema.org/name', o: '"Živa"@sl' };
    const incoming = { s: 'urn:related', p: '<http://schema.org/knows>' };
    h.replies(
      { agentAddress: '0xabc' },
      bindings([outgoing]),
      bindings([incoming]),
      bindings([outgoing]),
      bindings([incoming]),
    );
    const result = text(
      await h.server.call('dkg_get_entity', { uri: 'urn:entity', subGraphName: 'people' }),
    );
    expect(result).toContain('## Properties\n- **schema:name**: Živa');
    expect(result).toContain('## Incoming edges\n- urn:related → **schema:knows**');
    expect(result.match(/Živa/g)).toHaveLength(1);
    expect(result.match(/urn:related/g)).toHaveLength(1);
    expect(h.bodies()).toHaveLength(4);
    expect(h.bodies().slice(0, 2)).toEqual([
      expect.objectContaining({
        view: 'working-memory',
        agentAddress: '0xabc',
        subGraphName: 'people',
      }),
      expect.objectContaining({ view: 'working-memory', agentAddress: '0xabc' }),
    ]);
    expect(h.bodies().slice(2)).toEqual([
      expect.objectContaining({ graphSuffix: '_shared_memory' }),
      expect.objectContaining({ graphSuffix: '_shared_memory' }),
    ]);
  });
  it.each([
    {
      input: { view: 'shared-working-memory' },
      label: 'shared-working-memory',
      scope: { graphSuffix: '_shared_memory' },
    },
    {
      input: { subGraphName: 'people', includeSharedMemory: false },
      label: 'working-memory',
      scope: { view: 'working-memory', agentAddress: '0xabc' },
    },
  ])('does not expand a strict view: $label', async ({ input, label, scope }) => {
    const h = harness();
    if (label === 'working-memory') h.replies({ agentAddress: '0xabc' });
    h.replies(
      { result: { type: 'boolean', value: false } },
      { result: { type: 'boolean', value: false } },
    );
    expect(text(await h.server.call('dkg_get_entity', { uri: 'urn:empty', ...input }))).toContain(
      `view=${label}`,
    );
    expect(h.bodies()).toHaveLength(2);
    for (const body of h.bodies()) expect(body).toMatchObject(scope);
  });
  it.each(['outgoing', 'incoming'] as const)(
    'renders only the nonempty %s section',
    async (side) => {
      const h = harness();
      h.replies(
        bindings(side === 'outgoing' ? [{ p: 'urn:p', o: '"42"^^<urn:datatype>' }] : []),
        bindings(side === 'incoming' ? [{ s: 'urn:source', p: 'urn:p' }] : []),
      );
      const result = text(
        await h.server.call('dkg_get_entity', { uri: 'urn:entity', view: 'verifiable-memory' }),
      );
      expect(result.includes('## Properties')).toBe(side === 'outgoing');
      expect(result.includes('## Incoming edges')).toBe(side === 'incoming');
      expect(result).toContain(side === 'outgoing' ? '42' : 'urn:source');
    },
  );
  it('accepts an explicitly bracketed source URI and handles a non-binding response', async () => {
    const h = harness();
    h.replies({ result: { type: 'boolean', value: false } });
    expect(text(await h.server.call('dkg_get_entity_sources', { uri: '<urn:entity>' }))).toContain(
      'No facts',
    );
    expect(h.bodies()[0].sparql).toContain('<urn:entity>');
    expect(h.bodies()[0].sparql).not.toContain('<<');
  });
});

describe('activity summaries', () => {
  it.each(['decisions', 'tasks', 'github', 'code', 'chat', 'custom'])(
    'applies the %s filter and preserves authors and undated rows',
    async (subGraph) => {
      const h = harness();
      h.replies(
        bindings([
          {
            s: 'urn:first',
            t: 'http://schema.org/Thing',
            when: '"2026-01-01"',
            author: 'urn:alice',
          },
          { s: 'urn:undated', t: 'urn:Type' },
        ]),
      );
      const result = text(
        await h.server.call('dkg_list_activity', {
          subGraph,
          agentUri: 'urn:alice',
          sinceIso: '2026-01-01T00:00:00Z',
          view: 'verifiable-memory',
          limit: 999,
        }),
      );
      for (const part of [
        '2026-01-01',
        'by urn:alice',
        '(undated)',
        'urn:undated',
        `/ ${subGraph}`,
      ])
        expect(result).toContain(part);
      const body = h.bodies()[0];
      expect(body.view).toBe('verifiable-memory');
      expect(body.sparql).toContain('LIMIT 200');
      expect(body.sparql).toContain('prov:wasAttributedTo <urn:alice>');
      expect(body.sparql).toContain('FILTER(?when >=');
      if (subGraph !== 'custom')
        expect(body.sparql).toContain(`http://dkg.io/ontology/${subGraph}/`);
    },
  );
  it.each([false, true])(
    'uses the selected working-memory union flag %s',
    async (includeSharedMemory) => {
      const h = harness();
      h.replies(bindings([{ s: 'urn:event' }]));
      expect(
        text(
          await h.server.call('dkg_list_activity', {
            view: 'working-memory',
            includeSharedMemory,
            limit: 0,
          }),
        ),
      ).toContain('urn:event');
      expect(h.bodies()[0].includeSharedMemory).toBe(includeSharedMemory || undefined);
      expect(h.bodies()[0].sparql).toContain('LIMIT 1');
    },
  );
  it('handles a non-binding reply as an empty activity feed', async () => {
    const h = harness();
    h.replies({ result: { type: 'quads', quads: [] } });
    expect(text(await h.server.call('dkg_list_activity'))).toBe('(no activity)');
  });
});

describe('agent profile lookup', () => {
  it('resolves an escaped name before fetching its profile and authored counts', async () => {
    const h = harness();
    h.replies(
      bindings([{ a: { type: 'uri', value: 'urn:alice' } }]),
      bindings([{ p: 'http://schema.org/name', o: '"Alice"' }]),
      bindings([{ n: '2', t: 'http://dkg.io/ontology/tasks/Task' }]),
    );
    const result = text(await h.server.call('dkg_get_agent', { nameOrHandle: 'A"lice\n' }));
    for (const part of ['urn:alice', 'schema:name', 'Alice', '2 × tasks:Task'])
      expect(result).toContain(part);
    const body = h.bodies();
    expect(body[0].sparql).toContain('A\\"lice\\n');
    expect(body[0].subGraphName).toBe('meta');
    expect(body[1].sparql).toContain('<urn:alice>');
    expect(body[2].sparql).toContain('<urn:alice>');
  });
  it.each([{}, { nameOrHandle: 'missing' }])(
    'reports an unresolved profile for %j without querying a fabricated identity',
    async (input) => {
      const h = harness();
      h.replies({ result: { type: 'boolean', value: false } });
      const result = await h.server.call('dkg_get_agent', input);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('Could not resolve');
      expect(h.fetcher).toHaveBeenCalledTimes('nameOrHandle' in input ? 1 : 0);
    },
  );
  it.each([true, false])(
    'reports an unregistered explicit identity with empty/type-mismatched rows (%s)',
    async (tagged) => {
      const h = harness();
      h.replies(
        tagged ? { result: { type: 'quads', quads: [] } } : bindings([]),
        tagged ? { result: { type: 'boolean', value: false } } : bindings([]),
      );
      const result = text(await h.server.call('dkg_get_agent', { agentUri: 'urn:new' }));
      expect(result).toContain('may not be registered yet');
      expect(result).not.toContain('Authored activity');
      expect(h.bodies()).toHaveLength(2);
    },
  );
});

it('sorts distinct objects under the same predicate and labels multiple pre-publish sources as drafts', async () => {
  const h = harness();
  h.replies(
    bindings([
      { p: 'urn:p', o: '"zeta"', g: 'did:dkg:context-graph:team/_shared_memory/0xaa/2' },
      { p: 'urn:p', o: '"alpha"', g: 'did:dkg:context-graph:team/_shared_memory/0xaa/1' },
    ]),
  );
  const result = text(
    await h.server.call('dkg_get_entity_sources', {
      uri: 'urn:entity',
      view: 'shared-working-memory',
    }),
  );
  expect(result).toContain('2 draft KAs');
  expect(result).toContain('reserved UAL, not yet on-chain');
  expect(result.indexOf('alpha')).toBeLessThan(result.indexOf('zeta'));
});
