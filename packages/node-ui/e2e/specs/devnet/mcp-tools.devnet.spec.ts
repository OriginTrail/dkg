import { test, expect } from '../../fixtures/base.js';
import { isDevnetAvailable, devnetApiFetch, waitForDevnetStatus } from '../../helpers/devnet.js';
import { listContextGraphs, pickWritableContextGraph } from '../../helpers/devnet-publish.js';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.skip(!isDevnetAvailable(1), 'Devnet node1 not running');
  await waitForDevnetStatus(1);
});

test.describe('MCP server tools (devnet API smoke)', () => {
  test('daemon status endpoint is healthy', async () => {
    const res = await devnetApiFetch('/api/status');
    expect(res.ok).toBe(true);
    const json = (await res.json()) as { version?: string; identityId?: string };
    expect(json.version).toBeTruthy();
  });

  test('agent identity endpoint returns address', async () => {
    const res = await devnetApiFetch('/api/agent/identity');
    expect(res.ok).toBe(true);
    const json = (await res.json()) as { agentAddress?: string };
    expect(json.agentAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  test('context graph list is non-empty on seeded devnet', async () => {
    const res = await devnetApiFetch('/api/context-graphs');
    expect(res.ok).toBe(true);
    const json = (await res.json()) as { contextGraphs: unknown[] };
    expect(json.contextGraphs.length).toBeGreaterThan(0);
  });

  test('SPARQL query endpoint returns bindings for devnet CG', async () => {
    const cg = pickWritableContextGraph(await listContextGraphs(1));
    test.skip(!cg, 'No writable CGs');
    const cgId = cg.id;
    const res = await devnetApiFetch('/api/query', {
      method: 'POST',
      body: JSON.stringify({
        sparql: 'SELECT ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } LIMIT 5',
        contextGraphId: cgId,
      }),
    });
    expect(res.ok).toBe(true);
    const json = (await res.json()) as { result?: { bindings?: unknown[] } };
    expect(Array.isArray(json.result?.bindings)).toBe(true);
    expect(json.result!.bindings!.length).toBeGreaterThan(0);
  });

  test('context graph manifest endpoint responds', async () => {
    const cg = pickWritableContextGraph(await listContextGraphs(1));
    test.skip(!cg, 'No writable CGs');
    const cgId = cg.id;
    const res = await devnetApiFetch(`/api/context-graph/${encodeURIComponent(cgId)}/manifest`);
    expect([200, 404]).toContain(res.status);
  });

  test('gossip log surface is reachable via node log API', async () => {
    const res = await devnetApiFetch('/api/node-log?limit=5');
    expect([200, 404]).toContain(res.status);
  });
});
