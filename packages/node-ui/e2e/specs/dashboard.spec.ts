import { test, expect } from '../fixtures/base.js';
import { PRIMARY_CG, SECONDARY_CG } from '../helpers/real-node.js';

test.describe('Dashboard (rc.12)', () => {
  test.beforeEach(async ({ shell, page }) => {
    await shell.goto();
    await page.locator('.v10-dashboard').waitFor({ state: 'visible', timeout: 10_000 });
  });

  test('renders page title "Dashboard"', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  });

  test('displays subtitle with node name and network', async ({ dashboard, page }) => {
    // The subtitle is built from the live node status (name + network). Exact
    // values are environment-specific (devnet node name / chain), so assert the
    // subtitle renders real, non-empty content rather than the old mock strings.
    await page.locator('.v10-dash-subtitle').waitFor({ state: 'visible', timeout: 10_000 });
    const text = (await dashboard.subtitle.textContent())?.trim() ?? '';
    expect(text.length).toBeGreaterThan(0);
    // The subtitle separates node name and network with a separator — both halves present.
    expect(text).toMatch(/\S+\s*[·|—-]\s*\S+/);
  });

  test('shows My Context Graphs stat card', async ({ page }) => {
    await expect(page.locator('.stat-label').filter({ hasText: 'My Context Graphs' })).toBeVisible();
  });

  test('shows Context Graph Size stat card', async ({ page }) => {
    await expect(page.locator('.stat-label').filter({ hasText: 'Context Graph Size' })).toBeVisible();
  });

  test('sidebar lists seeded context graphs under My Context Graphs', async ({ leftPanel }) => {
    const names = await leftPanel.getProjectNames();
    expect(names.length).toBeGreaterThanOrEqual(2);
    expect(names).toContain(PRIMARY_CG);
  });

  test('clicking sidebar CG opens project tab', async ({ leftPanel, centerPanel }) => {
    await leftPanel.expandProject(PRIMARY_CG);
    const tabs = await centerPanel.getTabNames();
    expect(tabs.some((t) => t.includes(PRIMARY_CG))).toBe(true);
  });

  test('New Context Graph button opens create modal', async ({ leftPanel, createProjectModal }) => {
    await leftPanel.clickNewProject();
    expect(await createProjectModal.isOpen()).toBe(true);
    await createProjectModal.cancel();
  });

  test('spending section shows TRAC label from live node economics', async ({ page }) => {
    await expect(page.getByText('TRAC').first()).toBeVisible({ timeout: 10_000 });
  });

  // ── Greedy content assertions ──────────────────────────────────────────────
  // The dashboard summarises real, seeded node state. These assert the actual
  // rendered numbers/rows rather than just "a label exists", so a regression
  // that blanks a table or mis-wires a count fails loudly.

  test('renders exactly the three rc.12 stat cards', async ({ dashboard }) => {
    const labels = (await dashboard.getStatCards()).map((s) => s.label);
    expect(labels).toEqual(['My Context Graphs', 'Context Graph Size', 'Collaborating Agents']);
  });

  test('"My Context Graphs" stat value equals the number of CG rows', async ({ dashboard }) => {
    await dashboard.waitForCgRowsLoaded();
    const rowCount = await dashboard.cgRows.count();
    expect(rowCount).toBeGreaterThanOrEqual(2);
    const stat = (await dashboard.getStatCards()).find((s) => s.label === 'My Context Graphs');
    expect(stat?.value.trim()).toBe(String(rowCount));
  });

  test('CG rows list the seeded graphs, each with an entities·triples size and a role', async ({ dashboard }) => {
    await dashboard.waitForCgRowsLoaded();
    const names = await dashboard.getCgNames();
    expect(names).toContain(PRIMARY_CG);
    expect(names).toContain(SECONDARY_CG);
    const count = await dashboard.cgRows.count();
    for (let i = 0; i < count; i++) {
      const row = dashboard.cgRows.nth(i);
      const text = (await row.textContent())?.replace(/\s+/g, ' ') ?? '';
      expect(text, `row ${i} should show an entities·triples size`).toMatch(/\d+ entities · \d+ triples/);
      // Each row carries a role badge — CURATOR (this node created it) or JOINED
      // (member). Which one depends on identity resolution, so assert the badge
      // exists and reads one of the two valid labels rather than a fixed value.
      const badge = (await row.locator('.v10-cg-role .v10-cg-badge, .v10-cg-badge').first().textContent())?.trim();
      expect(badge, `row ${i} should show a role badge`).toMatch(/^(CURATOR|JOINED)$/);
    }
  });

  test('the seeded primary CG reports a non-zero size (global-setup published into it)', async ({ dashboard }) => {
    await dashboard.waitForCgRowsLoaded();
    const row = dashboard.cgRows.filter({ hasText: PRIMARY_CG }).first();
    const text = (await row.textContent())?.replace(/\s+/g, ' ') ?? '';
    const entities = Number(text.match(/(\d+) entities/)?.[1] ?? '0');
    const triples = Number(text.match(/(\d+) triples/)?.[1] ?? '0');
    expect(entities).toBeGreaterThan(0);
    expect(triples).toBeGreaterThanOrEqual(entities);
  });

  test('wallets table lists node wallets with TRAC and gas balances', async ({ page }) => {
    const addrs = page.locator('.v10-ws-wtable .v10-ws-addr');
    await expect(addrs.first()).toBeVisible({ timeout: 10_000 });
    expect(await addrs.count()).toBeGreaterThanOrEqual(1);
    // Primary TRAC + secondary gas balance both render numeric values.
    const trac = (await page.locator('.v10-ws-wtable .v10-ws-bal').first().textContent())?.trim() ?? '';
    const gas = (await page.locator('.v10-ws-wtable .v10-ws-bal-sec').first().textContent())?.trim() ?? '';
    expect(trac).toMatch(/[\d,]+(\.\d+)?/);
    expect(gas).toMatch(/[\d,]+(\.\d+)?/);
  });

  test('spending table breaks down 24h / 7d / 30d windows', async ({ dashboard }) => {
    await expect(dashboard.spendingTable).toBeVisible();
    const text = (await dashboard.spendingTable.textContent())?.replace(/\s+/g, ' ') ?? '';
    expect(text).toContain('Last 24h');
    expect(text).toContain('Last 7d');
    expect(text).toContain('Last 30d');
    // One row per time window.
    expect(await dashboard.spendingTable.locator('.v10-ws-spend-row').count()).toBe(3);
  });

  test('chain row reports the active blockchain', async ({ dashboard }) => {
    await expect(dashboard.chainRow).toBeVisible();
    const value = (await dashboard.chainRow.locator('.v10-ws-chain-value').textContent())?.trim() ?? '';
    expect(value.length).toBeGreaterThan(0);
    // Devnet is hardhat chain 31337; never the empty/placeholder.
    expect(value).toMatch(/Chain\s+\d+|Hardhat|Local|Base|Sepolia|Ethereum/i);
  });

  test('Context Graph Size card shows entities, triples and a WM/SWM/VM layer bar', async ({ page }) => {
    const card = page.locator('.stat-card').filter({ hasText: 'Context Graph Size' });
    await expect(card).toBeVisible();
    const nums = card.locator('.v10-cg-size-num');
    // The card body (counts + layer bar) hydrates from an async aggregate query;
    // wait for the first metric to render before asserting structure.
    await expect(nums.first()).toBeVisible({ timeout: 15_000 });
    expect(await nums.count()).toBeGreaterThanOrEqual(2);
    for (const layer of ['WM', 'SWM', 'VM']) {
      await expect(card.getByText(layer, { exact: true })).toBeVisible();
    }
    // Each size metric (entities + triples) renders ONE WM/SWM/VM proportion bar,
    // and `LayerBar` emits ONE segment per NON-ZERO layer (`pct <= 0` segments are
    // skipped) — so a populated bar has 1–3 segments, NOT a fixed multiple of 3
    // (the old `% 3 === 0` check was simply wrong: the VM-only seed leaves WM/SWM
    // empty, yielding a single VM segment). Scope to the size metrics so the
    // curator/joined RoleBar in the sibling "My Context Graphs" card — which
    // reuses `.v10-layerbar-seg` — can't bleed in. Assert the real invariant:
    // ≥1 metric bar exists, no bar exceeds three layer segments, and at least one
    // bar is populated (the seeded fixture guarantees a non-zero layer).
    const bars = card.locator('.v10-cg-size-metric .v10-layerbar');
    await expect(bars.first()).toBeVisible({ timeout: 15_000 });
    const barCount = await bars.count();
    expect(barCount).toBeGreaterThanOrEqual(1);
    let populatedBars = 0;
    for (let i = 0; i < barCount; i++) {
      const segCount = await bars.nth(i).locator('.v10-layerbar-seg').count();
      expect(segCount, 'a WM/SWM/VM bar has at most one segment per layer').toBeLessThanOrEqual(3);
      if (segCount > 0) populatedBars++;
    }
    expect(populatedBars, 'the seeded CG must render at least one populated layer bar').toBeGreaterThanOrEqual(1);
  });
});
