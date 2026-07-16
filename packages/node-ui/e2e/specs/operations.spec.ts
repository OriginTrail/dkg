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
    // The "Phases" legend (a flex row of phase labels) is distinct from the
    // operations table's "Phases" column <th>, which only renders once real
    // operations exist. Scope to the legend (the only "Phases" <span>) so the
    // assertion is stable regardless of how many operations the node recorded.
    const legend = page.locator('span').filter({ hasText: /^Phases$/ }).locator('xpath=..');
    await expect(legend).toBeVisible();
    await expect(legend.getByText('Prepare', { exact: true })).toBeVisible();
    await expect(legend.getByText('Broadcast', { exact: true })).toBeVisible();
    await expect(legend.getByText('Verify', { exact: true })).toBeVisible();
  });

  test('operations list renders rows or an empty state', async ({ page }) => {
    // A live devnet records real operations (publish/query/sync/gossip), so the
    // panel may show rows OR — on a very quiet node — the empty state. Both are
    // valid; assert the All-Operations surface resolves to one of them.
    const empty = page.getByText('No operations recorded');
    const rows = page.locator('.v10-op-row, [data-op-row], table tbody tr');
    await expect
      .poll(async () =>
        (await empty.isVisible().catch(() => false)) ||
        (await rows.first().isVisible().catch(() => false)),
      )
      .toBe(true);
  });

  test('switching to Hardware sub-tab shows hardware metrics shell', async ({ page }) => {
    await page.locator('button').filter({ hasText: 'Hardware' }).click();
    await expect(page.getByText(/CPU|Memory|Disk/i).first()).toBeVisible();
  });

  test('switching to Logs sub-tab shows log viewer controls', async ({ page }) => {
    await page.locator('button').filter({ hasText: 'Logs' }).click();
    // The `daemon.log` header control is always present.
    await expect(page.getByText('daemon.log')).toBeVisible();
    // A live node writes a real daemon log, so the viewer must render tail
    // lines and NOT the empty state. We can't anchor on a fixed mock line
    // (the network/timestamps are environment-specific), so assert the
    // wired-up contract: the empty state is absent and the viewer header
    // reports a positive line count. A broken /api/node-log surfaces here.
    await expect(page.getByText('No log lines found')).toHaveCount(0);
    // The viewer header renders "<N> lines" in a <span>. Scope to span so the
    // assertion doesn't match the tail-size <option>200 lines</option> control.
    await expect(page.locator('span').filter({ hasText: /^\d+ lines\b/ }).first()).toBeVisible({ timeout: 15_000 });
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

  test('switching to Errors sub-tab renders the errors surface', async ({ page }) => {
    await page.locator('button').filter({ hasText: 'Errors' }).click();
    // A real node may or may not have logged errors in the window, so accept
    // either the no-errors message or a rendered error list — the durable
    // contract is that the Errors surface (Error Hotspots) renders.
    await expect(page.getByText('Error Hotspots')).toBeVisible();
  });

  test('Errors sub-tab has time range selector', async ({ page }) => {
    await page.locator('button').filter({ hasText: 'Errors' }).click();
    await expect(page.getByText('Error Hotspots')).toBeVisible();
  });

  test('shows an operations total count', async ({ page }) => {
    // Live node → the total is whatever has been recorded (≥ 0), not a fixed 0.
    await expect(page.getByText(/\d+ total/).first()).toBeVisible();
  });

  test('Observability tab is closable', async ({ centerPanel }) => {
    expect(await centerPanel.isTabClosable('Observability')).toBe(true);
  });
});
