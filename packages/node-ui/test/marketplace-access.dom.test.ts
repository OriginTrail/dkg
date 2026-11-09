// @vitest-environment happy-dom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccessView } from '../src/ui/marketplace/views/AccessView.js';
import { FIXTURE_IDS, FIXTURE_SECRET, fixtureFetch } from '../src/ui/marketplace/api/fixtures.js';
import type { KeysAnswer } from '../src/ui/marketplace/api/types.js';
import { MISSING_COPY, byTestId, click, flush, render, type, unmountAll, useFixtureNode, waitForText } from './helpers/marketplace-render.js';

const access = () => React.createElement(AccessView);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function waitUntil(check: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await flush(10);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/**
 * The fixture node, keeping each write, whose keys stay as revoked once it
 * takes a revoke, so the next read of the keys shows it; with `refuse`, every
 * revoke gets that answer instead.
 */
function keysNode(refuse?: () => Response): Array<{ method: string; url: string; body: unknown }> {
  const writes: Array<{ method: string; url: string; body: unknown }> = [];
  const revoked = new Set<string>();
  const node = fixtureFetch('active');
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    if (method !== 'GET') writes.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const revoke = /^\/api\/marketplace\/keys\/([^/]+)\/revoke$/.exec(url);
    if (method === 'POST' && revoke) {
      if (refuse) return refuse();
      revoked.add(decodeURIComponent(revoke[1]));
    }
    const res = await node(input, init);
    if (method !== 'GET' || url !== '/api/marketplace/keys') return res;
    const { keys } = await res.json() as KeysAnswer;
    return json({ keys: keys.map((k) => (revoked.has(k.keyId) ? { ...k, revoked: true } : k)) });
  });
  return writes;
}

const CI_KEY = 'dkgmk_5e6f7a8b';

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

  it('counts what a key holds for calls not yet settled against its budget, beside what it spent', async () => {
    useFixtureNode('active');
    const c = await render(access());
    await waitForText(c, 'ci-bot');
    // 0.09 spent and 0.2 reserved of 0.5: the gateway takes calls only within the 0.21 left.
    const bot = byTestId(c, 'mkt-key-dkgmk_5e6f7a8b');
    expect(bot?.textContent).toContain('0.09 of 0.5 TRAC spent · 0.2 TRAC reserved · 0.21 TRAC left');
    expect(bot?.textContent).toContain('58% of budget');
    // A key with nothing reserved reads as before.
    expect(byTestId(c, 'mkt-key-dkgmk_1a2b3c4d')?.textContent).toContain('0.61 of 2 TRAC spent · 1.39 TRAC left');
    expect(byTestId(c, 'mkt-reserved-note')?.textContent).toContain('Reserved is held for calls not yet settled');
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

  it('revokes a key: the request names that key, and its row then shows it revoked', async () => {
    const writes = keysNode();
    const c = await render(access());
    await waitForText(c, 'ci-bot');
    const row = () => byTestId(c, `mkt-key-${CI_KEY}`);
    expect(row()?.getAttribute('data-revoked')).toBe('false');
    await click(byTestId(c, `mkt-revoke-${CI_KEY}`));
    await waitUntil(() => row()?.getAttribute('data-revoked') === 'true', 'the row to show the key revoked');
    expect(writes).toEqual([{ method: 'POST', url: `/api/marketplace/keys/${CI_KEY}/revoke`, body: {} }]);
    expect(row()?.textContent).toContain('Revoked — stops at the next call');
    expect(byTestId(c, `mkt-revoke-${CI_KEY}`)).toBeNull();
    // The other active key stays as it was.
    expect(byTestId(c, 'mkt-key-dkgmk_1a2b3c4d')?.getAttribute('data-revoked')).toBe('false');
    expect(byTestId(c, 'mkt-revoke-dkgmk_1a2b3c4d')).toBeTruthy();
  });

  it('shows a refused revoke on its key\'s row, and the key stays active', async () => {
    const writes = keysNode(() => json({ error: `KeyNotFound(${CI_KEY})`, code: 'KeyNotFound', args: [CI_KEY], retryable: false }, 404));
    const c = await render(access());
    await waitForText(c, 'ci-bot');
    await click(byTestId(c, `mkt-revoke-${CI_KEY}`));
    await waitForText(c, 'Couldn\'t revoke the key');
    const row = byTestId(c, `mkt-key-${CI_KEY}`);
    const cards = c.querySelectorAll('[data-testid="mkt-error-card"]');
    expect(cards).toHaveLength(1);
    expect(row?.contains(cards[0])).toBe(true);
    expect(cards[0].getAttribute('data-code')).toBe('KeyNotFound');
    expect(row?.textContent).toContain('No such key');
    expect(row?.getAttribute('data-revoked')).toBe('false');
    expect(row?.textContent).not.toContain('Revoked — stops at the next call');
    expect((byTestId(c, `mkt-revoke-${CI_KEY}`) as HTMLButtonElement).disabled).toBe(false);
    expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual([`POST /api/marketplace/keys/${CI_KEY}/revoke`]);
  });

  it('needs the node-admin token', async () => {
    useFixtureNode('viewer');
    const c = await render(access());
    await waitForText(c, 'This needs the node-admin token');
    expect(byTestId(c, 'mkt-access')?.getAttribute('data-state')).toBe('admin');
  });
});
