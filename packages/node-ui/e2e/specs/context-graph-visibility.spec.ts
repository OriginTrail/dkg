import { test, expect } from '../fixtures/rich.js';
import { PRIMARY_CG, SECONDARY_CG } from '../helpers/real-node.js';
import { sel } from '../helpers/selectors.js';

test.describe('Context graph visibility', () => {
  test.beforeEach(async ({ shell }) => {
    await shell.goto();
  });

  test('left panel lists the seeded context graphs under My Context Graphs', async ({ leftPanel }) => {
    await leftPanel.waitForProjectsLoaded();
    const names = await leftPanel.getProjectNames();
    // scripts/devnet.sh registers these two CGs on every boot.
    expect(names).toContain(PRIMARY_CG);
    expect(names).toContain(SECONDARY_CG);
  });

  test('dashboard My Context Graphs stat reflects the seeded count', async ({ page }) => {
    const card = page
      .locator('.v10-stat-tight')
      .filter({ has: page.locator('.stat-label', { hasText: 'My Context Graphs' }) });
    await expect(card).toBeVisible();
    // The value slot shows a "loading…" placeholder until the CG set resolves
    // (can be slow under load), so poll the .stat-value until it's a number.
    // The devnet seeds two; prior runs may add more, so assert the floor.
    const value = card.locator('.stat-value');
    await expect
      .poll(
        async () => {
          const t = (await value.textContent())?.trim() ?? '';
          return /^\d+$/.test(t) ? Number(t) : -1;
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThanOrEqual(2);
  });

  test('each seeded context graph opens its own center tab', async ({ leftPanel, centerPanel, page }) => {
    for (const name of [PRIMARY_CG, SECONDARY_CG]) {
      await leftPanel.expandProject(name);
      await expect(page.locator(sel.center.tab).filter({ hasText: name })).toBeVisible();
      const tabs = await centerPanel.getTabNames();
      expect(tabs.some((t) => t.includes(name))).toBe(true);
    }
  });

  test('seeded CG shows layer switcher with WM/SWM/VM', async ({ leftPanel, page }) => {
    await leftPanel.expandProject(PRIMARY_CG);
    await expect(page.locator(`${sel.layer.switchBtn}[data-layer="wm"]`)).toBeVisible();
    await expect(page.locator(`${sel.layer.switchBtn}[data-layer="swm"]`)).toBeVisible();
    await expect(page.locator(`${sel.layer.switchBtn}[data-layer="vm"]`)).toBeVisible();
  });

  test('the second seeded CG is visible and openable', async ({ leftPanel, page }) => {
    await leftPanel.expandProject(SECONDARY_CG);
    await expect(page.locator(sel.center.tab).filter({ hasText: SECONDARY_CG })).toBeVisible();
    await expect(page.locator('.v10-project-strip-name').filter({ hasText: SECONDARY_CG })).toBeVisible();
  });
});

test.describe('Context graph hide / restore (sidebar visibility toggle)', () => {
  // localStorage is per-browser-context (fresh per test), so hiding here never
  // leaks into other specs. The whole gesture is reversible in-UI, so this is a
  // safe real-node interaction to drive end-to-end.
  test.beforeEach(async ({ shell, leftPanel }) => {
    await shell.goto();
    await leftPanel.waitForProjectsLoaded();
  });

  test('the × button hides a CG from the sidebar and surfaces a restore affordance', async ({ leftPanel, page }) => {
    const before = await leftPanel.getProjectNames();
    expect(before).toContain(PRIMARY_CG);
    expect(before.length).toBeGreaterThanOrEqual(2);

    await leftPanel.hideProject(PRIMARY_CG);

    // The hidden CG drops out; siblings remain. Poll — the list re-renders off a
    // dispatched `v10:hidden-projects-change` event.
    await expect.poll(async () => await leftPanel.getProjectNames()).not.toContain(PRIMARY_CG);
    const after = await leftPanel.getProjectNames();
    expect(after).toContain(SECONDARY_CG);
    expect(after.length).toBe(before.length - 1);

    // The reversible restore button shows an accurate hidden count.
    await expect(leftPanel.showHiddenButton).toBeVisible();
    await expect(leftPanel.showHiddenButton).toContainText(/Show 1 hidden context graph\b/);

    // Persisted under the SAME key the dashboard + memory-stack read.
    const hidden = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('v10:hiddenProjectIds') || '[]'),
    );
    expect(Array.isArray(hidden)).toBe(true);
    expect(hidden.length).toBe(1);
    expect(typeof hidden[0]).toBe('string');
    expect(hidden[0].length).toBeGreaterThan(0);
  });

  test('the restore button un-hides every CG and then disappears', async ({ leftPanel, page }) => {
    await leftPanel.hideProject(PRIMARY_CG);
    await expect(leftPanel.showHiddenButton).toBeVisible();

    await leftPanel.showHiddenProjects();

    // The CG comes back and the restore control is gone (nothing hidden now).
    await expect.poll(async () => await leftPanel.getProjectNames()).toContain(PRIMARY_CG);
    await expect(leftPanel.showHiddenButton).toHaveCount(0);
    const hidden = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('v10:hiddenProjectIds') || '[]'),
    );
    expect(hidden.length).toBe(0);
  });

  test('hiding a CG decrements the dashboard "My Context Graphs" count in lockstep', async ({ leftPanel, page }) => {
    // PanelLeft + DashboardView share `useHiddenContextGraphIds`, so the sidebar
    // and the dashboard stat MUST move together — this is the invariant the hook
    // was extracted to guarantee. A regression to three private copies fails here.
    const statValue = page
      .locator('.v10-stat-tight')
      .filter({ has: page.locator('.stat-label', { hasText: 'My Context Graphs' }) })
      .locator('.stat-value');

    const readCount = async () => {
      const t = (await statValue.textContent())?.trim() ?? '';
      return /^\d+$/.test(t) ? Number(t) : -1;
    };

    // Wait for the count to resolve from its "loading…" placeholder.
    await expect.poll(readCount, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    const baseline = await readCount();

    await leftPanel.hideProject(PRIMARY_CG);

    await expect.poll(readCount, { timeout: 10_000 }).toBe(baseline - 1);
  });
});

test.describe('Context graph overview navigation', () => {
  test.beforeEach(async ({ shell, leftPanel }) => {
    await shell.goto();
    await leftPanel.expandProject(PRIMARY_CG);
  });

  test('project overview shows stat strip with Entities and Triples', async ({ projectLayer }) => {
    const cells = await projectLayer.getStatStripCells();
    const labels = cells.map((c) => c.label.toLowerCase());
    expect(labels.some((l) => l.includes('entit'))).toBe(true);
    expect(labels.some((l) => l.includes('triple'))).toBe(true);
  });

  test('overview triple count renders as a non-negative number', async ({ projectLayer }) => {
    const cells = await projectLayer.getStatStripCells();
    const triples = cells.find((c) => c.label.toLowerCase().includes('triple'));
    expect(triples).toBeTruthy();
    const n = Number(String(triples?.value ?? '').replace(/[^0-9]/g, ''));
    expect(Number.isFinite(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(0);
  });

  test('Share action opens Share Context Graph modal', async ({ projectLayer, shareProjectModal }) => {
    await projectLayer.clickShare();
    await expect(shareProjectModal.title).toHaveText('Share Context Graph');
    await shareProjectModal.close();
  });

  test('Subgraphs tab opens subgraph explorer', async ({ projectLayer, page }) => {
    await projectLayer.switchLayer('Subgraphs');
    await expect(page.locator(sel.subgraph.explorerTitle)).toHaveText('Subgraph Explorer');
  });
});
