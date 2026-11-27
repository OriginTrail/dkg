/**
 * Operate, on the seller node: its offerings with their backends and prices,
 * the epoch, and the receipt it holds for the call the playground made. Once
 * random sampling has scored the node this epoch, Land now puts the receipt
 * on chain; the batch appears, and on the buyer node the reconciliation
 * matches the landed receipt to the one it held, and the call reads as landed.
 */
import type { ActivityAnswer, ReconciliationAnswer, SellerStatus, SubscriptionsAnswer } from '../../../src/ui/marketplace/api/types.js';
import { test, expect } from '../fixtures.js';
import { epochTimes, nodeOk, readSetup } from '../devnet.js';
import { CHAT, SERVICES, STUB_UNITS, UI, callValueOf, microOf, tracOf } from '../topology.js';

/** Random sampling proves a node about every 100 blocks of a second each; the first proof can take a few periods. */
const SCORE_TIMEOUT_MS = Number(process.env.MKT_E2E_SCORE_TIMEOUT_MS) || 600_000;

test.describe('Operate', () => {
  test('shows the offerings and the epoch, and Land now lands the receipt the buyer holds', async ({ market, page }) => {
    test.setTimeout(SCORE_TIMEOUT_MS + 240_000);
    const { seller, buyer } = readSetup();
    const { epoch } = await epochTimes();
    const value = callValueOf(CHAT);

    const root = await market.open('operate', UI.seller);
    await expect(root).toHaveAttribute('data-state', 'active');
    await expect(page.getByTestId('mkt-ask-cycle')).toContainText(`Epoch ${epoch}, ends`);
    for (const s of SERVICES) {
      const offering = market.offering(s.serviceId);
      await expect(offering).toHaveAttribute('data-connector', 'up');
      await expect(offering).toContainText(s.name);
      await expect(offering).toContainText(`${microOf(s.pricePerUnit)} µTRAC/tok`);
    }
    await expect(root).toContainText(`identity ${seller.identityId}`);
    const ledger = market.ledger();
    await expect(ledger.getByTestId('mkt-ledger-counts')).toHaveText('1 served · 0 sent · 0 landed · 0 refused · 0 missed');

    // A receipt lands only in an epoch the node has proved: wait for random sampling to score it.
    await expect.poll(async () => (await nodeOk<SellerStatus>(seller.node, 'GET', '/api/marketplace/seller')).scoredThisEpoch, {
      message: `the seller node is scored by random sampling in epoch ${epoch}`,
      timeout: SCORE_TIMEOUT_MS,
      intervals: [5_000],
    }).toBe(true);
    await market.reload('operate');
    await expect(ledger.locator('.mkt-corenode-item', { hasText: /^Proved this epoch$/ }).locator('[aria-label="yes"]')).toBeVisible();

    await ledger.getByTestId('mkt-land-now').click();
    await expect(ledger.getByTestId('mkt-land-result')).toHaveText('Batches landed: 1 · 1 receipts · 0 refused', { timeout: 60_000 });
    await expect(ledger.getByTestId('mkt-ledger-counts')).toHaveText('0 served · 0 sent · 1 landed · 0 refused · 0 missed');
    await expect(ledger).toContainText(`landed ${tracOf(value)} TRAC`);
    const batches = page.getByTestId('mkt-batches').getByRole('row');
    await expect(batches).toHaveCount(1);
    await expect(batches.first()).toContainText('1 receipts');
    await expect(batches.first()).toContainText(`${tracOf(value)} TRAC`);

    // The buyer: its gateway follows what landed, so the receipt it held is matched and the call reads as landed.
    await expect.poll(async () => {
      const { rows } = await nodeOk<ReconciliationAnswer>(buyer.node, 'GET', '/api/marketplace/reconciliation');
      const row = rows.find((r) => r.serviceId === CHAT.serviceId && r.seller === seller.identityId);
      return row ? `${row.held.count} held, ${row.landed.count} landed, ${row.landed.matched} matched` : 'no row';
    }, { message: "the buyer's reconciliation matches the landed receipt", timeout: 90_000, intervals: [3_000] }).toBe('0 held, 1 landed, 1 matched');
    await expect.poll(async () => (await nodeOk<ActivityAnswer>(buyer.node, 'GET', '/api/marketplace/activity')).calls.map((c) => c.state), {
      message: "the buyer's activity shows the call as landed",
      timeout: 90_000,
      intervals: [3_000],
    }).toEqual(['landed']);
    // The budget counts the receipt as held until the gateway's next tick sees it landed.
    await expect.poll(async () => {
      const { subscriptions } = await nodeOk<SubscriptionsAnswer>(buyer.node, 'GET', '/api/marketplace/subscriptions');
      const budget = subscriptions.find((s) => s.epoch === epoch)?.budgets.find((b) => b.serviceId === CHAT.serviceId);
      return budget ? `${budget.used} used, ${budget.held} held` : 'no budget';
    }, { message: "the buyer's budget moves the receipt from held to used", timeout: 90_000, intervals: [3_000] }).toBe(`${value} used, 0 held`);

    const plans = await market.open('plans', UI.buyer);
    await expect(plans).toHaveAttribute('data-state', 'active');
    const reconciliation = page.getByTestId('mkt-reconciliation');
    await expect(reconciliation).toHaveAttribute('data-epoch', String(epoch));
    await expect(reconciliation.getByTestId('mkt-recon-body')).toContainText('So far: this node holds 0 receipts · 1 landed, 1 matched');
    const row = reconciliation.getByTestId('mkt-recon-rows').getByRole('row').filter({ hasText: CHAT.name });
    await expect(row).toContainText(`seller ${seller.identityId}`);
    await expect(row).toContainText(`1 landed, 1 matched · ${tracOf(value)} TRAC counted`);
    const call = page.getByTestId('mkt-activity').getByRole('row').first();
    await expect(call).toHaveAttribute('data-state', 'landed');
    await expect(call).toContainText(`${STUB_UNITS} tokens · ${tracOf(value)} TRAC`);
    await expect(market.meter(CHAT.serviceId)).toContainText(`${tracOf(value)} landed · 0 held`);
  });
});
