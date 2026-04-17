import { type Page, type Locator } from '@playwright/test';

export class ProjectViewPage {
  readonly page: Page;
  readonly root: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.locator('.v10-project-view, .v10-center-content');
  }

  async getProjectName() {
    const header = this.root.locator('.v10-pv-header h2, .v10-project-name').first();
    return header.textContent();
  }

  async clickImport() {
    await this.root.locator('button').filter({ hasText: /[Ii]mport/ }).first().click();
  }

  async clickRefresh() {
    await this.root.locator('button').filter({ hasText: '↻' }).first().click();
  }

  async switchSubTab(tab: 'Timeline' | 'Graph' | 'Knowledge') {
    await this.root.locator('button').filter({ hasText: tab }).click();
  }

  async getActiveSubTab() {
    return this.root.locator('button.active').filter({ hasText: /Timeline|Graph|Knowledge/ }).textContent();
  }

  async fillSearch(query: string) {
    const input = this.root.locator('input[type="text"]').first();
    await input.fill(query);
  }

  async hasGraphContainer() {
    return this.root.locator('canvas, .rdf-graph, svg').first().isVisible().catch(() => false);
  }

  async hasEmptyState() {
    return this.root.locator('text=/import|no.*data|empty/i').first().isVisible().catch(() => false);
  }

  async hasBackButton() {
    return this.root.locator('button').filter({ hasText: '←' }).isVisible().catch(() => false);
  }
}
