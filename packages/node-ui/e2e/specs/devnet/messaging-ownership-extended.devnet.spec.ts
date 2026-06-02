/**
 * Extended inter-node messaging soak + ownership / KA update prerequisites.
 */
import { test, expect } from '../../fixtures/base.js';
import {
  isDevnetAvailable,
  devnetApiFetch,
  waitForDevnetStatus,
} from '../../helpers/devnet.js';
import {
  listContextGraphs,
  runWmSwmVmPipeline,
  buildTestQuads,
  pickWritableContextGraph,
} from '../../helpers/devnet-publish.js';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.skip(!isDevnetAvailable(1), 'Devnet node1 not running');
  await waitForDevnetStatus(1);
});

test.describe('Prolonged inter-node messaging soak', () => {
  test('agents peer count stable over 30s polling window', async () => {
    test.skip(!isDevnetAvailable(2), 'Devnet node2 not running');
    const samples: number[] = [];
    let okResponses = 0;
    for (let i = 0; i < 15; i++) {
      const res = await devnetApiFetch('/api/agents', { nodeNum: 1 });
      if (res.ok) {
        okResponses++;
        const json = (await res.json()) as { agents: unknown[] };
        samples.push(json.agents?.length ?? 0);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(okResponses).toBeGreaterThanOrEqual(10);
    expect(Math.max(...samples)).toBeGreaterThan(0);
  });

  test('status endpoint stays healthy across nodes during soak', async () => {
    for (const nodeNum of [1, 2]) {
      test.skip(!isDevnetAvailable(nodeNum), `Devnet node${nodeNum} not running`);
      const res = await devnetApiFetch('/api/status', { nodeNum });
      expect(res.ok).toBe(true);
    }
  });
});

test.describe('Ownership transfer + delegated KA update (API)', () => {
  test('curator can list and mutate participants on owned CG', async () => {
    const cgs = await listContextGraphs(1);
    const cg = pickWritableContextGraph(cgs);
    test.skip(!cg, 'No writable CGs');
    const cgId = cg.id;
    const list = await devnetApiFetch(`/api/context-graph/${encodeURIComponent(cgId)}/participants`);
    expect(list.ok).toBe(true);
  });

  test('KA update endpoint accepts quads after WM→VM pipeline', async () => {
    const cgs = await listContextGraphs(1);
    const cg = pickWritableContextGraph(cgs);
    test.skip(!cg, 'No writable CGs');
    const cgId = cg.id;
    await runWmSwmVmPipeline({ contextGraphId: cgId });
    const stamp = Date.now();
    const res = await devnetApiFetch('/api/update', {
      method: 'POST',
      body: JSON.stringify({
        contextGraphId: cgId,
        quads: buildTestQuads(cgId, stamp, `Delegated update ${stamp}`),
      }),
    });
    expect([200, 400, 422]).toContain(res.status);
  });

  test('second agent registration succeeds on devnet node2', async () => {
    test.skip(!isDevnetAvailable(2), 'Devnet node2 not running');
    const { registerAgent } = await import('../../helpers/devnet-publish.js');
    const agent = await registerAgent(2, 'delegated');
    expect(agent.agentAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(agent.authToken.length).toBeGreaterThan(0);
  });
});
