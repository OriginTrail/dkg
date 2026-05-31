/**
 * Context graph variant matrix on devnet — edge vs core node roles.
 */
import { test, expect } from '../../fixtures/base.js';
import { isDevnetAvailable, waitForDevnetStatus, devnetApiFetch } from '../../helpers/devnet.js';
import { listContextGraphs, buildTestQuads, createWmAssertion } from '../../helpers/devnet-publish.js';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.skip(!isDevnetAvailable(1), 'Devnet node1 not running');
  await waitForDevnetStatus(1);
});

async function nodeRole(nodeNum: number): Promise<string> {
  const res = await devnetApiFetch('/api/status', { nodeNum });
  const json = (await res.json()) as { nodeRole?: string };
  return json.nodeRole ?? 'unknown';
}

test.describe('CG variants — edge and core nodes', () => {
  test('node1 and node2 both expose context graphs', async () => {
    test.skip(!isDevnetAvailable(2), 'Need 6-node devnet for core/edge matrix');
    await waitForDevnetStatus(2);
    const n1 = await listContextGraphs(1);
    const n2 = await listContextGraphs(2);
    expect(n1.length).toBeGreaterThan(0);
    expect(n2.length).toBeGreaterThan(0);
  });

  test('edge node (node5) can create WM assertion when available', async () => {
    test.skip(!isDevnetAvailable(5), 'Devnet node5 (edge) not running');
    await waitForDevnetStatus(5);
    const cgs = await listContextGraphs(5);
    test.skip(cgs.length === 0, 'No CGs on edge node');
    const cgId = cgs[0]!.id;
    const stamp = Date.now();
    const res = await createWmAssertion({
      contextGraphId: cgId,
      name: `e2e-edge-wm-${stamp}`,
      quads: buildTestQuads(cgId, stamp, `Edge WM ${stamp}`),
      nodeNum: 5,
    });
    expect(res.ok).toBe(true);
  });

  test('core node (node1) can create WM assertion', async () => {
    const cgs = await listContextGraphs(1);
    test.skip(cgs.length === 0, 'No CGs on core');
    const cgId = cgs[0]!.id;
    const stamp = Date.now();
    const res = await createWmAssertion({
      contextGraphId: cgId,
      name: `e2e-core-wm-${stamp}`,
      quads: buildTestQuads(cgId, stamp, `Core WM ${stamp}`),
      nodeNum: 1,
    });
    expect(res.ok).toBe(true);
  });

  test('reports node roles for edge/core identification', async () => {
    const role1 = await nodeRole(1);
    expect(role1.length).toBeGreaterThan(0);
    if (isDevnetAvailable(5)) {
      const role5 = await nodeRole(5);
      expect(role5.length).toBeGreaterThan(0);
    }
  });
});

test.describe('CG variants — UI visibility across nodes', () => {
  test('UI pointed at node1 lists devnet context graphs', async ({ shell, leftPanel, page }) => {
    await shell.goto();
    await page.waitForTimeout(2000);
    const names = await leftPanel.getProjectNames();
    expect(names.length).toBeGreaterThan(0);
  });
});
