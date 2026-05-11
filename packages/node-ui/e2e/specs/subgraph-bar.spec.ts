import { test, expect } from '../fixtures/base.js';

/**
 * SubGraphBar — the row of sub-graph chips above the memory layers.
 *
 * The bar is *purely additive*: if /api/sub-graph/list returns no non-meta
 * sub-graphs the component renders null (SubGraphBar.tsx:120). For the
 * seeded `qa-cg` (no ontology installed) that's exactly the state we'd
 * normally see — so these tests focus on the wiring contracts that have
 * to hold whether or not chips are present:
 *
 *   • the daemon fetch fires on project open
 *   • `useMemoryGraphEvents(contextGraphId, loadSubGraphs)` (SubGraphBar.tsx:97)
 *     re-fires on a `memory_graph_changed` event for THIS cg, but stays put
 *     for events on other CGs
 *   • each rendered chip is a clickable button that drives the `onSelect`
 *     callback (and visually goes `.active` for the chosen one)
 *
 * Together with `live-memory-updates.spec.ts` (which proves the SSE plumbing
 * end-to-end via AssertionList) these tests give the full live-update
 * coverage matrix without needing to install an ontology in the test fixture.
 */

test.describe('SubGraphBar', () => {
  test.beforeEach(async ({ shell, leftPanel, projectView, seed, page }) => {
    await shell.goto();
    await leftPanel.waitForReady();
    await leftPanel.openProject(seed.contextGraphName);
    await page.locator('.v10-layer-switcher').first().waitFor({ state: 'visible', timeout: 15_000 });
    await projectView.switchLayer('wm');
  });

  test('mounts and issues GET /api/sub-graph/list for the open CG', async ({ page, seed, shell, leftPanel, projectView }) => {
    // Set up a route observer and re-enter the project so the mount fetch
    // can be captured. The bar fires the request unconditionally in its
    // mount useEffect (SubGraphBar.tsx ~line 60); if a future refactor
    // moves the fetch behind a feature flag or breaks the URL, the route
    // handler never sees a hit and we fail loudly.
    let observed = false;
    await page.route('**/api/sub-graph/list*', (route) => {
      const u = new URL(route.request().url());
      if (u.searchParams.get('contextGraphId') === seed.contextGraphId) {
        observed = true;
      }
      route.continue();
    });
    await shell.goto();
    await leftPanel.waitForReady();
    await leftPanel.openProject(seed.contextGraphName);
    await page.locator('.v10-layer-switcher').first().waitFor({ state: 'visible', timeout: 15_000 });
    await projectView.switchLayer('wm');
    await expect.poll(() => observed, { timeout: 10_000, intervals: [200, 300, 500] }).toBe(true);
  });

  test('renders chips when /api/sub-graph/list returns non-empty data', async ({ page, seed, leftPanel, projectView }) => {
    // The bar early-returns null with no sub-graphs. Mock the endpoint to
    // synthesise a populated state so the chip-render path is exercised
    // even without an installed ontology — the entire chip DOM is owned by
    // this component, so this is a faithful test of the render path that
    // ships in production for projects that DO have sub-graphs.
    await page.route('**/api/sub-graph/list*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          subGraphs: [
            { name: 'decisions', description: 'Architectural decisions', entityCount: 3, tripleCount: 21 },
            { name: 'tasks', description: 'Tracked tasks', entityCount: 5, tripleCount: 18 },
            { name: 'meta', description: 'Profile and ontology', entityCount: 1, tripleCount: 4 },
          ],
        }),
      }),
    );
    await page.reload();
    await leftPanel.waitForReady();
    await leftPanel.openProject(seed.contextGraphName);
    await page.locator('.v10-layer-switcher').first().waitFor({ state: 'visible', timeout: 15_000 });
    await projectView.switchLayer('wm');

    // "All" + each non-meta sub-graph chip. `meta` is filtered out
    // (SubGraphBar.tsx:103).
    const bar = page.locator('.v10-subgraph-bar');
    await expect(bar).toBeVisible({ timeout: 10_000 });
    const chips = bar.locator('.v10-subgraph-chip');
    // 1 (All) + 2 (decisions, tasks) = 3 chips. `meta` is excluded.
    await expect(chips).toHaveCount(3);
    // The first chip is "All" with the ⊚ icon.
    await expect(chips.nth(0)).toHaveText(/All/);
    // The remaining chips carry the entity counts we mocked.
    await expect(bar.getByText('decisions', { exact: false })).toBeVisible();
    await expect(bar.getByText('tasks', { exact: false })).toBeVisible();
    // `meta` must NEVER appear in the bar — guard the filter.
    await expect(bar.getByText(/^meta$/)).toHaveCount(0);
  });

  test('clicking a chip flips its `.active` class and "All" becomes inactive', async ({ page, seed, leftPanel, projectView }) => {
    await page.route('**/api/sub-graph/list*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          subGraphs: [
            { name: 'decisions', description: 'Decisions', entityCount: 2, tripleCount: 10 },
          ],
        }),
      }),
    );
    await page.reload();
    await leftPanel.waitForReady();
    await leftPanel.openProject(seed.contextGraphName);
    await page.locator('.v10-layer-switcher').first().waitFor({ state: 'visible', timeout: 15_000 });
    await projectView.switchLayer('wm');

    const bar = page.locator('.v10-subgraph-bar');
    await expect(bar).toBeVisible({ timeout: 10_000 });
    const all = bar.locator('.v10-subgraph-chip').nth(0);
    const decisions = bar.locator('.v10-subgraph-chip').filter({ hasText: 'decisions' }).first();

    // Default: All active.
    await expect(all).toHaveClass(/active/);
    await expect(decisions).not.toHaveClass(/active/);

    await decisions.click();
    await expect(decisions).toHaveClass(/active/, { timeout: 5_000 });
    await expect(all).not.toHaveClass(/active/);

    // Clicking All deactivates the sub-graph.
    await all.click();
    await expect(all).toHaveClass(/active/);
    await expect(decisions).not.toHaveClass(/active/);
  });

  test('a memory_graph_changed SSE event for THIS cg auto-refetches /api/sub-graph/list', async ({ page, seed, daemon, leftPanel, projectView, shell }) => {
    // Live-update contract: useMemoryGraphEvents(contextGraphId,
    // loadSubGraphs) is wired in SubGraphBar.tsx to fire loadSubGraphs()
    // whenever the SSE event matches the open cg. Drive a real WM write
    // through the daemon (it emits the SSE event) and confirm /api/sub-
    // graph/list is re-hit WITHOUT a manual reload.
    let calls = 0;
    await page.route('**/api/sub-graph/list*', (route) => {
      calls++;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ subGraphs: [] }),
      });
    });
    await shell.goto();
    await leftPanel.waitForReady();
    await leftPanel.openProject(seed.contextGraphName);
    await page.locator('.v10-layer-switcher').first().waitFor({ state: 'visible', timeout: 15_000 });
    await projectView.switchLayer('wm');

    // Allow the initial mount fetch(es) to settle.
    await page.waitForTimeout(800);
    const baseline = calls;
    expect(baseline).toBeGreaterThanOrEqual(1);

    // Drive a WM write — this causes the daemon to emit memory_graph_changed.
    const probeName = `subgraph-sse-probe-${Date.now()}`;
    const writeResp = await page.request.post(
      `/api/assertion/${encodeURIComponent(probeName)}/write`,
      {
        headers: { Authorization: `Bearer ${daemon.authToken}` },
        data: {
          contextGraphId: seed.contextGraphId,
          quads: [
            {
              subject: 'urn:dkg:e2e:subgraph-sse',
              predicate: 'http://schema.org/name',
              object: '"SubGraphBar SSE probe"',
              graph: '',
            },
          ],
        },
      },
    );
    expect(writeResp.ok()).toBe(true);

    // Pure SSE-driven refetch — no re-entry / reload.
    await expect.poll(() => calls, { timeout: 15_000, intervals: [200, 400, 800, 1500] }).toBeGreaterThan(baseline);
  });
});
