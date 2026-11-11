import { expect, type Page, test } from '@playwright/test';

// The marketplace takes every colour from the app's theme tokens, so it
// follows the saved theme like the rest of the UI. The component gallery is
// a standalone route outside the shell: opening it directly must still apply
// the saved theme, and its card, primary button and status chip must resolve
// to the theme's own token values. The node is stubbed, so this runs with or
// without a devnet; the gallery itself never calls the node.

const THEMES = ['dark', 'light'] as const;

async function stubNode(page: Page) {
  // Only the node's routes: a `**/api/**` glob would also catch the UI's own
  // modules under /ui/marketplace/api/.
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/status') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ name: 'Theme test node', synced: true, connectedPeers: 0 }) });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
}

/** A token's value as the browser resolves it to a colour, for comparing against computed styles. */
async function resolved(page: Page, token: string): Promise<string> {
  return page.evaluate((t) => {
    const probe = document.createElement('div');
    probe.style.color = `var(${t})`;
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, token);
}

for (const theme of THEMES) {
  test(`the marketplace gallery opens in the saved ${theme} theme`, async ({ page }) => {
    await stubNode(page);
    await page.addInitScript((t) => localStorage.setItem('dkg-theme', t), theme);
    await page.goto('dev/gallery');
    await page.locator('.mktx .mkt-card').first().waitFor();

    const root = page.locator('html');
    await expect(root).toHaveAttribute('data-theme', theme);
    if (theme === 'light') await expect(root).toHaveClass(/(^|\s)light(\s|$)/);
    else await expect(root).not.toHaveClass(/(^|\s)light(\s|$)/);

    const card = page.locator('.mktx .mkt-card').first();
    await expect(card).toHaveCSS('background-color', await resolved(page, '--bg-surface'));

    const primary = page.locator('.mktx .ds-btn.ds-primary').first();
    await expect(primary).toHaveCSS('background-color', await resolved(page, '--accent-primary'));
    await expect(primary).toHaveCSS('color', await resolved(page, '--text-on-primary'));

    const landed = page.locator('[data-testid="mkt-gallery-calls"] .ds-badge.ds-tone-success').first();
    await expect(landed).toHaveCSS('color', await resolved(page, '--text-success'));
  });
}

test('the gallery card changes with the theme', async ({ page }) => {
  await stubNode(page);
  const backgrounds: string[] = [];
  for (const theme of THEMES) {
    await page.addInitScript((t) => localStorage.setItem('dkg-theme', t), theme);
    await page.goto('dev/gallery');
    const card = page.locator('.mktx .mkt-card').first();
    await card.waitFor();
    backgrounds.push(await card.evaluate((el) => getComputedStyle(el).backgroundColor));
  }
  expect(backgrounds[0]).not.toBe(backgrounds[1]);
});
