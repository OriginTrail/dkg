/**
 * Publishing Conviction (PCA) tab — UI-driving e2e (P0).
 *
 * Page-fixture spec (exemplar: create-project.spec.ts) that drives the real
 * node-UI against the devnet node1 (auto-staked, PCA contracts deployed by
 * scripts/devnet.sh — so the 503 mount-gate does NOT fire here and an owner can
 * actually create/manage a PCA). The API-only `/api/pca` contract smoke stays in
 * specs/devnet/conviction-publishing.devnet.spec.ts; THIS file is the
 * browser-driving gate the plan §2.4 calls for.
 *
 * STATUS: the discovery/mount/503/auth tests are LIVE as of Batch B
 * (e3e5954fa anchors). The create/approve/manage/edge/B8 tests stay `test.fixme`
 * until their screens land (Batches C–E); QA removes `.fixme` per screen.
 * Screen ↔ §5 invariant references point at PCA-NODE-UI-UX-PROPOSAL /
 * PUBLISHING-CONVICTION-ACCOUNTS so each assertion's intent is unambiguous.
 *
 * MUTATION SAFETY: create / top-up / approve / settle COMMIT real TRAC and are
 * owner-gated on-chain writes. On the shared devnet they mutate node1's chain
 * state, so those tests must `test.describe.configure({ mode: 'serial' })` and
 * use uniquely-named data; on the LIVE Base Sepolia testnet they spend real
 * (faucet/funded) TRAC and run ONLY in the lead-directed P0 validation phase,
 * never in the read-only conformance pass.
 */
import { test, expect } from '../fixtures/base.js';
import { fetchApiInPage } from '../helpers/page-api.js';

const SHOT_DIR = 'test-results/pca-smoke';

