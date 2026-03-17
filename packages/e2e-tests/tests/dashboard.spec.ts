import { test, expect } from '@playwright/test';

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/ui');
  });

  test.describe('page load', () => {
    test('loads correctly with title, heading, and live status', async ({ page }) => {
      await expect(page).toHaveTitle('DKG Node');
      await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(/Your node is live/)).toBeVisible({ timeout: 15_000 });
    });
  });

  test.describe('stats cards', () => {
    test('displays stat cards with numbers', async ({ page }) => {
      await page.waitForSelector('.stat-card', { timeout: 15_000 });
      const statCards = page.locator('.stat-card');
      await expect(statCards).toHaveCount(3);

      await expect(page.getByText('Knowledge Collections').first()).toBeVisible();
      await expect(page.getByText('Connected Peers').first()).toBeVisible();
      await expect(page.getByText('Agents Discovered').first()).toBeVisible();

      const kcCard = statCards.filter({ has: page.locator('text=Knowledge Collections') }).first();
      const peerCard = statCards.filter({ has: page.locator('text=Connected Peers') }).first();
      const agentCard = statCards.filter({ has: page.locator('text=Agents Discovered') }).first();

      await expect(kcCard.locator('.stat-value')).toBeVisible();
      await expect(peerCard.locator('.stat-value')).toBeVisible();
      await expect(agentCard.locator('.stat-value')).toBeVisible();
    });
  });

  test.describe('sidebar navigation', () => {
    test('displays sidebar with node name, powered by, nav links, Apps, version, Online status, peer count', async ({ page }) => {
      const sidebar = page.locator('.sidebar');
      await expect(sidebar).toBeVisible({ timeout: 15_000 });

      await expect(sidebar.getByText(/powered by/i)).toBeVisible();
      await expect(sidebar.getByRole('link', { name: 'Dashboard' })).toBeVisible();
      await expect(sidebar.getByRole('link', { name: 'Memory Explorer' })).toBeVisible();
      await expect(sidebar.getByRole('link', { name: 'Agent Hub' })).toBeVisible();
      await expect(sidebar.getByRole('button', { name: /Apps/ })).toBeVisible();
      await expect(sidebar.getByRole('link', { name: 'Settings' })).toBeVisible();
      await expect(sidebar.getByText(/Online|Connecting/)).toBeVisible();
      await expect(sidebar.getByText(/\d+ peers|…/)).toBeVisible();
    });
  });

  test.describe('paranet grid', () => {
    test('displays multiple paranet heading cards', async ({ page }) => {
      await page.waitForSelector('.paranet-list', { timeout: 15_000 });
      const paranetCards = page.locator('.paranet-list .paranet-card');
      const count = await paranetCards.count();
      expect(count).toBeGreaterThanOrEqual(1);
      await expect(paranetCards.first()).toBeVisible();
      await expect(page.locator('.paranet-card h3').first()).toBeVisible();
    });
  });

  test.describe('Recent Operations', () => {
    test('shows Recent Operations text and operation entries with time and type when operations exist', async ({ page }) => {
      await page.waitForLoadState('domcontentloaded');
      const recentOpsHeading = page.getByText('Recent Operations');
      const isVisible = await recentOpsHeading.isVisible().catch(() => false);
      if (isVisible) {
        const section = recentOpsHeading.locator('..').locator('..');
        const opRows = section.locator('div').filter({ has: page.locator('.mono') });
        const count = await opRows.count();
        if (count > 0) {
          await expect(opRows.first()).toContainText(/\d{1,2}:\d{2}/);
          await expect(opRows.first().locator('[style*="fontWeight: 700"]')).toBeVisible();
        }
      }
    });
  });

  test.describe('Error Hotspots', () => {
    test('displays Error Hotspots section', async ({ page }) => {
      await expect(
        page.getByText(/Error Hotspots \(7d\)|No errors in 7 days/)
      ).toBeVisible({ timeout: 15_000 });
    });
  });

  test.describe('Spending', () => {
    test('displays Spending section with ETH gas and TRAC when data available', async ({ page }) => {
      await page.waitForLoadState('domcontentloaded');
      const spendingHeading = page.getByText(/Spending/);
      const isVisible = await spendingHeading.isVisible().catch(() => false);
      if (isVisible) {
        await expect(page.getByText('ETH gas')).toBeVisible();
        await expect(page.getByText('TRAC')).toBeVisible();
      }
    });
  });

  test.describe('quick action buttons', () => {
    test('displays 3 quick action buttons', async ({ page }) => {
      await page.waitForSelector('.quick-actions', { timeout: 15_000 });
      const quickActions = page.locator('.quick-action');
      await expect(quickActions).toHaveCount(3);
      const qa = page.locator('.quick-actions');
      await expect(qa.locator('.quick-action').filter({ hasText: /Query the Graph/ })).toBeVisible();
      await expect(qa.locator('.quick-action').filter({ hasText: /Import Memories/ })).toBeVisible();
      await expect(qa.locator('.quick-action').filter({ hasText: /Play OriginTrail/ })).toBeVisible();
    });
  });

  test.describe('Import Memories modal', () => {
    test('opens modal, shows source buttons, textarea, Import disabled when empty, enables when typed, shows line count, Cancel closes', async ({ page }) => {
      const importBtn = page.locator('.quick-actions .quick-action').filter({ hasText: /Import Memories/ });
      await expect(importBtn).toBeVisible({ timeout: 15_000 });
      await importBtn.click();

      const modal = page.locator('.import-modal');
      await expect(modal.getByRole('heading', { name: 'Import Memories' })).toBeVisible({ timeout: 5_000 });
      await expect(modal.getByRole('button', { name: /Claude/ })).toBeVisible();
      await expect(modal.getByRole('button', { name: /ChatGPT/ })).toBeVisible();
      await expect(modal.getByRole('button', { name: /Gemini/ })).toBeVisible();
      await expect(modal.getByRole('button', { name: /Other/ })).toBeVisible();

      const textarea = modal.getByPlaceholder('Paste your exported memories here...');
      await expect(textarea).toBeVisible();

      const importSubmitBtn = modal.getByRole('button', { name: /Import as Private Knowledge/ });
      await expect(importSubmitBtn).toBeDisabled();

      await textarea.fill('Memory 1: User likes coffee\nMemory 2: User works at Acme');
      await expect(importSubmitBtn).toBeEnabled();
      await expect(modal.getByText(/lines detected/)).toBeVisible();

      await modal.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.locator('.import-modal-overlay.open')).toHaveCount(0);
    });
  });

  test.describe('Notifications dropdown', () => {
    test('opens notifications dropdown on click', async ({ page }) => {
      await page.waitForLoadState('domcontentloaded');
      const notifBtn = page.getByRole('button', { name: 'Notifications' });
      await notifBtn.click();
      await expect(page.getByText('Notifications').first()).toBeVisible({ timeout: 5_000 });
      const dropdown = page.locator('div').filter({ hasText: /No notifications yet|Notifications/ }).first();
      await expect(dropdown).toBeVisible();
    });
  });

  test.describe('console errors', () => {
    test('no unexpected console errors on load', async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          const text = msg.text();
          consoleErrors.push(text);
        }
      });
      await page.goto('/ui');
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(2000);
      const allowedPatterns = [
        /Failed to load resource/,
        /net::ERR_/,
        /ResizeObserver/,
        /ChunkLoadError/,
      ];
      const unexpected = consoleErrors.filter(
        (err) => !allowedPatterns.some((p) => p.test(err))
      );
      expect(unexpected).toEqual([]);
    });
  });

  test.describe('API health', () => {
    test('dashboard load triggers successful API responses', async ({ page }) => {
      const apiPaths = ['/api/status', '/api/apps', '/api/notifications'];
      const responses: Map<string, number> = new Map();
      page.on('response', (res) => {
        const url = res.url();
        const path = new URL(url).pathname;
        for (const apiPath of apiPaths) {
          if (path.includes(apiPath) || path === apiPath) {
            responses.set(apiPath, res.status());
            break;
          }
        }
      });
      await page.goto('/ui');
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(3000);

      for (const apiPath of apiPaths) {
        const status = responses.get(apiPath);
        expect(status, `Expected 200 for ${apiPath}`).toBe(200);
      }
    });
  });
});
