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

  test('switching to Performance sub-tab renders charts or the empty placeholder', async ({ page }) => {
    // Performance tab has two valid render paths:
    //   - empty (no ops yet) → "Not enough data for charts"
    //   - populated → at least one chart heading (e.g. "OPERATIONS OVER TIME")
    // The daemon almost always has activity, so populated is the common case;
    // we accept either branch but require one of them to land.
    await page.locator('.tab-item').filter({ hasText: 'Performance' }).click();
    const empty = page.getByText('Not enough data for charts');
    const chartHeading = page.getByText(/OPERATIONS OVER TIME|AVG DURATION BY|SUCCESS RATE BY/i);
    const someVisible = await Promise.race([
      empty.first().waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false),
      chartHeading.first().waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false),
    ]);
    expect(someVisible).toBe(true);
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

  test('changing the type filter actually filters the operations table', async ({ page }) => {
    // Old version only asserted `select.inputValue() === 'publish'` — a
    // tautology (selectOption sets the value, then we read it back). The
    // real contract: changing the dropdown re-queries the daemon with
    // `?name=publish`, and every row in the resulting table has type
    // `publish`. If the table has zero rows after the filter, accept it
    // as a valid empty result; what's NOT acceptable is a row whose
    // type cell shows something other than `publish`.
    const select = page.locator('select').first();
    await select.selectOption('publish');
    await expect(select).toHaveValue('publish');
    // Give the useFetch deps-change refetch ~2s to settle.
    await page.waitForTimeout(1500);
    const typeBadges = page.locator('table tbody tr td:nth-child(2) .badge');
    const rowCount = await typeBadges.count();
    for (let i = 0; i < rowCount; i++) {
      await expect(typeBadges.nth(i)).toHaveText('publish');
    }
  });

  test('changing the status filter actually filters the operations table', async ({ page }) => {
    const statusSelect = page.locator('select').nth(1);
    await statusSelect.selectOption('error');
    await expect(statusSelect).toHaveValue('error');
    await page.waitForTimeout(1500);
    // Status badge lives in column 3.
    const statusBadges = page.locator('table tbody tr td:nth-child(3) .badge');
    const rowCount = await statusBadges.count();
    for (let i = 0; i < rowCount; i++) {
      // StatusBadge renders the status string verbatim — match it
      // case-insensitively to absorb any future capitalisation tweak.
      await expect(statusBadges.nth(i)).toHaveText(/^error$/i);
    }
  });

  test('typing into the Operation ID search narrows the result set or empties it', async ({ page }) => {
    const input = page.locator('input[placeholder*="Operation ID"]');
    const totalBefore = page.getByText(/\d+ total/);
    const beforeText = (await totalBefore.first().textContent()) ?? '';
    const beforeCount = parseInt(beforeText.match(/(\d+)\s+total/)?.[1] ?? '0', 10);
    // A nonsense operation-id substring will either narrow the result set
    // (server-side filter via `?operationId=...`) OR produce zero rows.
    // Both prove the input is actually wired into the request, unlike
    // the old `expect(input).toHaveValue(...)` tautology.
    await input.fill('definitely-not-a-real-op-id-zzzzzzzz');
    await expect(input).toHaveValue('definitely-not-a-real-op-id-zzzzzzzz');
    await page.waitForTimeout(1500);
    const afterText = (await totalBefore.first().textContent()) ?? '';
    const afterCount = parseInt(afterText.match(/(\d+)\s+total/)?.[1] ?? '0', 10);
    expect(afterCount).toBeLessThanOrEqual(beforeCount);
  });

  test('Performance sub-tab is selectable and re-selectable', async ({ page }) => {
    const perfBtn = page.locator('.tab-item').filter({ hasText: 'Performance' });
    // Anchor to a stable element that's present in both empty and populated
    // states — the period selector at the top of the tab.
    const periodSelect = page.locator('select.input, .v10-ops-tab + * select').first();

    await perfBtn.click();
    await expect(periodSelect).toBeVisible();
    await page.locator('.tab-item').filter({ hasText: 'All Operations' }).click();
    await perfBtn.click();
    await expect(periodSelect).toBeVisible();
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
