import { test, expect } from '../fixtures/rich.js';
import { sel } from '../helpers/selectors.js';

async function openPharmaSubgraphs({ shell, leftPanel, projectLayer, subgraphBar }: {
  shell: { goto: () => Promise<void> };
  leftPanel: { expandProject: (n: string) => Promise<void> };
  projectLayer: { switchLayer: (l: 'Subgraphs') => Promise<void> };
  subgraphBar: { waitForBar: (t?: number) => Promise<void> };
}) {
  await shell.goto();
  await leftPanel.expandProject('Pharma Drug Interactions');
  await projectLayer.switchLayer('Subgraphs');
  await subgraphBar.waitForBar();
}

test.describe('SubGraph bar', () => {
  test.beforeEach(async ({ shell, leftPanel, projectLayer, subgraphBar }) => {
    await openPharmaSubgraphs({ shell, leftPanel, projectLayer, subgraphBar });
  });

  test('renders Subgraphs label and All chip', async ({ subgraphBar }) => {
    await expect(subgraphBar.page.locator(sel.subgraph.barLabel)).toHaveText('Subgraphs');
    const labels = await subgraphBar.getChipLabels();
    expect(labels[0]).toBe('All');
  });

  test('All chip shows aggregate entity count', async ({ subgraphBar }) => {
    const counts = await subgraphBar.getChipCounts();
    expect(counts[0]).toBeGreaterThan(0);
  });

  test('registered sub-graph chips appear with labels', async ({ subgraphBar }) => {
    const labels = await subgraphBar.getChipLabels();
    expect(labels.some((l) => /entit/i.test(l))).toBe(true);
  });

  test('clicking a sub-graph chip activates it', async ({ subgraphBar }) => {
    await subgraphBar.clickChip(/entit/i);
    const active = await subgraphBar.getActiveChipLabel();
    expect(active?.toLowerCase()).toContain('entit');
  });

  test('clicking All chip clears sub-graph filter', async ({ subgraphBar }) => {
    await subgraphBar.clickChip(/entit/i);
    await subgraphBar.clickChip('All');
    const active = await subgraphBar.getActiveChipLabel();
    expect(active).toBe('All');
  });

  test('sub-graph chip shows entity count from daemon list', async ({ subgraphBar }) => {
    const labels = await subgraphBar.getChipLabels();
    const entitiesIdx = labels.findIndex((l) => l.toLowerCase().includes('entit'));
    expect(entitiesIdx).toBeGreaterThan(-1);
    const counts = await subgraphBar.getChipCounts();
    expect(counts[entitiesIdx]).toBe(2);
  });

  test('Root chip appears when root-scope entities exist', async ({ subgraphBar }) => {
    const hasRoot = await subgraphBar.hasRootChip();
    if (hasRoot) {
      const labels = await subgraphBar.getChipLabels();
      expect(labels.some((l) => l.toLowerCase() === 'root')).toBe(true);
    }
  });
});

test.describe('SubGraph detail cross-layer strip', () => {
  test.beforeEach(async ({ shell, leftPanel, projectLayer, subgraphBar }) => {
    await openPharmaSubgraphs({ shell, leftPanel, projectLayer, subgraphBar });
    await subgraphBar.clickChip(/entit/i);
  });

  test('detail view shows cross-layer WM → SWM → VM strip', async ({ page }) => {
    const strip = page.locator(sel.subgraph.crossLayerStrip);
    await expect(strip).toBeVisible({ timeout: 15_000 });
    await expect(strip.locator(sel.subgraph.crossLayerCell).filter({ hasText: 'Working' })).toBeVisible();
    await expect(strip.locator(sel.subgraph.crossLayerCell).filter({ hasText: 'Shared' })).toBeVisible();
    await expect(strip.locator(sel.subgraph.crossLayerCell).filter({ hasText: 'Verifiable' })).toBeVisible();
  });

  test('cross-layer counts reflect rich mock fixture totals', async ({ page }) => {
    const strip = page.locator(sel.subgraph.crossLayerStrip);
    await strip.waitFor({ state: 'visible', timeout: 15_000 });
    const counts = strip.locator(sel.subgraph.crossLayerCount);
    const wm = parseInt((await counts.nth(0).textContent())?.trim() ?? '0', 10);
    const swm = parseInt((await counts.nth(1).textContent())?.trim() ?? '0', 10);
    const vm = parseInt((await counts.nth(2).textContent())?.trim() ?? '0', 10);
    // Cross-layer strip shows entity counts per layer, not raw triple totals.
    expect(wm + swm + vm).toBeGreaterThanOrEqual(2);
    expect(wm).toBeGreaterThanOrEqual(0);
    expect(swm).toBeGreaterThanOrEqual(0);
    expect(vm).toBeGreaterThanOrEqual(0);
  });

  test('sub-graph detail header shows chip title', async ({ page }) => {
    await expect(page.locator(sel.subgraph.detailTitle)).toContainText(/entit/i);
  });
});

test.describe('SubGraph bar on memory layer pages', () => {
  test('WM layer page includes subgraph bar', async ({ shell, leftPanel, projectLayer, subgraphBar }) => {
    await shell.goto();
    await leftPanel.expandProject('Pharma Drug Interactions');
    await projectLayer.switchLayer('Working Memory');
    await subgraphBar.waitForBar();
    expect((await subgraphBar.getChipLabels()).length).toBeGreaterThan(0);
  });

  test('SWM layer page includes subgraph bar', async ({ shell, leftPanel, projectLayer, subgraphBar }) => {
    await shell.goto();
    await leftPanel.expandProject('Climate Science');
    await projectLayer.switchLayer('Shared Working Memory');
    await subgraphBar.waitForBar();
    await expect(subgraphBar.bar).toBeVisible();
  });

  test('VM layer page includes subgraph bar', async ({ shell, leftPanel, projectLayer, subgraphBar }) => {
    await shell.goto();
    await leftPanel.expandProject('EU Supply Chain');
    await projectLayer.switchLayer('Verifiable Memory');
    await subgraphBar.waitForBar();
    await expect(subgraphBar.bar).toBeVisible();
  });
});
