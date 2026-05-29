import { type Page, type Locator } from '@playwright/test';
import { sel } from '../helpers/selectors.js';

export class LeftPanelPage {
  readonly page: Page;
  readonly root: Locator;
  readonly newProjectBtn: Locator;
  readonly oraclePlaceholder: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.locator(sel.leftPanel.root).first();
    this.newProjectBtn = page.locator(sel.leftPanel.newProjectBtn);
    this.oraclePlaceholder = page.locator(sel.leftPanel.oraclePlaceholder);
  }

  private myCgSections() {
    return this.root.locator(sel.myContextGraphs.peerGroupBody).locator(sel.leftPanel.section);
  }

  private memoryStackControl() {
    return this.root.locator(sel.leftPanel.dashboard).filter({ hasText: 'Memory Stack' });
  }

  async isVisible() {
    return this.root.isVisible();
  }

  async clickDashboard() {
    await this.root.locator(sel.leftPanel.dashboard).filter({ hasText: 'Dashboard' }).click();
  }

  async clickMemoryStack() {
    const sidebar = this.memoryStackControl();
    if (await sidebar.isVisible().catch(() => false)) {
      await sidebar.click();
      return;
    }
    throw new Error('Memory Stack navigation control not found (expected .v10-tree-dashboard with "Memory Stack" label)');
  }

  async isMemoryStackVisible() {
    return this.memoryStackControl().isVisible().catch(() => false);
  }

  async switchToMode(mode: 'explorer' | 'oracle') {
    const label = mode === 'explorer' ? 'Context Graphs' : 'Context Oracle';
    await this.root.locator(sel.leftPanel.modeBtn).filter({ hasText: label }).click();
  }

  async getActiveMode() {
    const active = this.root.locator(`${sel.leftPanel.modeBtn}.active`);
    return active.textContent();
  }

  async clickNewProject() {
    await this.newProjectBtn.first().click();
  }

  async waitForProjectsLoaded() {
    await this.myCgSections().locator(sel.leftPanel.sectionLabel).first().waitFor({ state: 'visible', timeout: 15_000 });
  }

  async getProjectNames() {
    await this.waitForProjectsLoaded();
    const labels = this.myCgSections().locator(sel.leftPanel.sectionLabel);
    const count = await labels.count();
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      const text = await labels.nth(i).textContent();
      if (text && !text.includes('No context graphs')) names.push(text.trim());
    }
    return names;
  }

  async expandProject(name: string) {
    await this.waitForProjectsLoaded();
    await this.myCgSections()
      .locator(sel.leftPanel.sectionHeader)
      .filter({ hasText: name })
      .click();
  }

  async clickLayer(projectName: string, layer: 'wm' | 'swm' | 'vm' | 'import') {
    await this.expandProject(projectName);
    await this.page.locator(sel.center.tab).filter({ hasText: projectName }).click();
    const root = this.page.locator('.v10-center-content .v10-memory-explorer').last();
    if (layer === 'import') {
      await root.locator(sel.layer.actionBtn).filter({ hasText: /Import/i }).click();
      return;
    }
    await root.locator(`${sel.layer.switchBtn}[data-layer="${layer}"]`).click();
  }

  async expandIntegrations() {
    const header = this.page.locator('.v10-peer-group-header').filter({ hasText: 'Integrations' });
    await header.click();
  }

  async getEmptyStateTitle() {
    return this.root.locator(sel.leftPanel.emptyTitle).textContent();
  }
}
