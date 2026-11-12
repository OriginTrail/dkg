import { describe, expect, it } from 'vitest';
import { MISSING_TOKEN_HELP } from '../src/auth-diagnostics.js';
import { DkgClient } from '../src/client.js';
import { registerReadGraphTools } from '../src/tools/read-graphs.js';
import { registerSetupTools } from '../src/tools/setup.js';
import { FakeServer, makeConfig } from './harness.js';

interface Call {
  method: string;
  url: string;
  authorization: string | null;
  actor: string | null;
  body?: unknown;
}

const SETTINGS = {
  policy: { enabled: true, layers: ['verifiable-memory', 'shared-working-memory', 'working-memory'] },
  contextGraphs: [{
    contextGraphId: 'team',
    layers: { 'verifiable-memory': 'build' },
    effective: { layers: { 'verifiable-memory': 'build', 'shared-working-memory': 'off', 'working-memory': 'off' }, viewSemantics: 'per-asset' },
    readGraphs: [{ readGraph: 'urn:rg', contextGraphId: 'team', layer: 'vm', state: 'ready', generation: 2 }],
  }],
};

function setup(answer: (call: Call) => Response | Promise<Response>, token = 'admin-token') {
  const calls: Call[] = [];
  const client = new DkgClient({
    config: makeConfig({ token }),
    fetcher: (async (url, init) => {
      const headers = new Headers(init?.headers);
      const call: Call = {
        method: init?.method ?? 'GET',
        url: String(url),
        authorization: headers.get('Authorization'),
        actor: headers.get('X-DKG-Actor'),
        ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
      };
      calls.push(call);
      return answer(call);
    }) as typeof fetch,
  });
  const server = new FakeServer();
  registerReadGraphTools(server.asMcpServer(), client, makeConfig({ token }));
  registerSetupTools(server.asMcpServer(), client, makeConfig({ token }));
  return { server, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const text = (result: { content: Array<{ text: string }> }) => result.content.map((part) => part.text).join('\n');

describe('dkg_read_graphs_status', () => {
  it('reads every context graph, or one, with the configured token, and answers in plain words', async () => {
    const { server, calls } = setup(() => json(200, SETTINGS));
    const all = await server.call('dkg_read_graphs_status', {});
    const one = await server.call('dkg_read_graphs_status', { contextGraphId: 'did:dkg:context-graph:0xabc/team' });

    expect(calls.map((call) => [call.method, call.url, call.authorization, call.actor])).toEqual([
      ['GET', 'http://localhost:9200/api/store/read-graphs/settings', 'Bearer admin-token', null],
      ['GET', 'http://localhost:9200/api/store/read-graphs/settings?contextGraphId=0xabc%2Fteam', 'Bearer admin-token', null],
    ]);
    expect(all.isError).toBeUndefined();
    expect(text(all)).toBe([
      'Search across assets in team:',
      '- Published assets: Preview: Ready to turn on',
      '- Shared memory, shared with your team: Off',
      '- Private drafts: Off',
      '- Queries search across assets by default: Off, each asset is searched on its own.',
    ].join('\n'));
    expect(all.structuredContent).toEqual(SETTINGS);
    expect(one.structuredContent).toEqual(SETTINGS);
  });

  it('declares itself read-only and refuses an empty id without a request', async () => {
    const { server, calls } = setup(() => json(200, SETTINGS));
    expect(server.get('dkg_read_graphs_status').config.annotations?.readOnlyHint).toBe(true);
    expect(text(await server.call('dkg_read_graphs_status', { contextGraphId: 'did:dkg:context-graph:' }))).toMatch(/empty/);
    expect(calls).toHaveLength(0);
  });

  it('says only the node admin may see the settings when the node refuses the token', async () => {
    const { server } = setup(() => json(403, {
      error: 'GET /api/store/read-graphs/settings requires a node-level admin token; agent-scoped tokens cannot list the read-graph settings of the node.',
    }), 'agent-token');
    const result = await server.call('dkg_read_graphs_status', {});
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      "Only the node admin can see or change search across assets, and the node did not accept this MCP server's token as the node admin token (HTTP 403).",
    );
    expect(result.structuredContent).toBeUndefined();
  });

  it('adds the setup hint when the server has no token at all', async () => {
    const { server, calls } = setup(() => json(401, { error: 'Unauthorized' }), '');
    const result = await server.call('dkg_read_graphs_status', {});
    expect(calls[0].authorization).toBeNull();
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/\(HTTP 401\)\. /);
    expect(text(result).endsWith(MISSING_TOKEN_HELP)).toBe(true);
  });

  it('names an older node, and a node it cannot reach', async () => {
    const older = setup(() => json(404, { error: 'Not found' }));
    expect(text(await older.server.call('dkg_read_graphs_status', {}))).toMatch(/runs a DKG version from before them/);
    const down = setup(() => { throw new TypeError('fetch failed'); });
    const result = await down.server.call('dkg_read_graphs_status', {});
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('No answer from the node: fetch failed');
    const odd = setup(() => { throw 'socket closed'; });
    expect(text(await odd.server.call('dkg_read_graphs_status', {}))).toBe('No answer from the node: socket closed');
  });

  it('shows a non-object answer as text only', async () => {
    const { server } = setup(() => json(200, []));
    const result = await server.call('dkg_read_graphs_status', {});
    expect(text(result)).toBe('No context graph has search across assets set up.');
    expect(result.structuredContent).toBeUndefined();
  });
});

