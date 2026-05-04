import { test, expect } from '../fixtures/base.js';

test.describe('Operations View', () => {
  test.beforeEach(async ({ shell, dashboard }) => {
    await shell.goto();
    // Wait for the dashboard's "View all" link to render before clicking
    // it — first fetch races daemon bootstrap.
    await dashboard.waitForReady();
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
    await expect(page.locator('.tab-item').filter({ hasText: 'Performance' })).toBeVisible();
    await expect(page.locator('.tab-item').filter({ hasText: 'Logs' })).toBeVisible();
    await expect(page.locator('.tab-item').filter({ hasText: 'Errors' })).toBeVisible();
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

  test('Phases column / header is rendered in the operations table', async ({ page }) => {
    // In populated mode the operations table has a Phases column. In empty
    // mode the layout shows the same column header. Either way "Phases"
    // appears as a heading-cell.
    await expect(page.getByRole('columnheader', { name: 'Phases' }).or(page.getByText('Phases', { exact: true })).first()).toBeVisible({ timeout: 10_000 });
  });

  test('Operations table shows entries or its empty marker', async ({ page }) => {
    const empty = page.getByText('No operations recorded');
    const rows = page.locator('.v10-ops-row, .v10-operation-row, table tbody tr');
    const someVisible = await Promise.race([
      empty.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false),
      rows.first().waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false),
    ]);
    expect(someVisible).toBe(true);
  });

  test('switching to Performance sub-tab shows chart placeholder', async ({ page }) => {
    await page.locator('.tab-item').filter({ hasText: 'Performance' }).click();
    await expect(page.getByText('Not enough data for charts')).toBeVisible();
  });

  test('switching to Logs sub-tab shows log viewer controls', async ({ page }) => {
    await page.locator('.tab-item').filter({ hasText: 'Logs' }).click();
    // The viewer always renders the level filter and refresh button; the
    // log lines / empty marker depends on daemon activity.
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
    await expect(page.locator('select').first()).toBeVisible();
  });

  test('Logs sub-tab has level filter dropdown', async ({ page }) => {
    await page.locator('.tab-item').filter({ hasText: 'Logs' }).click();
    const levelSelect = page.locator('select').first();
    await expect(levelSelect).toBeVisible();
    const html = await levelSelect.innerHTML();
    expect(html).toContain('All levels');
  });

  test('Logs sub-tab has refresh button', async ({ page }) => {
    await page.locator('.tab-item').filter({ hasText: 'Logs' }).click();
    const refreshBtn = page.getByRole('button', { name: 'Refresh', exact: true });
    await expect(refreshBtn).toBeVisible();
  });

  test('switching to Errors sub-tab shows success message', async ({ page }) => {
    await page.locator('.tab-item').filter({ hasText: 'Errors' }).click();
    await expect(page.getByText('All operations completed successfully')).toBeVisible();
  });

  test('Errors sub-tab has time range selector', async ({ page }) => {
    await page.locator('.tab-item').filter({ hasText: 'Errors' }).click();
    await expect(page.getByText('Error Hotspots')).toBeVisible();
  });

  test('shows a numeric "N total" operations count header', async ({ page }) => {
    await expect(page.getByText(/\d+ total/)).toBeVisible();
  });

  test('Operations tab is closable', async ({ centerPanel }) => {
    expect(await centerPanel.isTabClosable('Operations')).toBe(true);
  });

  test('changing the type filter retains its selected value', async ({ page }) => {
    const select = page.locator('select').first();
    await select.selectOption('publish');
    expect(await select.inputValue()).toBe('publish');
  });

  test('changing the status filter retains its selected value', async ({ page }) => {
    const statusSelect = page.locator('select').nth(1);
    await statusSelect.selectOption('error');
    expect(await statusSelect.inputValue()).toBe('error');
  });

  test('typing into the operation search filters input value', async ({ page }) => {
    const input = page.locator('input[placeholder*="Operation ID"]');
    await input.fill('xyz-search');
    await expect(input).toHaveValue('xyz-search');
  });

  test('Performance sub-tab is selectable and re-selectable', async ({ page }) => {
    const perfBtn = page.locator('.tab-item').filter({ hasText: 'Performance' });
    await perfBtn.click();
    await expect(page.getByText('Not enough data for charts')).toBeVisible();
    await page.locator('.tab-item').filter({ hasText: 'All Operations' }).click();
    await perfBtn.click();
    await expect(page.getByText('Not enough data for charts')).toBeVisible();
  });

  test('Logs level filter has an All levels default and at least one other option', async ({ page }) => {
    await page.locator('.tab-item').filter({ hasText: 'Logs' }).click();
    const levelSelect = page.locator('select').first();
    const opts = await levelSelect.locator('option').allTextContents();
    expect(opts.length).toBeGreaterThan(1);
    expect(opts.some(o => /All levels/i.test(o))).toBe(true);
  });

  test('Logs Refresh button is clickable without error', async ({ page }) => {
    await page.locator('.tab-item').filter({ hasText: 'Logs' }).click();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByText('daemon.log')).toBeVisible();
  });
});
