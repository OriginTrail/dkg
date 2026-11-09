import { test, expect } from '../fixtures/base.js';

// `/network` forwards to the Network tab in Observability. The Vite dev
// server is configured with `base: '/ui/'`, so absolute paths like
// `/network` get rewritten by the dev server to "did you mean
// /ui/network?". We use a path relative to the configured `baseURL`
// (`http://localhost:<port>/ui/`) instead.
//
// Stat-card labels are sentence case ("Total connections"); the label
// assertion below lowercases them first.

test.describe('Network tab in Observability (/ui/network)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('network', { waitUntil: 'domcontentloaded' });
    await page
      .getByRole('heading', { name: 'Observability', level: 1 })
      .waitFor({ state: 'visible', timeout: 15_000 });
  });

  test('opens the Network tab in Observability', async ({ page }) => {
    const heading = page.getByRole('heading', { name: 'Observability', level: 1 });
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

  test('Active connections section renders the empty-state on cold devnet', async ({ page }) => {
    const card = page
      .locator('.card')
      .filter({ has: page.locator('.card-title', { hasText: 'Active connections' }) });
    await expect(card).toBeVisible();
    // Either the empty-state copy renders (single-node devnet) or
    // a real `.data-table` does. Both are valid.
    const empty = card.locator('.v10-empty-state-title', { hasText: 'No active connections' });
    const table = card.locator('table.data-table');
    await expect(empty.or(table).first()).toBeVisible();
  });

  test('Discovered agents section renders the empty-state on cold devnet', async ({ page }) => {
    const card = page
      .locator('.card')
      .filter({ has: page.locator('.card-title', { hasText: 'Discovered agents' }) });
    await expect(card).toBeVisible();
    const empty = card.locator('.v10-empty-state-title', { hasText: 'No agents discovered' });
    const table = card.locator('table.data-table');
    await expect(empty.or(table).first()).toBeVisible();
  });

  test('Active connections card shows either the explanatory empty state or a connections table', async ({ page }) => {
    // On a 2-node devnet node1↔node2 may or may not have dialled by the time
    // this loads, so the card resolves to one of two valid shapes: the
    // explanatory empty-state copy ("Connections will appear here…") OR a
    // populated `.data-table`. Assert the union so the test always runs and
    // still catches a card that renders NEITHER (the real regression).
    const card = page
      .locator('.card')
      .filter({ has: page.locator('.card-title', { hasText: 'Active connections' }) });
    const desc = card.getByText(/Connections will appear here/i);
    const table = card.locator('table.data-table');
    await expect(desc.or(table).first()).toBeVisible();
  });

  test('Discovered agents card shows either the explanatory empty state or an agents table', async ({ page }) => {
    const card = page
      .locator('.card')
      .filter({ has: page.locator('.card-title', { hasText: 'Discovered agents' }) });
    const desc = card.getByText(/Agents will be listed here/i);
    const table = card.locator('table.data-table');
    await expect(desc.or(table).first()).toBeVisible();
  });

  test('sits inside the app shell, like every other Observability tab', async ({ page }) => {
    await expect(page.locator('button[title="Toggle sidebar"]')).toHaveCount(1);
    await expect(page.locator('.v10-panel-left').first()).toBeVisible();
  });

  test('document.title is "DKG Node"', async ({ page }) => {
    await expect(page).toHaveTitle('DKG Node');
  });
});