describe('dkg_read_graphs_set', () => {
  const changed = {
    ...SETTINGS,
    changes: [{ contextGraphId: 'team', layer: 'verifiable-memory', from: 'off', to: 'build', outcome: 'applied' }],
  };

  it('puts the engine modes for the words users see, on published assets by default', async () => {
    const { server, calls } = setup(() => json(200, changed));
    const result = await server.call('dkg_read_graphs_set', { contextGraphId: 'did:dkg:context-graph:team', mode: 'preview' });

    expect(calls).toEqual([{
      method: 'PUT',
      url: 'http://localhost:9200/api/store/read-graphs/settings',
      authorization: 'Bearer admin-token',
      actor: 'agent:mcp',
      body: { contextGraphId: 'team', layers: { 'verifiable-memory': 'build' } },
    }]);
    expect(text(result)).toBe("Getting search across assets ready for team's published assets. Preview shows how results would change before it is turned on.\n\nSearch across assets in team:\n"
      + '- Published assets: Preview: Ready to turn on\n- Shared memory, shared with your team: Off\n- Private drafts: Off\n'
      + '- Queries search across assets by default: Off, each asset is searched on its own.');
    expect(result.structuredContent).toEqual(changed);
  });

  it('sets all three layers, and the default semantics or its removal', async () => {
    const { server, calls } = setup(() => json(200, SETTINGS));
    await server.call('dkg_read_graphs_set', { contextGraphId: 'team', mode: 'on', layer: 'all', defaultSemantics: 'merged' });
    await server.call('dkg_read_graphs_set', { contextGraphId: 'team', mode: 'on', layer: 'working-memory' });
    const cleared = await server.call('dkg_read_graphs_set', { contextGraphId: 'team', defaultSemantics: 'none' });
    expect(calls.map((call) => call.body)).toEqual([
      { contextGraphId: 'team', layers: { 'verifiable-memory': 'serve', 'shared-working-memory': 'serve', 'working-memory': 'serve' }, viewSemantics: 'merged' },
      { contextGraphId: 'team', layers: { 'working-memory': 'serve' } },
      { contextGraphId: 'team', viewSemantics: null },
    ]);
    expect(text(cleared)).toMatch(/^Search across assets in team:/);
  });

  it('refuses incomplete arguments without a request', async () => {
    const { server, calls } = setup(() => json(200, SETTINGS));
    const set = (input: Record<string, unknown>) => server.call('dkg_read_graphs_set', input);
    expect(text(await set({ contextGraphId: 'team' }))).toBe('Give "mode", "defaultSemantics", or both.');
    expect(text(await set({ contextGraphId: 'team', layer: 'all', defaultSemantics: 'merged' }))).toBe('"layer" needs "mode".');
    expect(text(await set({ contextGraphId: ' did:dkg:context-graph: ', mode: 'off' }))).toBe('"contextGraphId" is empty.');
    await expect(set({ contextGraphId: 'team', mode: 'everything' })).rejects.toThrow();
    await expect(set({ contextGraphId: 'team', mode: 'build' })).rejects.toThrow();
    expect(calls).toHaveLength(0);
    expect(server.get('dkg_read_graphs_set').config.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
  });

  it("gives the node's refusal sentence and code", async () => {
    const { server } = setup(() => json(409, { code: 'READ_GRAPHS_LAYER_NOT_ALLOWED', error: 'This node does not allow read graphs for working memory.' }));
    const result = await server.call('dkg_read_graphs_set', { contextGraphId: 'team', mode: 'on', layer: 'working-memory' });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('The node refused: This node does not allow read graphs for working memory. (READ_GRAPHS_LAYER_NOT_ALLOWED)');
  });

  it('says only the node admin may change the settings when the node refuses the token', async () => {
    const { server } = setup(() => json(403, { error: 'PUT /api/store/read-graphs/settings requires a node-level admin token.' }), 'agent-token');
    const result = await server.call('dkg_read_graphs_set', { contextGraphId: 'team', mode: 'off' });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^Only the node admin can see or change search across assets, and the node did not accept this MCP server's token as the node admin token \(HTTP 403\)/);
  });
});

describe('dkg_context_graph_create with search across assets', () => {
  const created = (readGraphs?: unknown) => json(200, { created: 'team', uri: 'did:dkg:context-graph:team', ...(readGraphs === undefined ? {} : { readGraphs }) });

  it('sends the setting with the creation and reports it applied', async () => {
    const { server, calls } = setup(() => created({ applied: true }));
    const result = await server.call('dkg_context_graph_create', { name: 'Team', readGraphs: 'preview' });
    expect(calls[0].body).toEqual({ id: 'team', name: 'Team', accessPolicy: 1, publishPolicy: 0, readGraphs: { layers: { 'verifiable-memory': 'build' } } });
    expect(calls[0].actor).toBe('agent:mcp');
    expect(text(result)).toBe("Created context graph 'team'.\nURI: did:dkg:context-graph:team\nName: Team\n"
      + "Getting search across assets ready for team's published assets. Preview shows how results would change before it is turned on.");
  });

  it('reports a refused setting, with the creation kept', async () => {
    const { server, calls } = setup(() => created({ refused: { code: 'READ_GRAPHS_DISABLED', error: 'Search across assets is switched off for this node.' } }));
    const result = await server.call('dkg_context_graph_create', { name: 'Team', readGraphs: 'on', readGraphLayer: 'all' });
    expect(calls[0].body).toMatchObject({ readGraphs: { layers: { 'verifiable-memory': 'serve', 'shared-working-memory': 'serve', 'working-memory': 'serve' } } });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toMatch(/^Created context graph 'team'\./);
    expect(text(result)).toMatch(/was not turned on for team: Search across assets is switched off for this node\. \(READ_GRAPHS_DISABLED\) The context graph was created/);
  });

  it('says a node that ignores the setting did not apply it', async () => {
    const { server } = setup(() => created());
    expect(text(await server.call('dkg_context_graph_create', { name: 'Team', readGraphs: 'preview', readGraphLayer: 'shared-working-memory' })))
      .toMatch(/Search across assets was not turned on for team: the node did not apply the setting/);
    await expect(server.call('dkg_context_graph_create', { name: 'Team', readGraphs: 'serve' })).rejects.toThrow();
  });

  it('leaves the request and the reply as before without the setting', async () => {
    const { server, calls } = setup(() => created());
    const result = await server.call('dkg_context_graph_create', { name: 'Team' });
    expect(calls[0].body).toEqual({ id: 'team', name: 'Team', accessPolicy: 1, publishPolicy: 0 });
    expect(calls[0].actor).toBeNull();
    expect(text(result)).toBe("Created context graph 'team'.\nURI: did:dkg:context-graph:team\nName: Team");
  });

  it('says an existing context graph keeps its setting', async () => {
    const { server } = setup(() => json(409, { error: 'Context graph already exists' }));
    expect(text(await server.call('dkg_context_graph_create', { name: 'Team', readGraphs: 'on' })))
      .toBe("Context graph 'team' already exists.\nURI: did:dkg:context-graph:team\nSearch across assets was not changed; use dkg_read_graphs_set for that.");
    const plain = setup(() => json(409, { error: 'Context graph already exists' }));
    expect(text(await plain.server.call('dkg_context_graph_create', { name: 'Team' })))
      .toBe("Context graph 'team' already exists.\nURI: did:dkg:context-graph:team");
  });

  it('refuses a layer without a mode before any request', async () => {
    const { server, calls } = setup(() => created());
    const result = await server.call('dkg_context_graph_create', { name: 'Team', readGraphLayer: 'all' });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('"readGraphLayer" needs "readGraphs".');
    expect(calls).toHaveLength(0);
  });
});

describe('a refused token', () => {
  it.each([401, 403])('gets exactly one request per tool call, with no other token and no retry (%i)', async (status) => {
    const { server, calls } = setup(() => json(status, { error: 'Requires a node-level admin token.' }), 'agent-token');
    expect((await server.call('dkg_read_graphs_status', {})).isError).toBe(true);
    expect(calls).toHaveLength(1);
    expect((await server.call('dkg_read_graphs_set', { contextGraphId: 'team', mode: 'off' })).isError).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.authorization)).toEqual(['Bearer agent-token', 'Bearer agent-token']);
  });
});
