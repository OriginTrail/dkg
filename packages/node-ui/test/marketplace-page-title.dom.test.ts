// @vitest-environment happy-dom
// Every Marketplace page has one owner for its frame and title (MarketplacePage), so each
// state it can be in (loading, off, admin-needed, an error, the page itself) shows exactly
// one page heading, the page's own.
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_SCENARIOS } from '../src/ui/marketplace/api/fixtures.js';
import { MarketplaceView } from '../src/ui/marketplace/views/MarketplaceView.js';
import { PlansView } from '../src/ui/marketplace/views/PlansView.js';
import { AccessView } from '../src/ui/marketplace/views/AccessView.js';
import { OperateView } from '../src/ui/marketplace/views/OperateView.js';
import { MARKETPLACE_TABS } from '../src/ui/marketplace/tabs.js';
import { flush, render, unmountAll, useFixtureNode } from './helpers/marketplace-render.js';

const PAGES = [
  { view: MarketplaceView, testId: 'mkt-marketplace', title: MARKETPLACE_TABS.browse.label },
  { view: PlansView, testId: 'mkt-plans', title: MARKETPLACE_TABS.plans.label },
  { view: AccessView, testId: 'mkt-access', title: MARKETPLACE_TABS.access.label },
  { view: OperateView, testId: 'mkt-operate', title: MARKETPLACE_TABS.operate.label },
];

function headings(c: HTMLElement) {
  const frame = c.querySelector('.mkt-frame');
  return {
    state: frame?.getAttribute('data-state'),
    testId: frame?.getAttribute('data-testid'),
    h1s: [...c.querySelectorAll('h1')].map((h) => ({ text: h.textContent, shared: h.classList.contains('ds-page-title') })),
  };
}

describe('Marketplace page titles', () => {
  afterEach(unmountAll);

  for (const { view, testId, title } of PAGES) {
    it(`${title}: one page title in every state`, async () => {
      const seen = new Set<string>();
      for (const scenario of FIXTURE_SCENARIOS) {
        useFixtureNode(scenario);
        const c = await render(React.createElement(view as React.FC));
        // The first frame is the loading state; then whatever the node's answers lead to.
        for (const _ of [0, 1]) {
          const h = headings(c);
          seen.add(h.state ?? '');
          expect(h.testId).toBe(testId);
          expect(h.h1s).toEqual([{ text: title, shared: true }]);
          await flush(50);
        }
        await unmountAll();
      }
      // The check ran over more than one state of the page.
      expect(seen.size).toBeGreaterThan(1);
    });
  }
});
