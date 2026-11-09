import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { mockQuietNode } from './mock-node.js';

/**
 * Select's menu placement in a real browser. Select works out left, top and
 * width; the stylesheet fixes the menu to the viewport and, when it opens
 * upwards, lifts it by its own height (.v10-select-menu-above). happy-dom has
 * no layout, so only a browser can tell a missing or overridden rule.
 */

const VIEWPORT = { width: 1200, height: 800 };
const FIXTURE = '/ui/@fs/' + path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'select-fixture.tsx').replace(/\\/g, '/').replace(/^\//, '');

async function mount(page: Page, top: number) {
  await mockQuietNode(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto('/ui/');
  await expect(page.locator('.v10-app')).toBeVisible();
  await page.evaluate(async ({ url, top }) => {
    const mod = await import(/* @vite-ignore */ url);
    mod.mountSelect(top);
  }, { url: FIXTURE, top });
  const trigger = page.getByRole('button', { name: 'Probe select' });
  await expect(trigger).toBeVisible();
  return trigger;
}

async function boxes(page: Page) {
  const trigger = await page.getByRole('button', { name: 'Probe select' }).boundingBox();
  const menu = await page.getByRole('listbox').boundingBox();
  if (!trigger || !menu) throw new Error('trigger or menu has no box');
  return { trigger, menu };
}

test.describe('Select menu placement', () => {
  test('opens below a trigger near the top, inside the viewport', async ({ page }) => {
    const trigger = await mount(page, 80);
    await trigger.click();
    await expect(page.locator('.v10-select-menu-below')).toBeVisible();
    const { trigger: t, menu: m } = await boxes(page);
    expect(m.y).toBeGreaterThanOrEqual(t.y + t.height);
    expect(m.y - (t.y + t.height)).toBeLessThanOrEqual(12);
    expect(m.y + m.height).toBeLessThanOrEqual(VIEWPORT.height);
    expect(Math.round(m.x)).toBe(Math.round(t.x));
    expect(Math.round(m.width)).toBe(Math.round(t.width));

    await page.getByRole('option', { name: 'Gamma' }).click();
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(page.locator('#select-probe')).toHaveAttribute('data-value', 'gamma');
  });

  test('opens above a trigger near the bottom, inside the viewport', async ({ page }) => {
    const trigger = await mount(page, VIEWPORT.height - 60);
    await trigger.click();
    await expect(page.locator('.v10-select-menu-above')).toBeVisible();
    const { trigger: t, menu: m } = await boxes(page);
    expect(m.y + m.height).toBeLessThanOrEqual(t.y);
    expect(t.y - (m.y + m.height)).toBeLessThanOrEqual(12);
    expect(m.y).toBeGreaterThanOrEqual(0);
    expect(Math.round(m.x)).toBe(Math.round(t.x));
    expect(Math.round(m.width)).toBe(Math.round(t.width));

    await page.getByRole('option', { name: 'Beta' }).click();
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(page.locator('#select-probe')).toHaveAttribute('data-value', 'beta');
  });
});
