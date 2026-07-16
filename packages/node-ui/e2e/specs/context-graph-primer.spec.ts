import { type Page } from '@playwright/test';
import { test, expect } from '../fixtures/rich.js';
import { PRIMARY_CG } from '../helpers/real-node.js';

/**
 * Context Graph Primer (views/ContextGraphPrimerView.tsx). A reachable but
 * previously untested surface: it opens as its own closable centre tab either
 * by deep-linking `/ui/context-graph-primer` (ContextGraphPrimerRoute opens the
 * tab then redirects to `/`) or via the two "What is a Context Graph?" links in
 * a project overview (the identity-row link + the footer "New here?" escape
 * hatch). The view is static copy, so its content is fully deterministic and a
 * great target for exact assertions — a regression to the headings, the
 * WM→SWM→VM pipeline, or the section list fails loudly here.
 */
const PRIMER_SECTIONS = [
  'Memory layers',
  'Subgraphs',
  'Entities and Knowledge Assets',
  'Assertions',
  'Roles',
];

const PRIMER_TAB = 'What is a Context Graph?';

async function expectPrimerRendered(page: Page) {
  const view = page.locator('.v10-primer-view');
  await expect(view).toBeVisible({ timeout: 15_000 });

  await expect(view.locator('.v10-primer-kicker')).toHaveText('Context Graph Primer');
  await expect(view.getByRole('heading', { level: 1, name: 'What is a Context Graph?' })).toBeVisible();

  // The WM → SWM → VM pipeline must render in lifecycle order.
  const pipeline = view.locator('.v10-primer-pipeline');
  await expect(pipeline.locator('.wm')).toHaveText('Working Memory');
  await expect(pipeline.locator('.swm')).toHaveText('Shared Working Memory');
  await expect(pipeline.locator('.vm')).toHaveText('Verifiable Memory');

  // Exactly the five primer sections, in order — the headings are the structural
  // contract worth pinning.
  const headings = view.locator('.v10-primer-section h2');
  await expect(headings).toHaveCount(PRIMER_SECTIONS.length);
  expect((await headings.allInnerTexts()).map((t) => t.trim())).toEqual(PRIMER_SECTIONS);

  // Each section must render a non-trivial body, but DON'T pin the exact <p>
  // count: a harmless copy edit that splits one section into two paragraphs is
  // not a behavioral regression. Assert per-section that the combined paragraph
  // text is substantial instead.
  const sections = view.locator('.v10-primer-section');
  await expect(sections).toHaveCount(PRIMER_SECTIONS.length);
  for (let i = 0; i < PRIMER_SECTIONS.length; i++) {
    const bodyText = (await sections.nth(i).locator('p').allInnerTexts()).join(' ').trim();
    expect(
      bodyText.length,
      `primer section "${PRIMER_SECTIONS[i]}" must render body copy`,
    ).toBeGreaterThan(20);
  }
}

test.describe('Context Graph Primer', () => {
  test('deep-linking /context-graph-primer opens a closable primer tab and renders it', async ({ page, shell, centerPanel }) => {
    await page.goto('context-graph-primer', { waitUntil: 'domcontentloaded' });
    await shell.root.waitFor({ state: 'visible' });

    await expectPrimerRendered(page);
    expect(await centerPanel.getTabNames()).toContain(PRIMER_TAB);
    expect((await centerPanel.getActiveTabName())?.trim()).toBe(PRIMER_TAB);
    expect(await centerPanel.isTabClosable(PRIMER_TAB)).toBe(true);

    // ContextGraphPrimerRoute redirects to "/" after opening the tab, so the URL
    // must NOT stay pinned on the primer path (a refresh shouldn't re-stomp it).
    expect(new URL(page.url()).pathname).not.toContain('context-graph-primer');
  });

  test('the project-overview identity-row link opens the primer', async ({ shell, leftPanel, page, centerPanel }) => {
    await shell.goto();
    await leftPanel.expandProject(PRIMARY_CG);

    const link = page.locator('.v10-po-identity-primer').first();
    await expect(link).toBeVisible({ timeout: 15_000 });
    await expect(link).toHaveText('What is a Context Graph?');
    await link.click();

    await expectPrimerRendered(page);
    expect((await centerPanel.getActiveTabName())?.trim()).toBe(PRIMER_TAB);
  });

  test('the overview footer "New here?" escape hatch opens the primer', async ({ shell, leftPanel, page }) => {
    await shell.goto();
    await leftPanel.expandProject(PRIMARY_CG);

    const footer = page.locator('.v10-po-primer-footer').first();
    await expect(footer).toBeVisible({ timeout: 15_000 });
    await expect(footer.locator('.v10-po-primer-footer-lede')).toHaveText('New here?');
    await footer.locator('.v10-po-primer-footer-link').click();

    await expectPrimerRendered(page);
  });

  test('the primer tab can be closed again', async ({ page, shell, centerPanel }) => {
    await page.goto('context-graph-primer', { waitUntil: 'domcontentloaded' });
    await shell.root.waitFor({ state: 'visible' });
    await expect(page.locator('.v10-primer-view')).toBeVisible({ timeout: 15_000 });

    await centerPanel.closeTab(PRIMER_TAB);
    expect(await centerPanel.getTabNames()).not.toContain(PRIMER_TAB);
  });
});
