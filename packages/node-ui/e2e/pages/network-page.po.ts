import { type Page, type Locator } from '@playwright/test';

export class NetworkPagePO {
  readonly page: Page;
  readonly root: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.locator('.page-container, .network-page, body');
  }

  async goto() {
    await this.page.goto('/network');
    await this.page.locator('.page-title, h1').first().waitFor({ state: 'visible', timeout: 10_000 });
  }

  async getTitle() {
    return this.page.locator('.page-title, h1').first().textContent();
  }

  async getStatCards() {
    const cards = this.page.locator('.stat-card');
    const count = await cards.count();
    const stats: Array<{ label: string; value: string }> = [];
    for (let i = 0; i < count; i++) {
      const label = await cards.nth(i).locator('.stat-label').textContent() ?? '';
      const value = await cards.nth(i).locator('.stat-value').textContent() ?? '';
      stats.push({ label: label.trim(), value: value.trim() });
    }
    return stats;
  }

  async getConnectionTableRows() {
    return this.page.locator('.data-table tbody tr, table tbody tr').first()
      .locator('..').locator('tr').count().catch(() => 0);
  }

  async getAgentTableRows() {
    const tables = this.page.locator('table');
    const count = await tables.count();
    if (count < 2) return 0;
    return tables.nth(1).locator('tbody tr').count().catch(() => 0);
  }

  async hasConnectionBadge(status: string) {
    return this.page.locator('.badge, .connection-badge, span')
      .filter({ hasText: new RegExp(status, 'i') })
      .first().isVisible().catch(() => false);
  }
}
