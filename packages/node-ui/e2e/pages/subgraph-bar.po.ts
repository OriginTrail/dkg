import { type Page, type Locator } from '@playwright/test';
import { sel } from '../helpers/selectors.js';

export class SubGraphBarPage {
  readonly page: Page;
  readonly bar: Locator;
  readonly chips: Locator;

  constructor(page: Page) {
    this.page = page;
    this.bar = page.locator(sel.subgraph.bar);
    this.chips = page.locator(sel.subgraph.chip);
  }

  async isVisible() {
    return this.bar.isVisible().catch(() => false);
  }

  async waitForBar(timeout = 15_000) {
    await this.bar.waitFor({ state: 'visible', timeout });
    // Chips render asynchronously after the bar mounts (the bar fetches
    // `/api/sub-graph/list` on mount, then paints the "All" + per-scope chips).
    // Every caller reads chips right after this, so wait for the first chip to
    // exist — otherwise a count/label read can race the paint and see 0.
    await this.chips.first().waitFor({ state: 'visible', timeout });
  }

  async getChipLabels(): Promise<string[]> {
    const labels = this.bar.locator(sel.subgraph.chipLabel);
    const count = await labels.count();
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      const t = await labels.nth(i).textContent();
      if (t) out.push(t.trim());
    }
    return out;
  }

  async getChipCounts(): Promise<number[]> {
    const counts = this.bar.locator(sel.subgraph.chipCount);
    const n = await counts.count();
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = await counts.nth(i).textContent();
      out.push(parseInt(t?.trim() ?? '0', 10) || 0);
    }
    return out;
  }

  async clickChip(label: string | RegExp) {
    await this.chips.filter({ hasText: label }).click();
  }

  /**
   * Click the first concrete scope chip — i.e. the first chip that is NOT the
   * aggregate "All" chip. On a real node the scopes are whatever the daemon has
   * registered (named sub-graphs and/or the Root bucket), so specs select "the
   * first real scope" rather than a hard-coded mock sub-graph name.
   *
   * NB: a chip's textContent is `${icon}${label}${count}` (e.g. "⊚All31"), so we
   * can't filter on the whole chip text — `hasNotText: 'All'` would also exclude
   * legitimate scopes whose LABEL merely contains that substring (`Allergens`,
   * `Allocate`, …) and could skip the first real scope or find none. Instead read
   * each chip's dedicated label element and exact-match it against "All", so only
   * the aggregate chip (label === "All") is excluded.
   */
  async clickFirstScopeChip() {
    await this.chips.first().waitFor({ state: 'visible', timeout: 15_000 });
    const count = await this.chips.count();
    for (let i = 0; i < count; i++) {
      const chip = this.chips.nth(i);
      const label = (await chip.locator(sel.subgraph.chipLabel).textContent())?.trim();
      if (label && label !== 'All') {
        await chip.click();
        return;
      }
    }
    throw new Error('no concrete sub-graph scope chip found (only the aggregate "All" chip is present)');
  }

  async getActiveChipLabel(): Promise<string | null> {
    const active = this.bar.locator(sel.subgraph.chipActive).locator(sel.subgraph.chipLabel);
    return active.first().textContent();
  }

  async hasRootChip() {
    return this.bar.locator(sel.subgraph.chipRoot).isVisible().catch(() => false);
  }
}

export class StatStripPage {
  readonly page: Page;
  readonly root: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.locator(sel.statStrip.root).first();
  }

  async getCells(): Promise<Array<{ label: string; value: string }>> {
    const cells = this.root.locator(sel.statStrip.cell);
    const count = await cells.count();
    const out: Array<{ label: string; value: string }> = [];
    for (let i = 0; i < count; i++) {
      const cell = cells.nth(i);
      const label = (await cell.locator(sel.statStrip.label).textContent())?.trim() ?? '';
      const value = (await cell.locator(sel.statStrip.value).textContent())?.trim() ?? '';
      out.push({ label, value });
    }
    return out;
  }

  async getValueForLabel(label: string): Promise<string | null> {
    const cells = await this.getCells();
    const hit = cells.find((c) => c.label.toLowerCase() === label.toLowerCase());
    return hit?.value ?? null;
  }
}
