/**
 * A top-up, on the buyer node. The reasoner's budget is too small for one
 * call, so the playground meets its soft ceiling, charges nothing and offers
 * a top-up. Plans takes it from there: the dry run says what it would cost
 * from the subscription's source, Confirm sends it, the budget grows, and
 * the same chat is then served.
 */
import type { SubscriptionsAnswer } from '../../../src/ui/marketplace/api/types.js';
import { test, expect } from '../fixtures.js';
import { epochTimes, nodeOk, readSetup } from '../devnet.js';
import { PLAN, REASONER, STUB_UNITS, UI, callValueOf, stubAnswerOf, tracOf, weiOfTrac } from '../topology.js';

const budgetValueOf = async (node: number, serviceId: string): Promise<bigint> => {
  const { subscriptions } = await nodeOk<SubscriptionsAnswer>(node, 'GET', '/api/marketplace/subscriptions');
  const { epoch } = await epochTimes();
  const budget = subscriptions.find((s) => s.epoch === epoch)?.budgets.find((b) => b.serviceId === serviceId);
  if (!budget) throw new Error(`no budget for ${serviceId} in epoch ${epoch}`);
  return BigInt(budget.value);
};

test.describe('Top-up', () => {
  test("tops up a budget at its soft ceiling: a dry run, then Confirm, and the call goes through", async ({ market, page }) => {
    const { seller, buyer } = readSetup();
    const { epoch } = await epochTimes();
    const before = weiOfTrac(PLAN.reasonerTrac);
    const added = weiOfTrac(PLAN.topUpTrac);
    expect(await budgetValueOf(buyer.node, REASONER.serviceId)).toBe(before);

    // The call could cost more than 95% of the budget: nothing is sent, and the playground offers the top-up.
    await market.open('browse', UI.buyer);
    await market.view('Playground');
    await market.chat(REASONER.serviceId, 'Reason about this.');
    const fork = page.getByTestId('mkt-fork-ceiling');
    await expect(fork).toContainText('This budget is at its soft ceiling — nothing was charged');
    await fork.getByTestId('mkt-fork-topup').click();

    // Plans opens on the top-up of that budget, with its cap kept.
    const topUp = page.getByTestId('mkt-topup');
    await expect(topUp).toContainText(`Top up ${REASONER.name} for epoch ${epoch}`);
    await expect(topUp.getByTestId('mkt-topup-cap')).toBeDisabled();
    await topUp.getByTestId('mkt-topup-amount').fill(PLAN.topUpTrac);
    await expect(topUp).toContainText(`The budget becomes ${tracOf(before + added)} TRAC`);
    // The dry run: from the subscription's source, the buyer wallet, at no discount; nothing sent yet.
    await expect(market.dryRun()).toContainText(`Costs ${tracOf(added)} TRAC from the buyer wallet for epoch ${epoch}`);
    await expect(market.dryRun()).toHaveAttribute('data-refusal', '');
    expect(await budgetValueOf(buyer.node, REASONER.serviceId)).toBe(before);

    await topUp.getByTestId('mkt-topup-confirm').click();
    const sent = page.getByTestId('mkt-topup-sent');
    await expect(sent).toContainText(`${REASONER.name} topped up · tx 0x`, { timeout: 60_000 });
    expect(await budgetValueOf(buyer.node, REASONER.serviceId)).toBe(before + added);
    await sent.getByRole('button', { name: 'Done' }).click();
    await expect(market.meter(REASONER.serviceId)).toContainText(`0 landed · 0 held · ${tracOf(before + added)} left of ${tracOf(before + added)} TRAC`);

    // The same chat now fits under the ceiling, and the seller serves it.
    await market.open('browse', UI.buyer);
    await market.view('Playground');
    await market.chat(REASONER.serviceId, 'Reason about this.');
    const { bubble, served } = market.lastAnswer();
    await expect(bubble).toHaveText(stubAnswerOf(REASONER.backendModel), { timeout: 60_000 });
    const value = callValueOf(REASONER);
    await expect(served).toHaveText(
      `via seller ${seller.identityId} · ${STUB_UNITS} tokens · ${tracOf(value)} TRAC · ${tracOf(before + added - value)} TRAC left in this budget`,
    );
  });
});
