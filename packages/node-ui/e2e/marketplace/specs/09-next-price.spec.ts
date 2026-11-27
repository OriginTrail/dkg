/**
 * The next epoch's price, set on the seller's Operate. Calls in this epoch
 * keep this epoch's price; the seller shares its offer for the next epoch
 * again, and the buyer's catalog shows the new price beside this one's.
 */
import type { CatalogAnswer, SellerStatus } from '../../../src/ui/marketplace/api/types.js';
import { test, expect } from '../fixtures.js';
import { nodeOk, readSetup } from '../devnet.js';
import { CHAT, NEXT_CHAT_PRICE, UI, microOf } from '../topology.js';

test.describe("The next epoch's price", () => {
  test('the seller sets it on Operate, and the buyer sees it beside this epoch\'s', async ({ market, page }) => {
    const { seller, buyer } = readSetup();

    await market.open('operate', UI.seller);
    const offering = market.offering(CHAT.serviceId);
    await expect(offering).toContainText('same price next epoch');
    await offering.getByTestId(`mkt-ask-input-${CHAT.serviceId}`).fill(microOf(NEXT_CHAT_PRICE));
    await offering.getByTestId(`mkt-ask-queue-${CHAT.serviceId}`).click();
    await expect(offering).toContainText(`next epoch: ${microOf(NEXT_CHAT_PRICE)} µTRAC`);
    await expect(offering).toContainText(`${microOf(CHAT.pricePerUnit)} µTRAC/tok`);
    const offerings = (await nodeOk<SellerStatus>(seller.node, 'GET', '/api/marketplace/seller')).offerings;
    expect(offerings.find((o) => o.serviceId === CHAT.serviceId)).toMatchObject({ price: String(CHAT.pricePerUnit), nextPrice: String(NEXT_CHAT_PRICE) });

    // The buyer's catalog: the seller's new copy of its offer for the next epoch.
    await expect.poll(async () => {
      const { services } = await nodeOk<CatalogAnswer>(buyer.node, 'GET', '/api/marketplace/catalog');
      return services.find((s) => s.serviceId === CHAT.serviceId)?.offers.find((o) => o.seller === seller.identityId)?.nextPricePerUnit;
    }, { message: "the buyer's catalog has the seller's price for the next epoch", timeout: 120_000, intervals: [3_000] }).toBe(String(NEXT_CHAT_PRICE));
    await market.open('browse', UI.buyer);
    await market.card(CHAT.serviceId).click();
    const row = page.getByTestId('mkt-model-page').getByTestId(`mkt-provider-${seller.identityId}`);
    await expect(row).toContainText(`${microOf(CHAT.pricePerUnit)} µTRAC/tok`);
    await expect(row).toContainText(`next epoch ${microOf(NEXT_CHAT_PRICE)} µTRAC`);
  });
});
