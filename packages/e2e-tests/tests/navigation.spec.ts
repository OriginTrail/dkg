/**
 * E2E tests for DKG Node UI sidebar navigation and cross-page behavior.
 * Base URL is configured in playwright.config.ts. The UI is at /ui.
 */
import { test, expect } from '@playwright/test';

const UI_BASE = '/ui';

test.describe('Sidebar links navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(UI_BASE);
    await page.waitForLoadState('domcontentloaded');
  });

  test('Dashboard link navigates to /ui with heading', async ({ page }) => {
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await page.waitForURL(/\/ui\/?(\?|$)/);
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible({ timeout: 15_000 });
  });

  test('Memory Explorer link navigates to /ui/explorer with heading', async ({ page }) => {
    await page.getByRole('link', { name: 'Memory Explorer' }).click();
    await page.waitForURL(/\/ui\/explorer/);
    await expect(page.getByRole('heading', { name: 'Memory Explorer' })).toBeVisible({ timeout: 15_000 });
  });

  test('Agent Hub link navigates to /ui/agent', async ({ page }) => {
    await page.getByRole('link', { name: 'Agent Hub' }).click();
    await page.waitForURL(/\/ui\/agent/);
    await expect(page.getByRole('button', { name: /OpenClaw|My Agent|Peer Chat/ }).first()).toBeVisible({ timeout: 15_000 });
  });

  test('Settings link navigates to /ui/settings with heading', async ({ page }) => {
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.waitForURL(/\/ui\/settings/);
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('Sidebar persists across pages', () => {
  const pages = [
    { path: UI_BASE, label: 'Dashboard' },
    { path: `${UI_BASE}/explorer`, label: 'Explorer' },
    { path: `${UI_BASE}/agent`, label: 'Agent Hub' },
    { path: `${UI_BASE}/settings`, label: 'Settings' },
  ];

  for (const { path, label } of pages) {
    test(`sidebar shows node name, powered by, status, peer count, network, version on ${label}`, async ({
      page,
    }) => {
      await page.goto(path);
      await page.waitForLoadState('domcontentloaded');

      const sidebar = page.locator('.sidebar');
      await expect(sidebar).toBeVisible({ timeout: 15_000 });

      // Node name (or loading placeholder)
      await expect(sidebar.locator('.sidebar-logo .mono')).toBeVisible();
      await expect(sidebar.getByText(/powered by/i)).toBeVisible();
      await expect(sidebar.getByText(/Online|Connecting|Offline/)).toBeVisible();
      await expect(sidebar.getByText(/\d+ peers|…/)).toBeVisible();
      await expect(sidebar.locator('.sidebar-footer')).toBeVisible();
    });
  }
});

test.describe('Apps dropdown', () => {
  test('click Apps button opens dropdown with OriginTrail Game, click navigates to /ui/apps with iframe', async ({
    page,
  }) => {
    await page.goto(UI_BASE);
    await page.waitForLoadState('domcontentloaded');

    const appsBtn = page.getByRole('button', { name: /Apps/ });
    await expect(appsBtn).toBeVisible();
    await appsBtn.click();

    const dropdown = page.locator('.apps-dropdown.open');
    await expect(dropdown).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('button', { name: /OriginTrail Game/ })).toBeVisible();

    await page.getByRole('button', { name: /OriginTrail Game/ }).click();
    await page.waitForURL(/\/ui\/apps/);
    await expect(page.locator('iframe[title="OriginTrail Game"]')).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('Active link highlighting', () => {
  test('Dashboard link has active class on Dashboard page', async ({ page }) => {
    await page.goto(UI_BASE);
    await page.waitForLoadState('domcontentloaded');

    const dashboardLink = page.getByRole('link', { name: 'Dashboard' });
    await expect(dashboardLink).toBeVisible();
    await expect(dashboardLink).toHaveClass(/active/);
  });

  test('Memory Explorer link has active class on Explorer page', async ({ page }) => {
    await page.goto(`${UI_BASE}/explorer`);
    await page.waitForLoadState('domcontentloaded');

    const explorerLink = page.getByRole('link', { name: 'Memory Explorer' });
    await expect(explorerLink).toBeVisible();
    await expect(explorerLink).toHaveClass(/active/);
  });
});

test.describe('Direct URL navigation', () => {
  test('navigate directly to /ui/explorer/sparql loads SPARQL page', async ({ page }) => {
    await page.goto(`${UI_BASE}/explorer/sparql`);
    await page.waitForLoadState('domcontentloaded');

    await expect(page).toHaveURL(/\/ui\/explorer\/sparql/);
    const sparqlLink = page.getByRole('link', { name: 'SPARQL' });
    await expect(sparqlLink).toBeVisible();
    await expect(sparqlLink).toHaveClass(/active/);
    await expect(page.getByRole('button', { name: /Run Query|Running\.\.\./ })).toBeVisible({ timeout: 15_000 });
  });

  test('navigate directly to /ui/settings?tab=observability loads Observability tab (with dev mode)', async ({
    page,
  }) => {
    await page.goto(`${UI_BASE}/settings`);
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(() => {
      localStorage.setItem('dkg-developer-mode', '1');
      window.dispatchEvent(new Event('devmode-change'));
    });
    await page.goto(`${UI_BASE}/settings?tab=observability`);
    await page.waitForLoadState('domcontentloaded');

    await expect(page).toHaveURL(/\/ui\/settings\?tab=observability/);
    await expect(page.getByRole('button', { name: 'All Operations' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Performance' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Logs' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Errors' })).toBeVisible();
  });

  test('navigate directly to /ui/agent loads Agent Hub', async ({ page }) => {
    await page.goto(`${UI_BASE}/agent`);
    await page.waitForLoadState('domcontentloaded');

    await expect(page).toHaveURL(/\/ui\/agent/);
    await expect(page.getByRole('button', { name: /OpenClaw|My Agent|Peer Chat/ }).first()).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('Browser back/forward', () => {
  test('back and forward navigation works correctly', async ({ page }) => {
    await page.goto(UI_BASE);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible({ timeout: 15_000 });

    await page.getByRole('link', { name: 'Memory Explorer' }).click();
    await page.waitForURL(/\/ui\/explorer/);
    await expect(page.getByRole('heading', { name: 'Memory Explorer' })).toBeVisible({ timeout: 15_000 });

    await page.getByRole('link', { name: 'Settings' }).click();
    await page.waitForURL(/\/ui\/settings/);
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible({ timeout: 15_000 });

    await page.goBack();
    await page.waitForURL(/\/ui\/explorer/);
    await expect(page.getByRole('heading', { name: 'Memory Explorer' })).toBeVisible({ timeout: 5_000 });

    await page.goBack();
    await page.waitForURL(/\/ui\/?(\?|$)/);
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible({ timeout: 5_000 });

    await page.goForward();
    await page.waitForURL(/\/ui\/explorer/);
    await expect(page.getByRole('heading', { name: 'Memory Explorer' })).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('Quick action buttons on Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(UI_BASE);
    await page.waitForLoadState('domcontentloaded');
  });

  test('Query the Graph button navigates to SPARQL page', async ({ page }) => {
    await page.getByRole('button', { name: /Query the Graph/ }).click();
    await page.waitForURL(/\/ui\/explorer\/sparql/);
    await expect(page.getByRole('link', { name: 'SPARQL' })).toHaveClass(/active/);
    await expect(page.getByRole('button', { name: /Run Query|Running\.\.\./ })).toBeVisible({ timeout: 15_000 });
  });

  test('Play OriginTrail button navigates to game page', async ({ page }) => {
    await page.getByRole('button', { name: /Play OriginTrail/ }).click();
    await page.waitForURL(/\/ui\/apps/);
    await expect(page.locator('iframe[title="OriginTrail Game"]')).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('API requests succeed across pages', () => {
  test('no 5xx errors when navigating through all pages', async ({ page }) => {
    const fivexxResponses: { url: string; status: number }[] = [];

    page.on('response', (res) => {
      const status = res.status();
      if (status >= 500 && status < 600) {
        fivexxResponses.push({ url: res.url(), status });
      }
    });

    await page.goto(UI_BASE);
    await page.waitForLoadState('domcontentloaded');

    await page.getByRole('link', { name: 'Memory Explorer' }).click();
    await page.waitForLoadState('domcontentloaded');

    await page.getByRole('link', { name: 'Agent Hub' }).click();
    await page.waitForLoadState('domcontentloaded');

    await page.getByRole('link', { name: 'Settings' }).click();
    await page.waitForLoadState('domcontentloaded');

    await page.getByRole('button', { name: /Apps/ }).click();
    await page.getByRole('button', { name: /OriginTrail Game/ }).click();
    await page.waitForLoadState('domcontentloaded');

    await page.getByRole('link', { name: 'Dashboard' }).click();
    await page.waitForLoadState('domcontentloaded');

    expect(
      fivexxResponses,
      fivexxResponses.length > 0
        ? `Unexpected 5xx responses: ${JSON.stringify(fivexxResponses)}`
        : undefined
    ).toEqual([]);
  });
});
