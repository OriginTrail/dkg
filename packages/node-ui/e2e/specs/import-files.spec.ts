import { test, expect } from '../fixtures/base.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);

test.describe('Import Files Modal', () => {
  test.beforeEach(async ({ shell, leftPanel, importFilesModal, seed }) => {
    await shell.goto();
    await leftPanel.waitForReady();
    await leftPanel.expandProject(seed.contextGraphName);
    await leftPanel.clickLayer(seed.contextGraphName, 'import');
    await expect(importFilesModal.overlay).toBeVisible();
  });

  test('modal title is "Import to Working Memory"', async ({ importFilesModal }) => {
    await expect(importFilesModal.title).toHaveText('Import to Working Memory');
  });

  test('subtitle references the project name', async ({ page, seed }) => {
    const subtitle = page.locator('.v10-modal-subtitle');
    const text = await subtitle.textContent();
    expect(text).toContain(seed.contextGraphName);
  });

  test('dropzone area is visible', async ({ importFilesModal }) => {
    expect(await importFilesModal.isDropzoneVisible()).toBe(true);
  });

  test('Start Import button disabled with no files', async ({ importFilesModal }) => {
    expect(await importFilesModal.isImportDisabled()).toBe(true);
  });

  test('Cancel button closes the modal', async ({ importFilesModal }) => {
    await importFilesModal.cancel();
    expect(await importFilesModal.isOpen()).toBe(false);
  });

  test('clicking overlay closes the modal', async ({ importFilesModal }) => {
    await importFilesModal.closeViaOverlay();
    expect(await importFilesModal.isOpen()).toBe(false);
  });

  test('ingestion option checkboxes are disabled', async ({ importFilesModal }) => {
    expect(await importFilesModal.areIngestionCheckboxesDisabled()).toBe(true);
  });

  test('adding a file shows it in the file list', async ({ importFilesModal }) => {
    const testFile = join(__dir, '..', 'helpers', 'selectors.ts');
    await importFilesModal.selectFile(testFile);
    const names = await importFilesModal.getFileNames();
    expect(names.length).toBe(1);
    expect(names[0]).toBe('selectors.ts');
  });

  test('removing a file clears the list', async ({ importFilesModal }) => {
    const testFile = join(__dir, '..', 'helpers', 'selectors.ts');
    await importFilesModal.selectFile(testFile);
    await importFilesModal.removeFile('selectors.ts');
    const names = await importFilesModal.getFileNames();
    expect(names.length).toBe(0);
  });

  test('Start Import button enabled after adding a file', async ({ importFilesModal }) => {
    const testFile = join(__dir, '..', 'helpers', 'selectors.ts');
    await importFilesModal.selectFile(testFile);
    expect(await importFilesModal.isImportDisabled()).toBe(false);
  });

  test('supported file formats text is displayed', async ({ page }) => {
    const text = page.getByText('.md, .docx, .pdf');
    await expect(text).toBeVisible();
  });

  test('dropzone shows drag instruction text', async ({ page }) => {
    await expect(page.getByText('Drag files here, or click to browse')).toBeVisible();
  });

  test('dropzone shows extraction hint', async ({ page }) => {
    const hint = page.locator('.v10-import-dropzone-hint').first();
    await expect(hint).toBeVisible();
    const text = await hint.textContent();
    expect(text).toContain('extract structured knowledge');
  });

  test('Start Import button shows file count', async ({ page }) => {
    const btn = page.locator('.v10-modal-footer .v10-modal-btn.primary');
    const text = await btn.textContent();
    expect(text).toContain('0 files');
  });

  test('Start Import button updates count after adding file', async ({ importFilesModal, page }) => {
    const testFile = (await import('node:path')).join(
      (await import('node:url')).fileURLToPath(new URL('.', import.meta.url)),
      '..', 'helpers', 'selectors.ts'
    );
    await importFilesModal.selectFile(testFile);
    const btn = page.locator('.v10-modal-footer .v10-modal-btn.primary');
    const text = await btn.textContent();
    expect(text).toContain('1 file');
  });

  test('ingestion options show specific labels', async ({ page }) => {
    await expect(page.getByText('Store original files as Knowledge Assets')).toBeVisible();
    await expect(page.getByText('Let agent extract structured knowledge from content')).toBeVisible();
  });

  test('selecting a file shows its size next to the file name', async ({ importFilesModal, page }) => {
    const testFile = (await import('node:path')).join(
      (await import('node:url')).fileURLToPath(new URL('.', import.meta.url)),
      '..', 'helpers', 'selectors.ts'
    );
    await importFilesModal.selectFile(testFile);
    await expect(page.locator('.v10-import-file-size').first()).toBeVisible();
  });

  test('removing the only file disables Start Import again', async ({ importFilesModal, page }) => {
    const testFile = (await import('node:path')).join(
      (await import('node:url')).fileURLToPath(new URL('.', import.meta.url)),
      '..', 'helpers', 'selectors.ts'
    );
    await importFilesModal.selectFile(testFile);
    await page.locator('.v10-import-file-remove').first().click();
    const btn = page.locator('.v10-modal-footer .v10-modal-btn.primary');
    await expect(btn).toBeDisabled();
  });

  test('dropzone shows hover styling target on dragover event', async ({ page }) => {
    const dropzone = page.locator('.v10-import-dropzone');
    await dropzone.dispatchEvent('dragenter');
    await dropzone.dispatchEvent('dragover');
    await expect(dropzone).toHaveClass(/drag-over/);
    await dropzone.dispatchEvent('dragleave');
    await expect(dropzone).not.toHaveClass(/drag-over/);
  });
});
