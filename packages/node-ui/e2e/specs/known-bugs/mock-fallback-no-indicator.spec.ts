/**
 * Regression test for GH #904 — FIXED in this PR. Was a `test.fixme()` known-bug
 * repro; now ACTIVE and passing. It guards the fix and turns red if the bug
 * regresses.
 *
 * GH ISSUE: https://github.com/OriginTrail/dkg/issues/904 — "UI silently shows
 * fabricated demo data with no indicator when the node is unreachable".
 *
 * This spec deliberately uses the RAW `@playwright/test` runner instead of
 * `e2e/fixtures/base.ts`, because that fixture installs `_noMockModeGuard`, an
 * auto-fixture that FAILS any test which enters mock mode. This test does the
 * opposite — it FORCES mock mode (by faulting `/api/status`) to prove the
 * product gives the operator NO visible signal that the dashboard they're
 * looking at is fabricated demo data rather than live node state.
 *
 * Using `page.route` here is fault injection (simulate the daemon being down),
 * NOT data mocking: we assert on the ABSENCE of a UI affordance, never on a
 * fabricated payload.
 *
 * Source: src/ui/api-wrapper.ts `detectMockMode()` — on a non-OK (≠401) / 2s
 * timeout / network error from `/api/status` it sets `useMocks = true` and
 * `withFallback` swaps every wrapped endpoint to `mocks/provider.ts` fixtures
 * (mock-node-agent, connectedPeers:12, "DKG Mainnet · Base", "Pharma Drug
 * Interactions" CGs, fake wallet balances). The only signal is a `console.warn`
 * + a `window.__DKG_USING_MOCKS__` flag — nothing rendered for the user.
 */
import { test, expect } from '@playwright/test';

test.describe('KNOWN BUG: silent mock/demo-data fallback has no UI indicator', () => {
  test('UI must visibly indicate demo/mock data when the node is unreachable', async ({ page }) => {
    // Fault-inject: the node-health probe 5xx's, exactly as it would if the
    // daemon were down / restarting / returning errors.
    await page.route('**/api/status', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: '{"error":"forced-down for known-bug repro"}',
      }),
    );

    await page.goto('/');

    // Precondition: confirm the product actually fell back to fabricated demo
    // data. If this never becomes true the repro itself is invalid.
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (window as { __DKG_USING_MOCKS__?: boolean }).__DKG_USING_MOCKS__ === true,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);

    // Sanity: the fabricated demo identity really is on screen, so a user IS
    // looking at fake data — this is exactly the danger an indicator must guard.
    await expect(page.getByText(/mock-node-agent|my-dkg-node/i).first()).toBeVisible();

    // ==== THE BUG ====
    // There is NO banner/badge/pill anywhere telling the operator the data is
    // demo/offline/sample/mock. A node operator whose daemon is down sees a
    // healthy-looking "synced · 12 peers · DKG Mainnet · Base" dashboard with
    // fabricated wallet balances and spending. This assertion encodes the
    // CORRECT behavior (some visible indicator) and therefore FAILS today.
    const indicator = page.getByText(
      /demo data|mock data|sample data|preview data|offline|node unreachable|not connected to a node|using example data/i,
    );
    await expect(
      indicator.first(),
      'When the UI silently serves fabricated demo data (window.__DKG_USING_MOCKS__===true), it must show a visible indicator so the operator is not misled into trusting fake node state. None is rendered today — see linked GH issue.',
    ).toBeVisible({ timeout: 5_000 });
  });
});
