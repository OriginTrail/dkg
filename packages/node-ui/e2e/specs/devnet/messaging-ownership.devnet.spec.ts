import { test, expect } from '../../fixtures/base.js';
import { isDevnetAvailable, devnetApiFetch, waitForDevnetStatus } from '../../helpers/devnet.js';
import { listContextGraphs, pickWritableContextGraph } from '../../helpers/devnet-publish.js';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.skip(!isDevnetAvailable(1), 'Devnet node1 not running');
  await waitForDevnetStatus(1);
});

test.describe('Inter-node messaging (devnet API)', () => {
  test('node2 is reachable when 6-node devnet is running', async () => {
    test.skip(!isDevnetAvailable(2), 'Devnet node2 not running');
    await waitForDevnetStatus(2);
    const res = await devnetApiFetch('/api/status', { nodeNum: 2 });
    expect(res.ok).toBe(true);
  });

  test('agents endpoint lists connected peers over prolonged polling window', async () => {
    test.skip(!isDevnetAvailable(2), 'Devnet node2 not running');
    let maxPeers = 0;
    let okResponses = 0;
    for (let i = 0; i < 6; i++) {
      const res = await devnetApiFetch('/api/agents', { nodeNum: 1 });
      if (res.ok) {
        okResponses++;
        const json = (await res.json()) as { agents: unknown[] };
        maxPeers = Math.max(maxPeers, json.agents?.length ?? 0);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(okResponses).toBeGreaterThan(0);
    expect(maxPeers).toBeGreaterThan(0);
  });

  test('memory sessions endpoint responds (messaging persistence surface)', async () => {
    // `/api/memory/sessions` is served by the UI proxy layer; daemon may 404.
    const res = await devnetApiFetch('/api/memory/sessions?limit=5');
    expect([200, 404]).toContain(res.status);
  });
});

test.describe('Ownership transfer UI prerequisites (devnet API)', () => {
  test('participants list is readable for first context graph', async () => {
    const cg = pickWritableContextGraph(await listContextGraphs(1));
    test.skip(!cg, 'No writable CGs');
    const cgId = cg.id;
    const res = await devnetApiFetch(`/api/context-graph/${encodeURIComponent(cgId)}/participants`);
    expect(res.ok).toBe(true);
  });
});
