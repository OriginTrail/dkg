import { type Page, type Locator } from '@playwright/test';
import { sel } from '../../helpers/selectors.js';

export class JoinProjectModal {
  readonly page: Page;
  readonly overlay: Locator;
  readonly box: Locator;
  readonly title: Locator;
  readonly subtitle: Locator;
  readonly inviteInput: Locator;
  readonly cancelBtn: Locator;
  readonly joinBtn: Locator;
  readonly error: Locator;
  readonly tip: Locator;
  readonly accessDeniedSendBtn: Locator;

  constructor(page: Page) {
    this.page = page;
    this.overlay = page.locator(sel.modal.overlay);
    this.box = page.locator(sel.modal.box).filter({ has: page.getByText('Join a Project') });
    this.title = this.box.locator(sel.modal.title);
    this.subtitle = this.box.locator(sel.modal.subtitle);
    this.inviteInput = this.box.locator(sel.modal.formTextarea);
    this.cancelBtn = this.box.getByRole('button', { name: 'Cancel' });
    this.joinBtn = this.box.getByRole('button', { name: /Join Project|Joining|Subscribing|Connecting|Syncing|Refreshing|Joined/ });
    this.error = this.box.locator(sel.modal.error);
    this.tip = this.box.locator(sel.modal.tip);
    this.accessDeniedSendBtn = this.box.getByRole('button', { name: /Send Join Request|Signing/ });
  }

  async isOpen() {
    return this.box.isVisible();
  }

  async fillInvite(text: string) {
    await this.inviteInput.fill(text);
  }

  async clickJoin() {
    await this.joinBtn.click();
  }

  async clickCancel() {
    await this.cancelBtn.click();
  }

  async closeViaOverlay() {
    // Click directly on the overlay element (not on its modal-box child).
    // The modal handler checks `e.target === e.currentTarget` so the click
    // must register on the overlay itself.
    await this.overlay.first().click({ position: { x: 5, y: 5 } });
  }
}
