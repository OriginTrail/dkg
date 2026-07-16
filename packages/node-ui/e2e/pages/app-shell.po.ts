import { type Page, type Locator } from '@playwright/test';
import { sel } from '../helpers/selectors.js';

export class AppShellPage {
  readonly page: Page;
  readonly root: Locator;
  readonly body: Locator;
  readonly leftPanel: Locator;
  readonly rightPanel: Locator;
  readonly leftResizeHandle: Locator;
  readonly rightResizeHandle: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.locator(sel.app);
    this.body = page.locator(sel.appBody);
    this.leftPanel = page.locator(sel.leftPanel.root).first();
    this.rightPanel = page.locator(sel.rightPanel.root).first();
    this.leftResizeHandle = page.locator(sel.resizeHandle).first();
    this.rightResizeHandle = page.locator(sel.resizeHandle).last();
  }

  async goto() {
    await this.page.goto('/');
    await this.root.waitFor({ state: 'visible' });
  }

  async isLeftPanelVisible() {
    return this.leftPanel.isVisible();
  }

  async isRightPanelVisible() {
    return this.rightPanel.isVisible();
  }

  async getLeftPanelWidth() {
    const box = await this.leftPanel.boundingBox();
    return box?.width ?? 0;
  }

  async getRightPanelWidth() {
    const box = await this.rightPanel.boundingBox();
    return box?.width ?? 0;
  }

  async dragLeftHandle(deltaX: number) {
    const box = await this.leftResizeHandle.boundingBox();
    if (!box) return;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await this.page.mouse.move(x, y);
    await this.page.mouse.down();
    await this.page.mouse.move(x + deltaX, y, { steps: 5 });
    await this.page.mouse.up();
  }

  async dragRightHandle(deltaX: number) {
    const handle = this.page.locator(sel.resizeHandle).last();
    const box = await handle.boundingBox();
    if (!box) return;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await this.page.mouse.move(x, y);
    await this.page.mouse.down();
    await this.page.mouse.move(x + deltaX, y, { steps: 5 });
    await this.page.mouse.up();
  }
}
