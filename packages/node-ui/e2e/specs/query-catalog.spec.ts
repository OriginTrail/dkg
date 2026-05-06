import { test, expect } from '../fixtures/base.js';

// Coverage for the Query layer added in v10 PR #326. The Query layer is
// the sixth button in the project-view LayerSwitcher (`⟐ Query`) and
// renders ContextGraphQueryView, which is built around three pieces:
//   1. A built-in catalog of canned queries ("Whole graph" → All triples,
//      Graphs, Types) plus any saved-by-user catalogs.
//   2. A SPARQL textarea + Run / Save / Reset action buttons.
//   3. A results pane that flips between table / "No results" / status.
test.describe('Query Catalog (Query layer)', () => {
  test.beforeEach(async ({ shell, leftPanel, projectView, page, seed }) => {
    await shell.goto();
    await leftPanel.waitForReady();
    await leftPanel.openProject(seed.contextGraphName);
    await page.locator('.v10-layer-switcher').first().waitFor({ state: 'visible', timeout: 15_000 });
    await projectView.switchLayer('query');
    await page.locator('.v10-cg-query-view').first().waitFor({ state: 'visible', timeout: 10_000 });
  });

  test('Query layer is active and renders the Context Graph Query header', async ({ page, projectView }) => {
    expect(await projectView.getActiveLayer()).toBe('query');
    await expect(page.getByRole('heading', { name: 'Context Graph Query' })).toBeVisible();
    await expect(page.getByText(/Run SPARQL against the full context graph/)).toBeVisible();
  });

  test('built-in catalog exposes "Whole graph" with All triples / Graphs / Types', async ({ page }) => {
    const catalog = page.locator('.v10-cg-query-catalog');
    await expect(catalog).toBeVisible();
    await expect(catalog).toContainText('Query catalog');
    await expect(catalog).toContainText('Whole graph');
    // Buttons are rendered as `.v10-subgraph-savedquery` chips inside the
    // catalog row. Match by role for resilience against icon changes.
    for (const name of ['All triples', 'Graphs', 'Types']) {
      await expect(catalog.getByRole('button', { name: new RegExp(name) })).toBeVisible();
    }
  });

  test('SPARQL textarea is pre-populated with a default query', async ({ page }) => {
    const textarea = page.locator('.v10-cg-query-textarea');
    await expect(textarea).toBeVisible();
    const value = await textarea.inputValue();
    expect(value.length).toBeGreaterThan(0);
    expect(value.toUpperCase()).toContain('SELECT');
  });

  test('Run / Save / Reset action buttons are present', async ({ page }) => {
    const editor = page.locator('.v10-cg-query-editor');
    await expect(editor.getByRole('button', { name: /^Run$/ })).toBeVisible();
    await expect(editor.getByRole('button', { name: /^Save$/ })).toBeVisible();
    await expect(editor.getByRole('button', { name: /^Reset$/ })).toBeVisible();
  });

  test('clicking a built-in catalog query loads it into the textarea', async ({ page }) => {
    const textarea = page.locator('.v10-cg-query-textarea');
    const before = await textarea.inputValue();
    await page.locator('.v10-cg-query-catalog').getByRole('button', { name: /Graphs/ }).click();
    // The Graphs query is `SELECT ?g (COUNT(*) AS ?triples) WHERE { ... }`,
    // distinctly different from the default. Either the textarea now
    // contains "GROUP BY" (Graphs/Types) or it changed, but it should
    // not match the default content unchanged.
    const after = await textarea.inputValue();
    expect(after).not.toBe(before);
    expect(after.toUpperCase()).toContain('GROUP BY');
  });

  test('clicking Run executes the query and settles to a non-loading terminal state within 10s', async ({ page }) => {
    await page.locator('.v10-cg-query-editor').getByRole('button', { name: /^Run$/ }).click();
    // The view must reach a TERMINAL state — rows in a table or the
    // "No results" empty marker. An earlier version of this test also
    // accepted any visible `.v10-mlv-status` banner, but `.v10-mlv-status`
    // includes "Loading..." — meaning a query stuck loading forever
    // would pass. Match only the post-load outcomes.
    const resultsTable = page.locator('.v10-mlv-table');
    const noResults = page.getByText('No results for this query.');
    const terminal = await Promise.race([
      resultsTable.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false),
      noResults.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false),
    ]);
    expect(terminal).toBe(true);
    // Belt-and-braces: assert the loading banner is gone after the wait.
    await expect(page.getByText('Loading...', { exact: true })).toHaveCount(0);
  });

  test('clicking Save opens the save panel with Name + Description fields', async ({ page }) => {
    await page.locator('.v10-cg-query-editor').getByRole('button', { name: /^Save$/ }).click();
    const savePanel = page.locator('.v10-cg-query-save-panel');
    await expect(savePanel).toBeVisible();
    await expect(savePanel.getByText('Name', { exact: true })).toBeVisible();
    await expect(savePanel.getByText('Description', { exact: true })).toBeVisible();
    await expect(savePanel.getByRole('button', { name: 'Save query' })).toBeVisible();
    await expect(savePanel.getByRole('button', { name: 'Cancel' })).toBeVisible();
  });

  test('Cancel inside the save panel closes it without saving', async ({ page }) => {
    await page.locator('.v10-cg-query-editor').getByRole('button', { name: /^Save$/ }).click();
    const savePanel = page.locator('.v10-cg-query-save-panel');
    await expect(savePanel).toBeVisible();
    await savePanel.getByRole('button', { name: 'Cancel' }).click();
    await expect(savePanel).toBeHidden();
  });

  test('saving without a Name shows an inline error', async ({ page }) => {
    await page.locator('.v10-cg-query-editor').getByRole('button', { name: /^Save$/ }).click();
    const savePanel = page.locator('.v10-cg-query-save-panel');
    // The default firstLine-derived name is non-empty, so clear it to
    // exercise the validation branch.
    await savePanel.locator('input').first().fill('');
    await savePanel.getByRole('button', { name: 'Save query' }).click();
    await expect(page.getByText('Name is required.')).toBeVisible();
  });

  test('Reset button re-fills the textarea with the default query', async ({ page }) => {
    const textarea = page.locator('.v10-cg-query-textarea');
    const def = await textarea.inputValue();
    await textarea.fill('SELECT * WHERE { ?s ?p ?o } LIMIT 1');
    expect(await textarea.inputValue()).not.toBe(def);
    await page.locator('.v10-cg-query-editor').getByRole('button', { name: /^Reset$/ }).click();
    await expect(textarea).toHaveValue(def);
  });

  test('switching back to Overview leaves the Query view (no separate tab spawned)', async ({ projectView, centerPanel }) => {
    const tabsBefore = await centerPanel.getTabCount();
    await projectView.switchLayer('overview');
    const tabsAfter = await centerPanel.getTabCount();
    // Tab count is unchanged — switching layers only swaps the in-pane view.
    expect(tabsAfter).toBe(tabsBefore);
    expect(await projectView.getActiveLayer()).toBe('overview');
  });
});
