import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { DkgClient, type ProjectRow } from '../src/client.js';
import { registerReadTools } from '../src/tools.js';
import { registerQueryCatalogTools } from '../src/tools/query-catalog.js';
import { filterContextGraphsForScope } from '../src/tools/context-graph-scope.js';
import { FakeClient, FakeServer, makeConfig } from './harness.js';

const address = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const did = `did:dkg:agent:${address}`;
let http: Server | undefined;
afterEach(async () => {
  if (!http) return;
  http.closeAllConnections();
  await new Promise<void>((resolve, reject) => http!.close((error) => error ? reject(error) : resolve()));
  http = undefined;
});

const rows: ProjectRow[] = [
  { id: 'owned', curator: `<did:dkg:agent:${address.toUpperCase()}>` },
  { id: 'joined', callerInvolved: true },
  { id: 'explicit-exclusion', callerInvolved: false, curator: did },
  { id: 'discovered', curator: 'did:dkg:agent:foreign', subscribed: true },
  { id: 'role-only', role: 'curator' },
  { id: 'unknown' },
  { id: 'agents', isSystem: true, callerInvolved: true },
];

describe('MCP mine membership', () => {
  it('requires positive caller membership or a matching legacy curator, not discovery or subscription', () => {
    expect(filterContextGraphsForScope(rows, 'mine', did).map((row) => row.id)).toEqual(['owned', 'joined']);
    expect(filterContextGraphsForScope(rows, 'mine').map((row) => row.id)).toEqual(['joined']);
    expect(filterContextGraphsForScope(rows, 'all')).toEqual(rows);
  });

  it.each([
    { id: 'team', name: 'team', nameKnown: true, expected: 'team' },
    { id: 'team', name: 'team', expected: 'team' },
    { id: `0x${'a'.repeat(64)}`, name: `0x${'a'.repeat(64)}`, nameKnown: false, expected: '(name unresolved)' },
    { id: `0x${'a'.repeat(64)}`, name: `0x${'a'.repeat(64)}`, expected: '(name unresolved)' },
    { id: `0x${'a'.repeat(64)}`, name: `0x${'a'.repeat(64)}`, nameKnown: true, expected: `0x${'a'.repeat(64)}` },
    { id: `0x${'a'.repeat(64)}`, name: 'Resolved graph', expected: 'Resolved graph' },
    { id: 'team', name: 'stale name', nameKnown: false, expected: '(name unresolved)' },
  ])('renders known names and only marks unresolved daemon/legacy names: $expected ($nameKnown)', async ({ expected, ...row }) => {
    const tools = new FakeServer();
    const client = new FakeClient({ listProjects: async () => [{ ...row, callerInvolved: true }] });
    registerReadTools(tools.asMcpServer(), client.asDkgClient(), makeConfig({ defaultProject: null }));
    const result = await tools.call('dkg_list_context_graphs', {});
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain(`- **${row.id}** — ${expected}`);
  });

  it('fails visibly when legacy curator ownership cannot be resolved, while explicit membership needs no identity probe', async () => {
    const identity = vi.fn(async () => { throw new Error('identity unavailable'); });
    const legacy = new FakeClient({ listProjects: async () => [{ id: 'owned', curator: did }], getAgentIdentity: identity });
    const tools = new FakeServer();
    registerReadTools(tools.asMcpServer(), legacy.asDkgClient(), makeConfig());
    const failed = await tools.call('dkg_list_context_graphs', {});
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toContain('identity unavailable');
    const explicit = new FakeClient({ listProjects: async () => [{ id: 'joined', callerInvolved: true }], getAgentIdentity: identity });
    const explicitTools = new FakeServer();
    registerReadTools(explicitTools.asMcpServer(), explicit.asDkgClient(), makeConfig());
    const listed = await explicitTools.call('dkg_list_context_graphs', {});
    expect(listed.isError).toBeFalsy();
    expect(listed.content[0].text).toContain('**joined**');
    expect(identity).toHaveBeenCalledTimes(1);
  });

  it('returns the same owned graph through listing and catalog tools over authenticated HTTP', async () => {
    const routes: string[] = [];
    const catalogGraphs: unknown[] = [];
    http = createServer(async (request, response) => {
      routes.push(request.url ?? '');
      if (request.headers.authorization !== 'Bearer test-token') {
        response.writeHead(401); response.end(); return;
      }
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/context-graph/list') response.end(JSON.stringify({ contextGraphs: rows }));
      else if (request.url === '/api/agent/identity') response.end(JSON.stringify({ agentDid: did, agentAddress: address }));
      else {
        if (request.url === '/api/profile/query-catalog/read' && request.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          catalogGraphs.push(JSON.parse(Buffer.concat(chunks).toString()).contextGraphId);
        }
        response.writeHead(503); response.end(JSON.stringify({ error: 'catalog not available in this fixture' }));
      }
    });
    await new Promise<void>((resolve) => http!.listen(0, '127.0.0.1', resolve));
    const bound = http.address();
    if (!bound || typeof bound === 'string') throw new Error('HTTP server did not bind');
    const config = makeConfig({ api: `http://127.0.0.1:${bound.port}`, token: 'test-token' });
    const client = new DkgClient({ config });
    const tools = new FakeServer();
    registerReadTools(tools.asMcpServer(), client, config);
    registerQueryCatalogTools(tools.asMcpServer(), client, config);
    const mine = await tools.call('dkg_list_context_graphs', {});
    expect(mine.isError).toBeFalsy();
    expect(mine.content[0].text).toContain('Found 2 context graph(s)');
    expect(mine.content[0].text).toContain('**owned**');
    expect(mine.content[0].text).not.toContain('discovered');
    expect(mine.content[0].text).toContain('(name unresolved)');
    expect(routes.filter((route) => route === '/api/agent/identity')).toHaveLength(1);
    const all = await tools.call('dkg_list_context_graphs', { scope: 'all' });
    expect(all.content[0].text).toContain('Found 7 context graph(s)');
    expect(all.content[0].text).toContain('**discovered**');
    expect(routes.filter((route) => route === '/api/agent/identity')).toHaveLength(1);
    const catalog = await tools.call('dkg_query_catalog_context_graphs', {});
    expect(catalog.structuredContent).toMatchObject({ accessibleCount: 2, inspectedCount: 2 });
    expect(catalogGraphs.sort()).toEqual(['joined', 'owned']);
  });
});
