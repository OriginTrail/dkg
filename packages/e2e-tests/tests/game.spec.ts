import { test, expect, type Page } from '@playwright/test';

const GAME_URL = '/apps/origin-trail-game/';

async function ensureLobby(page: Page) {
  await page.goto(GAME_URL);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);

  const leaveBtn = page.getByRole('button', { name: 'Leave Swarm' });
  const backBtn = page.getByRole('button', { name: 'Back to Lobby' });

  if (await leaveBtn.isVisible().catch(() => false)) {
    await leaveBtn.click();
    const confirmBtn = page.getByRole('button', { name: 'Confirm Leave' });
    await expect(confirmBtn).toBeVisible({ timeout: 5_000 });
    await confirmBtn.click();
    await page.waitForTimeout(2000);
  } else if (await backBtn.isVisible().catch(() => false)) {
    await backBtn.click();
    await page.waitForTimeout(2000);
  }
}

test.describe('OriginTrail Game', () => {
  test.describe('Navigate to game via UI', () => {
    test('Apps button opens dropdown, OriginTrail Game navigates to /ui/apps', async ({ page }) => {
      await page.goto('/ui');
      const appsBtn = page.getByRole('button', { name: /Apps/ });
      await expect(appsBtn).toBeVisible({ timeout: 15_000 });
      await appsBtn.click();

      const gameLink = page.getByRole('button', { name: /OriginTrail Game/ });
      await expect(gameLink).toBeVisible();
      await gameLink.click();

      await expect(page).toHaveURL(/\/ui\/apps/);
      await expect(page.locator('iframe[title="OriginTrail Game"]')).toBeVisible({ timeout: 15_000 });
    });
  });

  test.describe('Lobby', () => {
    test.beforeEach(async ({ page }) => {
      await ensureLobby(page);
    });

    test('shows game header and Playing as', async ({ page }) => {
      await expect(page.getByText('ORIGINTRAIL GAME', { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(/AI Frontier Journey/i)).toBeVisible();
      await expect(page.getByText(/Playing as:/)).toBeVisible();
    });

    test('shows leaderboard section', async ({ page }) => {
      await expect(page.getByRole('heading', { name: /Leaderboard/ })).toBeVisible({ timeout: 15_000 });
    });

    test('shows lobby sections', async ({ page }) => {
      await expect(page.getByRole('heading', { name: 'Your Swarms' })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('heading', { name: 'Open Swarms' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Launch Swarm' })).toBeVisible();
      await expect(page.getByText('Lobby Chat')).toBeVisible();
    });

    test('launch swarm form has name input, max players controls, disabled button', async ({ page }) => {
      const nameInput = page.getByPlaceholder('Swarm name...');
      await expect(nameInput).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('Max players:')).toBeVisible();

      const launchBtn = page.getByRole('button', { name: 'Launch Swarm' });
      await expect(launchBtn).toBeDisabled();

      await nameInput.fill('E2E-Test-Swarm');
      await expect(launchBtn).toBeEnabled();
    });

    test('lobby chat input and send button', async ({ page }) => {
      const chatInput = page.getByPlaceholder('Say something...');
      await expect(chatInput).toBeVisible({ timeout: 15_000 });
      const sendBtn = page.getByRole('button', { name: 'Send' });
      await expect(sendBtn).toBeDisabled();
    });

    test('refresh button works without errors', async ({ page }) => {
      const refreshBtn = page.getByRole('button', { name: 'Refresh' });
      await expect(refreshBtn).toBeVisible({ timeout: 15_000 });

      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));

      await refreshBtn.click();
      await page.waitForTimeout(2000);
      expect(errors).toEqual([]);
    });
  });

});
