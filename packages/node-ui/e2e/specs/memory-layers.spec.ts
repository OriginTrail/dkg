import { test, expect } from '../fixtures/base.js';

test.describe('Memory Layer Views', () => {
  test.describe('Working Memory', () => {
    test.beforeEach(async ({ shell, leftPanel }) => {
      await shell.goto();
      await leftPanel.expandProject('Pharma Drug Interactions');
      await leftPanel.clickLayer('Pharma Drug Interactions', 'wm');
    });

    test('opens tab named "WM · Pharma Drug Interactions"', async ({ centerPanel }) => {
      const tabs = await centerPanel.getTabNames();
      const wmTab = tabs.find(t => t.startsWith('WM'));
      expect(wmTab).toBeTruthy();
      expect(wmTab).toContain('Pharma Drug Interactions');
    });

    test('displays "Working Memory" heading', async ({ page }) => {
      const heading = page.getByRole('heading', { name: 'Working Memory' });
      await expect(heading).toBeVisible();
    });

    test('shows description text', async ({ page }) => {
      const desc = page.getByText('Private agent drafts');
      await expect(desc).toBeVisible();
    });

    test('SPARQL query input is visible', async ({ page }) => {
      const input = page.locator('input[placeholder*="SPARQL"], input[placeholder*="sparql"]').first();
      await expect(input).toBeVisible();
    });

    test('Run button is present', async ({ page }) => {
      const runBtn = page.getByRole('button', { name: 'Run', exact: true });
      await expect(runBtn).toBeVisible();
    });

    test('Table view and Graph view buttons exist', async ({ page }) => {
      const tableBtn = page.getByRole('button', { name: 'Table view' });
      const graphBtn = page.getByRole('button', { name: 'Graph view' });
      await expect(tableBtn).toBeVisible();
      await expect(graphBtn).toBeVisible();
    });

    test('can type a SPARQL query', async ({ page }) => {
      const input = page.locator('input[placeholder*="SPARQL"], input[placeholder*="sparql"]').first();
      await input.fill('SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10');
      const value = await input.inputValue();
      expect(value).toContain('SELECT');
    });

    test('shows empty state message', async ({ page }) => {
      const emptyText = page.getByText('No triples found');
      await expect(emptyText).toBeVisible();
    });

    test('shows empty state import suggestion', async ({ page }) => {
      await expect(page.getByText('Import files or chat with your agent')).toBeVisible();
    });

    test('Graph view is active by default', async ({ page }) => {
      const graphBtn = page.locator('.v10-mlv-toggle-btn[title="Graph view"]');
      const isActive = await graphBtn.evaluate((el: Element) => el.classList.contains('active'));
      expect(isActive).toBe(true);
    });

    test('clicking Table view button switches active toggle', async ({ page }) => {
      const tableBtn = page.locator('.v10-mlv-toggle-btn[title="Table view"]');
      await tableBtn.click();
      await expect(tableBtn).toHaveClass(/active/, { timeout: 5_000 });
    });

    test.skip('SPARQL query does not show HTTP 500 error without backend', async ({ page }) => {
      // BUG: Memory layer view shows "Error: HTTP 500" instead of graceful fallback
      const status = page.locator('.v10-mlv-status');
      await expect(status).toBeHidden();
    });

    test('layer icon shows Working Memory color', async ({ page }) => {
      const icon = page.locator('.v10-mlv-icon');
      await expect(icon).toBeVisible();
      await expect(icon).toHaveText('◇');
    });
  });

  test.describe('Shared Working Memory', () => {
    test.beforeEach(async ({ shell, leftPanel }) => {
      await shell.goto();
      await leftPanel.expandProject('Climate Science');
      await leftPanel.clickLayer('Climate Science', 'swm');
    });

    test('opens tab containing "SWM"', async ({ centerPanel }) => {
      const tabs = await centerPanel.getTabNames();
      expect(tabs.some(t => t.includes('SWM'))).toBe(true);
    });

    test('displays "Shared Working Memory" heading', async ({ page }) => {
      const heading = page.getByRole('heading', { name: /Shared.*Memory/i });
      await expect(heading).toBeVisible();
    });

    test('SPARQL input available', async ({ page }) => {
      const input = page.locator('input[placeholder*="SPARQL"], input[placeholder*="sparql"]').first();
      await expect(input).toBeVisible();
    });
  });

  test.describe('Verified Memory', () => {
    test.beforeEach(async ({ shell, leftPanel }) => {
      await shell.goto();
      await leftPanel.expandProject('EU Supply Chain');
      await leftPanel.clickLayer('EU Supply Chain', 'vm');
    });

    test('opens tab containing "VM"', async ({ centerPanel }) => {
      const tabs = await centerPanel.getTabNames();
      expect(tabs.some(t => t.includes('VM'))).toBe(true);
    });

    test('displays "Verified Memory" heading', async ({ page }) => {
      const heading = page.getByRole('heading', { name: /Verified.*Memory/i });
      await expect(heading).toBeVisible();
    });
  });

  test.describe('Memory Stack page', () => {
    test.beforeEach(async ({ shell, leftPanel }) => {
      await shell.goto();
      await leftPanel.clickMemoryStack();
    });

    test('displays "Memory Stack" heading', async ({ page }) => {
      const heading = page.getByRole('heading', { name: 'Memory Stack', level: 1 });
      await expect(heading).toBeVisible();
    });

    test('shows aggregate description', async ({ page }) => {
      const desc = page.getByText('Aggregate view of all memory layers');
      await expect(desc).toBeVisible();
    });

    test('renders three memory layer cards', async ({ page }) => {
      await expect(page.getByText('Working Memory', { exact: true })).toBeVisible();
      await expect(page.getByText('Shared Working Memory', { exact: true })).toBeVisible();
      await expect(page.getByText('Verified Memory', { exact: true })).toBeVisible();
    });

    test('layer cards show descriptions', async ({ page }) => {
      await expect(page.getByText('Private agent drafts')).toBeVisible();
      await expect(page.getByText('Shared proposals')).toBeVisible();
      await expect(page.getByText('Published knowledge')).toBeVisible();
    });

    test('Memory Stack tab is closable', async ({ centerPanel }) => {
      expect(await centerPanel.isTabClosable('Memory Stack')).toBe(true);
    });
  });
});
