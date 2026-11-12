/**
 * Plans, on the buyer node: a node that never subscribed funds this epoch's
 * plan from its buyer wallet. The composer's dry run says what it costs
 * before anything is sent; Confirm sends that same request from the node, and
 * the plan then shows each budget.
 */
import type { SubscriptionsAnswer } from '../../../src/ui/marketplace/api/types.js';
import { test, expect } from '../fixtures.js';
import { epochTimes, nodeOk, readSetup } from '../devnet.js';
import { CHAT, PLAN, REASONER, UI, tracOf, weiOfTrac } from '../topology.js';

test.describe('Plans', () => {
  test("funds this epoch's plan from the buyer wallet: a dry run, then Confirm", async ({ market, page }) => {
    const { buyer } = readSetup();
    const { epoch } = await epochTimes();
    const total = tracOf(weiOfTrac(PLAN.chatTrac) + weiOfTrac(PLAN.reasonerTrac));

    const root = await market.open('plans', UI.buyer);
    await expect(root, 'the buyer node must not have subscribed this epoch: run the lane on a fresh devnet').toHaveAttribute('data-state', 'never-subscribed');
    await expect(page.getByTestId('mkt-buyer-wallet')).toContainText(buyer.wallet);

    const flow = page.getByTestId('mkt-fund-flow');
    await expect(flow).toHaveAttribute('data-phase', 'compose');
    await expect(page.getByTestId('mkt-epoch-current')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('mkt-source-wallet')).toHaveAttribute('aria-checked', 'true');
    await market.pickService(CHAT.serviceId, PLAN.chatTrac);
    await market.pickService(REASONER.serviceId, PLAN.reasonerTrac);

    // The dry run: what this request costs from the wallet, with nothing sent.
    const dryRun = market.dryRun();
    await expect(dryRun).toContainText(`Costs ${total} TRAC from the buyer wallet for epoch ${epoch}`);
    await expect(dryRun).toHaveAttribute('data-refusal', '');
    expect((await nodeOk<SubscriptionsAnswer>(buyer.node, 'GET', '/api/marketplace/subscriptions')).subscriptions).toEqual([]);

    await page.getByTestId('mkt-compose-continue').click();
    const gate = page.getByTestId('mkt-confirm-gate');
    await expect(gate.getByTestId('mkt-gate-source')).toContainText(`Epoch ${epoch}, paid from the buyer wallet`);
    const lines = gate.getByTestId('mkt-gate-lines').getByRole('row');
    await expect(lines).toHaveCount(2);
    await expect(lines.filter({ hasText: CHAT.name })).toContainText(`${PLAN.chatTrac} TRAC`);
    await expect(lines.filter({ hasText: REASONER.name })).toContainText(`${PLAN.reasonerTrac} TRAC`);
    await expect(gate.getByTestId('mkt-gate-total')).toContainText(`${total} TRAC of service · costs ${total} TRAC`);
    await gate.getByTestId('mkt-gate-confirm').click();

    await expect(page.getByTestId('mkt-funded')).toContainText(`Epoch ${epoch} is funded with ${total} TRAC`, { timeout: 60_000 });
    const [subscription] = (await nodeOk<SubscriptionsAnswer>(buyer.node, 'GET', '/api/marketplace/subscriptions')).subscriptions;
    expect(subscription).toMatchObject({ epoch, source: { kind: 'wallet' }, value: String(weiOfTrac(PLAN.chatTrac) + weiOfTrac(PLAN.reasonerTrac)) });

    // The plan shows each budget, with nothing used yet.
    await page.getByTestId('mkt-view-plan').click();
    await expect(root).toHaveAttribute('data-state', 'active');
    await expect(page.getByTestId('mkt-subscription')).toHaveAttribute('data-epoch', String(epoch));
    await expect(market.meter(CHAT.serviceId)).toContainText(`0 landed · 0 held · ${PLAN.chatTrac} left of ${PLAN.chatTrac} TRAC`);
    await expect(market.meter(REASONER.serviceId)).toContainText(`0 landed · 0 held · ${PLAN.reasonerTrac} left of ${PLAN.reasonerTrac} TRAC`);
  });
});
