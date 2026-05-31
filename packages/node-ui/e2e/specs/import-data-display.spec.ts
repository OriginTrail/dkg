import { test, expect } from '../fixtures/rich.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dir = dirname(fileURLToPath(import.meta.url));

test.describe('Import data display', () => {
  test.beforeEach(async ({ shell, leftPanel }) => {
    await shell.goto();
    await leftPanel.expandProject('Pharma Drug Interactions');
  });

  test('header Import button opens import modal for active CG', async ({ page, importFilesModal }) => {
    await page.locator('button[title*="Import"], button[aria-label*="Import"]').first().click();
    await expect(importFilesModal.overlay).toBeVisible();
    await expect(importFilesModal.title).toContainText(/Import/i);
    await importFilesModal.cancel();
  });

  test('import modal references active context graph name', async ({ page, importFilesModal }) => {
    await page.locator('button[title*="Import"], button[aria-label*="Import"]').first().click();
    const subtitle = page.locator('.v10-modal-subtitle');
    await expect(subtitle).toContainText('Pharma Drug Interactions');
    await importFilesModal.cancel();
  });

  test('adding markdown file shows filename in import list', async ({ page, importFilesModal }) => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-import-'));
    const samplePath = join(dir, 'e2e-sample.md');
    writeFileSync(samplePath, '# E2E Sample\n\nWarfarin interacts with aspirin.\n');

    await page.locator('button[title*="Import"], button[aria-label*="Import"]').first().click();
    await importFilesModal.selectFile(samplePath);
    const names = await importFilesModal.getFileNames();
    expect(names).toContain('e2e-sample.md');
    expect(await importFilesModal.isImportDisabled()).toBe(false);
    await importFilesModal.cancel();
  });

  test('import modal shows supported format hint', async ({ page, importFilesModal }) => {
    await page.locator('button[title*="Import"], button[aria-label*="Import"]').first().click();
    await expect(page.getByText(/\.md|\.pdf|\.docx/i)).toBeVisible();
    await importFilesModal.cancel();
  });
});

test.describe('Import from dashboard quick action', () => {
  test('Import quick action opens modal when present', async ({ shell, page, importFilesModal }) => {
    await shell.goto();
    const importAction = page.locator('.v10-quick-action').filter({ hasText: /Import/i });
    if ((await importAction.count()) === 0) {
      test.skip(true, 'Dashboard import quick action removed in rc.12 layout.');
    }
    await importAction.first().click();
    expect(await importFilesModal.isOpen()).toBe(true);
    await importFilesModal.cancel();
  });
});
