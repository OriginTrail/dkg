import { test, expect } from '../fixtures/rich.js';
import { sel } from '../helpers/selectors.js';
import { PRIMARY_CG, NAMED_SUBGRAPH } from '../helpers/real-node.js';

// `global-setup.ts` registers + seeds the `NAMED_SUBGRAPH` sub-graph inside
// PRIMARY_CG (plus a root-bucket VM entity), so the SubGraphBar deterministically
// renders an "All" chip + at least one concrete scope chip (NAMED_SUBGRAPH, and
// "Root" when root entities are in scope) on EVERY layer page. That guarantee is what
// lets these specs assert directly instead of skipping on the degenerate
// "only All exists" case. We don't re-seed per-describe — parallel on-chain
// publishes from multiple beforeAll hooks contend on the 2-node devnet.

async function openSubgraphs(
  cg: string,
  { shell, leftPanel, projectLayer, subgraphBar }: {
    shell: { goto: () => Promise<void> };
    leftPanel: { expandProject: (n: string) => Promise<void> };
    projectLayer: { switchLayer: (l: 'Subgraphs') => Promise<void> };
    subgraphBar: { waitForBar: (t?: number) => Promise<void> };
  },
) {
  await shell.goto();
  await leftPanel.expandProject(cg);
  await projectLayer.switchLayer('Subgraphs');
  await subgraphBar.waitForBar();
}

test.describe('SubGraph bar', () => {
  test.beforeEach(async ({ shell, leftPanel, projectLayer, subgraphBar }) => {
    await openSubgraphs(PRIMARY_CG, { shell, leftPanel, projectLayer, subgraphBar });
  });

  test('renders Subgraphs label and All chip', async ({ subgraphBar }) => {
    await expect(subgraphBar.page.locator(sel.subgraph.barLabel)).toHaveText('Subgraphs');
    const labels = await subgraphBar.getChipLabels();
    expect(labels[0]).toBe('All');
  });

  test('chips expose numeric counts', async ({ subgraphBar }) => {
    const counts = await subgraphBar.getChipCounts();
    expect(counts.length).toBeGreaterThanOrEqual(1);
    expect(counts.every((c) => Number.isFinite(c))).toBe(true);
  });

  test('the seeded named sub-graph surfaces as a concrete scope chip', async ({ subgraphBar }) => {
    // global-setup seeds NAMED_SUBGRAPH into PRIMARY_CG, so its chip is always
    // present alongside "All". This is the invariant the rest of the scope tests
    // lean on — assert it explicitly so a seeding regression fails loudly here.
    //
    // The named chips derive from an async `/api/sub-graph/list` fetch, so they
    // paint a beat after the synchronously-derived "All"/"Root" chips — wait for
    // the NAMED_SUBGRAPH chip to appear rather than reading labels once.
    const namedChip = subgraphBar.bar
      .locator(sel.subgraph.chipLabel)
      .filter({ hasText: new RegExp(`^${NAMED_SUBGRAPH}$`, 'i') });
    await expect(namedChip.first()).toBeVisible({ timeout: 15_000 });
    expect(await subgraphBar.getChipLabels()).toContain('All');
  });

  test('clicking the first concrete scope chip activates it', async ({ subgraphBar }) => {
    await subgraphBar.clickFirstScopeChip();
    const active = await subgraphBar.getActiveChipLabel();
    expect(active).not.toBe('All');
    expect((active ?? '').length).toBeGreaterThan(0);
  });

  test('clicking All chip clears the sub-graph filter back to All', async ({ subgraphBar }) => {
    await subgraphBar.clickFirstScopeChip();
    await subgraphBar.clickChip('All');
    const active = await subgraphBar.getActiveChipLabel();
    expect(active).toBe('All');
  });

  test('Root chip appears when root-scope entities exist', async ({ subgraphBar }) => {
    // global-setup deterministically seeds a root-bucket VM entity (see file
    // header), so the Root chip MUST render on the Subgraphs view. Assert it
    // directly — an early-return on "no root chip" would make the test vacuous
    // and silently mask a regression where the chip fails to paint (Codex).
    // Poll the chip labels (the bar re-renders live as node events arrive) until
    // the root chip's label appears; this also closes the original two-step race.
    await expect
      .poll(async () => (await subgraphBar.getChipLabels()).map((l) => l.toLowerCase()), {
        timeout: 15_000,
      })
      .toContain('root');
  });
});

