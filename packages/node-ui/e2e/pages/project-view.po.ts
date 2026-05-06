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

  layerSwitcher() {
    return this.root.locator('.v10-layer-switcher');
  }

  layerBtn(layer: 'overview' | 'graph-overview' | 'query' | 'wm' | 'swm' | 'vm') {
    return this.root.locator(`.v10-layer-switch-btn[data-layer="${layer}"]`);
  }

  async switchLayer(layer: 'overview' | 'graph-overview' | 'query' | 'wm' | 'swm' | 'vm') {
    await this.layerBtn(layer).click();
  }

  async getActiveLayer() {
    const active = this.root.locator('.v10-layer-switch-btn.active');
    return active.getAttribute('data-layer');
  }

  async clickShare() {
    // The Share action button lives in the layer-switcher toolbar, not the
    // layer-name buttons (e.g. "Shared Memory") below.
    await this.root.locator('.v10-layer-switcher .v10-layer-action-btn').filter({ hasText: 'Share' }).click();
  }

  /**
   * Click the Import action in the LayerSwitcher toolbar. As of v10 (PR #326)
   * the import entry-point moved out of the sidebar tree and into the
   * project view's own action bar.
   */
  async clickImport() {
    await this.root.locator('.v10-layer-switcher .v10-layer-action-btn').filter({ hasText: /Import/ }).click();
  }
}
