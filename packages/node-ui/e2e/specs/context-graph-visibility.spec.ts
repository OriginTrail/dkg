import { test, expect } from '../fixtures/rich.js';
import {
  CLIMATE_CG_ID,
  EDGE_CG_IDS,
  PHARMA_CG_ID,
  PHARMA_LAYER_TRIPLE_COUNTS,
  SUPPLY_CG_ID,
} from '../helpers/rich-mock-data.js';
import { sel } from '../helpers/selectors.js';

test.describe('Context graph visibility', () => {
  test.beforeEach(async ({ shell }) => {
    await shell.goto();
  });

  test('left panel lists all mock context graphs under My Context Graphs', async ({ leftPanel }) => {
    await leftPanel.waitForProjectsLoaded();
    const names = await leftPanel.getProjectNames();
    expect(names).toContain('Pharma Drug Interactions');
    expect(names).toContain('Climate Science');
    expect(names).toContain('EU Supply Chain');
  });

  test('dashboard shows My Context Graphs stat with count 3', async ({ page }) => {
    const card = page.locator('.v10-stat-tight').filter({ has: page.locator('.stat-label', { hasText: 'My Context Graphs' }) });
    await expect(card).toBeVisible();
    await expect(card).toContainText('3');
  });

  test('each context graph opens its own center tab', async ({ leftPanel, centerPanel }) => {
    for (const name of ['Pharma Drug Interactions', 'Climate Science', 'EU Supply Chain']) {
      await leftPanel.expandProject(name);
      const tabs = await centerPanel.getTabNames();
      expect(tabs.some((t) => t.includes(name.split(' ')[0]!))).toBe(true);
    }
  });

  test('edge-style CG (Pharma) shows layer switcher with WM/SWM/VM', async ({ leftPanel, page }) => {
    await leftPanel.expandProject('Pharma Drug Interactions');
    await expect(page.locator(`${sel.layer.switchBtn}[data-layer="wm"]`)).toBeVisible();
    await expect(page.locator(`${sel.layer.switchBtn}[data-layer="swm"]`)).toBeVisible();
    await expect(page.locator(`${sel.layer.switchBtn}[data-layer="vm"]`)).toBeVisible();
  });

  test('edge-style CG (EU Supply Chain) owned by different curator is visible', async ({ leftPanel, page }) => {
    await leftPanel.expandProject('EU Supply Chain');
    const heading = page.getByRole('button', { name: 'EU Supply Chain', disabled: true });
    await expect(heading).toBeVisible();
  });

  test('core-style CG (Climate Science) is listed and openable', async ({ leftPanel, centerPanel }) => {
    await leftPanel.expandProject('Climate Science');
    const tabs = await centerPanel.getTabNames();
    expect(tabs.some((t) => t.includes('Climate'))).toBe(true);
  });

  test('context graph IDs map to expected edge/core variants', () => {
    expect(EDGE_CG_IDS).toContain(PHARMA_CG_ID);
    expect(EDGE_CG_IDS).toContain(SUPPLY_CG_ID);
    expect(EDGE_CG_IDS).not.toContain(CLIMATE_CG_ID);
  });
});

test.describe('Context graph overview navigation', () => {
  test.beforeEach(async ({ shell, leftPanel }) => {
    await shell.goto();
    await leftPanel.expandProject('Pharma Drug Interactions');
  });

  test('project overview shows stat strip with Entities and Triples', async ({ projectLayer }) => {
    const cells = await projectLayer.getStatStripCells();
    const labels = cells.map((c) => c.label.toLowerCase());
    expect(labels.some((l) => l.includes('entit'))).toBe(true);
    expect(labels.some((l) => l.includes('triple'))).toBe(true);
  });

  test('overview triple count matches rich mock fixture total', async ({ projectLayer }) => {
    const cells = await projectLayer.getStatStripCells();
    const triples = cells.find((c) => c.label.toLowerCase().includes('triple'));
    expect(triples?.value).toBe(String(PHARMA_LAYER_TRIPLE_COUNTS.total));
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
