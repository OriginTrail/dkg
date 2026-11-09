// @vitest-environment happy-dom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccessView } from '../src/ui/marketplace/views/AccessView.js';
import { FIXTURE_IDS, FIXTURE_SECRET, fixtureFetch } from '../src/ui/marketplace/api/fixtures.js';
import { MISSING_COPY, byTestId, click, render, type, unmountAll, useFixtureNode, waitForText } from './helpers/marketplace-render.js';

const access = () => React.createElement(AccessView);

describe('marketplace Access', () => {
  afterEach(unmountAll);

  it('lists the keys in TRAC: spent and left, services, rate, expiry, last use and the mix', async () => {
    useFixtureNode('active');
    const c = await render(access());
    await waitForText(c, 'my-agent');
    const agent = byTestId(c, 'mkt-key-dkgmk_1a2b3c4d');
    expect(agent?.textContent).toContain('0.61 of 2 TRAC spent · 1.39 TRAC left');
    expect(agent?.textContent).toContain('Every service this epoch\'s subscription funds · 5 rps · never · last used 5 min ago');
    expect(agent?.textContent).toContain('31% of budget');
    expect(agent?.textContent).toContain('mostly qwen2.5-14b-instruct');
    expect(byTestId(c, 'mkt-key-dkgmk_5e6f7a8b')?.textContent).toContain('2 services · 2 rps · expires in 23 d');
    expect(byTestId(c, 'mkt-key-dkgmk_9c0d1e2f')?.getAttribute('data-revoked')).toBe('true');
    expect(c.textContent).not.toContain(MISSING_COPY);
  });

  it('mints a key with the budget, services, rate and expiry entered, and shows its secret once, with the gateway\'s base URL', async () => {
    // Only the clock is fixed, so the expiry is exact; timers stay real.
    const now = Date.UTC(2026, 10, 9, 12, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    try {
      const writes: Array<{ method: string; url: string; body: unknown }> = [];
      const node = fixtureFetch('active');
      vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method && init.method !== 'GET') writes.push({ method: init.method, url: String(input), body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
        return node(input, init);
      });
      const c = await render(access());
      await waitForText(c, 'my-agent');
      await click(byTestId(c, 'mkt-mint-open'));
      await type(byTestId(c, 'mkt-mint-label'), 'ci-runner');
      await type(byTestId(c, 'mkt-mint-budget'), '0.25');
      await type(byTestId(c, 'mkt-mint-expiry'), '30');
      await click(byTestId(c, 'mkt-mint-all'));
      await click(byTestId(c, `mkt-mint-service-${FIXTURE_IDS.qwen7b}`));
      await click(byTestId(c, `mkt-mint-service-${FIXTURE_IDS.llama8b}`));
      await type(byTestId(c, 'mkt-mint-rps'), '7');
      await click(byTestId(c, 'mkt-mint'));
      await waitForText(c, 'Your new key');
      expect(writes).toEqual([{
        method: 'POST', url: '/api/marketplace/keys',
        body: { label: 'ci-runner', budget: '250000000000000000', services: [FIXTURE_IDS.qwen7b, FIXTURE_IDS.llama8b], rps: 7, expiresAt: now / 1000 + 30 * 86_400 },
      }]);
      const plaintext = byTestId(c, 'mkt-key-plaintext')?.textContent ?? '';
      expect(plaintext).toMatch(new RegExp(`api_key\\s+= "${FIXTURE_SECRET}"`));
      expect(plaintext).toContain('/api/marketplace/v1');
      await click(byTestId(c, 'mkt-key-done'));
      expect(byTestId(c, 'mkt-key-plaintext')).toBeNull();
      expect(c.textContent).not.toContain(FIXTURE_SECRET);
    } finally {
      vi.useRealTimers();
    }
  });

  it('needs the node-admin token', async () => {
    useFixtureNode('viewer');
    const c = await render(access());
    await waitForText(c, 'This needs the node-admin token');
    expect(byTestId(c, 'mkt-access')?.getAttribute('data-state')).toBe('admin');
  });
});
