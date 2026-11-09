/**
 * The marketplace specs' fixtures: the default suite's (and its guard against
 * a page that fell back to demo data), and the marketplace page object.
 */
import { test as base } from '../fixtures/base.js';
import { MarketplacePage } from '../pages/marketplace.po.js';

export const test = base.extend<{ market: MarketplacePage }>({
  market: async ({ page }, use) => {
    await use(new MarketplacePage(page));
  },
});

export { expect } from '@playwright/test';
