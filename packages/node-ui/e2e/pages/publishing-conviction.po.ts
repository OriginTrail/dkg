import { type Page, type Locator } from '@playwright/test';
import { sel } from '../helpers/selectors.js';

/**
 * Page object for the GREENFIELD Publishing Conviction (PCA) tab
 * (pages/PublishingConviction.tsx). Opens as a closable center tab from the
 * header "Publishing Conviction" button (Header.tsx → openTab id:'conviction').
 *
 * SCAFFOLD — the tab is not built yet (P0, Batch B). This PO encodes the e2e
 * selector contract (see sel.conviction) so the driving spec
 * (publishing-conviction.spec.ts) is ready the moment Frontend lands S1. Every
 * anchor is a data-testid Frontend must add; QA owns this map.
 *
 * SAFETY: helpers stop at non-mutating boundaries. On the LIVE testnet the
 * create/topUp/register flows COMMIT and STAKE real TRAC — those steps are
 * gated behind explicit driver calls used only in the directed P0 validation
 * phase, never in the read-only conformance pass.
 */
export class PublishingConvictionPage {
  readonly page: Page;
  readonly headerBtn: Locator;
  readonly view: Locator;
  readonly unavailable: Locator;
  readonly recheckBtn: Locator;
  readonly landing: Locator;
  readonly trackToggle: Locator;
  readonly trackInput: Locator;
  readonly trackSubmit: Locator;
  readonly accountCard: Locator;
  readonly healthChip: Locator;
  readonly tierLadder: Locator;
  readonly createBtn: Locator;
  readonly createModal: Locator;
  readonly createTokensInput: Locator;
  readonly createPrimaryNode: Locator;
  readonly createSubmit: Locator;
  readonly createSuccess: Locator;
  readonly approveOwnWalletsCta: Locator;
  readonly detail: Locator;
  readonly agentList: Locator;
  readonly agentRows: Locator;
  readonly actionResult: Locator;
  readonly approveModal: Locator;
  readonly approveAddressInput: Locator;
  readonly approveSubmit: Locator;
  readonly eligibilityVerdict: Locator;
  readonly eligibilityChip: Locator;
  readonly discountBadge: Locator;
  readonly getSponsoredPanel: Locator;

  constructor(page: Page) {
    this.page = page;
    this.headerBtn = page.locator(sel.conviction.headerBtn);
    this.view = page.locator(sel.conviction.view);
    this.unavailable = page.locator(sel.conviction.unavailable);
    this.recheckBtn = page.locator(sel.conviction.recheckBtn);
    this.landing = page.locator(sel.conviction.landing);
    this.trackToggle = page.locator(sel.conviction.trackToggle);
    this.trackInput = page.locator(sel.conviction.trackInput);
    this.trackSubmit = page.locator(sel.conviction.trackSubmit);
    this.accountCard = page.locator(sel.conviction.accountCard);
    this.healthChip = page.locator(sel.conviction.healthChip);
    this.tierLadder = page.locator(sel.conviction.tierLadder);
    this.createBtn = page.locator(sel.conviction.createBtn);
    this.createModal = page.locator(sel.conviction.createModal);
    this.createTokensInput = page.locator(sel.conviction.createTokensInput);
    this.createPrimaryNode = page.locator(sel.conviction.createPrimaryNode);
    this.createSubmit = page.locator(sel.conviction.createSubmit);
    this.createSuccess = page.locator(sel.conviction.createSuccess);
    this.approveOwnWalletsCta = page.locator(sel.conviction.approveOwnWalletsCta);
    this.detail = page.locator(sel.conviction.detail);
    this.agentList = page.locator(sel.conviction.agentList);
    this.agentRows = page.locator(sel.conviction.agentRow);
    this.actionResult = page.locator(sel.conviction.actionResult);
    this.approveModal = page.locator(sel.conviction.approveModal);
    this.approveAddressInput = page.locator(sel.conviction.approveAddressInput);
    this.approveSubmit = page.locator(sel.conviction.approveSubmit);
    this.eligibilityVerdict = page.locator(sel.conviction.eligibilityVerdict);
    this.eligibilityChip = page.locator(sel.conviction.eligibilityChip);
    this.discountBadge = page.locator(sel.conviction.discountBadge);
    this.getSponsoredPanel = page.locator(sel.conviction.getSponsoredPanel);
  }

  /** Open the PCA tab from the header and wait for it to mount. */
  async open(timeout = 15_000) {
    await this.headerBtn.click();
    // The tab is React.lazy — wait for either the live view OR the 503 gate.
    await this.page
      .locator(`${sel.conviction.view}, ${sel.conviction.unavailable}`)
      .first()
      .waitFor({ state: 'visible', timeout });
  }

  /** True when the mount-gate short-circuited the tab (feature not on this network). */
  async isUnavailable(): Promise<boolean> {
    return this.unavailable.isVisible().catch(() => false);
  }

  /** Track a known PCA by accountId (S1 pre-discovery manual path, P0). The
   *  track-by-id input lives in a collapsed disclosure — expand it first. */
  async trackAccount(accountId: string) {
    if (!(await this.trackInput.isVisible().catch(() => false))) {
      await this.trackToggle.first().click();
    }
    await this.trackInput.fill(accountId);
    await this.trackSubmit.click();
    await this.accountCard.first().waitFor({ state: 'visible', timeout: 15_000 });
  }

  /**
   * The S5 verdict's accessible role. Invariant 6: amber/danger verdicts must be
   * an assertive live region (role=alert); a benign verdict is polite.
   */
  async verdictRole(): Promise<string | null> {
    return this.eligibilityVerdict.first().getAttribute('role');
  }
}
