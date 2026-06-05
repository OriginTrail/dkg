import { test, expect } from '../fixtures/rich.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { PRIMARY_CG } from '../helpers/real-node.js';

const __dir = dirname(fileURLToPath(import.meta.url));

test.describe('Import data display', () => {
  test.beforeEach(async ({ shell, leftPanel }) => {
    await shell.goto();
    await leftPanel.expandProject(PRIMARY_CG);
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
    await expect(subtitle).toContainText(PRIMARY_CG);
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
    // Scope to the import modal: a page-wide getByText(/\.md/) also matches any
    // `.md` document the shared devnet already holds (e.g. another spec's
    // import), which trips strict-mode with multiple matches. The hint lives in
    // the modal, so assert there.
    await expect(importFilesModal.overlay.getByText(/\.md|\.pdf|\.docx/i)).toBeVisible();
    await importFilesModal.cancel();
  });
});

// (Removed) "Import from dashboard quick action": the `.v10-quick-action`
// Import affordance was dropped from the dashboard in the rc.12 layout (only
// orphaned CSS for the class remains — no component renders it). The header
// Import button is the supported entry point and is covered by
// "header Import button opens import modal for active CG" above.
