import { type Page, type Locator } from '@playwright/test';
import { sel } from '../helpers/selectors.js';

export class BottomPanelPage {
  readonly page: Page;
  readonly root: Locator;
  readonly toggleBtn: Locator;
  readonly content: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.locator(sel.bottom.root);
    this.toggleBtn = page.locator(sel.bottom.toggle);
    this.content = page.locator(sel.bottom.content);
  }

  async toggle() {
    await this.toggleBtn.click();
  }

  async isCollapsed() {
    return this.root.evaluate((el) => el.classList.contains('collapsed'));
  }

  async switchTab(name: string) {
    await this.root.locator(sel.bottom.tab).filter({ hasText: name }).click();
  }

  async getActiveTabName() {
    return this.root.locator(`${sel.bottom.tab}.active`).textContent();
  }

  async getTabNames() {
    const tabs = this.root.locator(sel.bottom.tab);
    const count = await tabs.count();
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      const text = await tabs.nth(i).textContent();
      if (text) names.push(text.trim());
    }
    return names;
  }

  async filterLogs(text: string) {
    const input = this.page.locator(sel.bottom.logFilter);
    await input.fill(text);
  }

  async getLogLines() {
    const lines = this.page.locator(sel.bottom.logLine);
    const count = await lines.count();
    const result: string[] = [];
    for (let i = 0; i < count; i++) {
      const text = await lines.nth(i).textContent();
      if (text) result.push(text);
    }
    return result;
  }

  async getLogLineCount() {
    return this.page.locator(sel.bottom.logLine).count();
  }

  async isContentVisible() {
    return this.content.isVisible();
  }
}
