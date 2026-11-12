import { afterEach, describe, expect, it, vi } from 'vitest';
import { DkgDaemonClient } from '../src/dkg-client.js';
import { DkgNodePlugin } from '../src/DkgNodePlugin.js';
import { buildReadGraphTools, readGraphsCreateOption, withReadGraphsOutcome } from '../src/tools/read-graph-tools.js';
import type { OpenClawTool, OpenClawToolResult } from '../src/types.js';

const SETTINGS = {
  policy: { enabled: true, layers: ['verifiable-memory', 'shared-working-memory', 'working-memory'] },
  contextGraphs: [{
    contextGraphId: 'team',
    layers: { 'verifiable-memory': 'serve' },
    effective: { layers: { 'verifiable-memory': 'serve', 'shared-working-memory': 'off', 'working-memory': 'off' }, viewSemantics: 'merged' },
    readGraphs: [{ readGraph: 'urn:rg', contextGraphId: 'team', layer: 'vm', state: 'ready', generation: 3 }],
  }],
};
const SUMMARY = [
  'Search across assets in team:',
  '- Published assets: On: In use',
  '- Shared memory, shared with your team: Off',
  '- Private drafts: Off',
  '- Queries search across assets by default: On.',
].join('\n');

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function answering(...responses: Array<Response | Error>) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
    const next = responses.length > 1 ? responses.shift()! : responses[0];
    if (next instanceof Error) throw next;
    return next.clone();
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const parsed = (result: OpenClawToolResult) => JSON.parse(result.content[0].text) as Record<string, unknown>;

function tools(): Map<string, OpenClawTool> {
  const client = new DkgDaemonClient({ baseUrl: 'http://localhost:9200', apiToken: 'admin-token' });
  return new Map(buildReadGraphTools(client).map((tool) => [tool.name, tool] as const));
}