test.describe('Publishing Conviction tab (PCA) — P0', () => {
  test.beforeEach(async ({ shell }) => {
    await shell.goto();
  });

  // ── Discovery / mount (S7 landing, S1 overview, 503 gate) ──────────────────

  test('opens from the header and mounts the PCA view', async ({ conviction, page }) => {
    await conviction.open();
    // On a PCA-enabled chain (devnet / Base Sepolia) the feature IS deployed →
    // the live overview renders, not the 503 gate.
    expect(await conviction.isUnavailable()).toBe(false);
    await expect(conviction.view).toBeVisible();
    await expect(conviction.landing).toBeVisible(); // S7/S1 role-adaptive landing
    await page.screenshot({ path: `${SHOT_DIR}/s1-overview.png`, fullPage: true });
  });

  test('503 mount-gate short-circuits the tab on a network without PCA', async ({ conviction, page }) => {
    // usePcaAvailability probes GET /api/pca/0; a 503 with a non-RPC_* code →
    // isPcaFeatureUnavailable → the tab short-circuits to the EmptyState gate
    // (proposal §6.6/§8a). Route-mock it so the gate is exercised even on a chain
    // that HAS the PCA contract. Set the route BEFORE opening the tab (the probe
    // fires on mount).
    await page.route('**/api/pca/0*', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'FEATURE_UNAVAILABLE', code: 'FEATURE_UNAVAILABLE' }),
      }),
    );
    await conviction.open();
    expect(await conviction.isUnavailable()).toBe(true);
    await expect(conviction.recheckBtn).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/503-gate.png`, fullPage: true });
  });

  test('S1: core overview shows the owner Create-PCA affordance + track-by-id discovery', async ({ conviction, page }) => {
    await conviction.open();
    // A fresh CORE node owns no PCAs → the role-adaptive landing (S7) leads with
    // the owner Create-PCA CTA and the manual track-by-id discovery disclosure
    // (no enumeration API yet). Read-only, deterministic on an empty node.
    await expect(conviction.createBtn).toBeVisible();          // core/owner-capable
    await expect(conviction.trackToggle.first()).toBeVisible(); // S1 manual discovery
    await page.screenshot({ path: `${SHOT_DIR}/s1-core-overview.png`, fullPage: true });
  });

  test.fixme('S1: tracking an OWNED accountId renders the account card', async ({ conviction }) => {
    // Needs an account classified into the active filter (owned/approved). A
    // fresh node has none, so this belongs to the capstone (after S2 create) or a
    // mocked-data unit test — PcaAccountCard's 4 states are covered there.
    await conviction.open();
    await conviction.trackAccount('1');
    await expect(conviction.accountCard.first()).toBeVisible();
  });

  // ── Auth pattern (window.__DKG_TOKEN__) ────────────────────────────────────

  test('authed /api/pca/:id round-trips from the browser context', async ({ page }) => {
    // Bearer-token pattern UXUI/QA reuse for any authed probe: fetchApiInPage
    // attaches window.__DKG_TOKEN__ (injected by vite.config.ts), matching the
    // UI's own requests. Structured 200/404/503 contract itself is asserted in
    // conviction-publishing.devnet.spec.ts.
    const res = await fetchApiInPage<{ accountId?: string; error?: string }>(page, '/api/pca/1');
    expect([200, 404, 503]).toContain(res.status);
  });

  // ── S2 create (MUTATING — owner-gated, commits TRAC) — Batch C ──────────────

  test.describe('create flow (S2)', () => {
    test.describe.configure({ mode: 'serial' });

    test.fixme('create modal opens with tokens + primary-node fields; submit guarded', async ({ conviction }) => {
      await conviction.open();
      await conviction.createBtn.click();
      await expect(conviction.createModal).toBeVisible();
      await expect(conviction.createTokensInput).toBeVisible();
      await expect(conviction.createPrimaryNode).toBeVisible(); // required (GitBook doc bug: it was omitted)
    });

    test.fixme('INVARIANT 11: success card leads with "0/100 wallets approved — discounts nothing yet"', async ({ conviction }) => {
      // A fresh PCA grants ZERO self-discount until the owner approves its own
      // wallets (agentToAccountId[owner]==0 at mint). The success state must NOT
      // be a generic "Done — discounted" and MUST surface the approve-own-wallets CTA.
      await conviction.open();
      await expect(conviction.createSuccess).toContainText(/0\s*\/\s*100 wallets approved/i);
      await expect(conviction.approveOwnWalletsCta).toBeVisible();
    });
  });

  // ── S4 approve wallets (MUTATING) — Batch C ────────────────────────────────

  test.fixme('S4: approve a publishing wallet (the OPERATIONAL wallet, not admin/peerId)', async ({ conviction }) => {
    // INVARIANT 1: what gets registered is the publish-tx msg.sender (op wallet),
    // copy says "approved publishing wallet". INVARIANT 5: one wallet ↔ one PCA.
    await conviction.open();
    await conviction.approveModal.waitFor({ state: 'visible' });
    await conviction.approveAddressInput.fill('0x...');
    await conviction.approveSubmit.click();
    await expect(conviction.agentRows.first()).toBeVisible(); // B3 live list
  });

  // ── S5 eligibility / fail-open-can-fail-closed (read-only; a11y) — Batch E ──

  test.fixme('S5 a11y: amber/danger verdict is an assertive live region (role=alert)', async ({ conviction }) => {
    // INVARIANT 6: fail-open is graceful ONLY if the signing wallet can pay full
    // price in TRAC; otherwise the fall-through HARD-REVERTS. Amber ("will pay
    // direct cost") vs danger ("this publish will FAIL") — never a false green.
    await conviction.open();
    await expect(conviction.eligibilityVerdict.first()).toBeVisible();
    expect(await conviction.verdictRole()).toBe('alert');
  });

  test.fixme('INVARIANT 9: pre-B8 discount is PREDICTED ("pending confirmation"), never asserted', async ({ conviction }) => {
    await conviction.open();
    await expect(conviction.eligibilityChip.first()).toContainText(/pending confirmation/i);
  });

  // ── B8 confirmed discount badge (P2; degrade-to-hidden) ────────────────────

  test.fixme('B8: discount badge is HIDDEN when the publish response carries no CostCovered', async ({ conviction }) => {
    await conviction.open();
    await expect(conviction.discountBadge).toHaveCount(0);
  });
});
