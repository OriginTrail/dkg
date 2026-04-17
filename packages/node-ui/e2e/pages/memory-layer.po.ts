import { type Page, type Locator } from '@playwright/test';

export class MemoryLayerPage {
  readonly page: Page;
  readonly root: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.locator('.v10-center-content');
  }

  async getSparqlInput() {
    return this.root.locator('input[type="text"]').first();
  }

  async fillSparql(query: string) {
    const input = await this.getSparqlInput();
    await input.fill(query);
  }

  async clickRun() {
    await this.root.locator('button').filter({ hasText: 'Run' }).click();
  }

  async clickReset() {
    await this.root.locator('button').filter({ hasText: 'Reset' }).click();
  }

  async isResetVisible() {
    return this.root.locator('button').filter({ hasText: 'Reset' }).isVisible().catch(() => false);
  }

  async switchViewMode(mode: 'table' | 'graph') {
    const labels = { table: /table|list/i, graph: /graph/i };
    await this.root.locator('button').filter({ hasText: labels[mode] }).click();
  }

  async getPromoteAllButton() {
    return this.root.locator('button').filter({ hasText: /Promote All/i });
  }

  async hasPromoteAllButton() {
    return (await this.getPromoteAllButton()).isVisible().catch(() => false);
  }

  async getPublishAllButton() {
    return this.root.locator('button').filter({ hasText: /Publish All/i });
  }

  async hasPublishAllButton() {
    return (await this.getPublishAllButton()).isVisible().catch(() => false);
  }

  async getSelectAllCheckbox() {
    return this.root.locator('label').filter({ hasText: /Select all/i }).locator('input[type="checkbox"]');
  }

  async getPublishSelectedButton() {
    return this.root.locator('button').filter({ hasText: /Publish.*selected/i });
  }

  async hasPublishSelectedButton() {
    return (await this.getPublishSelectedButton()).isVisible().catch(() => false);
  }

  async getAssertionNames() {
    const items = this.root.locator('button').filter({ hasText: /\./ });
    const count = await items.count();
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      const text = await items.nth(i).textContent();
      if (text) names.push(text.trim());
    }
    return names;
  }

  async hasRefreshButton() {
    return this.root.locator('button').filter({ hasText: '↻' }).isVisible().catch(() => false);
  }
}
