import { type Page, type Locator } from '@playwright/test';
import { sel } from '../../helpers/selectors.js';

export class FilePreviewModal {
  readonly page: Page;
  readonly overlay: Locator;
  readonly box: Locator;
  readonly closeBtn: Locator;
  readonly downloadBtn: Locator;

  constructor(page: Page) {
    this.page = page;
    this.overlay = page.locator(sel.modal.overlay);
    this.box = page.locator(sel.modal.box);
    this.closeBtn = this.box.locator('button').filter({ hasText: '×' });
    this.downloadBtn = page.locator(sel.modal.btn).filter({ hasText: /[Dd]ownload/ });
  }

  async isOpen() {
    return this.overlay.isVisible();
  }

  async close() {
    await this.closeBtn.click();
  }

  async closeViaOverlay() {
    await this.overlay.click({ position: { x: 5, y: 5 } });
  }

  async hasDownloadButton() {
    return this.downloadBtn.first().isVisible();
  }
}
