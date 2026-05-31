import { test, expect } from '../fixtures/rich.js';
import { PHARMA_LAYER_TRIPLE_COUNTS } from '../helpers/rich-mock-data.js';
import { sel } from '../helpers/selectors.js';

test.describe('Triple counts — project overview', () => {
  test.beforeEach(async ({ shell, leftPanel }) => {
    await shell.goto();
    await leftPanel.expandProject('Pharma Drug Interactions');
  });

  test('overview stat strip shows canonical triple total', async ({ projectLayer }) => {
    const cells = await projectLayer.getStatStripCells();
    const triples = cells.find((c) => c.label.toLowerCase().includes('triple'));
    expect(triples?.value).toBe(String(PHARMA_LAYER_TRIPLE_COUNTS.total));
  });

  test('overview entity count reflects rich mock entities', async ({ projectLayer }) => {
    const cells = await projectLayer.getStatStripCells();
    const entities = cells.find((c) => c.label.toLowerCase().includes('entit'));
    expect(parseInt(entities?.value ?? '0', 10)).toBeGreaterThanOrEqual(2);
  });

  test('knowledge pipeline cards show per-layer breakdown', async ({ page }) => {
    await expect(page.getByText('Knowledge Pipeline')).toBeVisible();
    await expect(page.getByRole('button', { name: /Working Memory/i }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Verifiable Memory/i }).first()).toBeVisible();
  });
});

test.describe('Triple counts — memory layers', () => {
  test('VM layer hero shows verifiable triple stat', async ({ shell, leftPanel, projectLayer, page }) => {
    await shell.goto();
    await leftPanel.expandProject('Pharma Drug Interactions');
    await projectLayer.switchLayer('Verifiable Memory');
    await expect(page.getByText(/Verifiable Triples/i)).toBeVisible({ timeout: 15_000 });
    const statCells = page.locator('.v10-vm-hero-stats .v10-stat-strip-value, .v10-stat-strip-value');
    await expect(statCells.first()).toBeVisible();
  });

  test('VM layer entity cards show triple badges', async ({ shell, leftPanel, projectLayer, page }) => {
    await shell.goto();
    await leftPanel.expandProject('Pharma Drug Interactions');
    await projectLayer.switchLayer('Verifiable Memory');
    await expect(page.locator('.v10-entity-card-triples, .v10-item-count').first()).toBeVisible({ timeout: 15_000 });
  });

  test('WM layer shows empty or staging state without crash', async ({ shell, leftPanel, projectLayer, page }) => {
    await shell.goto();
    await leftPanel.expandProject('Pharma Drug Interactions');
    await projectLayer.switchLayer('Working Memory');
    await expect(page.locator('.v10-me-error')).toBeHidden();
    await expect(page.locator('.v10-layer-expand-body').first()).toBeVisible();
  });
});

test.describe('Triple counts — subgraph scope', () => {
  test('subgraph chip entity count matches daemon list fixture', async ({ shell, leftPanel, projectLayer, subgraphBar }) => {
    await shell.goto();
    await leftPanel.expandProject('Pharma Drug Interactions');
    await projectLayer.switchLayer('Subgraphs');
    await subgraphBar.waitForBar();
    const labels = await subgraphBar.getChipLabels();
    const idx = labels.findIndex((l) => l.toLowerCase().includes('entit'));
    const counts = await subgraphBar.getChipCounts();
    expect(counts[idx]).toBe(2);
  });
});
