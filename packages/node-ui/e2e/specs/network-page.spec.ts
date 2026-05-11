import { test, expect } from '../fixtures/base.js';

test.describe('Network Debug Page (/network)', () => {
  test.beforeEach(async ({ page }) => {
    // baseURL is /ui/; the network page lives at /ui/network in dev mode.
    await page.goto('network', { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Network', level: 1 }).waitFor({ state: 'visible', timeout: 15_000 });
  });

  test('renders "Network" heading', async ({ page }) => {
    const heading = page.getByRole('heading', { name: 'Network', level: 1 });
    await expect(heading).toBeVisible();
  });

  test('renders four stat cards', async ({ page }) => {
    const cards = page.locator('.stat-card');
    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBe(4);
  });

  test('stat cards show correct labels', async ({ page }) => {
    // Each label appears in a `.stat-label` span; scope to that to avoid
    // matching column headers like "Direction".
    const labels = page.locator('.stat-label');
    const text = (await labels.allTextContents()).map(t => t.trim().toUpperCase());
    expect(text).toContain('TOTAL CONNECTIONS');
    expect(text).toContain('DIRECT');
    expect(text).toContain('RELAYED');
    expect(text).toContain('KNOWN AGENTS');
  });

  test('stat values show dash or zero for offline node', async ({ page }) => {
    const values = page.locator('.stat-value');
    const count = await values.count();
    expect(count).toBe(4);
    for (let i = 0; i < count; i++) {
      const text = (await values.nth(i).textContent())!.trim();
      expect(text === '—' || text === '0' || /^\d+$/.test(text)).toBe(true);
    }
  });

  test('Active Connections section is rendered (populated or empty)', async ({ page }) => {
    await expect(page.getByText('Active Connections', { exact: true })).toBeVisible();
  });

  test('Discovered Agents section is rendered (populated or empty)', async ({ page }) => {
    await expect(page.getByText('Discovered Agents')).toBeVisible();
  });

  test('Active Connections shows either entries or its empty hint', async ({ page }) => {
    const empty = page.getByText('No active connections', { exact: true });
    const tableBody = page.locator('table').first().locator('tbody tr').first();
    // Isolated test daemon: no connections expected. If `tableBody` wins
    // we still pass (so a future daemon-with-peers fixture doesn't bit-
    // rot this test), but the empty marker is the contract for the
    // current isolated-daemon environment.
    const someVisible = await Promise.race([
      empty.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false),
      tableBody.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false),
    ]);
    expect(someVisible).toBe(true);
  });

  test('Discovered Agents shows either entries or its empty hint', async ({ page }) => {
    const card = page.locator('.card').filter({ has: page.getByText('Discovered Agents') });
    const empty = card.locator('.empty-state-title', { hasText: /No agents discovered/ });
    const rows = card.locator('table.data-table tbody tr');
    const someVisible = await Promise.race([
      empty.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false),
      rows.first().waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false),
    ]);
    expect(someVisible).toBe(true);
  });

  test('page has no sidebar or header from AppShell', async ({ page }) => {
    const toggle = page.locator('button[title="Toggle sidebar"]');
    expect(await toggle.count()).toBe(0);
  });

  test('page title is "DKG Node"', async ({ page }) => {
    await expect(page).toHaveTitle('DKG Node');
  });
});
