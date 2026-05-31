import { type Page, type Locator } from '@playwright/test';
import { sel } from '../helpers/selectors.js';

/**
 * DashboardPage — page object for the rc11 redesigned dashboard.
 *
 * The legacy dashboard had quick-action buttons, demo project cards
 * (`.v10-dash-project-card`), and a recent-operations feed
 * (`.v10-recent-op`). All three were removed in the rc11 redesign.
 * The current dashboard ships:
 *   - 3 StatCards (My Context Graphs / Context Graph Size /
 *     Collaborating Agents) in `.v10-dash-stats.v10-dash-stats-3`,
 *   - the My-Context-Graphs section (`.v10-cg-list` with `.v10-cg-row`
 *     buttons) — which doubles as the project picker,
 *   - the Wallets and Spending section (`.v10-ws-wtable` / `.v10-ws-spend`).
 *
 * The PO surface still exposes `clickQuickAction(label)` as a shim so
 * specs that just need to *open the create-project modal* as a
 * precondition keep working — the shim delegates to the left panel's
 * "+ New Context Graph" button. Methods that have no replacement in
 * the new UI (project cards, recent ops, "view all" link) have been
 * removed.
 */
export class DashboardPage {
  readonly page: Page;
  readonly root: Locator;
  readonly title: Locator;
  readonly subtitle: Locator;
  readonly statsContainer: Locator;
  readonly quickActions: Locator;

  // Newly-named handles for the rc11 dashboard. The CG list IS the
  // project picker now — clicking a `.v10-cg-row` opens that project's
  // tab in the centre panel (replacing the legacy `.v10-dash-project-card`).
  readonly cgRows: Locator;
  readonly cgEmpty: Locator;
  readonly walletsSection: Locator;
  readonly spendingTable: Locator;
  readonly chainRow: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.locator(sel.dashboard.root);
    this.title = page.locator(sel.dashboard.title);
    this.subtitle = page.locator(sel.dashboard.subtitle);
    this.statsContainer = page.locator(sel.dashboard.stats);
    this.quickActions = page.locator(sel.dashboard.quickAction);
    this.cgRows = page.locator('.v10-cg-list .v10-cg-row');
    this.cgEmpty = page.locator('.v10-cg-empty');
    this.walletsSection = page
      .locator('.v10-dash-section')
      .filter({ has: page.getByRole('heading', { name: 'Wallets and Spending' }) });
    this.spendingTable = page.locator('.v10-ws-spend');
    this.chainRow = page.locator('.v10-ws-chain-row');
  }

  async getStatCards() {
    const cards = this.statsContainer.locator(sel.dashboard.statCard);
    const count = await cards.count();
    const stats: Array<{ label: string; value: string }> = [];
    for (let i = 0; i < count; i++) {
      const label = await cards.nth(i).locator(sel.dashboard.statLabel).textContent() ?? '';
      const value = await cards.nth(i).locator(sel.dashboard.statValue).textContent() ?? '';
      stats.push({ label: label.trim(), value: value.trim() });
    }
    return stats;
  }

  async clickQuickAction(label: string) {
    // The legacy `.v10-quick-action` row on the dashboard was removed in
    // the rc11 redesign — the entry points moved into the left panel
    // ("+ New Context Graph") and into the project view ("Import files"
    // hub). Rather than ripping every spec that opens these modals as a
    // precondition, this method now resolves to the still-extant entry
    // point per label so the *modal-under-test* is what gets asserted,
    // not the obsolete dashboard row.
    const entryByLabel: Record<string, () => Promise<void>> = {
      'Create Project': async () => {
        await this.page
          .locator('.v10-new-project-btn')
          .filter({ hasText: /New Context Graph/i })
          .first()
          .click();
      },
    };
    const direct = this.quickActions.filter({ hasText: label });
    if ((await direct.count()) > 0) {
      await direct.first().click();
      return;
    }
    const fallback = entryByLabel[label];
    if (fallback) {
      await fallback();
      return;
    }
    // Preserve the original locator-error if neither path resolves so a
    // future regression doesn't silently no-op.
    await direct.click();
  }

  async getCgNames(): Promise<string[]> {
    const count = await this.cgRows.count();
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      const text = await this.cgRows.nth(i).locator('.v10-cg-name').textContent();
      if (text) names.push(text.trim());
    }
    return names;
  }

  async clickCgRow(name: string) {
    await this.cgRows.filter({ hasText: name }).first().click();
  }

  async getSubtitleText(): Promise<string> {
    return (await this.subtitle.textContent())?.trim() ?? '';
  }
}
