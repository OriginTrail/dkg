/**
 * Browse, on the buyer node: the catalog lists what the seller node offers in
 * the Marketplace Context Graph, at its prices, and the service's page and the
 * seller's storefront both name the seller.
 */
import { test, expect } from '../fixtures.js';
import { readSetup } from '../devnet.js';
import { SERVICES, UI, microOf } from '../topology.js';

test.describe('Browse', () => {
  test("lists each of the seller's services at its price", async ({ market }) => {
    const { seller } = readSetup();
    const root = await market.open('browse', UI.buyer);
    await expect(root).toHaveAttribute('data-state', 'ok');
    await expect(market.sellerChip(seller.identityId)).toContainText(`seller ${seller.identityId}`);
    for (const s of SERVICES) {
      const card = market.card(s.serviceId);
      await expect(card.getByRole('heading')).toHaveText(s.name);
      await expect(card).toContainText(`via seller ${seller.identityId}`);
      await expect(card).toContainText(`${microOf(s.pricePerUnit)} µTRAC/tok`);
      // A llama.cpp backend on loopback is offered as weights-pinned.
      await expect(card).toContainText('Weights verified');
      // Nothing funds it yet, so it can be added to a plan.
      await expect(card.getByTestId(`mkt-add-${s.serviceId}`)).toBeEnabled();
    }
  });

  test("a service's page and the seller's storefront show the seller", async ({ market, page }) => {
    const { seller } = readSetup();
    const [chat] = SERVICES;
    await market.open('browse', UI.buyer);
    await market.card(chat.serviceId).click();

    const servicePage = page.getByTestId('mkt-model-page');
    await expect(servicePage).toHaveAttribute('data-service', chat.serviceId);
    await expect(servicePage.getByRole('heading', { level: 1 })).toContainText(chat.name);
    await expect(servicePage).toContainText(chat.model);
    const row = servicePage.getByTestId(`mkt-provider-${seller.identityId}`);
    await expect(row).toContainText(`seller ${seller.identityId}`);
    await expect(row).toContainText(`${microOf(chat.pricePerUnit)} µTRAC/tok`);

    await row.getByTestId(`mkt-open-seller-${seller.identityId}`).click();
    const store = page.getByTestId('mkt-storefront');
    await expect(store).toHaveAttribute('data-seller', String(seller.identityId));
    await expect(store.getByRole('heading', { level: 1 })).toContainText(`seller ${seller.identityId}`);
    // A Core Node: its profile and its place in the sharding table, each marked as met.
    for (const requirement of [/^Profile$/, /^In the sharding table$/]) {
      await expect(store.locator('.mkt-corenode-item', { hasText: requirement }).locator('[aria-label="yes"]')).toBeVisible();
    }
    for (const s of SERVICES) {
      await expect(store.getByTestId(`mkt-store-offer-${s.serviceId}`)).toContainText(`${microOf(s.pricePerUnit)} µTRAC/tok`);
    }
  });
});
