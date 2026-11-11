import { type Page, type Locator } from '@playwright/test';
import { sel } from '../helpers/selectors.js';

export class CenterPanelPage {
  readonly page: Page;
  readonly root: Locator;
  readonly tabBar: Locator;
  readonly content: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.locator(sel.center.root);
    this.tabBar = page.locator(sel.center.tabs);
    this.content = page.locator(sel.center.content);
  }

  async getTabNames() {
    const tabs = this.tabBar.locator(sel.center.tab);
    const count = await tabs.count();
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      const label = await tabs.nth(i).locator(sel.center.tabLabel).textContent();
      if (label) names.push(label.trim());
    }
    return names;
  }

  async getActiveTabName() {
    const active = this.tabBar.locator(`${sel.center.tab}.active`);
    return active.locator(sel.center.tabLabel).textContent();
  }

  async switchTab(name: string) {
    await this.tabBar.locator(sel.center.tab).filter({ hasText: name }).click();
  }

  async closeTab(name: string) {
    const tab = this.tabBar.locator(sel.center.tab).filter({ hasText: name });
    await tab.locator(sel.center.tabClose).click();
  }

  async isTabClosable(name: string) {
    const tab = this.tabBar.locator(sel.center.tab).filter({ hasText: name });
    return tab.locator(sel.center.tabClose).isVisible();
  }

  async getTabCount() {
    return this.tabBar.locator(sel.center.tab).count();
  }

  async hasPlaceholder() {
    return this.page.locator(sel.center.placeholder).isVisible();
  }

  async getPlaceholderText() {
    return this.page.locator(sel.center.placeholder).textContent();
  }
}
