import { test, expect } from '../fixtures/rich.js';
import { PRIMARY_CG } from '../helpers/real-node.js';

// PRIMARY_CG is guaranteed to hold ≥1 verifiable entity by `global-setup.ts`,
// which publishes one WM→SWM→VM entity into it once (before the workers start).
// We deliberately do NOT re-seed per-describe: parallel on-chain VM publishes
// from multiple beforeAll hooks contend on the 2-node devnet and time out.
test.describe('Triple counts — project overview', () => {
  test.beforeEach(async ({ shell, leftPanel }) => {
    await shell.goto();
    await leftPanel.expandProject(PRIMARY_CG);
  });

  test('overview stat strip shows a positive triple total', async ({ projectLayer }) => {
    await expect.poll(async () => {
      const cells = await projectLayer.getStatStripCells();
      const triples = cells.find((c) => c.label.toLowerCase().includes('triple'));
      return Number(String(triples?.value ?? '').replace(/[^0-9]/g, ''));
    }, {
      message: 'seeded triples should appear after the live memory layers load',
      timeout: 30_000,
    }).toBeGreaterThanOrEqual(1);
  });

  test('overview entity count reflects seeded entities', async ({ projectLayer }) => {
    await expect.poll(async () => {
      const cells = await projectLayer.getStatStripCells();
      const entities = cells.find((c) => c.label.toLowerCase().includes('entit'));
      return parseInt(entities?.value ?? '0', 10);
    }, {
      message: 'seeded entities should appear after the live memory layers load',
      timeout: 30_000,
    }).toBeGreaterThanOrEqual(1);
  });

  test('knowledge pipeline cards show per-layer breakdown', async ({ page }) => {
    await expect(page.getByText('Knowledge Pipeline')).toBeVisible();
    await expect(page.getByRole('button', { name: /Working Memory/i }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Verifiable Memory/i }).first()).toBeVisible();
  });
});

test.describe('Triple counts — memory layers', () => {
  test('VM layer hero shows stored data and provenance triple count', async ({ shell, leftPanel, projectLayer, page }) => {
    await shell.goto();
    await leftPanel.expandProject(PRIMARY_CG);
    await projectLayer.switchLayer('Verifiable Memory');
    const triples = page.locator('.v10-vm-hero-stats [data-stat-id="triples"]');
    await expect(triples.locator('.v10-stat-strip-label')).toHaveText('Stored triples (data + provenance)', { timeout: 15_000 });
    await expect(triples).toHaveAttribute('title', 'Publication adds provenance to the data. Raw triple counts can change between memory layers without losing entities.');
    await expect.poll(async () => Number((await triples.locator('.v10-stat-strip-value').innerText()).replace(/[^0-9]/g, '')), {
      message: 'the VM triples cell should display the seeded stored triple count',
      timeout: 30_000,
    }).toBeGreaterThanOrEqual(1);
  });

  test('VM layer entity cards show triple badges', async ({ shell, leftPanel, projectLayer, page }) => {
    await shell.goto();
    await leftPanel.expandProject(PRIMARY_CG);
    await projectLayer.switchLayer('Verifiable Memory');
    await expect(page.locator('.v10-entity-card-triples, .v10-item-count').first()).toBeVisible({ timeout: 15_000 });
  });

  test('WM layer shows empty or staging state without crash', async ({ shell, leftPanel, projectLayer, page }) => {
    await shell.goto();
    await leftPanel.expandProject(PRIMARY_CG);
    await projectLayer.switchLayer('Working Memory');
    await expect(page.locator('.v10-me-error')).toBeHidden();
    await expect(page.locator('.v10-layer-expand-body').first()).toBeVisible();
  });
});

test.describe('Triple counts — subgraph scope', () => {
  test('subgraph chips expose numeric entity counts', async ({ shell, leftPanel, projectLayer, subgraphBar }) => {
    await shell.goto();
    await leftPanel.expandProject(PRIMARY_CG);
    await projectLayer.switchLayer('Subgraphs');
    await subgraphBar.waitForBar();
    const counts = await subgraphBar.getChipCounts();
    // The daemon derives scope chips from the real entities; assert at least the
    // aggregate chip is present and every chip count parses as a finite number.
    expect(counts.length).toBeGreaterThanOrEqual(1);
    expect(counts.every((c) => Number.isFinite(c))).toBe(true);
  });
});
