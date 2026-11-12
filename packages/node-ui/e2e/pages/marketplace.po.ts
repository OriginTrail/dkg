import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The NeuroSymbolic Marketplace section of the node UI (OT-RFC-27): Browse
 * (with the playground), Plans, Access and Operate, each a centre tab with a
 * deep link. The section is still behind a flag that `?marketplace` on any
 * page turns on, so every `open` carries it.
 */
export type MarketplaceTab = 'browse' | 'plans' | 'access' | 'operate';

const TABS: Record<MarketplaceTab, { path: string; root: string }> = {
  browse: { path: 'marketplace', root: 'mkt-marketplace' },
  plans: { path: 'marketplace/plans', root: 'mkt-plans' },
  access: { path: 'marketplace/access', root: 'mkt-access' },
  operate: { path: 'marketplace/operate', root: 'mkt-operate' },
};

export class MarketplacePage {
  constructor(readonly page: Page) {}

  /** A tab's root, whose `data-state` says what it shows (loading, off, ok, active, …). */
  root(tab: MarketplaceTab): Locator {
    return this.page.getByTestId(TABS[tab].root);
  }

  /**
   * Open a tab on the UI served at `origin` (`…/ui/`, one per node), and
   * wait until it has loaded. Returns its root.
   */
  async open(tab: MarketplaceTab, origin: string): Promise<Locator> {
    await this.page.goto(new URL(`${TABS[tab].path}?marketplace`, origin).toString());
    const root = this.root(tab);
    await expect(root).toBeVisible({ timeout: 60_000 });
    await expect(root).not.toHaveAttribute('data-state', 'loading', { timeout: 60_000 });
    return root;
  }

  /** Load the current tab again: a tab reads the node once, when it opens. */
  async reload(tab: MarketplaceTab): Promise<Locator> {
    await this.page.reload();
    const root = this.root(tab);
    await expect(root).toBeVisible({ timeout: 60_000 });
    await expect(root).not.toHaveAttribute('data-state', 'loading', { timeout: 60_000 });
    return root;
  }

  // ── Browse ──────────────────────────────────────────────────────────────

  sellerChip(identityId: number): Locator {
    return this.page.getByTestId(`mkt-seller-${identityId}`);
  }

  card(serviceId: string): Locator {
    return this.page.getByTestId(`mkt-card-${serviceId}`);
  }

  /** Browse's Models or Playground view. */
  async view(name: 'Models' | 'Playground'): Promise<void> {
    await this.root('browse').getByRole('tab', { name }).click();
  }

  // ── Playground ──────────────────────────────────────────────────────────

  playground(): Locator {
    return this.page.getByTestId('mkt-playground');
  }

  /** Send one message to `serviceId` from the playground, which must be open. */
  async chat(serviceId: string, message: string): Promise<void> {
    const play = this.playground();
    await play.getByTestId(`mkt-chip-${serviceId}`).click();
    await expect(play.getByTestId(`mkt-chip-${serviceId}`)).toHaveAttribute('aria-checked', 'true');
    await play.getByTestId('mkt-play-input').fill(message);
    await play.getByTestId('mkt-play-send').click();
  }

  /** The playground's last answer and the line under it: who served it and what it cost. */
  lastAnswer(): { bubble: Locator; served: Locator } {
    const play = this.playground();
    return { bubble: play.locator('.mkt-bubble.assistant').last(), served: play.getByTestId('mkt-served').last() };
  }

  // ── Plans ───────────────────────────────────────────────────────────────

  /** One budget's meter in this epoch's subscription. */
  meter(serviceId: string): Locator {
    return this.page.getByTestId(`mkt-meter-${serviceId}`);
  }

  /** In the composer, pick a service and give it a budget in TRAC. */
  async pickService(serviceId: string, valueTrac: string): Promise<void> {
    const line = this.page.getByTestId(`mkt-line-${serviceId}`);
    await line.getByTestId(`mkt-pick-${serviceId}`).check();
    await line.getByTestId(`mkt-value-${serviceId}`).fill(valueTrac);
  }

  /** The dry run's line under the composer or a top-up: what the request as it stands would cost, or what the node would refuse. */
  dryRun(): Locator {
    return this.page.getByTestId('mkt-preview');
  }

  // ── Operate ─────────────────────────────────────────────────────────────

  offering(serviceId: string): Locator {
    return this.page.getByTestId(`mkt-ask-${serviceId}`);
  }

  ledger(): Locator {
    return this.page.getByTestId('mkt-ledger');
  }
}
