import { test, expect } from '../fixtures/base.js';

test.describe('Network Debug Page (/network)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/network', { waitUntil: 'domcontentloaded' });
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
    await expect(page.getByText('TOTAL CONNECTIONS')).toBeVisible();
    await expect(page.getByText('DIRECT')).toBeVisible();
    await expect(page.getByText('RELAYED')).toBeVisible();
    await expect(page.getByText('KNOWN AGENTS')).toBeVisible();
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

  test('Active Connections section shows empty state', async ({ page }) => {
    await expect(page.getByText('Active Connections', { exact: true })).toBeVisible();
    await expect(page.getByText('No active connections', { exact: true })).toBeVisible();
  });

  test('Discovered Agents section shows empty state', async ({ page }) => {
    await expect(page.getByText('Discovered Agents')).toBeVisible();
    await expect(page.getByText('No agents discovered')).toBeVisible();
  });

  test('Active Connections empty state shows description', async ({ page }) => {
    await expect(page.getByText('Connections will appear here as your node links with peers')).toBeVisible();
  });

  test('Discovered Agents empty state shows description', async ({ page }) => {
    await expect(page.getByText('Agents will be listed here as they are discovered')).toBeVisible();
  });

  test('page has no sidebar or header from AppShell', async ({ page }) => {
    const toggle = page.locator('button[title="Toggle sidebar"]');
    expect(await toggle.count()).toBe(0);
  });

  test('page title is "DKG Node"', async ({ page }) => {
    await expect(page).toHaveTitle('DKG Node');
  });
});
