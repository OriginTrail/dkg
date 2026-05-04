import { test, expect } from '../fixtures/base.js';

test.describe('FilePreviewModal', () => {
  test.beforeEach(async ({ shell, leftPanel, page, seed }) => {
    await shell.goto();
    await leftPanel.waitForReady();
    await leftPanel.expandProject(seed.contextGraphName);
    await leftPanel.clickLayer(seed.contextGraphName, 'wm');
    // KNOWN BUG: file-imported assertions don't appear in the WM list-
    // assertions SPARQL view (their triples land outside the
    // did:dkg:context-graph:<cg>/assertion/<addr>/<name> graph URI). For
    // now we click the write-backed assertion `qa-seed-doc`; the modal
    // opens and we exercise its overlay/close/loading states. Once the
    // daemon bug is fixed, switch the click to `seed.fileAssertionName`.
    const link = page.locator('.v10-assertion-item-name', { hasText: seed.assertionName });
    await link.waitFor({ state: 'visible', timeout: 15_000 });
    await link.click();
  });

  test('opens with the modal overlay visible', async ({ filePreviewModal }) => {
    expect(await filePreviewModal.isOpen()).toBe(true);
  });

  test('renders the assertion name in the modal header', async ({ page, seed }) => {
    await expect(page.locator('.v10-modal-title')).toHaveText(seed.assertionName);
  });

  test('shows either metadata or an extraction-status error', async ({ page }) => {
    // Write-only assertions have no file extraction status, so the modal
    // legitimately shows an error. Either branch is acceptable; what's
    // not acceptable is the modal failing to render anything.
    const meta = page.locator('.v10-file-preview-meta-item').first();
    const err = page.locator('.v10-file-preview-error');
    const someVisible = await Promise.race([
      meta.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false),
      err.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false),
    ]);
    expect(someVisible).toBe(true);
  });

  test('close (×) button closes the modal', async ({ filePreviewModal }) => {
    await filePreviewModal.close();
    expect(await filePreviewModal.isOpen()).toBe(false);
  });
});
