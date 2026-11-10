/**
 * The epoch's close, last of the specs because it moves the chain's clock.
 * Ten minutes before the end the seller is in its last stretch, and lands
 * the receipt it still holds (the reasoner's call) by itself: the lane's
 * landing interval is longer than the epoch, so no regular landing time is
 * crossed on the way and only the last stretch can land it; the buyer's
 * standing plan, inside its prefund lead, funds the next epoch from its
 * source (the Conviction Account the account spec chose, at its discount).
 * Past the end, the buyer's reconciliation of the epoch is final,
 * the seller's Operate lists the epoch with its pool and its gross (a lone
 * seller's gross is the whole pool, all that was funded for the epoch), and
 * Browse prices the chat service at the price the seller set for this epoch.
 */
import type { Plan, ReconciliationAnswer, SellerStatus, SubscriptionsAnswer } from '../../../src/ui/marketplace/api/types.js';
import { test, expect } from '../fixtures.js';
import { advanceChainTime, epochTimes, nodeOk, readSetup } from '../devnet.js';
import { ACCOUNT, CHAT, LANDING_INTERVAL_MINUTES, NEXT_CHAT_PRICE, PLAN, REASONER, UI, microOf, tracOf, weiOfTrac } from '../topology.js';

test.describe('The epoch closes', () => {
  test('the seller lands what it holds, the plan funds the next epoch, and the ended epoch is final', async ({ market, page }) => {
    test.setTimeout(420_000);
    const { seller, buyer } = readSetup();
    const sellerStatus = () => nodeOk<SellerStatus>(seller.node, 'GET', '/api/marketplace/seller');
    const subscriptions = () => nodeOk<SubscriptionsAnswer>(buyer.node, 'GET', '/api/marketplace/subscriptions');
    const start = await epochTimes();
    const epoch = start.epoch;
    const funded = weiOfTrac(PLAN.chatTrac) + weiOfTrac(PLAN.reasonerTrac) + weiOfTrac(PLAN.topUpTrac);
    const planValue = weiOfTrac(PLAN.chatTrac) + weiOfTrac(PLAN.reasonerTrac);

    // What the earlier specs left: the chat's receipt landed, the reasoner's still held by the seller,
    // and a standing plan that pays from the Conviction Account the account spec opened, at its discount.
    expect((await sellerStatus()).ledger).toMatchObject({ served: 1, landed: 1, missed: 0 });
    const chosen = (await nodeOk<Plan>(buyer.node, 'GET', '/api/marketplace/plan')).source;
    expect(chosen, 'the account spec left the plan paying from its Conviction Account').toMatchObject({ kind: 'account', discountBps: ACCOUNT.discountBps });
    const accountId = chosen.kind === 'account' ? chosen.accountId : '';
    // Worked out here, not read back from the node: the plan's value less the account's discount.
    const cost = (planValue * BigInt(10_000 - ACCOUNT.discountBps)) / 10_000n;

    // Into the last stretch. The jump crosses no regular landing time, so the seller's landing below
    // can only be the last stretch's.
    expect(start.endsAt - start.startsAt, "the lane's landing interval is longer than the epoch").toBeLessThan(LANDING_INTERVAL_MINUTES * 60);
    await advanceChainTime(start.endsAt - 600 - start.now);
    await expect.poll(async () => (await sellerStatus()).ledger.landed, {
      message: 'the seller lands the receipt it held, by itself, in the last stretch',
      timeout: 120_000,
      intervals: [3_000],
    }).toBe(2);
    await expect.poll(async () => (await subscriptions()).subscriptions.find((s) => s.epoch === epoch + 1)?.value, {
      message: `the standing plan funds epoch ${epoch + 1} before epoch ${epoch} ends`,
      timeout: 120_000,
      intervals: [3_000],
    }).toBe(String(planValue));
    // The renewal pays from that account at its discount, and the plan still pays from it: a renewal
    // from the buyer wallet, or at full price, fails here.
    const renewed = (await subscriptions()).subscriptions.find((s) => s.epoch === epoch + 1)!;
    expect(renewed.source).toMatchObject({ kind: 'account', accountId });
    expect(renewed.cost).toBe(String(cost));
    expect((await nodeOk<Plan>(buyer.node, 'GET', '/api/marketplace/plan')).source).toMatchObject({ kind: 'account', accountId, discountBps: ACCOUNT.discountBps });

    const operate = await market.open('operate', UI.seller);
    await expect(operate).toHaveAttribute('data-state', 'active');
    await expect(market.ledger().getByTestId('mkt-ledger-counts')).toHaveText('0 served · 0 sent · 2 landed · 0 refused · 0 missed');
    await expect(page.getByTestId('mkt-batches').getByRole('row')).toHaveCount(2);
    const plans = await market.open('plans', UI.buyer);
    await expect(plans).toHaveAttribute('data-state', 'active');
    await expect(page.getByTestId('mkt-next-epoch')).toHaveAttribute('data-funded', 'true');
    await expect(page.getByTestId('mkt-next-epoch')).toContainText(`Epoch ${epoch + 1} is funded`);
    await expect(page.getByTestId('mkt-next-epoch')).toContainText(`for ${tracOf(cost)} TRAC, from account ${accountId}`);

    // Past the end.
    await advanceChainTime(start.endsAt + 30 - (await epochTimes()).now);
    expect((await epochTimes()).epoch).toBe(epoch + 1);

    // The buyer: the ended epoch's reconciliation is final, every receipt it held landed and matched.
    await expect.poll(async () => {
      const r = await nodeOk<ReconciliationAnswer>(buyer.node, 'GET', `/api/marketplace/reconciliation?epoch=${epoch}`);
      return { final: r.final, rows: r.rows.map((row) => `${row.serviceId}: ${row.held.count} held, ${row.landed.count} landed, ${row.landed.matched} matched`).sort() };
    }, { message: `the buyer's reconciliation of epoch ${epoch} is final`, timeout: 60_000, intervals: [3_000] }).toEqual({
      final: true,
      rows: [`${CHAT.serviceId}: 0 held, 1 landed, 1 matched`, `${REASONER.serviceId}: 0 held, 1 landed, 1 matched`].sort(),
    });
    await market.open('plans', UI.buyer);
    await expect(page.getByTestId('mkt-subscription')).toHaveAttribute('data-epoch', String(epoch + 1));
    const reconciliation = page.getByTestId('mkt-reconciliation');
    await reconciliation.getByTestId(`mkt-recon-${epoch}`).click();
    await expect(reconciliation).toHaveAttribute('data-epoch', String(epoch));
    await expect(reconciliation.getByTestId('mkt-recon-body')).toHaveAttribute('data-final', 'true');
    await expect(reconciliation.getByTestId('mkt-recon-body')).toContainText("Final: 2 receipts landed, 2 matched this node's · 0 held");

    // The seller: the ended epoch with its pool, all that was funded for it, and its gross, the whole pool but for rounding.
    await expect.poll(async () => (await sellerStatus()).ended.some((e) => e.epoch === epoch), {
      message: `the seller's Operate lists epoch ${epoch} as ended`,
      timeout: 60_000,
      intervals: [3_000],
    }).toBe(true);
    const ended = (await sellerStatus()).ended.find((e) => e.epoch === epoch)!;
    expect(BigInt(ended.pool)).toBe(funded);
    expect(funded - BigInt(ended.gross) <= 2n && BigInt(ended.gross) <= funded, `gross ${ended.gross} is the pool ${ended.pool} but for 2 wei at most`).toBe(true);
    await market.open('operate', UI.seller);
    const row = page.getByTestId('mkt-ended').getByRole('row').filter({ hasText: `epoch ${epoch}` });
    await expect(row).toContainText(`gross ${tracOf(BigInt(ended.gross))} TRAC`);
    await expect(row).toContainText(`pool ${tracOf(funded)} TRAC`);

    // The new epoch's price, set on Operate the epoch before, is the one Browse lists now.
    await market.open('browse', UI.buyer);
    await expect(market.card(CHAT.serviceId)).toContainText(`${microOf(NEXT_CHAT_PRICE)} µTRAC/tok`);
    await expect(market.card(REASONER.serviceId)).toContainText(`${microOf(REASONER.pricePerUnit)} µTRAC/tok`);
  });
});
