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

  /**
   * Wait until the daemon-driven project tree has finished its initial
   * fetch AND a project section has rendered. The empty-card state is
   * not accepted because the seed always creates one CG — if we see the
   * empty card we want the test to continue waiting (or fail). This
   * makes "no projects yet" a real signal rather than a passable state.
   */
  async waitForReady(timeoutMs = 45_000): Promise<void> {
    await this.root.locator(this.sectionHeaderSel).first().waitFor({ state: 'visible', timeout: timeoutMs });
  }

  private get sectionHeaderSel() {
    return sel.leftPanel.sectionHeader;
  }

  async clickDashboard() {
    await this.root.locator(sel.leftPanel.dashboard).filter({ hasText: 'Dashboard' }).click();
  }

  async clickMemoryStack() {
    // Memory Stack only renders once the tree knows there's at least one
    // CG. Wait for the row before clicking.
    const row = this.root.locator(sel.leftPanel.dashboard).filter({ hasText: 'Memory Stack' });
    await row.waitFor({ state: 'visible', timeout: 30_000 });
    await row.click();
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
    // Daemon-driven CG list can lag; wait until the project header renders
    // before clicking. Failing this wait is a real symptom (the seeded CG
    // never appeared in the UI) — let it surface rather than hide it.
    await header.waitFor({ state: 'visible', timeout: 30_000 });
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

  async getEmptyStateTitle() {
    return this.root.locator(sel.leftPanel.emptyTitle).textContent();
  }

  async clickJoinProject() {
    await this.root.getByRole('button', { name: /Join Project/ }).click();
  }

  async hideProject(name: string) {
    const section = this.root.locator(sel.leftPanel.section).filter({ hasText: name });
    await section.locator(sel.leftPanel.hideBtn).click();
  }

  async toggleParticipating(name: string) {
    const section = this.root.locator(sel.leftPanel.section).filter({ hasText: name });
    await section.locator(sel.leftPanel.moveBtn).click();
  }

  async clickShowHidden() {
    await this.root.locator(sel.leftPanel.showHidden).click();
  }

  async isShowHiddenVisible() {
    return this.root.locator(sel.leftPanel.showHidden).isVisible();
  }
}
