import { test, expect } from '../fixtures/rich.js';
import { sel } from '../helpers/selectors.js';

async function openLayerGraphTab(projectLayer: { switchLayer: (l: 'Working Memory') => Promise<void> }, page: import('@playwright/test').Page) {
  await projectLayer.switchLayer('Working Memory');
  await page.locator('.v10-layer-expand-tab').filter({ hasText: 'Graph' }).click();
}

test.describe('Graph presentation — memory layer views', () => {
  test.beforeEach(async ({ shell, leftPanel }) => {
    await shell.goto();
    await leftPanel.expandProject('Pharma Drug Interactions');
  });

  test('WM layer exposes Items and Graph tabs', async ({ projectLayer, page }) => {
    await projectLayer.switchLayer('Working Memory');
    await expect(page.locator('.v10-layer-expand-tab').filter({ hasText: /^Entities$|^Items$/ })).toBeVisible();
    await expect(page.locator('.v10-layer-expand-tab').filter({ hasText: 'Graph' })).toBeVisible();
  });

  test('WM Graph tab renders canvas or loading state without error', async ({ projectLayer, page }) => {
    await openLayerGraphTab(projectLayer, page);
    await expect(page.locator('.v10-me-error')).toBeHidden();
    const graphSurface = page.locator('canvas, .rdf-graph, .v10-me-graph-loading, .v10-layer-expand-body');
    await expect(graphSurface.first()).toBeVisible({ timeout: 15_000 });
  });

  test('WM Items tab shows staging entities or empty state', async ({ projectLayer, page }) => {
    await projectLayer.switchLayer('Working Memory');
    await page.locator('.v10-layer-expand-tab').filter({ hasText: /^Entities$|^Items$/ }).click();
    const hasEntities = await page.getByText('Warfarin').isVisible().catch(() => false);
    const hasEmpty = await page.getByText(/No .* yet|empty|staging/i).first().isVisible().catch(() => false);
    expect(hasEntities || hasEmpty).toBe(true);
  });

  test('SWM layer renders without error banner', async ({ projectLayer, page }) => {
    await projectLayer.switchLayer('Shared Working Memory');
    await expect(page.locator('.v10-me-error')).toBeHidden();
  });

  test('VM layer shows verifiable memory hero and entity list', async ({ projectLayer, page }) => {
    await projectLayer.switchLayer('Verifiable Memory');
    await expect(page.locator('.v10-me-error')).toBeHidden();
    await expect(page.getByText(/Verifiable Triples|Knowledge Assets/i).first()).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('Graph presentation — subgraph detail', () => {
  test('subgraph detail shows cross-layer strip after chip select', async ({ shell, leftPanel, projectLayer, subgraphBar, page }) => {
    await shell.goto();
    await leftPanel.expandProject('Pharma Drug Interactions');
    await projectLayer.switchLayer('Subgraphs');
    await subgraphBar.waitForBar();
    await subgraphBar.clickChip('entities');
    await expect(page.locator(sel.subgraph.crossLayerStrip)).toBeVisible({ timeout: 15_000 });
  });

  test('subgraph Graph tab mounts detail body', async ({ shell, leftPanel, projectLayer, subgraphBar, page }) => {
    await shell.goto();
    await leftPanel.expandProject('Pharma Drug Interactions');
    await projectLayer.switchLayer('Subgraphs');
    await subgraphBar.waitForBar();
    await subgraphBar.clickChip('entities');
    const graphTab = page.locator('.v10-layer-expand-tab, button').filter({ hasText: /^Graph$/i });
    if (await graphTab.first().isVisible().catch(() => false)) {
      await graphTab.first().click();
    }
    await expect(page.locator(sel.subgraph.detail)).toBeVisible();
  });
});
