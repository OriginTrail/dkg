import { test, expect } from '../fixtures/base.js';

// `/network` is an unframed legacy debug page mounted at the root
// router (no AppShell, no sidebar, no Vite client). The Vite dev
// server is configured with `base: '/ui/'`, so absolute paths like
// `/network` get rewritten by the dev server to "did you mean
// /ui/network?". We use a path relative to the configured `baseURL`
// (`http://localhost:<port>/ui/`) instead.
//
// Stat-card labels are MIXED case in the DOM ("Total Connections")
// and only rendered uppercase via `text-transform: uppercase`.
// `getByText` matches the underlying text content, so we assert on
// the actual case.

test.describe('Network Debug Page (/ui/network)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('network', { waitUntil: 'domcontentloaded' });
    await page
      .getByRole('heading', { name: 'Network', level: 1 })
      .waitFor({ state: 'visible', timeout: 15_000 });
  });

  test('renders the "Network" page-title heading', async ({ page }) => {
    const heading = page.getByRole('heading', { name: 'Network', level: 1 });
    await expect(heading).toBeVisible();
    await expect(heading).toHaveClass(/page-title/);
  });

  test('renders exactly four stat cards', async ({ page }) => {
    const cards = page.locator('.stats-grid .stat-card');
    await expect(cards.first()).toBeVisible();
    await expect(cards).toHaveCount(4);
  });

  test('stat cards expose the documented labels', async ({ page }) => {
    const labels = page.locator('.stats-grid .stat-label');
    const texts = (await labels.allInnerTexts()).map((t) => t.trim().toLowerCase());
    expect(texts).toEqual([
      'total connections',
      'direct',
      'relayed',
      'known agents',
    ]);
  });

  test('stat values are dashes, zero, or numeric on a single-node devnet', async ({ page }) => {
    const values = page.locator('.stats-grid .stat-value');
    await expect(values).toHaveCount(4);
    const texts = await values.allInnerTexts();
    expect(texts.length).toBe(4);
    for (const raw of texts) {
      const t = raw.trim();
      expect(t === '—' || /^\d+$/.test(t)).toBe(true);
    }
  });

  test('Active Connections section renders the empty-state on cold devnet', async ({ page }) => {
    const card = page
      .locator('.card')
      .filter({ has: page.locator('.card-title', { hasText: 'Active Connections' }) });
    await expect(card).toBeVisible();
    // Either the empty-state copy renders (single-node devnet) or
    // a real `.data-table` does. Both are valid.
    const empty = card.locator('.empty-state-title', { hasText: 'No active connections' });
    const table = card.locator('table.data-table');
    await expect(empty.or(table).first()).toBeVisible();
  });

  test('Discovered Agents section renders the empty-state on cold devnet', async ({ page }) => {
    const card = page
      .locator('.card')
      .filter({ has: page.locator('.card-title', { hasText: 'Discovered Agents' }) });
    await expect(card).toBeVisible();
    const empty = card.locator('.empty-state-title', { hasText: 'No agents discovered' });
    const table = card.locator('table.data-table');
    await expect(empty.or(table).first()).toBeVisible();
  });

  test('Active Connections empty state explains the surface', async ({ page }) => {
    // Only assert when the empty-state branch is actually rendered —
    // skip cleanly if the daemon happens to surface a connection.
    const desc = page.getByText(/Connections will appear here/i);
    if ((await desc.count()) === 0) {
      test.skip(true, 'devnet surfaced a real connection; empty-state copy not rendered');
    }
    await expect(desc).toBeVisible();
  });

  test('Discovered Agents empty state explains the surface', async ({ page }) => {
    const desc = page.getByText(/Agents will be listed here/i);
    if ((await desc.count()) === 0) {
      test.skip(true, 'devnet surfaced a discovered agent; empty-state copy not rendered');
    }
    await expect(desc).toBeVisible();
  });

  test('the page is unframed (no AppShell sidebar / header)', async ({ page }) => {
    // Sidebar toggle button only exists inside the framed AppShell.
    await expect(page.locator('button[title="Toggle sidebar"]')).toHaveCount(0);
    await expect(page.locator('.v10-panel-left')).toHaveCount(0);
    await expect(page.locator('.v10-panel-bottom')).toHaveCount(0);
  });

  test('document.title is "DKG Node"', async ({ page }) => {
    await expect(page).toHaveTitle('DKG Node');
  });
});
