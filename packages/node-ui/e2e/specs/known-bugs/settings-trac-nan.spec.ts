/**
 * Regression test for GH #915 — FIXED in this PR. Was a `test.fixme()` known-bug
 * repro; now ACTIVE and passing. It guards the fix and turns red if the bug
 * regresses.
 *
 * GH ISSUE: https://github.com/OriginTrail/dkg/issues/915 — "Settings shows 'NaN'
 * for the TRAC wallet balance when the node returns no numeric trac value".
 *
 * Root cause: `packages/node-ui/src/ui/pages/Settings.tsx:482`:
 *   {parseFloat(b.trac).toFixed(2)} {formatTracSymbol(b.symbol, w?.chainId)}
 * `parseFloat(null | undefined | non-numeric)` is `NaN`, and `NaN.toFixed(2)`
 * is the string "NaN" — so the wallet row shows "NaN TRAC". The ETH amount
 * right beside it is guarded (`formatEth(b.eth)` handles null/NaN), so the two
 * sibling balances are inconsistent. `/api/wallets/balances` types `trac` as
 * `string`, but a node that can't read the TRAC token balance (RPC hiccup,
 * token contract unreachable on a fresh chain, …) can return it null.
 *
 * No /api/status fault here, so the page does NOT enter mock mode and the
 * base-fixture `_noMockModeGuard` stays satisfied. We only shape the wallets
 * payload to the real "trac unavailable" failure mode.
 */
import { test, expect } from '../../fixtures/base.js';

test.describe('KNOWN BUG: Settings TRAC balance renders "NaN" when trac is unavailable', () => {
  test('TRAC balance shows a guarded value (—/0.00), never the string "NaN"', async ({ page }) => {
    const addr = '0xAD6d956782Cf699F6a2D67D54aeB164C5B3AFc7C';
    await page.route('**/api/wallets/balances**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          wallets: [addr],
          // trac:null models a node that returned ETH but could not resolve the
          // TRAC token balance. eth stays valid so we can prove ETH is guarded
          // while TRAC is not.
          balances: [{ address: addr, eth: '99.5', trac: null, symbol: 'TRAC' }],
          chainId: '31337',
        }),
      }),
    );

    await page.goto('/ui/settings');

    // Wait for the Blockchain Config balance row to render (our faked address).
    await expect(page.getByText(addr).first()).toBeVisible({ timeout: 15_000 });

    // ==== THE BUG ====
    // CORRECT: an unavailable TRAC balance renders a guarded placeholder
    // ("—" or "0.00"), never the literal "NaN". Today Settings.tsx:482 prints
    // "NaN TRAC". This search finds the "NaN" and FAILS until guarded.
    await expect(
      page.getByText(/\bNaN\b/),
      'Settings renders "NaN" for the TRAC balance (Settings.tsx:482 — unguarded parseFloat(b.trac).toFixed(2)) ' +
        'while the sibling ETH amount is guarded via formatEth(). See linked GH issue.',
    ).toHaveCount(0, { timeout: 10_000 });
  });
});
