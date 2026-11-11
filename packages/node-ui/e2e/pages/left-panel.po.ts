import { expect, type Page, type Locator } from '@playwright/test';
import { sel } from '../helpers/selectors.js';

/** Matches `text` and nothing longer: a section's header also holds its count. */
const exactly = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

export class LeftPanelPage {
  readonly page: Page;
  readonly root: Locator;
  readonly newProjectBtn: Locator;
  readonly joinProjectBtn: Locator;
  /** The sidebar's "Node" group: Observability, Publisher Conviction, Settings. */
  readonly nodePlaces: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.locator(sel.leftPanel.root).first();
    this.newProjectBtn = this.root.locator(sel.leftPanel.newProjectBtn).filter({ hasText: /^New$/i });
    this.joinProjectBtn = this.root.locator(sel.leftPanel.newProjectBtn).filter({ hasText: /^Join$/i });
    this.oraclePlaceholder = page.locator(sel.leftPanel.oraclePlaceholder);
    this.nodePlaces = page.getByRole('navigation', { name: 'Node' });
  }

  /** A node-level place in the sidebar, by its visible name. */
  place(name: 'Observability' | 'Publisher Conviction' | 'Settings') {
    return this.nodePlaces.getByRole('button', { name, exact: true });
  }

  async openObservability() {
    await this.place('Observability').click();
    // The Observability view is a lazy-loaded centre tab: its <h1> only paints
    // once the dynamic chunk + initial render settle. Under heavy parallel load
    // (shared Vite dev server + shared node) that can exceed the default 5s
    // `expect` budget callers assert with, and a click fired right after
    // `shell.goto()` can also be missed while the shell is still hydrating.
    // Confirm the view actually opened, retrying the click once — same missed-
    // click guard used in clickNewProject — so every caller starts loaded.
    const heading = this.page.getByRole('heading', { name: 'Observability', level: 1 });
    try {
      await heading.waitFor({ state: 'visible', timeout: 8_000 });
    } catch {
      await this.place('Observability').click();
      await heading.waitFor({ state: 'visible', timeout: 20_000 });
    }
  }

  async openSettings() {
    await this.place('Settings').click();
  }

  private myCgSections() {
    return this.section('My Context Graphs')
      .locator(sel.myContextGraphs.peerGroupBody)
      .locator(sel.leftPanel.section);
  }

  /**
   * A collapsible sidebar section by its label (Marketplace, My Context
   * Graphs, Public graphs, Integrations): its header, with the count where it
   * has one, and, while expanded, its body.
   */
  section(label: string) {
    return this.root
      .locator(sel.leftPanel.peerGroup)
      .filter({ has: this.page.locator(sel.leftPanel.peerGroupLabel, { hasText: exactly(label) }) })
      .first();
  }

  /** The button that expands and collapses the section `label`; its `aria-expanded` says which it is. */
  sectionHeader(label: string) {
    return this.section(label).locator(sel.leftPanel.peerGroupHeader).first();
  }

  async isSectionExpanded(label: string) {
    return (await this.sectionHeader(label).getAttribute('aria-expanded')) === 'true';
  }

  /** Expand the section `label`, and leave one already expanded as it is: a click on its header would collapse it. */
  async expandSection(label: string) {
    const header = this.sectionHeader(label);
    if (!(await this.isSectionExpanded(label))) await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
  }

  /** The Public graphs section alone: its header (with the count) and, while expanded, its body. */
  publicGraphsSection() {
    return this.section('Public graphs');
  }

  private memoryStackControl() {
    return this.root.locator(sel.leftPanel.dashboard).filter({ hasText: 'Memory stack' });
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
    throw new Error('Memory stack navigation control not found in the structured sidebar');
  }

  async isMemoryStackVisible() {
    return this.memoryStackControl().isVisible().catch(() => false);
  }

  async clickNewProject() {
    const btn = this.newProjectBtn;
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
      if (text && !text.includes('No Context Graphs')) names.push(text.trim());
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
    await section.locator(sel.leftPanel.sectionHeader).first().getByRole('button', { name: /^Hide .+ from the sidebar$/ }).click();
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
