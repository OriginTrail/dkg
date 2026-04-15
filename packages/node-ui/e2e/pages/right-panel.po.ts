import { type Page, type Locator } from '@playwright/test';
import { sel } from '../helpers/selectors.js';

export class RightPanelPage {
  readonly page: Page;
  readonly root: Locator;
  readonly chatInput: Locator;
  readonly sendBtn: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.locator(sel.rightPanel.root).first();
    this.chatInput = page.locator(sel.rightPanel.chatInput);
    this.sendBtn = page.locator(sel.rightPanel.sendBtn).first();
  }

  async isVisible() {
    return this.root.isVisible();
  }

  async switchMode(mode: 'Agents' | 'Network' | 'Sessions') {
    await this.root.locator(sel.rightPanel.modeTab).filter({ hasText: mode }).click();
  }

  async getActiveMode() {
    return this.root.locator(`${sel.rightPanel.modeTab}.active`).textContent();
  }

  async getModeTabNames() {
    const tabs = this.root.locator(sel.rightPanel.modeTab);
    const count = await tabs.count();
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      const text = await tabs.nth(i).textContent();
      if (text) names.push(text.trim());
    }
    return names;
  }

  async getSubtabNames() {
    const tabs = this.root.locator(sel.rightPanel.subtab).filter({ hasNotText: '+' });
    const count = await tabs.count();
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      const text = await tabs.nth(i).textContent();
      if (text) names.push(text.trim());
    }
    return names;
  }

  async clickAddAgent() {
    await this.root.locator(sel.rightPanel.addBtn).click();
  }

  async typeMessage(text: string) {
    await this.chatInput.fill(text);
  }

  async sendMessage(text: string) {
    await this.chatInput.fill(text);
    await this.sendBtn.click();
  }

  async sendViaEnter(text: string) {
    await this.chatInput.fill(text);
    await this.chatInput.press('Enter');
  }

  async isSendDisabled() {
    return this.sendBtn.isDisabled();
  }

  async getMessageBubbles() {
    const bubbles = this.root.locator(sel.rightPanel.chatBubble);
    const count = await bubbles.count();
    const texts: string[] = [];
    for (let i = 0; i < count; i++) {
      const text = await bubbles.nth(i).textContent();
      if (text) texts.push(text);
    }
    return texts;
  }

  async clickConnect(name: string) {
    const card = this.root.locator(sel.rightPanel.agentCard).filter({ hasText: name });
    await card.locator(sel.rightPanel.connectBtn).click();
  }

  async clickRefresh() {
    await this.root.locator(sel.rightPanel.refreshBtn).first().click();
  }

  async getPeerCards() {
    return this.root.locator(sel.rightPanel.agentCard).count();
  }

  async getSessionCount() {
    return this.root.locator(sel.rightPanel.sessionItem).count();
  }

  async clickSession(index: number) {
    await this.root.locator(sel.rightPanel.sessionItem).nth(index).click();
  }

  async hasWarning() {
    return this.root.locator(sel.rightPanel.warning).isVisible();
  }
}
