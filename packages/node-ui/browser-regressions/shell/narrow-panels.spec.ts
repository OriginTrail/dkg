import { test, expect, type Page } from '@playwright/test';
import { mockQuietNode } from './mock-node.js';

/**
 * AppShell side panels in a real browser: the 860px breakpoint is a media
 * query, the scrim and drawers are CSS, and `data-narrow` comes from a
 * ResizeObserver, so none of this can be checked in happy-dom.
 */

const NARROW = { width: 800, height: 900 };
const DESKTOP = { width: 1400, height: 900 };

const left = (page: Page) => page.locator('.v10-app-body > .v10-panel-left');
const right = (page: Page) => page.locator('.v10-app-body > .v10-panel-right');
const scrim = (page: Page) => page.locator('.v10-panel-scrim');
const centre = (page: Page) => page.locator('.v10-center-content');
const sidebarButton = (page: Page) => page.getByTitle('Toggle sidebar');
const agentPanelButton = (page: Page) => page.getByTitle('Toggle agent panel');

async function open(page: Page, viewport: { width: number; height: number }, saved?: Record<string, unknown>) {
  await page.setViewportSize(viewport);
  if (saved) {
    await page.addInitScript((layout) => {
      // Only on the first load, so a reload sees what the app itself saved.
      if (!sessionStorage.getItem('layout-seeded')) {
        localStorage.setItem('dkg-layout', JSON.stringify(layout));
        sessionStorage.setItem('layout-seeded', '1');
      }
    }, saved);
  }
  await page.goto('/ui/');
  await expect(page.locator('.v10-app')).toBeVisible();
  await expect(centre(page)).toBeVisible();
}

