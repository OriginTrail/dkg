import { test, expect } from '../fixtures/base.js';

test.describe('Operations View (rc.12 Observability)', () => {
  test.beforeEach(async ({ shell, header }) => {
    await shell.goto();
    await header.openObservability();
  });

  test('Observability tab opens in center panel', async ({ centerPanel }) => {
    const tabs = await centerPanel.getTabNames();
    expect(tabs).toContain('Observability');
  });

  test('heading reads "Observability"', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Observability', level: 1 })).toBeVisible();
  });

  test('shows description text', async ({ page }) => {
    await expect(page.getByText('Track operation performance, phases, and errors')).toBeVisible();
  });

  test('four sub-tabs are rendered', async ({ page }) => {
    await expect(page.locator('button').filter({ hasText: 'All Operations' })).toBeVisible();
    await expect(page.locator('button').filter({ hasText: 'Hardware' })).toBeVisible();
    await expect(page.locator('button').filter({ hasText: 'Logs' })).toBeVisible();
    await expect(page.locator('button').filter({ hasText: 'Errors' })).toBeVisible();
  });

  test('type filter dropdown has operation types', async ({ page }) => {
    const select = page.getByTitle('Filter by operation type');
    await expect(select).toBeVisible();
    expect(await select.locator('option').count()).toBeGreaterThan(1);
  });

  test('type filter includes specific operation types', async ({ page }) => {
    const select = page.getByTitle('Filter by operation type');
    const html = await select.innerHTML();
    expect(html).toContain('publish');
    expect(html).toContain('query');
    expect(html).toContain('sync');
    expect(html).toContain('gossip');
  });

  test('status filter dropdown has status options', async ({ page }) => {
    const statusSelect = page.locator('select.input').filter({ has: page.locator('option', { hasText: 'All statuses' }) });
    await expect(statusSelect).toBeVisible();
    const texts: string[] = [];
    const options = statusSelect.locator('option');
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
    await expect(page.getByText('No operations recorded')).toBeVisible();
  });

  test('switching to Hardware sub-tab shows hardware metrics shell', async ({ page }) => {
    await page.locator('button').filter({ hasText: 'Hardware' }).click();
    await expect(page.getByText(/CPU|Memory|Disk/i).first()).toBeVisible();
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
    expect(await levelSelect.innerHTML()).toContain('All levels');
  });

  test('Logs sub-tab has refresh button', async ({ page }) => {
    await page.locator('button').filter({ hasText: 'Logs' }).click();
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
  });

  test('switching to Errors sub-tab shows success message', async ({ page }) => {
    await page.locator('button').filter({ hasText: 'Errors' }).click();
    await expect(page.getByText('No errors in this period')).toBeVisible();
  });

  test('Errors sub-tab has time range selector', async ({ page }) => {
    await page.locator('button').filter({ hasText: 'Errors' }).click();
    await expect(page.getByText('Error Hotspots')).toBeVisible();
  });

  test('shows "0 total" operations count', async ({ page }) => {
    await expect(page.getByText('0 total')).toBeVisible();
  });

  test('Observability tab is closable', async ({ centerPanel }) => {
    expect(await centerPanel.isTabClosable('Observability')).toBe(true);
  });
});
