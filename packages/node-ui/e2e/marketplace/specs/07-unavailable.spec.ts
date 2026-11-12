/**
 * Where the marketplace is off. A node without `marketplace.enabled` shows
 * every marketplace tab as unavailable, and says what it would need; a node
 * that buys but does not sell shows Operate as selling being off.
 */
import { test, expect } from '../fixtures.js';
import { nodeCall, readSetup } from '../devnet.js';
import { UI } from '../topology.js';
import type { MarketplaceTab } from '../../pages/marketplace.po.js';

test.describe('Where the marketplace is off', () => {
  for (const tab of ['browse', 'plans', 'access'] as const satisfies readonly MarketplaceTab[]) {
    test(`${tab} on a node without the marketplace says it is off`, async ({ market }) => {
      const { plain } = readSetup();
      expect((await nodeCall<{ code?: string }>(plain.node, 'GET', '/api/marketplace/catalog')).body.code).toBe('MarketplaceOff');
      const root = await market.open(tab, UI.plain);
      await expect(root).toHaveAttribute('data-state', 'off');
      const card = root.getByTestId('mkt-off');
      await expect(card).toContainText('The NS Marketplace is off on this node');
      await expect(card).toContainText("It needs marketplace.enabled in the node's config");
    });
  }

  test('Operate on a node without the marketplace says selling is off', async ({ market }) => {
    const root = await market.open('operate', UI.plain);
    await expect(root).toHaveAttribute('data-state', 'inactive');
    await expect(root.getByTestId('mkt-operate-inactive')).toContainText('Selling is off on this node');
  });

  test('Operate on the buyer node, which does not sell, says selling is off', async ({ market }) => {
    const root = await market.open('operate', UI.buyer);
    await expect(root).toHaveAttribute('data-state', 'inactive');
    await expect(root.getByTestId('mkt-operate-inactive')).toContainText('Selling is off on this node');
    await expect(root.getByTestId('mkt-operate-inactive')).toContainText('marketplace.seller.enabled');
  });
});
