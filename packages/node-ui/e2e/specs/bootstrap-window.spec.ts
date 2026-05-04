import { test, expect } from '../fixtures/base.js';
import { sel } from '../helpers/selectors.js';

/**
 * Bootstrap-window guard.
 *
 * The seeded context graph exists on the daemon before any test runs
 * (the harness's globalSetup confirms `/api/paranet/list` returns it
 * before yielding). A user opening the UI right after starting their
 * node should see their project in the left panel within a few seconds
 * — not wait a full 30s for the dashboard's useFetch poll to refresh.
 *
 * The other specs in this suite use a longer `waitForReady()` in their
 * `beforeEach` so they don't trip over this race. This one deliberately
 * does not — it asserts the user-facing SLA and stays failing if the UI
 * regresses on first-load freshness.
 */
const SLA_MS = 10_000;

test.describe('Bootstrap window guard', () => {
  test(`seeded CG renders in left tree within ${SLA_MS / 1000}s of page load`, async ({ shell, page, seed }) => {
    await shell.goto();
    await expect(
      page.locator(sel.leftPanel.sectionHeader).filter({ hasText: seed.contextGraphName }),
    ).toBeVisible({ timeout: SLA_MS });
  });
});
