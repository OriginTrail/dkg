import { test, expect } from '../fixtures/base.js';

// In v10 (PR #088dbc17) the sidebar's Integrations section was rewired to
// lazy-load `/api/local-agent-integrations` once expanded and render a row
// per local-agent integration (Hermes, OpenClaw, …) with a status dot.
// The legacy Obsidian placeholder was removed at the same time.
//
// PanelLeft only mounts the IntegrationsSection when `journey.stage >= 1`.
// Stage advances are driven by CreateProjectModal (which we don't run in
// these tests because the seed creates the CG via the daemon API). So we
// pre-seed the journey-stage flag in localStorage before navigation —
// that's a UX-progress hint, not a security boundary, and pinning it
// faithfully reproduces "user has at least one project" without going
// through the modal flow.
test.describe('Sidebar Integrations (Agents)', () => {
  test.beforeEach(async ({ shell, leftPanel, page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('dkg-journey-stage', '2');
    });
    await shell.goto();
    await leftPanel.waitForReady();
    await leftPanel.expandIntegrations();
  });

  test('Integrations section header is visible', async ({ leftPanel }) => {
    await expect(leftPanel.root.getByText('Integrations', { exact: true })).toBeVisible();
  });

  test('Agents subsection label is rendered once the section is expanded', async ({ leftPanel }) => {
    await expect(leftPanel.root.getByText('Agents', { exact: true })).toBeVisible();
  });

  test('Agents subsection settles into either an integration row or the empty marker', async ({ leftPanel }) => {
    // The daemon fields /api/local-agent-integrations as soon as it's up.
    // What we render depends on what the operator has connected: any of
    // Hermes / OpenClaw rows, or the "No agents detected." italic empty.
    // Either branch is acceptable; both branches must render *something*
    // so the user is never staring at a blank Integrations panel.
    const item = leftPanel.root.locator('.v10-tree-item');
    const empty = leftPanel.root.getByText('No agents detected.');
    const someVisible = await Promise.race([
      item.first().waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false),
      empty.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false),
    ]);
    expect(someVisible).toBe(true);
  });

  test('the legacy Obsidian placeholder is gone', async ({ leftPanel }) => {
    // The v9-era sidebar shipped an "Obsidian" placeholder under the
    // Integrations section. The v10 rewrite drops it; this guards
    // against a regression that re-adds a hard-coded placeholder.
    await expect(leftPanel.root.getByText('Obsidian')).toHaveCount(0);
  });

  test('integration rows (when present) carry a coloured status dot and a label', async ({ leftPanel }) => {
    const items = leftPanel.root.locator('.v10-tree-item');
    const count = await items.count();
    test.skip(count === 0, 'No local-agent integrations connected on this run; status-dot assertion is moot.');

    // Each row's first child is the dot (rendered as an inline `<span>`
    // with a `background` style). The label sits in the middle.
    for (let i = 0; i < count; i++) {
      const row = items.nth(i);
      const dot = row.locator('span').first();
      const label = row.locator('.v10-tree-item-label');
      await expect(dot).toBeVisible();
      await expect(label).toBeVisible();
      const labelText = (await label.textContent())?.trim() ?? '';
      expect(labelText.length).toBeGreaterThan(0);
    }
  });
});
