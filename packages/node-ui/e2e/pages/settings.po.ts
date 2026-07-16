import { type Page, type Locator } from '@playwright/test';
import { sel } from '../helpers/selectors.js';

/**
 * Page object for the rewritten Settings page (pages/Settings.tsx). The page
 * opens as a closable center tab from the header gear button and renders five
 * `.card` sections: Node Identity, Blockchain Config, Network Telemetry, Local
 * Data Retention, Danger Zone.
 *
 * Every interactive control on this page is either reversible (telemetry
 * consent → Cancel) or non-destructive on first activation (shutdown is a
 * two-click confirm; the first click only arms it). The helpers below stop at
 * those safe boundaries so the shared devnet is never mutated or killed.
 */
export class SettingsPage {
  readonly page: Page;
  readonly root: Locator;
  readonly title: Locator;
  readonly telemetrySwitch: Locator;
  readonly telemetryDialog: Locator;
  readonly retentionSelect: Locator;
  readonly retentionConfirm: Locator;
  readonly shutdownButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.locator(sel.settings.stack);
    this.title = page.locator(sel.settings.pageTitle).filter({ hasText: 'Settings' });
    this.telemetrySwitch = page.locator(sel.settings.telemetrySwitch);
    this.telemetryDialog = page.locator(sel.settings.telemetryDialog);
    this.retentionSelect = page.locator(sel.settings.retentionSelect);
    this.retentionConfirm = page.locator(sel.settings.retentionConfirm);
    this.shutdownButton = page.locator(`${sel.settings.stack} button`).filter({ hasText: /Shutdown|Confirm Shutdown|Shutting down/ });
  }

  async waitForLoaded(timeout = 10_000) {
    await this.root.waitFor({ state: 'visible', timeout });
  }

  /**
   * Wait until the Node-Identity card has hydrated from `/api/status`. The card
   * paints immediately with "—" placeholders + an OFFLINE pill and only fills in
   * once the async status fetch resolves. Under the high local worker count the
   * status endpoint can be slow, so identity assertions must wait for the real
   * value rather than racing the first paint (otherwise they read "—").
   */
  async waitForIdentityLoaded(timeout = 20_000) {
    await this.page.waitForFunction(
      () => {
        const labels = Array.from(document.querySelectorAll('.settings-field-label'));
        const nameLabel = labels.find((l) => /^name$/i.test(l.textContent?.trim() || ''));
        const value = nameLabel?.nextElementSibling?.textContent?.trim();
        return !!value && value !== '—';
      },
      undefined,
      { timeout },
    );
  }

  /** Card titles in render order (e.g. "Node Identity", "Danger Zone"). */
  async getSectionTitles(): Promise<string[]> {
    return this.page.locator(sel.settings.cardTitle).allTextContents().then((t) => t.map((s) => s.trim()));
  }

  /** Value of a labelled Node-Identity / Blockchain field (label is exact, case-insensitive). */
  fieldValue(label: string): Locator {
    return this.page
      .locator(sel.settings.fieldLabel)
      .filter({ hasText: new RegExp(`^${label}$`, 'i') })
      .locator('xpath=following-sibling::*[1]');
  }

  /** The "● ONLINE" / "● OFFLINE" status pill inside the Node Identity card. */
  get onlinePill(): Locator {
    return this.page.locator(sel.settings.onlinePill).filter({ hasText: /ONLINE|OFFLINE/ });
  }

  async getOnlinePillText(): Promise<string> {
    return (await this.onlinePill.first().textContent())?.trim() ?? '';
  }

  async getRetentionOptions(): Promise<string[]> {
    return this.retentionSelect.locator('option').allTextContents().then((t) => t.map((s) => s.trim()));
  }
}
