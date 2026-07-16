import { type Page, type Locator } from '@playwright/test';
import { sel } from '../../helpers/selectors.js';

export class ImportFilesModal {
  readonly page: Page;
  readonly overlay: Locator;
  readonly box: Locator;
  readonly title: Locator;
  readonly dropzone: Locator;
  readonly fileList: Locator;
  readonly fileItems: Locator;
  readonly cancelBtn: Locator;
  readonly importBtn: Locator;
  readonly doneBtn: Locator;
  readonly result: Locator;
  readonly progress: Locator;

  constructor(page: Page) {
    this.page = page;
    this.overlay = page.locator(sel.modal.overlay);
    this.box = page.locator(sel.modal.box);
    this.title = page.locator(sel.modal.title);
    this.dropzone = page.locator(sel.importModal.dropzone);
    this.fileList = page.locator(sel.importModal.fileList);
    this.fileItems = page.locator(sel.importModal.fileItem);
    this.cancelBtn = page.locator(sel.modal.btn).filter({ hasText: 'Cancel' });
    this.importBtn = page.locator(sel.modal.btnPrimary).filter({ hasText: /Start Import/ });
    this.doneBtn = page.locator(sel.modal.btnPrimary).filter({ hasText: 'Done' });
    this.result = page.locator(sel.importModal.result);
    this.progress = page.locator(sel.importModal.progress);
  }

  async isOpen() {
    return this.overlay.isVisible();
  }

  async getFileNames() {
    const names = this.page.locator(sel.importModal.fileName);
    const count = await names.count();
    const result: string[] = [];
    for (let i = 0; i < count; i++) {
      const text = await names.nth(i).textContent();
      if (text) result.push(text.trim());
    }
    return result;
  }

  async removeFile(name: string) {
    const item = this.fileItems.filter({ hasText: name });
    await item.locator(sel.importModal.fileRemove).click();
  }

  async cancel() {
    await this.cancelBtn.click();
  }

  async closeViaOverlay() {
    await this.overlay.click({ position: { x: 5, y: 5 } });
  }

  async isImportDisabled() {
    return this.importBtn.isDisabled();
  }

  async startImport() {
    await this.importBtn.click();
  }

  async clickDone() {
    await this.doneBtn.click();
  }

  async isDropzoneVisible() {
    return this.dropzone.isVisible();
  }

  async getStatus() {
    if (await this.progress.isVisible()) return 'uploading';
    if (await this.result.isVisible()) return 'done';
    return 'idle';
  }

  async areIngestionCheckboxesDisabled() {
    const options = this.page.locator(sel.importModal.option);
    const count = await options.count();
    for (let i = 0; i < count; i++) {
      const checkbox = options.nth(i).locator('input[type="checkbox"]');
      if (!(await checkbox.isDisabled())) return false;
    }
    return true;
  }

  async selectFile(filePath: string) {
    const fileInput = this.page.locator(`${sel.modal.box} input[type="file"]`);
    await fileInput.setInputFiles(filePath);
  }
}
