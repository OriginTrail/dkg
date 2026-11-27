import { test, expect, type Page } from '@playwright/test';
import { mockQuietNode } from './mock-node.js';

/**
 * The reference page's state matrix shows hover and focus with preview classes
 * that share the components' own selectors. Here a real pointer and keyboard
 * put the Default cell into that state, and its computed look must equal the
 * preview cell's, in both themes.
 */

const LOOK = ['background-color', 'border-color', 'color', 'outline-style', 'outline-color', 'outline-width', 'box-shadow'] as const;

const look = (page: Page, row: string, state: string) =>
  page.locator('table.dsp-matrix tr', { has: page.locator(`th b:text-is("${row}")`) })
    .locator(`td[data-state="${state}"]`).locator('button, input, select, [role="switch"]').first()
    .evaluate((el, props) => {
      const style = getComputedStyle(el);
      return Object.fromEntries(props.map((p) => [p, style.getPropertyValue(p)]));
    }, [...LOOK]);

const control = (page: Page, row: string) =>
  page.locator('table.dsp-matrix tr', { has: page.locator(`th b:text-is("${row}")`) })
    .locator('td[data-state="Default"]').locator('button, input, select, [role="switch"]').first();

test.beforeEach(async ({ page }) => {
  await mockQuietNode(page);
  await page.setViewportSize({ width: 1400, height: 900 });
});

for (const theme of ['dark', 'light'] as const) {
  test(`preview cells match the real hover and focus looks (${theme})`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem('dkg-theme', t), theme);
    await page.goto('/ui/design-system.html');
    await expect(page.locator('table.dsp-matrix')).toBeVisible();
    // Transitions would catch a look half way.
    await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });

    for (const row of ['Button · primary', 'Button · secondary', 'Button · ghost', 'Button · danger', 'Button · swm', 'Button · vm', 'Tab', 'Segment', 'Filter chip', 'Context graph chip']) {
      await control(page, row).hover();
      const real = await look(page, row, 'Default');
      await page.mouse.move(0, 0);
      expect(await look(page, row, 'Hover'), `${row} hover`).toEqual(real);
    }

    for (const row of ['Button · primary', 'Input', 'Select', 'Toggle · off', 'Tab', 'Segment', 'Filter chip']) {
      const el = control(page, row);
      // Keyboard focus, so :focus-visible applies.
      await el.focus();
      await page.keyboard.press('Shift');
      const real = await look(page, row, 'Default');
      await el.blur();
      expect(await look(page, row, 'Focus'), `${row} focus`).toEqual(real);
    }
  });
}
