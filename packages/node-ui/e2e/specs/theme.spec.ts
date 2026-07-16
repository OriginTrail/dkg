import { test, expect } from '../fixtures/base.js';

test.describe('Theme Toggle', () => {
  test.beforeEach(async ({ shell }) => {
    await shell.goto();
  });

  test('defaults to dark mode', async ({ page }) => {
    const hasLight = await page.evaluate(() => document.body.classList.contains('light'));
    expect(hasLight).toBe(false);
  });

  test('toggle adds body.light class for light mode', async ({ page, header }) => {
    await header.toggleTheme();
    const hasLight = await page.evaluate(() => document.body.classList.contains('light'));
    expect(hasLight).toBe(true);
  });

  test('double toggle restores dark mode', async ({ page, header }) => {
    await header.toggleTheme();
    await header.toggleTheme();
    const hasLight = await page.evaluate(() => document.body.classList.contains('light'));
    expect(hasLight).toBe(false);
  });

  test('button title reflects current mode', async ({ header }) => {
    const darkTitle = await header.getThemeTitle();
    expect(darkTitle).toContain('light');
    await header.toggleTheme();
    const lightTitle = await header.getThemeTitle();
    expect(lightTitle).toContain('dark');
  });

  test('preference persists in localStorage', async ({ page, header }) => {
    await header.toggleTheme();
    const stored = await page.evaluate(() => localStorage.getItem('dkg-theme'));
    expect(stored).toBe('light');
    await header.toggleTheme();
    const storedBack = await page.evaluate(() => localStorage.getItem('dkg-theme'));
    expect(storedBack).toBe('dark');
  });
});
