import { type Page, type Locator } from '@playwright/test';
import { expect } from '@playwright/test';
import { sel } from '../helpers/selectors.js';

export class ProjectLayerPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /** Scope layer controls to the active (or named) project view tab. */
  private async projectView(projectName?: string): Promise<Locator> {
    if (projectName) {
      const tab = this.page.locator(sel.center.tab).filter({ hasText: projectName });
      await tab.click();
      await expect(tab).toHaveClass(/active/);
      return this.page.locator('.v10-center-content .v10-memory-explorer').filter({
        has: this.page.getByRole('button', { name: projectName }),
      });
    }
    const activeTab = this.page.locator(`${sel.center.tab}.active`);
    const label = (await activeTab.locator(sel.center.tabLabel).textContent())?.trim();
    if (label && !label.includes('Dashboard')) {
      return this.page.locator('.v10-center-content .v10-memory-explorer').filter({
        has: this.page.getByRole('button', { name: label }),
      });
    }
    return this.page.locator('.v10-center-content .v10-memory-explorer').last();
  }

  async openProject(name: string) {
    await this.page
      .locator(sel.myContextGraphs.peerGroupBody)
      .locator(sel.leftPanel.sectionHeader)
      .filter({ hasText: name })
      .click();
    const view = await this.projectView(name);
    await view.waitFor({ state: 'visible', timeout: 15_000 });
  }

  async switchLayer(
    layer: 'Overview' | 'Working Memory' | 'Shared Working Memory' | 'Verifiable Memory' | 'Subgraphs',
    projectName?: string,
  ) {
    const root = await this.projectView(projectName);
    const layerAttr: Record<string, string | null> = {
      Overview: null,
      'Working Memory': 'wm',
      'Shared Working Memory': 'swm',
      'Verifiable Memory': 'vm',
      Subgraphs: null,
    };
    const attr = layerAttr[layer];
    const btn = attr
      ? root.locator(`${sel.layer.switchBtn}[data-layer="${attr}"]`)
      : root.locator(sel.layer.switchBtn).filter({ hasText: layer });
    await btn.click();
  }

  async clickShare(projectName?: string) {
    const root = await this.projectView(projectName);
    await root.locator(sel.layer.actionBtn).filter({ hasText: /Share/i }).click();
  }

  async clickImport(projectName?: string) {
    const root = await this.projectView(projectName);
    await root.locator(sel.layer.actionBtn).filter({ hasText: /Import/i }).click();
  }

  async getStatStripCells(projectName?: string): Promise<Array<{ label: string; value: string }>> {
    const root = (await this.projectView(projectName)).locator(sel.statStrip.root).first();
    await root.waitFor({ state: 'visible', timeout: 15_000 });
    const cells = root.locator(sel.statStrip.cell);
    const count = await cells.count();
    const out: Array<{ label: string; value: string }> = [];
    for (let i = 0; i < count; i++) {
      const cell = cells.nth(i);
      out.push({
        label: (await cell.locator(sel.statStrip.label).textContent())?.trim() ?? '',
        value: (await cell.locator(sel.statStrip.value).textContent())?.trim() ?? '',
      });
    }
    return out;
  }
}
