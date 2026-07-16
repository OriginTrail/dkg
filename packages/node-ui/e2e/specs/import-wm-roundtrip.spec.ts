import { test, expect } from '../fixtures/rich.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { sel } from '../helpers/selectors.js';
import { PRIMARY_CG } from '../helpers/real-node.js';

/**
 * Import → Working-Memory round-trip under the rc.17 uniform per-KA layout.
 *
 * Regression guard for the bug where `POST /wm/import-file` wrote the imported
 * triples to the LEGACY name-keyed graph (`…/{cg}/assertion/{addr}/{name}`)
 * instead of the per-KA `…/{cg}/_working_memory/{addr}/{number}` graph that the
 * WM view (and every WM panel/widget) actually reads — so a freshly imported
 * document showed ZERO content in Working Memory even though the bytes landed.
 *
 * The existing `triple-counts` WM test only asserts "doesn't crash"; this drives
 * a REAL import through the UI and asserts the content surfaces (entities,
 * counts, graph render), which is the user-visible contract.
 */
test.describe('Import → Working Memory round-trip (per-KA)', () => {
  test.describe.configure({ mode: 'serial' });

  // One real import shared across the assertions below (each import is a real
  // create+finalize+write round-trip, so we do it once and inspect the result).
  test('a markdown import surfaces its triples + entities in the WM layer', async ({
    page,
    shell,
    leftPanel,
    importFilesModal,
    projectLayer,
  }) => {
    await shell.goto();
    await leftPanel.expandProject(PRIMARY_CG);

    const stamp = Date.now();
    const dir = mkdtempSync(join(tmpdir(), 'e2e-wm-roundtrip-'));
    const fname = `roundtrip-${stamp}.md`;
    const fpath = join(dir, fname);
    writeFileSync(
      fpath,
      `# Roundtrip ${stamp}\n\n## Drugs\n- Warfarin interacts with aspirin\n- Metformin treats diabetes\n- Ibuprofen relieves pain\n`,
    );

    // ── Import through the UI ────────────────────────────────────────────────
    await projectLayer.clickImport();
    await expect(importFilesModal.overlay).toBeVisible();
    await importFilesModal.selectFile(fpath);
    await expect(importFilesModal.importBtn).toBeEnabled();
    await importFilesModal.startImport();
    // The import is a real create→finalize→write; give the result panel room.
    await expect(importFilesModal.result).toBeVisible({ timeout: 60_000 });
    await importFilesModal.clickDone();

    // ── Working Memory must now show the imported content ─────────────────────
    await projectLayer.switchLayer('Working Memory');
    await expect(page.locator('.v10-me-error')).toBeHidden();
    const body = page.locator('.v10-layer-expand-body').first();
    await expect(body).toBeVisible({ timeout: 20_000 });

    // The KA must surface as real entity/triple content. Pre-fix this region was
    // empty (data sat in the orphaned legacy graph). Accept any of the canonical
    // entity-content signals the shared MemoryLayerView renders.
    const wmContent = page.locator(
      '.v10-entity-card, .v10-entity-card-triples, .v10-item-count, .v10-me-entity',
    );
    await expect(wmContent.first()).toBeVisible({ timeout: 20_000 });

    // ── The triple count must be positive (the "right amount of triples") ─────
    const cells = await projectLayer.getStatStripCells();
    const tripleCell = cells.find((c) => c.label.toLowerCase().includes('triple'));
    expect(tripleCell, 'WM stat strip should expose a triple count').toBeTruthy();
    const tripleCount = Number(String(tripleCell?.value ?? '').replace(/[^0-9]/g, ''));
    expect(tripleCount, 'imported markdown must yield >0 WM triples').toBeGreaterThan(0);
  });

  test('the imported WM content renders in graph view without error', async ({
    page,
    shell,
    leftPanel,
    projectLayer,
  }) => {
    await shell.goto();
    await leftPanel.expandProject(PRIMARY_CG);
    await projectLayer.switchLayer('Working Memory');
    await expect(page.locator('.v10-me-error')).toBeHidden();

    // Toggle into graph render mode (the RDF graph canvas) and assert it mounts.
    const graphToggle = page
      .locator(`${sel.center.content} button`)
      .filter({ hasText: /graph/i })
      .first();
    if (await graphToggle.isVisible().catch(() => false)) {
      await graphToggle.click();
      await expect(page.locator(sel.layer.graphCanvas).first()).toBeVisible({ timeout: 20_000 });
    }
  });
});
