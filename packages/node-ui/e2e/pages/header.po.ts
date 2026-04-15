import { type Page, type Locator } from '@playwright/test';
import { sel } from '../helpers/selectors.js';

export class HeaderPage {
  readonly page: Page;
  readonly root: Locator;
  readonly logo: Locator;
  readonly logoText: Locator;
  readonly version: Locator;
  readonly sidebarToggle: Locator;
  readonly agentName: Locator;
  readonly statusDot: Locator;
  readonly meta: Locator;
  readonly notifWrap: Locator;
  readonly notifBadge: Locator;
  readonly notifDropdown: Locator;
  readonly notifItems: Locator;
  readonly themeToggle: Locator;
  readonly rightPanelToggle: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.locator(sel.header.root);
    this.logo = page.locator(sel.header.logo);
    this.logoText = page.locator(sel.header.logoText);
    this.version = page.locator(sel.header.version);
    this.sidebarToggle = page.locator(sel.header.sidebarToggle);
    this.agentName = page.locator(sel.header.agentName);
    this.statusDot = page.locator(sel.header.statusDot);
    this.meta = page.locator(sel.header.meta);
    this.notifWrap = page.locator(sel.header.notifWrap);
    this.notifBadge = page.locator(sel.header.notifBadge);
    this.notifDropdown = page.locator(sel.header.notifDropdown);
    this.notifItems = page.locator(sel.header.notifItem);
    this.themeToggle = page.locator(sel.header.themeToggle);
    this.rightPanelToggle = page.locator(sel.header.rightPanelToggle);
  }

  async toggleSidebar() {
    await this.sidebarToggle.click();
  }

  async toggleTheme() {
    await this.themeToggle.click();
  }

  async toggleRightPanel() {
    await this.rightPanelToggle.click();
  }

  async openNotifications() {
    const btn = this.notifWrap.locator('button').first();
    await btn.click();
  }

  async getAgentName() {
    return this.agentName.textContent();
  }

  async getPeerCount() {
    const text = await this.meta.textContent();
    const match = text?.match(/(\d+)\s*peer/);
    return match ? parseInt(match[1], 10) : 0;
  }

  async isSynced() {
    return this.statusDot.evaluate((el) => el.classList.contains('online'));
  }

  async getUnreadCount() {
    const visible = await this.notifBadge.isVisible();
    if (!visible) return 0;
    const text = await this.notifBadge.textContent();
    return parseInt(text ?? '0', 10);
  }

  async getNotificationTexts() {
    const items = this.notifItems;
    const count = await items.count();
    const texts: string[] = [];
    for (let i = 0; i < count; i++) {
      const text = await items.nth(i).locator(sel.header.notifItemText).textContent();
      if (text) texts.push(text);
    }
    return texts;
  }

  async getThemeTitle() {
    return this.themeToggle.getAttribute('title');
  }
}
