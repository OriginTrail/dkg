// @vitest-environment happy-dom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarketplaceView } from '../src/ui/marketplace/views/MarketplaceView.js';
import { PlansView } from '../src/ui/marketplace/views/PlansView.js';
import { AccessView } from '../src/ui/marketplace/views/AccessView.js';
import { OperateView } from '../src/ui/marketplace/views/OperateView.js';
import { MISSING_COPY, byTestId, render, unmountAll, waitForText } from './helpers/marketplace-render.js';

/** A node without the marketplace routes: every one of them answers 404, naming nothing. */
function nodeWithoutMarketplace(): string[] {
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  });
  return asked;
}

describe('marketplace on a node without it', () => {
  afterEach(unmountAll);

  for (const [name, view, testId] of [
    ['Browse', MarketplaceView, 'mkt-marketplace'],
    ['Plans', PlansView, 'mkt-plans'],
    ['Access', AccessView, 'mkt-access'],
    ['Operate', OperateView, 'mkt-operate'],
  ] as const) {
    it(`says so plainly on ${name}, with no error`, async () => {
      const asked = nodeWithoutMarketplace();
      const c = await render(React.createElement(view));
      await waitForText(c, 'The NS Marketplace isn\'t available on this node');
      expect(byTestId(c, testId)?.getAttribute('data-state')).toBe('absent');
      expect(c.textContent).toContain('This node answers no NS Marketplace routes');
      expect(byTestId(c, 'mkt-error-card')).toBeNull();
      expect(c.querySelector('[role="alert"]')).toBeNull();
      expect(c.textContent).not.toMatch(/Not found|HTTP 404|no such route/);
      expect(c.textContent).not.toContain(MISSING_COPY);
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.every((u) => u.startsWith('/api/marketplace/'))).toBe(true);
    });
  }
});
