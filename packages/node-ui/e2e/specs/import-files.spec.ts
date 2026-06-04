import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);

// rc11 entry-point change:
//   * The legacy spec opened the modal via
//     `leftPanel.expandProject(...) → leftPanel.clickLayer(..., 'import')`
//     against a demo fixture CG.
//   * Both the inline "expand a project to see its layers" gesture and
//     the demo fixture are gone. The modal is now reached from inside
//     the project view, via the LayerSwitcher's
//     `aria-label="Import into Context Graph"` action button.
// Discovery flow is mirrored from tab-management.spec — pick the first
// CG that the seeded devnet exposes, click its sidebar header to open
// a project tab, then trigger Import.

async function discoverProjectName(leftPanel: any, page: Page): Promise<string> {
  await expect(async () => {
    const names = await leftPanel.getProjectNames();
    expect(names.length).toBeGreaterThan(0);
  }).toPass({ timeout: 12_000, intervals: [250, 500, 1000] });
  const names = await leftPanel.getProjectNames();
  return names[0]!;
}

async function openProjectTab(page: Page, name: string) {
  await page
    .locator('.v10-panel-left')
    .first()
    .locator('.v10-tree-section-header')
    .filter({ hasText: name })
    .first()
    .click();
}

async function openImportModal(page: Page) {
  // Layer switcher renders inside the active project view. Wait for
  // it before clicking — the project tab content lazy-loads.
  const importBtn = page.locator('button[aria-label="Import into Context Graph"]');
  await expect(importBtn).toBeVisible({ timeout: 10_000 });
  await importBtn.click();
}

test.describe('Import Files Modal', () => {
  let projectName: string;

  test.beforeEach(async ({ shell, leftPanel, page, importFilesModal }) => {
    await shell.goto();
    projectName = await discoverProjectName(leftPanel, page);
    await openProjectTab(page, projectName);
    await openImportModal(page);
    await expect(importFilesModal.overlay).toBeVisible();
  });

  test('modal title is "Import to Working Memory"', async ({ importFilesModal }) => {
    await expect(importFilesModal.title).toHaveText('Import to Working Memory');
  });

  test('subtitle references the active context-graph name', async ({ page }) => {
    const subtitle = page.locator('.v10-modal-subtitle');
    await expect(subtitle).toBeVisible();
    const text = (await subtitle.textContent()) ?? '';
    expect(text).toContain(projectName);
  });

  test('dropzone area is visible', async ({ importFilesModal }) => {
    expect(await importFilesModal.isDropzoneVisible()).toBe(true);
  });

  test('Start Import button is disabled with no files', async ({ importFilesModal }) => {
    expect(await importFilesModal.isImportDisabled()).toBe(true);
  });

  test('Cancel button closes the modal', async ({ importFilesModal }) => {
    await importFilesModal.cancel();
    expect(await importFilesModal.isOpen()).toBe(false);
  });

  test('clicking the overlay closes the modal', async ({ importFilesModal }) => {
    await importFilesModal.closeViaOverlay();
    expect(await importFilesModal.isOpen()).toBe(false);
  });

  // Regression for #959: the Import modal hand-rolled its overlay and only
  // got backdrop-click dismissal — Esc did nothing, unlike Create/Join.
  // Now it uses the shared `useModalDismiss` hook, so Esc closes it too.
  test('Escape key closes the modal (#959)', async ({ importFilesModal, page }) => {
    await page.keyboard.press('Escape');
    await expect(importFilesModal.overlay).toBeHidden();
  });

  // The shared hook also adds a header × close button (the modal had only
  // a footer Cancel before).
  test('header × button closes the modal (#959)', async ({ importFilesModal }) => {
    // Scope to the modal overlay — a bare `.v10-modal-close` is global and
    // would match any other dialog/popover present on the page (Codex review).
    await importFilesModal.overlay.locator('.v10-modal-close').click();
    await expect(importFilesModal.overlay).toBeHidden();
  });

  test('ingestion option checkboxes are disabled (coming-soon stub)', async ({ importFilesModal }) => {
    expect(await importFilesModal.areIngestionCheckboxesDisabled()).toBe(true);
  });

  test('adding a file shows it in the file list', async ({ importFilesModal }) => {
    const testFile = join(__dir, '..', 'helpers', 'selectors.ts');
    await importFilesModal.selectFile(testFile);
    const names = await importFilesModal.getFileNames();
    expect(names).toEqual(['selectors.ts']);
  });

  test('removing a file clears the list', async ({ importFilesModal }) => {
    const testFile = join(__dir, '..', 'helpers', 'selectors.ts');
    await importFilesModal.selectFile(testFile);
    await importFilesModal.removeFile('selectors.ts');
    const names = await importFilesModal.getFileNames();
    expect(names).toEqual([]);
  });

  test('Start Import button is enabled after adding a file', async ({ importFilesModal }) => {
    const testFile = join(__dir, '..', 'helpers', 'selectors.ts');
    await importFilesModal.selectFile(testFile);
    expect(await importFilesModal.isImportDisabled()).toBe(false);
  });

  test('dropzone shows the supported-format hint', async ({ page }) => {
    // The hint text was reformatted in rc11 to include the leading
    // "Supported:" prefix — assert against a substring that's stable
    // across both the legacy (`.md, .docx, .pdf`) and rc11 surface.
    await expect(page.getByText(/\.md/)).toBeVisible();
  });

  test('dropzone shows the drag instruction', async ({ page }) => {
    await expect(page.getByText('Drag files here, or click to browse')).toBeVisible();
  });

  test('dropzone shows the extraction hint', async ({ page }) => {
    const hint = page.locator('.v10-import-dropzone-hint').first();
    await expect(hint).toBeVisible();
    const text = (await hint.textContent()) ?? '';
    expect(text.toLowerCase()).toContain('extract structured knowledge');
  });

  test('Start Import button initially shows the "0 files" count', async ({ page }) => {
    const btn = page.locator('.v10-modal-footer .v10-modal-btn.primary');
    const text = (await btn.textContent()) ?? '';
    expect(text).toContain('0 files');
  });

  test('Start Import count updates after adding a file', async ({ importFilesModal, page }) => {
    const testFile = join(__dir, '..', 'helpers', 'selectors.ts');
    await importFilesModal.selectFile(testFile);
    const btn = page.locator('.v10-modal-footer .v10-modal-btn.primary');
    const text = (await btn.textContent()) ?? '';
    expect(text).toContain('1 file');
  });

  test('ingestion options surface the documented labels', async ({ page }) => {
    await expect(page.getByText('Store original files as Knowledge Assets')).toBeVisible();
    await expect(page.getByText('Let agent extract structured knowledge from content')).toBeVisible();
  });

  test('LayerSwitcher Import action is idempotent (close + reopen)', async ({ page, importFilesModal }) => {
    // Re-entry contract: closing the modal and clicking the same
    // LayerSwitcher action re-opens it. Guards against the action
    // regressing into a one-shot button (e.g. an effect that hides
    // the button after first use, or a stale `open` state).
    await importFilesModal.cancel();
    await expect(importFilesModal.overlay).toBeHidden();

    await openImportModal(page);
    await expect(importFilesModal.overlay).toBeVisible();
  });
});