/** Client-side navigation the router sees, like back and forward do. */
async function navigateTo(page: Page, path: string) {
  await page.evaluate((to) => {
    history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  await expect(page).toHaveURL(new RegExp(`${path}$`));
}

async function savedLayout(page: Page): Promise<Record<string, unknown>> {
  // Writes are debounced by 150ms in stores/layout.ts.
  await page.waitForTimeout(300);
  return page.evaluate(() => JSON.parse(localStorage.getItem('dkg-layout') ?? '{}'));
}

test.beforeEach(async ({ page }) => { await mockQuietNode(page); });

test.describe('narrow screen (860px and below)', () => {
  test('both side panels start closed, even when the desktop layout has them open', async ({ page }) => {
    await open(page, NARROW, { leftCollapsed: false, rightCollapsed: false });
    await expect(left(page)).toBeHidden();
    await expect(right(page)).toBeHidden();
    await expect(scrim(page)).toHaveCount(0);
    // The centre takes the full width.
    const box = await centre(page).boundingBox();
    expect(box!.width).toBeGreaterThan(NARROW.width - 20);
  });

  test('the header buttons open one panel at a time over the page', async ({ page }) => {
    await open(page, NARROW);
    await sidebarButton(page).click();
    await expect(left(page)).toBeVisible();
    await expect(right(page)).toBeHidden();
    await expect(scrim(page)).toBeVisible();
    await expect(sidebarButton(page)).toHaveClass(/active-toggle/);
    // The drawer floats: the centre keeps its full width underneath it.
    expect(await left(page).evaluate((el) => getComputedStyle(el).position)).toBe('absolute');
    expect((await centre(page).boundingBox())!.width).toBeGreaterThan(NARROW.width - 20);

    await agentPanelButton(page).click();
    await expect(right(page)).toBeVisible();
    await expect(left(page)).toBeHidden();
    await expect(sidebarButton(page)).not.toHaveClass(/active-toggle/);

    // The same button closes its own panel.
    await agentPanelButton(page).click();
    await expect(right(page)).toBeHidden();
    await expect(scrim(page)).toHaveCount(0);
  });

  test('a tap on the scrim closes the open panel', async ({ page }) => {
    await open(page, NARROW);
    for (const [button, panel] of [[sidebarButton, left], [agentPanelButton, right]] as const) {
      await button(page).click();
      await expect(panel(page)).toBeVisible();
      // Tap the strip the drawer leaves uncovered on the far side.
      const panelBox = (await panel(page).boundingBox())!;
      const scrimBox = (await scrim(page).boundingBox())!;
      const x = panelBox.x > scrimBox.x + 1 ? 10 : scrimBox.width - 10;
      await scrim(page).click({ position: { x, y: scrimBox.height / 2 } });
      await expect(panel(page)).toBeHidden();
      await expect(scrim(page)).toHaveCount(0);
    }
  });

  test('going somewhere from the sidebar closes it', async ({ page }) => {
    await open(page, NARROW);
    await sidebarButton(page).click();
    await left(page).getByRole('button', { name: /^Settings$/ }).click();
    await expect(page).toHaveURL(/\/ui\/settings$/);
    await expect(left(page)).toBeHidden();
    await expect(scrim(page)).toHaveCount(0);

    // Back and forward count as going somewhere too.
    await agentPanelButton(page).click();
    await expect(right(page)).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/ui\/$/);
    await expect(right(page)).toBeHidden();
  });

  for (const [dialog, button] of [
    ['create', /New context graph/],
    ['join', /Join context graph/],
  ] as const) {
    test(`the ${dialog} dialog and what's typed in it outlive the sidebar that opened it`, async ({ page }) => {
      await open(page, NARROW);
      await sidebarButton(page).click();
      await left(page).getByRole('button', { name: button }).first().click();
      const shown = page.getByRole('dialog');
      await expect(shown).toBeVisible();
      const field = shown.getByRole('textbox').first();
      await field.fill('Typed before the panel closed');

      // The dialog navigates before its last step. The panel closes; the dialog stays.
      await navigateTo(page, '/ui/settings');
      await expect(left(page)).toBeHidden();
      await expect(shown).toBeVisible();
      await expect(field).toHaveValue('Typed before the panel closed');

      // Crossing 860px either way doesn't lose it either.
      await page.setViewportSize(DESKTOP);
      await expect(shown).toBeVisible();
      await expect(field).toHaveValue('Typed before the panel closed');
      await page.setViewportSize(NARROW);
      await expect(shown).toBeVisible();
      await expect(field).toHaveValue('Typed before the panel closed');

      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });
  }

  test('an unsent chat message survives resizing and switching panels', async ({ page }) => {
    const composer = right(page).locator('textarea.v10-agent-input');
    await open(page, DESKTOP, { leftCollapsed: false, rightCollapsed: false });
    await composer.fill('Draft typed on desktop');

    await page.setViewportSize(NARROW);
    await agentPanelButton(page).click();
    await expect(composer).toHaveValue('Draft typed on desktop');

    // Opening the sidebar closes the agent panel; its draft stays.
    await sidebarButton(page).click();
    await expect(right(page)).toBeHidden();
    await agentPanelButton(page).click();
    await expect(composer).toHaveValue('Draft typed on desktop');

    await page.setViewportSize(DESKTOP);
    await expect(composer).toHaveValue('Draft typed on desktop');
  });

  test('hiding the agent panel closes its open picker menu but keeps the draft', async ({ page }) => {
    const composer = right(page).locator('textarea.v10-agent-input');
    // One Context Graph, so the composer's picker has something to offer.
    await page.route('**/api/context-graph/list**', (route) => route.fulfill({ json: { contextGraphs: [
      { id: 'cg-picker', name: 'Picker graph', accessPolicy: 'private', callerInvolved: true, subscribed: true, synced: true },
    ] } }));
    await open(page, DESKTOP, { leftCollapsed: false, rightCollapsed: false });
    await composer.fill('Draft kept while the panel hides');
    // The Context Graph picker's menu is portalled to the page body.
    await right(page).locator('.v10-local-agent-target-select button[aria-haspopup="listbox"]').click();
    await expect(page.getByRole('listbox')).toBeVisible();

    // The shortcut closes the panel without a click outside the menu.
    await page.keyboard.press('Control+Shift+B');
    await expect(right(page)).toBeHidden();
    await expect(page.getByRole('listbox')).toHaveCount(0);

    await agentPanelButton(page).click();
    await expect(composer).toHaveValue('Draft kept while the panel hides');
  });

  test('a draft typed on a narrow screen survives widening when the desktop agent panel is saved closed', async ({ page }) => {
    const composer = right(page).locator('textarea.v10-agent-input');
    await open(page, NARROW, { leftCollapsed: false, rightCollapsed: true });
    await agentPanelButton(page).click();
    await composer.fill('Draft typed on a phone');

    // The saved desktop state wins: the panel closes, but nothing in it is lost.
    await page.setViewportSize(DESKTOP);
    await expect(right(page)).toBeHidden();
    await agentPanelButton(page).click();
    await expect(composer).toHaveValue('Draft typed on a phone');
  });
});

test.describe('back to desktop', () => {
  test('widening restores the saved panel state and leaves it unchanged', async ({ page }) => {
    const saved = { leftCollapsed: false, rightCollapsed: true, leftWidth: 260, rightWidth: 380 };
    await open(page, DESKTOP, saved);
    await expect(left(page)).toBeVisible();
    await expect(right(page)).toBeHidden();

    await page.setViewportSize(NARROW);
    await expect(left(page)).toBeHidden();
    await agentPanelButton(page).click();
    await expect(right(page)).toBeVisible();

    await page.setViewportSize(DESKTOP);
    await expect(left(page)).toBeVisible();
    await expect(right(page)).toBeHidden();
    await expect(scrim(page)).toHaveCount(0);
    expect((await left(page).boundingBox())!.width).toBe(260);
    expect(await savedLayout(page)).toMatchObject(saved);

    // And the other way round: the right panel saved open comes back too.
    await agentPanelButton(page).click();
    await expect(right(page)).toBeVisible();
    await page.setViewportSize(NARROW);
    await expect(right(page)).toBeHidden();
    await page.setViewportSize(DESKTOP);
    await expect(left(page)).toBeVisible();
    await expect(right(page)).toBeVisible();
  });

  test('the resize handles drag the side panels, and the new widths are saved', async ({ page }) => {
    // Left starts closed so its handle mounts after the shell does.
    await open(page, DESKTOP, { leftCollapsed: true, rightCollapsed: false, leftWidth: 240, rightWidth: 360 });
    await expect(left(page)).toBeHidden();
    await sidebarButton(page).click();
    await expect(left(page)).toBeVisible();

    const drag = async (handle: number, dx: number) => {
      const box = (await page.locator('.v10-app-body > .v10-resize-handle-h').nth(handle).boundingBox())!;
      // A 1px handle: Chromium rounds a half-pixel point onto the next element.
      const x = Math.floor(box.x);
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx / 2, y, { steps: 3 });
      await page.mouse.move(x + dx, y, { steps: 3 });
      await page.mouse.up();
    };
    await drag(0, 60);
    await expect.poll(async () => (await left(page).boundingBox())!.width).toBe(300);
    await drag(1, -50);
    await expect.poll(async () => (await right(page).boundingBox())!.width).toBe(410);
    // Clamped to the limits in stores/layout.ts.
    await drag(0, 400);
    await expect.poll(async () => (await left(page).boundingBox())!.width).toBe(400);
    expect(await savedLayout(page)).toMatchObject({ leftWidth: 400, rightWidth: 410 });
    // The drag leaves no cursor or selection lock behind.
    expect(await page.evaluate(() => document.body.style.cursor + document.body.style.userSelect)).toBe('');

    // On a narrow screen the handles are hidden.
    await page.setViewportSize(NARROW);
    await sidebarButton(page).click();
    await expect(left(page)).toBeVisible();
    await expect(page.locator('.v10-app-body > .v10-resize-handle-h')).toBeHidden();
  });
});

