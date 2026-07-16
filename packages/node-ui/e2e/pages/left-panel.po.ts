import { type Page, type Locator } from '@playwright/test';
import { sel } from '../helpers/selectors.js';

export class LeftPanelPage {
  readonly page: Page;
  readonly root: Locator;
  readonly newProjectBtn: Locator;
  readonly joinProjectBtn: Locator;
  readonly oraclePlaceholder: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.locator(sel.leftPanel.root).first();
    // rc11 renamed "+ New Project" -> "+ New Context Graph". The button
    // class (`.v10-new-project-btn`) was kept for backwards-compat but
    // is now shared with "↗ Join Context Graph", so each handle filters
    // by visible label to disambiguate.
    this.newProjectBtn = this.root.locator(sel.leftPanel.newProjectBtn).filter({ hasText: /New Context Graph/i });
    this.joinProjectBtn = this.root.locator(sel.leftPanel.newProjectBtn).filter({ hasText: /Join Context Graph/i });
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
    // rc11 renamed mode tab "Projects" -> "Context Graphs"; the underlying
    // store value `treeMode` is still 'explorer'/'oracle'.
    const label = mode === 'explorer' ? 'Context Graphs' : 'Context Oracle';
    await this.root.locator(sel.leftPanel.modeBtn).filter({ hasText: label }).click();
  }

  async getActiveMode() {
    const active = this.root.locator(`${sel.leftPanel.modeBtn}.active`);
    return active.textContent();
  }

  async clickNewProject() {
    const btn = this.newProjectBtn.filter({ hasText: '+ New Context Graph' });
    await btn.waitFor({ state: 'visible', timeout: 10_000 });
    await btn.click();
    // The modal mounts via a layout-store update. If the click lands while the
    // left panel is still re-rendering from its async context-graphs fetch, the
    // onClick can be missed and the overlay never appears. Verify the overlay
    // opened and retry once — keeps the open deterministic instead of flaky.
    const overlay = this.page.locator(sel.modal.overlay);
    try {
      await overlay.waitFor({ state: 'visible', timeout: 2_000 });
    } catch {
      await btn.click();
      await overlay.waitFor({ state: 'visible', timeout: 5_000 });
    }
  }

  async waitForProjectsLoaded() {
    await this.myCgSections().locator(sel.leftPanel.sectionLabel).first().waitFor({ state: 'visible', timeout: 15_000 });
  }

  async clickJoinProject() {
    await this.joinProjectBtn.first().click();
  }

  /**
   * Returns the names of every context graph rendered under the
   * "My Context Graphs" peer-group. Each CG row is a
   * `.v10-tree-section > .v10-tree-section-header > .v10-tree-section-label`;
   * scoping the locator to `.v10-peer-group-body` keeps us from picking
   * up the parent peer-group label or the Integrations section.
   */
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
    // Clicking the CG row opens its project tab, but the ProjectView BODY
    // (`.v10-memory-explorer` — the project strip + dot, layer switcher,
    // overview card, …) only mounts AFTER ProjectView's async
    // `fetchContextGraphs` resolves and the CG appears in the list; until then
    // the centre shows a "Loading context graph..." placeholder. Nearly every
    // caller immediately asserts on a body element, often with the default 5s
    // `expect` timeout, which races that cold fetch under heavy parallel load
    // against the single shared devnet node (e.g. `.v10-project-strip-dot`
    // "element(s) not found"). Wait for the body to actually mount here so every
    // caller starts from a fully-loaded project — a real load wait, not a
    // masked assertion (if the project never loads in 30s that's a genuine
    // failure worth surfacing).
    await this.page
      .locator('.v10-center-content .v10-memory-explorer')
      .filter({ has: this.page.getByRole('button', { name }) })
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });
  }

  /**
   * Click a context-graph header. In rc11 this opens the project tab in
   * the centre panel; the inline "expand to see memory layers" gesture
   * was removed (memory layers live inside the project view's
   * LayerSwitcher now).
   */
  async clickProject(name: string) {
    const section = this.root.locator(sel.leftPanel.section).filter({ hasText: name }).first();
    await section.locator(sel.leftPanel.sectionHeader).first().click();
  }

  /**
   * Click the inline `×` next to a CG row, which hides the CG from the
   * sidebar (reversibly — a "↺ Show N hidden context graphs" button
   * appears underneath the list while any are hidden).
   */
  async hideProject(name: string) {
    const section = this.root.locator(sel.leftPanel.section).filter({ hasText: name }).first();
    await section.locator(sel.leftPanel.sectionHeader).first().getByRole('button', { name: '×' }).click();
  }

  /** The "↺ Show N hidden context graphs" restore button (only present while ≥1 is hidden). */
  get showHiddenButton() {
    return this.root.locator(sel.leftPanel.showHidden).first();
  }

  /** Restore every CG dismissed from the sidebar (calls the shared `unhideAll`). */
  async showHiddenProjects() {
    await this.showHiddenButton.click();
  }

  async clickLayer(projectName: string, layer: 'wm' | 'swm' | 'vm' | 'import') {
    await this.expandProject(projectName);
    const tab = this.page.locator(sel.center.tab).filter({ hasText: projectName });
    await tab.click();
    await tab.waitFor({ state: 'visible' });
    const root = this.page.locator('.v10-center-content .v10-memory-explorer').filter({
      has: this.page.getByRole('button', { name: projectName }),
    });
    // ProjectView renders "Loading context graph..." (a `.v10-view-placeholder`,
    // NOT the explorer) until its async `fetchContextGraphs` resolves and the CG
    // appears in the list — only then does `.v10-memory-explorer` (and the layer
    // switcher inside it) mount. Under heavy parallel load that cold fetch can
    // take longer than a click's default 10s actionability wait, so clicking the
    // layer button straight away races the loading spinner and times out — a
    // false negative, not a real UI defect (the same path passes once warm).
    // Wait for the explorer to actually mount (poll interval is 30s) first.
    await root.waitFor({ state: 'visible', timeout: 30_000 });
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
