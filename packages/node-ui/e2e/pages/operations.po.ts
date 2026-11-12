import { type Page, type Locator } from '@playwright/test';

export class OperationsPage {
  readonly page: Page;
  readonly root: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.locator('.v10-center-content');
  }

  async switchTab(tab: 'All operations' | 'Performance' | 'Logs' | 'Errors') {
    await this.root.locator('button').filter({ hasText: tab }).click();
  }

  async getActiveTab() {
    return this.root.locator('button.active').first().textContent();
  }

  async getOperationRows() {
    return this.root.locator('table tbody tr').count();
  }

  async filterByType(type: string) {
    const select = this.root.locator('select').first();
    await select.selectOption({ label: type });
  }

  async filterByStatus(status: string) {
    const selects = this.root.locator('select');
    const count = await selects.count();
    if (count >= 2) {
      await selects.nth(1).selectOption({ label: status });
    }
  }

  async searchById(id: string) {
    const input = this.root.locator('input[type="text"]').first();
    await input.fill(id);
  }

  async clickOperationRow(index: number) {
    const rows = this.root.locator('table tbody tr');
    await rows.nth(index).click();
  }

  async hasChartArea() {
    return this.root.locator('.recharts-wrapper, .recharts-responsive-container, svg.recharts-surface')
      .first().isVisible().catch(() => false);
  }

  async getLogLines() {
    return this.root.locator('.v10-log-line, .ops-log-line').count();
  }

  async setLogLevel(level: string) {
    const selects = this.root.locator('select');
    const count = await selects.count();
    for (let i = 0; i < count; i++) {
      const options = selects.nth(i).locator('option');
      const optCount = await options.count();
      for (let j = 0; j < optCount; j++) {
        const text = await options.nth(j).textContent();
        if (text?.toLowerCase().includes(level.toLowerCase())) {
          await selects.nth(i).selectOption({ index: j });
          return;
        }
      }
    }
  }

  async hasPagination() {
    return this.root.locator('button').filter({ hasText: /next|prev|›|‹/i }).first().isVisible().catch(() => false);
  }

  async hasCopyButton() {
    return this.root.locator('button').filter({ hasText: /copy/i }).first().isVisible().catch(() => false);
  }
}
