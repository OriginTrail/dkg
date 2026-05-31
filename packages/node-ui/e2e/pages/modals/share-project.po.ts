import { type Page, type Locator } from '@playwright/test';
import { sel } from '../../helpers/selectors.js';

export class ShareProjectModal {
  readonly page: Page;
  readonly overlay: Locator;
  readonly box: Locator;
  readonly title: Locator;
  readonly doneBtn: Locator;

  constructor(page: Page) {
    this.page = page;
    this.overlay = page.locator(sel.modal.overlay);
    this.box = page.locator(sel.modal.box);
    this.title = page.locator(sel.shareModal.title);
    this.doneBtn = page.locator(sel.modal.btn).filter({ hasText: 'Done' });
  }

  async isOpen() {
    return this.overlay.isVisible();
  }

  async waitForOpen() {
    await this.overlay.waitFor({ state: 'visible' });
    await expectTitle(this.title);
  }

  async close() {
    await this.doneBtn.click();
  }

  async hasInviteSection() {
    return this.page.locator(sel.shareModal.inviteLabel).isVisible().catch(() => false);
  }

  async hasAllowedAgentsSection() {
    return this.page.locator(sel.shareModal.allowedAgents).isVisible().catch(() => false);
  }

  async hasPendingRequestsSection() {
    return this.page.locator(sel.shareModal.pendingRequests).isVisible().catch(() => false);
  }

  async openJoinRequestsTab() {
    await this.page.getByRole('button', { name: /Join Requests/i }).click();
  }

  async getInviteCodeText(): Promise<string | null> {
    const group = this.page.locator('.v10-form-group').filter({ hasText: 'Invite Code' });
    const code = group.locator('code, textarea, input, pre').first();
    if (!(await code.isVisible().catch(() => false))) return null;
    const tag = await code.evaluate((el) => el.tagName.toLowerCase());
    if (tag === 'input' || tag === 'textarea') {
      return code.inputValue();
    }
    return code.textContent();
  }
}

async function expectTitle(title: Locator) {
  await title.waitFor({ state: 'visible' });
}
