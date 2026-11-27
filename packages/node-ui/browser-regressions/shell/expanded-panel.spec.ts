import { test, expect, type Page } from '@playwright/test';
import { mockQuietNode } from './mock-node.js';

/**
 * The expanded agents panel in a real browser: it covers the centre with flex
 * sizing, and going anywhere brings the centre back. Sizes, `display: none`
 * and the 860px breakpoint can't be checked in happy-dom.
 */

const NARROW = { width: 800, height: 900 };
const DESKTOP = { width: 1400, height: 900 };
const SAVED = { leftCollapsed: false, rightCollapsed: false, leftWidth: 240, rightWidth: 360 };

const left = (page: Page) => page.locator('.v10-app-body > .v10-panel-left');
const right = (page: Page) => page.locator('.v10-app-body > .v10-panel-right');
const centreRegion = (page: Page) => page.locator('.v10-center-region');
const scrim = (page: Page) => page.locator('.v10-panel-scrim');
const expandButton = (page: Page) => right(page).getByRole('button', { name: 'Expand agents panel' });
const collapseButton = (page: Page) => right(page).getByRole('button', { name: 'Collapse agents panel' });
const agentPanelButton = (page: Page) => page.getByTitle('Toggle agent panel');
const activeObservabilityTab = (page: Page) => page.locator('.tab-group .ds-tab.active');

async function open(page: Page, viewport: { width: number; height: number }, path = '/ui/') {
  await page.setViewportSize(viewport);
  await page.addInitScript((layout) => {
    if (!sessionStorage.getItem('layout-seeded')) {
      localStorage.setItem('dkg-layout', JSON.stringify(layout));
      sessionStorage.setItem('layout-seeded', '1');
    }
  }, SAVED);
  await page.goto(path);
  await expect(page.locator('.v10-app')).toBeVisible();
  await expect(right(page)).toBeVisible();
}

async function expectExpanded(page: Page) {
  await expect(collapseButton(page)).toBeVisible();
  await expect(centreRegion(page)).toBeHidden();
  // The panel takes the space the centre gave up: everything right of the sidebar.
  const panel = (await right(page).boundingBox())!;
  const sidebar = (await left(page).boundingBox())!;
  expect(panel.width).toBeGreaterThan(DESKTOP.width - sidebar.width - 20);
  // No resize handle beside a panel that fills the space.
  await expect(page.locator('.v10-app-body > .v10-resize-handle-h')).toHaveCount(1);
}

async function expectCentreBack(page: Page) {
  await expect(expandButton(page)).toBeVisible();
  await expect(centreRegion(page)).toBeVisible();
  expect((await right(page).boundingBox())!.width).toBe(SAVED.rightWidth);
}

test.beforeEach(async ({ page }) => { await mockQuietNode(page); });

test.describe('expanded agents panel', () => {
  test('expanding covers the centre, and going somewhere brings it back at the saved width', async ({ page }) => {
    await open(page, DESKTOP);
    await expandButton(page).click();
    await expectExpanded(page);

    await left(page).getByRole('button', { name: /^Settings$/ }).click();
    await expect(page).toHaveURL(/\/ui\/settings$/);
    await expectCentreBack(page);
  });

  test('choosing the tab already open brings the centre back', async ({ page }) => {
    await open(page, DESKTOP);
    await expandButton(page).click();
    await expectExpanded(page);
    await left(page).getByRole('button', { name: /^Dashboard$/ }).click();
    await expect(page).toHaveURL(/\/ui\/$/);
    await expectCentreBack(page);
  });

  test('the collapse control brings the centre back', async ({ page }) => {
    await open(page, DESKTOP);
    await expandButton(page).click();
    await expectExpanded(page);
    await collapseButton(page).click();
    await expectCentreBack(page);
  });

  test('Details, then Back and Forward between Observability tabs, always show the page', async ({ page }) => {
    await open(page, DESKTOP, '/ui/observability?tab=logs');
    await expect(activeObservabilityTab(page)).toHaveText('Logs');

    await right(page).getByRole('button', { name: 'Network', exact: true }).click();
    await expandButton(page).click();
    await expectExpanded(page);
    await right(page).getByRole('button', { name: 'Connection details' }).click();
    await expect(page).toHaveURL(/\/ui\/observability\?tab=network$/);
    await expectCentreBack(page);
    await expect(activeObservabilityTab(page)).toHaveText('Network');

    await expandButton(page).click();
    await expectExpanded(page);
    await page.goBack();
    await expect(page).toHaveURL(/\/ui\/observability\?tab=logs$/);
    await expectCentreBack(page);
    await expect(activeObservabilityTab(page)).toHaveText('Logs');

    await expandButton(page).click();
    await expectExpanded(page);
    await page.goForward();
    await expect(page).toHaveURL(/\/ui\/observability\?tab=network$/);
    await expectCentreBack(page);
    await expect(activeObservabilityTab(page)).toHaveText('Network');
  });

  test('crossing to a narrow screen shows the page, the panel floats with a scrim, and widening restores the saved layout', async ({ page }) => {
    await open(page, DESKTOP);
    await expandButton(page).click();
    await expectExpanded(page);

    await page.setViewportSize(NARROW);
    await expect(centreRegion(page)).toBeVisible();
    await expect(right(page)).toBeHidden();

    await agentPanelButton(page).click();
    await expect(right(page)).toBeVisible();
    await expect(scrim(page)).toBeVisible();
    expect(await right(page).evaluate((el) => getComputedStyle(el).position)).toBe('absolute');
    // A floating panel is never the expanded one, so the centre stays rendered beneath it.
    await expect(centreRegion(page)).toBeVisible();
    const scrimBox = (await scrim(page).boundingBox())!;
    await scrim(page).click({ position: { x: 10, y: scrimBox.height / 2 } });
    await expect(right(page)).toBeHidden();

    await page.setViewportSize(DESKTOP);
    await expect(left(page)).toBeVisible();
    await expect(right(page)).toBeVisible();
    await expectCentreBack(page);
    expect((await left(page).boundingBox())!.width).toBe(SAVED.leftWidth);
  });
});
