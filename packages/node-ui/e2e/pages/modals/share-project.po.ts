import { type Page, type Locator } from '@playwright/test';
import { sel } from '../../helpers/selectors.js';

export class ShareProjectModal {
  readonly page: Page;
  readonly box: Locator;
  readonly title: Locator;
  readonly allowlistTab: Locator;
  readonly requestsTab: Locator;
  readonly addAgentInput: Locator;
  readonly addAgentBtn: Locator;
  readonly copyInviteBtn: Locator;
  readonly doneBtn: Locator;

  constructor(page: Page) {
    this.page = page;
    this.box = page.locator(sel.modal.box).filter({ hasText: 'Invite Code' });
    this.title = this.box.locator(sel.modal.title);
    this.allowlistTab = this.box.getByRole('button', { name: /Allowlist/ });
    this.requestsTab = this.box.getByRole('button', { name: /Join Requests/ });
    this.addAgentInput = this.box.locator('input[placeholder^="0x"]');
    this.addAgentBtn = this.box.getByRole('button', { name: /Add Agent|Adding/ });
    // V10 button label is conditional on `inviteReady` (peerId known AND at
    // least one remotely-dialable multiaddr advertised). In an isolated test
    // daemon all multiaddrs are 127.0.0.1 / RFC1918, so `inviteReady === false`
    // and the button reads "Copy Project ID". When the daemon does have a
    // public-dialable addr the label flips to "Copy Invite". After click the
    // label transitions to "Copied" for 2 s in either case. See
    // ShareProjectModal.tsx ~line 447: `inviteReady ? 'Copy Invite' : 'Copy Project ID'`.
    this.copyInviteBtn = this.box.getByRole('button', { name: /Copy Invite|Copy Project ID|Copied/ });
    this.doneBtn = this.box.getByRole('button', { name: 'Done' });
  }

  async isOpen() {
    return this.box.isVisible();
  }

  async switchToRequests() {
    await this.requestsTab.click();
  }

  async switchToAllowlist() {
    await this.allowlistTab.click();
  }

  async fillAddress(addr: string) {
    await this.addAgentInput.fill(addr);
  }

  async clickAdd() {
    await this.addAgentBtn.click();
  }

  async clickCopy() {
    await this.copyInviteBtn.click();
  }

  async close() {
    await this.doneBtn.click();
  }
}
