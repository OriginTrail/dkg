import { test, expect } from '../fixtures/base.js';

test.describe('Operations View', () => {
  test.beforeEach(async ({ shell, dashboard }) => {
    await shell.goto();
    await dashboard.clickViewAllOperations();
  });

  test('Operations tab opens in center panel', async ({ centerPanel }) => {
    const tabs = await centerPanel.getTabNames();
    expect(tabs).toContain('Operations');
  });

  test('heading reads "Observability"', async ({ page }) => {
    const heading = page.getByRole('heading', { name: 'Observability', level: 1 });
    await expect(heading).toBeVisible();
  });

  test('shows description text', async ({ page }) => {
    const desc = page.getByText('Track operation performance, phases, and errors');
    await expect(desc).toBeVisible();
  });

  test('four sub-tabs are rendered', async ({ page }) => {
    await expect(page.locator('button').filter({ hasText: 'All Operations' })).toBeVisible();
    await expect(page.locator('button').filter({ hasText: 'Performance' })).toBeVisible();
    await expect(page.locator('button').filter({ hasText: 'Logs' })).toBeVisible();
    await expect(page.locator('button').filter({ hasText: 'Errors' })).toBeVisible();
  });

  test('type filter dropdown has operation types', async ({ page }) => {
    const select = page.locator('select').first();
    await expect(select).toBeVisible();
    const options = select.locator('option');
    const count = await options.count();
    expect(count).toBeGreaterThan(1);
  });

  test('type filter includes specific operation types', async ({ page }) => {
    const select = page.locator('select').first();
    const html = await select.innerHTML();
    expect(html).toContain('publish');
    expect(html).toContain('query');
    expect(html).toContain('sync');
    expect(html).toContain('gossip');
  });

  test('status filter dropdown has status options', async ({ page }) => {
    const selects = page.locator('select');
    const statusSelect = selects.nth(1);
    await expect(statusSelect).toBeVisible();
    const options = statusSelect.locator('option');
    const texts: string[] = [];
    for (let i = 0; i < await options.count(); i++) {
      texts.push((await options.nth(i).textContent())!.trim());
    }
    expect(texts).toContain('All statuses');
    expect(texts).toContain('success');
    expect(texts).toContain('error');
  });

  test('Operation ID search input accepts text', async ({ page }) => {
    const input = page.locator('input[placeholder*="Operation ID"]');
    await input.fill('op-123');
    expect(await input.inputValue()).toBe('op-123');
  });

  test('PHASES section lists operation phases', async ({ page }) => {
    await expect(page.getByText('Phases', { exact: true })).toBeVisible();
    await expect(page.getByText('Prepare', { exact: true })).toBeVisible();
    await expect(page.getByText('Broadcast', { exact: true })).toBeVisible();
    await expect(page.getByText('Verify', { exact: true })).toBeVisible();
  });

  test('empty state message when no operations', async ({ page }) => {
    const empty = page.getByText('No operations recorded');
    await expect(empty).toBeVisible();
  });

  test('switching to Performance sub-tab shows chart placeholder', async ({ page }) => {
    await page.locator('button').filter({ hasText: 'Performance' }).click();
    await expect(page.getByText('Not enough data for charts')).toBeVisible();
  });

  test('switching to Logs sub-tab shows log viewer controls', async ({ page }) => {
    await page.locator('button').filter({ hasText: 'Logs' }).click();
    await expect(page.getByText('daemon.log')).toBeVisible();
    await expect(page.getByText('No log lines found')).toBeVisible();
  });

  test('Logs sub-tab has level filter dropdown', async ({ page }) => {
    await page.locator('button').filter({ hasText: 'Logs' }).click();
    const levelSelect = page.locator('select').first();
    await expect(levelSelect).toBeVisible();
    const html = await levelSelect.innerHTML();
    expect(html).toContain('All levels');
  });

  test('Logs sub-tab has refresh button', async ({ page }) => {
    await page.locator('button').filter({ hasText: 'Logs' }).click();
    const refreshBtn = page.getByRole('button', { name: 'Refresh', exact: true });
    await expect(refreshBtn).toBeVisible();
  });

  test('switching to Errors sub-tab shows success message', async ({ page }) => {
    await page.locator('button').filter({ hasText: 'Errors' }).click();
    await expect(page.getByText('All operations completed successfully')).toBeVisible();
  });

  test('Errors sub-tab has time range selector', async ({ page }) => {
    await page.locator('button').filter({ hasText: 'Errors' }).click();
    await expect(page.getByText('Error Hotspots')).toBeVisible();
  });

  test('shows "0 total" operations count', async ({ page }) => {
    await expect(page.getByText('0 total')).toBeVisible();
  });

  test('Operations tab is closable', async ({ centerPanel }) => {
    expect(await centerPanel.isTabClosable('Operations')).toBe(true);
  });
});