test.describe('SubGraph detail cross-layer strip', () => {
  test('detail view shows cross-layer WM → SWM → VM strip', async ({ shell, leftPanel, projectLayer, subgraphBar, page }) => {
    await openSubgraphs(PRIMARY_CG, { shell, leftPanel, projectLayer, subgraphBar });
    await subgraphBar.clickFirstScopeChip();
    const strip = page.locator(sel.subgraph.crossLayerStrip);
    await expect(strip).toBeVisible({ timeout: 15_000 });
    await expect(strip.locator(sel.subgraph.crossLayerCell).filter({ hasText: 'Working' })).toBeVisible();
    await expect(strip.locator(sel.subgraph.crossLayerCell).filter({ hasText: 'Shared' })).toBeVisible();
    await expect(strip.locator(sel.subgraph.crossLayerCell).filter({ hasText: 'Verifiable' })).toBeVisible();
  });

  test('cross-layer counts are non-negative numbers', async ({ shell, leftPanel, projectLayer, subgraphBar, page }) => {
    await openSubgraphs(PRIMARY_CG, { shell, leftPanel, projectLayer, subgraphBar });
    await subgraphBar.clickFirstScopeChip();
    const strip = page.locator(sel.subgraph.crossLayerStrip);
    await strip.waitFor({ state: 'visible', timeout: 15_000 });
    const counts = strip.locator(sel.subgraph.crossLayerCount);
    const wm = parseInt((await counts.nth(0).textContent())?.trim() ?? '0', 10);
    const swm = parseInt((await counts.nth(1).textContent())?.trim() ?? '0', 10);
    const vm = parseInt((await counts.nth(2).textContent())?.trim() ?? '0', 10);
    expect(wm).toBeGreaterThanOrEqual(0);
    expect(swm).toBeGreaterThanOrEqual(0);
    expect(vm).toBeGreaterThanOrEqual(0);
  });

  test('sub-graph detail header shows the active chip title', async ({ shell, leftPanel, projectLayer, subgraphBar, page }) => {
    await openSubgraphs(PRIMARY_CG, { shell, leftPanel, projectLayer, subgraphBar });
    await subgraphBar.clickFirstScopeChip();
    const active = (await subgraphBar.getActiveChipLabel())?.trim() ?? '';
    await expect(page.locator(sel.subgraph.detailTitle)).toContainText(active);
  });
});

test.describe('SubGraph bar on memory layer pages', () => {
  test('WM layer page includes subgraph bar', async ({ shell, leftPanel, projectLayer, subgraphBar }) => {
    await shell.goto();
    await leftPanel.expandProject(PRIMARY_CG);
    await projectLayer.switchLayer('Working Memory');
    await subgraphBar.waitForBar();
    // The named sub-graph guarantees the bar renders an "All" + concrete chip on
    // every layer (chips derive from project-wide `/api/sub-graph/list`). Poll
    // to ride out the brief mount during which chips are still painting.
    await expect
      .poll(async () => (await subgraphBar.getChipLabels()).length, { timeout: 15_000 })
      .toBeGreaterThan(0);
  });

  test('SWM layer page includes subgraph bar', async ({ shell, leftPanel, projectLayer, subgraphBar }) => {
    // Use PRIMARY_CG (devnet-test), NOT SECONDARY_CG. The SubGraphBar renders
    // `null` unless the CG has a user-facing named sub-graph OR the current
    // layer holds root-bucket entities (SubGraphBar.tsx: `merged.length === 0
    // && !showRootChip → return null`). `merged` derives from the project-wide
    // `/api/sub-graph/list`. The seeded NAMED_SUBGRAPH sub-graph lives in PRIMARY_CG,
    // so the bar deterministically renders on EVERY layer there. devnet-isolation
    // has no named sub-graph, so the bar appears only if its SWM happens to hold
    // promoted entities — and the conviction baseline's `clearAfter: true` wipes
    // exactly that. Asserting the bar against SECONDARY_CG's SWM was therefore a
    // false negative waiting to happen (the absent bar is CORRECT when there's
    // nothing to scope), not a product defect. The WM/VM siblings already use
    // PRIMARY_CG for this reason.
    await shell.goto();
    await leftPanel.expandProject(PRIMARY_CG);
    await projectLayer.switchLayer('Shared Working Memory');
    await subgraphBar.waitForBar();
    await expect(subgraphBar.bar).toBeVisible();
  });

  test('VM layer page includes subgraph bar', async ({ shell, leftPanel, projectLayer, subgraphBar }) => {
    await shell.goto();
    await leftPanel.expandProject(PRIMARY_CG);
    await projectLayer.switchLayer('Verifiable Memory');
    await subgraphBar.waitForBar();
    await expect(subgraphBar.bar).toBeVisible();
  });
});
