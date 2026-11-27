/**
 * The playground, on the buyer node: a chat through the node's gateway, paid
 * from this epoch's subscription. The answer is the stub model's, served by
 * the seller node over the network, and the line under it says who served it,
 * how many tokens it came to and what it cost. Plans then shows the budget
 * used: held by this node until the seller lands its receipt.
 */
import type { ActivityAnswer } from '../../../src/ui/marketplace/api/types.js';
import { test, expect } from '../fixtures.js';
import { nodeOk, readSetup } from '../devnet.js';
import { CHAT, PLAN, PORTS, STUB_UNITS, UI, callValueOf, stubAnswerOf, tracOf, weiOfTrac } from '../topology.js';

const stubCalls = async (): Promise<Record<string, number>> =>
  (await fetch(`http://127.0.0.1:${PORTS.stub}/calls`)).json() as Promise<Record<string, number>>;

test.describe('Playground', () => {
  test('sends a chat: the answer names the seller, its tokens and its value, and Plans shows the budget used', async ({ market, page }) => {
    const { seller, buyer } = readSetup();
    const value = callValueOf(CHAT);
    const budget = weiOfTrac(PLAN.chatTrac);
    const before = (await stubCalls())[CHAT.backendModel] ?? 0;

    await market.open('browse', UI.buyer);
    await market.view('Playground');
    await expect(market.playground()).toHaveAttribute('data-mode', 'chat');
    await market.chat(CHAT.serviceId, 'Which node serves this answer?');

    const { bubble, served } = market.lastAnswer();
    await expect(bubble).toHaveText(stubAnswerOf(CHAT.backendModel), { timeout: 60_000 });
    await expect(served).toHaveText(
      `via seller ${seller.identityId} · ${STUB_UNITS} tokens · ${tracOf(value)} TRAC · ${tracOf(budget - value)} TRAC left in this budget`,
    );
    // The page made its own key for the gateway, and the seller's backend ran once.
    await expect(market.playground().getByTestId('mkt-play-key')).toContainText('dkgmk_');
    expect((await stubCalls())[CHAT.backendModel]).toBe(before + 1);

    // Plans: held, not landed, until the seller lands the receipt; the call is in this epoch's activity.
    await market.open('plans', UI.buyer);
    await expect(market.meter(CHAT.serviceId)).toContainText(`0 landed · ${tracOf(value)} held · ${tracOf(budget - value)} left of ${PLAN.chatTrac} TRAC`);
    const activity = page.getByTestId('mkt-activity');
    await expect(activity.getByRole('row')).toHaveCount(1);
    await expect(activity.getByRole('row').first()).toContainText(`${STUB_UNITS} tokens · ${tracOf(value)} TRAC`);
    await expect(activity.getByRole('row').first()).toContainText(`seller ${seller.identityId}`);
    await expect(activity.getByRole('row').first()).toHaveAttribute('data-state', 'held');
    const { calls } = await nodeOk<ActivityAnswer>(buyer.node, 'GET', '/api/marketplace/activity');
    expect(calls).toEqual([expect.objectContaining({ serviceId: CHAT.serviceId, seller: seller.identityId, units: STUB_UNITS, value: String(value), state: 'held' })]);
  });
});
