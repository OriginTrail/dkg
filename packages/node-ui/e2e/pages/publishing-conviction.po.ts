import { type Page, type Locator } from '@playwright/test';
import { sel } from '../helpers/selectors.js';
import { fetchApiInPage } from '../helpers/page-api.js';

/**
 * Page object for the GREENFIELD Publisher Conviction (PCA) tab
 * (pages/PublishingConviction.tsx). Opens as a closable center tab from the
 * header "Publisher Conviction" button (Header.tsx -> openTab id:'conviction').
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
  readonly checkInput: Locator;
  readonly checkSubmit: Locator;
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
  readonly topUpBtn: Locator;
  readonly topUpInput: Locator;
  readonly deregisterBtn: Locator;
  readonly approveModal: Locator;
  readonly approveAddressInput: Locator;
  readonly approveSubmit: Locator;
  readonly publishEligibility: Locator;
  readonly eligibilityVerdict: Locator;
  readonly eligibilityChip: Locator;
  readonly discountBadge: Locator;
  readonly getSponsoredPanel: Locator;
  readonly bellAlert: Locator;

  constructor(page: Page) {
    this.page = page;
    this.headerBtn = page.locator(sel.conviction.headerBtn);
    this.view = page.locator(sel.conviction.view);
    this.unavailable = page.locator(sel.conviction.unavailable);
    this.recheckBtn = page.locator(sel.conviction.recheckBtn);
    this.landing = page.locator(sel.conviction.landing);
    this.checkInput = page.locator(sel.conviction.checkInput);
    this.checkSubmit = page.locator(sel.conviction.checkSubmit);
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
    this.topUpBtn = page.locator(sel.conviction.topUpBtn);
    this.topUpInput = page.getByLabel('Top-up amount in TRAC');
    this.deregisterBtn = page.locator(sel.conviction.deregisterBtn);
    this.approveModal = page.locator(sel.conviction.approveModal);
    this.approveAddressInput = page.locator(sel.conviction.approveAddressInput);
    this.approveSubmit = page.locator(sel.conviction.approveSubmit);
    this.publishEligibility = page.locator(sel.conviction.publishEligibility);
    this.eligibilityVerdict = page.locator(sel.conviction.eligibilityVerdict);
    this.eligibilityChip = page.locator(sel.conviction.eligibilityChip);
    this.discountBadge = page.locator(sel.conviction.discountBadge);
    this.getSponsoredPanel = page.locator(sel.conviction.getSponsoredPanel);
    this.bellAlert = page.locator(sel.conviction.bellAlert);
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

  /** Add a known PCA to the list by accountId, the way a user does: type it beside
   *  "Already have a PCA?", press Check, and in Get added either let an approved
   *  wallet add it automatically or press "Add PCA #N to your list". */
  async trackAccount(accountId: string) {
    await this.checkInput.first().fill(accountId);
    await this.checkSubmit.first().click();
    const dialog = this.page.getByTestId('pca-get-sponsored');
    await dialog.waitFor({ state: 'visible' });
    const add = dialog.getByTestId('pca-sponsor-track');
    // The check is done when there's a result, an Add offer, or the PCA is already in the list.
    await dialog
      .locator('[data-testid="pca-sponsor-track"], [data-testid="pca-sponsor-tracked"], .v10-pca-approve-results')
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 });
    if (await add.isVisible()) await add.click();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await this.accountCard.first().waitFor({ state: 'visible', timeout: 15_000 });
  }

  /**
   * Put PCA IDs in this browser's tracked list directly, without checking them on chain,
   * then reload so the app reads them. For tests that only need "a PCA is tracked" (the
   * chip's mount gate) and mustn't depend on another test having minted one. The key
   * matches stores/pca.ts: `dkg-pca:` + pcaStorageScopeForContracts(contracts).
   */
  async seedTrackedIds(ids: string[]) {
    const res = await fetchApiInPage<{ chainId: string | number; nft: string; token: string }>(this.page, '/api/pca/contracts');
    if (!res.ok || !res.json) throw new Error(`seedTrackedIds: /api/pca/contracts returned ${res.status}`);
    const { chainId, nft, token } = res.json;
    const key = `dkg-pca:${[String(chainId), nft, token].map((p) => p.toLowerCase()).join(':')}`;
    await this.page.evaluate(
      ({ key, ids }) => localStorage.setItem(key, JSON.stringify({ trackedIds: ids, createPending: null, topUpPending: {} })),
      { key, ids },
    );
    await this.page.reload();
  }

  /**
   * The S5 verdict's accessible role. Invariant 6: amber/danger verdicts must be
   * an assertive live region (role=alert); a benign verdict is polite.
   */
  async verdictRole(): Promise<string | null> {
    return this.eligibilityVerdict.first().getAttribute('role');
  }
}