test.describe('narrow centre content (under 560px wide)', () => {
  const tracks = (page: Page) => page.locator('.v10-dash-stats-3').evaluate(
    (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length,
  );

  test('open desktop panels can make the centre narrow, and the dashboard stacks', async ({ page }) => {
    // 1100 − 240 − 360 leaves under 560px for the centre.
    await open(page, { width: 1100, height: 900 }, { leftCollapsed: false, rightCollapsed: false, leftWidth: 240, rightWidth: 360 });
    await expect(left(page)).toBeVisible();
    await expect(right(page)).toBeVisible();
    expect((await centre(page).boundingBox())!.width).toBeLessThan(560);
    await expect(centre(page)).toHaveAttribute('data-narrow', '');
    expect(await tracks(page)).toBe(1);

    // Closing a panel gives the centre its room back.
    await agentPanelButton(page).click();
    await expect(right(page)).toBeHidden();
    expect((await centre(page).boundingBox())!.width).toBeGreaterThanOrEqual(560);
    await expect(centre(page)).not.toHaveAttribute('data-narrow');
    expect(await tracks(page)).toBe(3);
  });

  test('a small screen sets it with both panels closed', async ({ page }) => {
    await open(page, { width: 800, height: 900 });
    await expect(centre(page)).not.toHaveAttribute('data-narrow');
    await page.setViewportSize({ width: 520, height: 900 });
    await expect(centre(page)).toHaveAttribute('data-narrow', '');
    expect(await tracks(page)).toBe(1);
    // A floating drawer doesn't change the centre's width.
    await sidebarButton(page).click();
    await expect(left(page)).toBeVisible();
    await expect(centre(page)).toHaveAttribute('data-narrow', '');
  });
});
