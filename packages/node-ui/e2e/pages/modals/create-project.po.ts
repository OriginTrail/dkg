import { type Page, type Locator } from '@playwright/test';
import { sel } from '../../helpers/selectors.js';

export class CreateProjectModal {
  readonly page: Page;
  readonly overlay: Locator;
  readonly box: Locator;
  readonly title: Locator;
  readonly nameInput: Locator;
  readonly descriptionInput: Locator;
  readonly advancedToggle: Locator;
  readonly advancedBody: Locator;
  readonly cancelBtn: Locator;
  readonly submitBtn: Locator;
  readonly errorMsg: Locator;
  readonly tip: Locator;

  constructor(page: Page) {
    this.page = page;
    this.overlay = page.locator(sel.modal.overlay);
    this.box = page.locator(sel.modal.box);
    this.title = page.locator(sel.modal.title);
    this.nameInput = page.locator(sel.modal.formInput);
    this.descriptionInput = page.locator(sel.modal.formTextarea);
    this.advancedToggle = page.locator(sel.modal.advancedToggle);
    this.advancedBody = page.locator(sel.modal.advancedBody);
    this.cancelBtn = page.locator(sel.modal.btn).filter({ hasText: 'Cancel' });
    this.submitBtn = page.locator(sel.modal.btnPrimary);
    this.errorMsg = page.locator(sel.modal.error);
    this.tip = page.locator(sel.modal.tip);
  }

  async isOpen() {
    return this.overlay.isVisible();
  }

  async fill(name: string, description = '') {
    await this.nameInput.fill(name);
    if (description) {
      await this.descriptionInput.fill(description);
    }
  }

  async getNameValue() {
    return this.nameInput.inputValue();
  }

  async submit() {
    await this.submitBtn.click();
  }

  async cancel() {
    await this.cancelBtn.click();
  }

  async closeViaOverlay() {
    await this.overlay.click({ position: { x: 5, y: 5 } });
  }

  async isSubmitDisabled() {
    return this.submitBtn.isDisabled();
  }

  async toggleAdvanced() {
    await this.advancedToggle.click();
  }

  async isAdvancedVisible() {
    return this.advancedBody.isVisible();
  }

  async getDisabledSelectCount() {
    return this.page.locator(`${sel.modal.formSelect}:disabled`).count();
  }

  async getRadioGroupCount() {
    return this.page.locator(sel.modal.formRadio).count();
  }

  async hasLayerPreview() {
    return this.page.locator(sel.modal.layerPreview).isVisible();
  }

  async hasFirstProjectTip() {
    return this.tip.isVisible();
  }

  async getSubmitText() {
    return this.submitBtn.textContent();
  }
}
