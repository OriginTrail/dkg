import { type Page, type Locator } from '@playwright/test';
import { sel } from '../helpers/selectors.js';

export class LeftPanelPage {
  readonly page: Page;
  readonly root: Locator;
  readonly collapseBtn: Locator;
  readonly newProjectBtn: Locator;
  readonly oraclePlaceholder: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.locator(sel.leftPanel.root).first();
    this.collapseBtn = page.locator(sel.leftPanel.collapseBtn);
    this.newProjectBtn = page.locator(sel.leftPanel.newProjectBtn);
    this.oraclePlaceholder = page.locator(sel.leftPanel.oraclePlaceholder);
  }

  async isVisible() {
    return this.root.isVisible();
  }

  async clickDashboard() {
    await this.root.locator(sel.leftPanel.dashboard).filter({ hasText: 'Dashboard' }).click();
  }

  async clickMemoryStack() {
    await this.root.locator(sel.leftPanel.dashboard).filter({ hasText: 'Memory Stack' }).click();
  }

  async isMemoryStackVisible() {
    return this.root.locator(sel.leftPanel.dashboard).filter({ hasText: 'Memory Stack' }).isVisible();
  }

  async switchToMode(mode: 'explorer' | 'oracle') {
    const label = mode === 'explorer' ? 'Projects' : 'Context Oracle';
    await this.root.locator(sel.leftPanel.modeBtn).filter({ hasText: label }).click();
  }

  async getActiveMode() {
    const active = this.root.locator(`${sel.leftPanel.modeBtn}.active`);
    return active.textContent();
  }

  async collapse() {
    await this.collapseBtn.click();
  }

  async clickNewProject() {
    await this.newProjectBtn.first().click();
  }

  async getProjectNames() {
    const labels = this.root.locator(sel.leftPanel.sectionLabel);
    const count = await labels.count();
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      const text = await labels.nth(i).textContent();
      if (text && text !== 'Integrations') names.push(text);
    }
    return names;
  }

  async expandProject(name: string) {
    const header = this.root.locator(sel.leftPanel.sectionHeader).filter({ hasText: name });
    await header.click();
  }

  async clickLayer(projectName: string, layer: 'wm' | 'swm' | 'vm' | 'import') {
    const section = this.root.locator(sel.leftPanel.section).filter({ hasText: projectName });
    const items = section.locator(sel.leftPanel.treeItem);

    const labelMap: Record<string, string> = {
      wm: 'agent drafts',
      import: 'Import files',
      swm: 'team workspace',
      vm: 'verified assets',
    };

    await items.filter({ hasText: labelMap[layer] }).click();
  }

  async expandIntegrations() {
    const header = this.root.locator(sel.leftPanel.sectionHeader).filter({ hasText: 'Integrations' });
    await header.click();
  }

  async clickGame() {
    await this.root.locator(sel.leftPanel.treeItem).filter({ hasText: 'OriginTrail Game' }).click();
  }

  async getEmptyStateTitle() {
    return this.root.locator(sel.leftPanel.emptyTitle).textContent();
  }
}
