import { test, expect, type Page } from '@playwright/test';
import { mockQuietNode } from './mock-node.js';

/**
 * Two layout boundaries the shell relies on: tables scroll inside their card
 * with the first column pinned, and PCA dialog contents follow the dialog's
 * own width, not the centre panel's.
 */

const LONG = 'a-very-long-operation-identifier-that-cannot-wrap-0123456789abcdef';

function operation(i: number) {
  return {
    operation_id: `${LONG}-${i}`,
    operation_name: i % 2 ? 'publish' : 'share',
    status: i % 3 ? 'success' : 'in_progress',
    started_at: Date.now() - i * 60_000,
    duration_ms: 1200 + i,
    gas_cost_eth: 0.000123456789,
    tx_hash: `0x${'ab'.repeat(32)}`,
    phases: [],
  };
}

test.describe('tables at narrow widths', () => {
  test('the Operations table scrolls inside its card and keeps the first column pinned', async ({ page }) => {
    await mockQuietNode(page);
    // Matched on the path: in a glob, `?` would match any one character.
    await page.route((url) => url.pathname.endsWith('/api/operations'), (route) => route.fulfill({
      json: { operations: Array.from({ length: 6 }, (_, i) => operation(i)), total: 6 },
    }));
    await page.setViewportSize({ width: 520, height: 900 });
    await page.goto('/ui/observability');

    const scroller = page.locator('.ds-table-scroll.ds-table-pin').filter({ has: page.locator('tbody tr') }).first();
    await expect(scroller).toBeVisible();
    await expect(scroller.locator('tbody tr')).toHaveCount(6);

    // The page itself never scrolls sideways; only the table does.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const widths = await scroller.evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    expect(widths.scroll).toBeGreaterThan(widths.client);

    const firstCell = scroller.locator('tbody tr').first().locator('td').first();
    const lastHeader = scroller.locator('thead th').last();
    const box = (await scroller.boundingBox())!;
    const pinnedBefore = (await firstCell.boundingBox())!.x;

    await scroller.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    // The last column comes into the card's view.
    const last = (await lastHeader.boundingBox())!;
    expect(last.x + last.width).toBeLessThanOrEqual(box.x + box.width + 1);
    expect(last.x).toBeGreaterThanOrEqual(box.x - 1);
    // The first column stays where it was.
    expect((await firstCell.boundingBox())!.x).toBeCloseTo(pinnedBefore, 0);
  });
});

test.describe('PCA dialog contents follow the dialog, not the centre', () => {
  test.beforeEach(async ({ page }) => {
    await mockQuietNode(page);
    await page.goto('/ui/');
    await expect(page.locator('.v10-center-content')).toBeVisible();
  });

  /** Grid tracks of `inner` inside a box `width` wide, placed in the centre with or without data-narrow. */
  const tracks = (page: Page, html: string, inner: string, width: number, narrow: boolean) => page.evaluate(
    ({ html, inner, width, narrow }) => {
      const centre = document.querySelector('.v10-center-content')!;
      const had = centre.hasAttribute('data-narrow');
      if (narrow) centre.setAttribute('data-narrow', ''); else centre.removeAttribute('data-narrow');
      const box = document.createElement('div');
      box.style.width = `${width}px`;
      box.innerHTML = html;
      centre.appendChild(box);
      const n = getComputedStyle(box.querySelector(inner)!).gridTemplateColumns.split(' ').length;
      box.remove();
      if (had) centre.setAttribute('data-narrow', ''); else centre.removeAttribute('data-narrow');
      return n;
    },
    { html, inner, width, narrow },
  );

  const HANDSHAKE = '<div class="v10-pca-handshake"><div class="v10-pca-handshake-half">A</div><div class="v10-pca-handshake-half">B</div></div>';
  const PICKER = '<ul class="v10-pca-node-picker-list"><li class="v10-pca-node-picker-option"><span>1</span><span>Peer</span><span class="ds-badge">Core</span><span class="v10-pca-node-picker-stake">50k</span><span class="v10-pca-node-picker-own">You</span></li></ul>';

  test('the handshake keeps two halves in a wide dialog whatever the side panels do', async ({ page }) => {
    expect(await tracks(page, HANDSHAKE, '.v10-pca-handshake', 560, false)).toBe(2);
    expect(await tracks(page, HANDSHAKE, '.v10-pca-handshake', 560, true)).toBe(2);
    expect(await tracks(page, HANDSHAKE, '.v10-pca-handshake', 320, false)).toBe(1);
  });

  test('the node picker re-flows to the width the dialog gives it', async ({ page }) => {
    expect(await tracks(page, PICKER, '.v10-pca-node-picker-option', 720, true)).toBe(5);
    expect(await tracks(page, PICKER, '.v10-pca-node-picker-option', 420, false)).toBe(2);
  });
});