describe('dkg_read_graphs_status', () => {
  it('reads every context graph, or one, with the adapter token, and adds a plain-words summary', async () => {
    const fetchMock = answering(json(200, SETTINGS));
    const status = tools().get('dkg_read_graphs_status')!;
    const all = await status.execute('tc', {});
    await status.execute('tc', { context_graph_id: 'did:dkg:context-graph:0xabc/team' });

    expect(fetchMock.mock.calls.map(([url, init]) => [String(url), init?.method, new Headers(init?.headers).get('Authorization'), new Headers(init?.headers).get('X-DKG-Actor')])).toEqual([
      ['http://localhost:9200/api/store/read-graphs/settings', 'GET', 'Bearer admin-token', null],
      ['http://localhost:9200/api/store/read-graphs/settings?contextGraphId=0xabc%2Fteam', 'GET', 'Bearer admin-token', null],
    ]);
    expect(parsed(all)).toEqual({ summary: SUMMARY, ...SETTINGS });
    expect(all.details).toEqual({ summary: SUMMARY, ...SETTINGS });
  });

  it('refuses an id that names no context graph without a request', async () => {
    const fetchMock = answering(json(200, SETTINGS));
    const status = tools().get('dkg_read_graphs_status')!;
    for (const id of ['did:dkg:context-graph:', '  ', 7]) {
      expect(parsed(await status.execute('tc', { context_graph_id: id }))).toEqual({ error: '"context_graph_id" must be a context graph id.' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says only the node admin may see the settings, names an older node, and one it cannot reach', async () => {
    answering(
      json(403, { error: 'GET /api/store/read-graphs/settings requires a node-level admin token.' }),
      json(404, { error: 'Not found' }),
      new TypeError('fetch failed'),
    );
    const status = tools().get('dkg_read_graphs_status')!;
    expect(parsed(await status.execute('tc', {})).error).toBe(
      "Only the node admin can see or change search across assets, and the node did not accept this OpenClaw adapter's token "
        + 'as the node admin token (HTTP 403).',
    );
    expect(parsed(await status.execute('tc', {})).error).toMatch(/runs a DKG version from before them/);
    expect(parsed(await status.execute('tc', {})).error).toBe('No answer from the node: fetch failed');
  });

  it('keeps a non-object answer out of the result', async () => {
    answering(json(200, ['odd']));
    expect(parsed(await tools().get('dkg_read_graphs_status')!.execute('tc', {}))).toEqual({
      summary: 'No context graph has search across assets set up.',
    });
  });
});

describe('dkg_read_graphs_set', () => {
  it('puts the engine modes for the words users see, on published assets by default', async () => {
    const answer = { ...SETTINGS, changes: [{ contextGraphId: 'team', layer: 'verifiable-memory', from: 'build', to: 'serve', outcome: 'applied' }] };
    const fetchMock = answering(json(200, answer));
    const result = await tools().get('dkg_read_graphs_set')!.execute('tc', { context_graph_id: 'did:dkg:context-graph:team', mode: 'on' });

    const [url, init] = fetchMock.mock.calls[0];
    expect([String(url), init?.method, new Headers(init?.headers).get('Authorization'), new Headers(init?.headers).get('X-DKG-Actor')])
      .toEqual(['http://localhost:9200/api/store/read-graphs/settings', 'PUT', 'Bearer admin-token', 'agent:openclaw']);
    expect(JSON.parse(String(init?.body))).toEqual({ contextGraphId: 'team', layers: { 'verifiable-memory': 'serve' } });
    expect(parsed(result)).toEqual({ summary: `Turned search across assets on for team's published assets.\n\n${SUMMARY}`, ...answer });
  });

  it('sets all three layers, and the default semantics or its removal', async () => {
    const fetchMock = answering(json(200, SETTINGS));
    const set = tools().get('dkg_read_graphs_set')!;
    await set.execute('tc', { context_graph_id: 'team', mode: 'preview', layer: 'all', default_semantics: 'per-asset' });
    const cleared = await set.execute('tc', { context_graph_id: 'team', default_semantics: 'none' });
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { contextGraphId: 'team', layers: { 'verifiable-memory': 'build', 'shared-working-memory': 'build', 'working-memory': 'build' }, viewSemantics: 'per-asset' },
      { contextGraphId: 'team', viewSemantics: null },
    ]);
    expect(parsed(cleared).summary).toBe(SUMMARY);
  });

  it.each([
    [{}, '"context_graph_id" is required.'],
    [{ context_graph_id: 'did:dkg:context-graph:', mode: 'on' }, '"context_graph_id" is required.'],
    [{ context_graph_id: 'team', mode: 'everything' }, '"mode" must be one of off, preview, on.'],
    [{ context_graph_id: 'team', mode: 'serve' }, '"mode" must be one of off, preview, on.'],
    [{ context_graph_id: 'team', mode: 'on', layer: 'cold-storage' }, '"layer" must be one of verifiable-memory, shared-working-memory, working-memory, all.'],
    [{ context_graph_id: 'team', default_semantics: true }, '"default_semantics" must be one of merged, per-asset, none.'],
    [{ context_graph_id: 'team' }, 'Give "mode", "default_semantics", or both.'],
    [{ context_graph_id: 'team', layer: 'all', default_semantics: 'merged' }, '"layer" needs "mode".'],
  ])('refuses %j without a request', async (args, error) => {
    const fetchMock = answering(json(200, SETTINGS));
    expect(parsed(await tools().get('dkg_read_graphs_set')!.execute('tc', args))).toEqual({ error });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives the node's refusal sentence and code, and says only the node admin may change the settings", async () => {
    answering(
      json(409, { code: 'READ_GRAPHS_ROLLBACK_TARGET_OLDER', error: 'The rollback target cannot read these settings.' }),
      json(403, { error: 'Requires a node-level admin token.' }),
    );
    const set = tools().get('dkg_read_graphs_set')!;
    expect(parsed(await set.execute('tc', { context_graph_id: 'team', mode: 'on' })).error)
      .toBe('The node refused: The rollback target cannot read these settings. (READ_GRAPHS_ROLLBACK_TARGET_OLDER)');
    expect(parsed(await set.execute('tc', { context_graph_id: 'team', mode: 'off' })).error)
      .toMatch(/^Only the node admin can see or change search across assets, and the node did not accept this OpenClaw adapter's token as the node admin token \(HTTP 403\)/);
  });

  it('reports a thrown value that is not an Error', async () => {
    globalThis.fetch = (async () => { throw 'socket closed'; }) as unknown as typeof fetch;
    expect(parsed(await tools().get('dkg_read_graphs_set')!.execute('tc', { context_graph_id: 'team', mode: 'off' })).error)
      .toBe('No answer from the node: socket closed');
  });
});

describe('the create option', () => {
  it.each([
    [{}, {}],
    [{ read_graphs: 'preview' }, { readGraphs: { layers: { 'verifiable-memory': 'build' } } }],
    [{ read_graphs: 'on', read_graph_layer: 'working-memory' }, { readGraphs: { layers: { 'working-memory': 'serve' } } }],
    [{ read_graphs: 'on', read_graph_layer: 'all' }, { readGraphs: { layers: { 'verifiable-memory': 'serve', 'shared-working-memory': 'serve', 'working-memory': 'serve' } } }],
    [{ read_graph_layer: 'all' }, { error: '"read_graph_layer" needs "read_graphs".' }],
    [{ read_graphs: 'off' }, { error: '"read_graphs" must be one of preview, on.' }],
    [{ read_graphs: 'build' }, { error: '"read_graphs" must be one of preview, on.' }],
    [{ read_graphs: 'on', read_graph_layer: 3 }, { error: '"read_graph_layer" must be one of verifiable-memory, shared-working-memory, working-memory, all.' }],
  ])('reads %j', (args, expected) => {
    expect(readGraphsCreateOption(args)).toEqual(expected);
  });

  it('adds the outcome only when a setting was asked for', () => {
    const result = { created: 'team', uri: 'did:dkg:context-graph:team', readGraphs: { applied: true } };
    expect(withReadGraphsOutcome(result, undefined, 'team')).toBe(result);
    expect(withReadGraphsOutcome(result, { layers: { 'verifiable-memory': 'build' } }, 'team')).toEqual({
      ...result,
      searchAcrossAssets: "Getting search across assets ready for team's published assets. Preview shows how results would change before it is turned on.",
    });
  });
});

describe('DkgNodePlugin', () => {
  function plugin(): Map<string, OpenClawTool> {
    const node = new DkgNodePlugin({ daemonUrl: 'http://localhost:9200' });
    const registered: OpenClawTool[] = [];
    node.register({ config: {}, registerTool: (tool) => registered.push(tool), registerHook: () => {}, on: () => {}, logger: {} });
    return new Map(registered.map((tool) => [tool.name, tool] as const));
  }

  it('registers both settings tools after the existing ones', () => {
    const names = [...plugin().keys()];
    expect(names.slice(-2)).toEqual(['dkg_read_graphs_status', 'dkg_read_graphs_set']);
    expect(Object.keys(plugin().get('dkg_context_graph_create')!.parameters.properties)).toEqual(
      expect.arrayContaining(['read_graphs', 'read_graph_layer']),
    );
  });

  it('creates a context graph with the setting and reports what happened to it', async () => {
    const fetchMock = answering(json(200, { created: 'team', uri: 'did:dkg:context-graph:team', readGraphs: { refused: 'Only the node admin can change this.' } }));
    const result = await plugin().get('dkg_context_graph_create')!.execute('tc', { name: 'Team', read_graphs: 'on' });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      id: 'team', name: 'Team', accessPolicy: 1, readGraphs: { layers: { 'verifiable-memory': 'serve' } },
    });
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('X-DKG-Actor')).toBe('agent:openclaw');
    expect(parsed(result).searchAcrossAssets).toBe(
      'Search across assets was not turned on for team: Only the node admin can change this. '
        + 'The context graph was created; search across assets can be turned on later with dkg_read_graphs_set.',
    );
  });

  it('creates as before without the setting, and refuses a bad one without a request', async () => {
    const fetchMock = answering(json(200, { created: 'team', uri: 'did:dkg:context-graph:team' }));
    const create = plugin().get('dkg_context_graph_create')!;
    const plain = await create.execute('tc', { name: 'Team', public: true });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ id: 'team', name: 'Team' });
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('X-DKG-Actor')).toBeNull();
    expect(parsed(plain)).toEqual({ created: 'team', uri: 'did:dkg:context-graph:team' });
    expect(parsed(await create.execute('tc', { name: 'Team', read_graphs: 'everything' })))
      .toEqual({ error: '"read_graphs" must be one of preview, on.' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
