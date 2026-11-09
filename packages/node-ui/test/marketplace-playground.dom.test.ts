// @vitest-environment happy-dom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarketplaceView } from '../src/ui/marketplace/views/MarketplaceView.js';
import { PLAYGROUND_KEY_STORAGE, forgetPlaygroundKey } from '../src/ui/marketplace/views/Playground.js';
import { FIXTURE_SECRET, fixtureFetch } from '../src/ui/marketplace/api/fixtures.js';
import { byTestId, click, flush, render, type, unmountAll, waitForText } from './helpers/marketplace-render.js';

/** The fixture node, keeping each call's method and path. */
function recordCalls(): string[] {
  const calls: string[] = [];
  const node = fixtureFetch('active');
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return node(input, init);
  });
  return calls;
}

async function openPlayground(): Promise<HTMLElement> {
  const c = await render(React.createElement(MarketplaceView));
  await waitForText(c, 'Playground');
  await click(Array.from(c.querySelectorAll('[role="tab"]')).find((t) => t.textContent === 'Playground'));
  await waitForText(c, 'qwen2.5-14b-instruct · 72% left');
  return c;
}

/** Wait until `n` answers stand in the chat, each with what it cost. */
async function waitUntilAnswers(c: HTMLElement, n: number): Promise<void> {
  const started = Date.now();
  while (c.querySelectorAll('[data-testid="mkt-served"]').length < n) {
    if (Date.now() - started > 2_000) throw new Error(`Timed out waiting for ${n} answers (have: ${(c.textContent ?? '').slice(0, 300)})`);
    await flush(10);
  }
}

async function send(c: HTMLElement, text: string): Promise<void> {
  await type(byTestId(c, 'mkt-play-input'), text);
  await click(byTestId(c, 'mkt-play-send'));
  await waitForText(c, 'A knowledge graph links facts');
}

const keyCalls = (calls: string[]) => calls.filter((x) => x.includes('/api/marketplace/keys'));

type Json = Record<string, unknown>;

/**
 * The fixture node with each access key's budget kept, as the gateway keeps
 * it: a key's calls count against the budget it was made with, and one that
 * would go past it is refused with key_budget. `exhaust()` spends what every
 * key has left; `topUp(wei)` adds to this epoch's subscription and its first
 * budget, as the reads of it then show.
 */
function keyBudgetNode() {
  const node = fixtureFetch('active');
  const calls: string[] = [];
  const keys = new Map<string, { keyId: string; budget: bigint; spent: bigint }>();
  let added = 0n;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Json : {};
    calls.push(method === 'POST' && url === '/api/marketplace/keys' ? `${method} ${url} ${String(body.budget)}` : `${method} ${url}`);
    const reply = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
    if (method === 'POST' && url === '/api/marketplace/keys') {
      const secret = `dkgmk_${String(keys.size + 1).padStart(48, '0')}`;
      const keyId = secret.slice(0, 14);
      keys.set(secret, { keyId, budget: BigInt(String(body.budget)), spent: 0n });
      return reply({ keyId, label: body.label, budget: body.budget, spent: '0', reserved: '0', services: null, rps: 2, expiresAt: body.expiresAt, revoked: false, lastUsedAt: null, secret });
    }
    if (method === 'POST' && /^\/api\/marketplace\/keys\/[^/]+\/revoke$/.test(url)) return reply({});
    if (method === 'POST' && url.endsWith('/v1/chat/completions')) {
      const key = keys.get(new Headers(init?.headers).get('Authorization')?.replace('Bearer ', '') ?? '');
      const res = await node(input, init);
      if (!key || res.status !== 200) return res;
      const answer = await res.json() as { marketplace: { value: string } };
      const cost = BigInt(answer.marketplace.value);
      if (key.spent + cost > key.budget) return reply({ error: { code: 'key_budget', message: "the call could cost more than the access key's budget has left", type: 'marketplace' } }, 402);
      key.spent += cost;
      return reply(answer);
    }
    if (method === 'GET' && url.startsWith('/api/marketplace/subscriptions') && added > 0n) {
      const answer = await (await node(input, init)).json() as { subscriptions: Json[] };
      for (const sub of answer.subscriptions) {
        if (sub.epoch !== 664) continue;
        sub.value = (BigInt(String(sub.value)) + added).toString();
        const [first] = sub.budgets as Json[];
        Object.assign(first, { value: (BigInt(String(first.value)) + added).toString(), left: (BigInt(String(first.left)) + added).toString() });
      }
      return reply(answer);
    }
    return node(input, init);
  });
  return {
    calls,
    exhaust() { for (const k of keys.values()) k.spent = k.budget; },
    topUp(wei: bigint) { added += wei; },
  };
}

describe('marketplace playground key', () => {
  afterEach(unmountAll);

  it('makes its key on the first send, not on load, and keeps only the keyId in storage', async () => {
    const calls = recordCalls();
    const c = await openPlayground();
    await flush(50);
    expect(keyCalls(calls)).toEqual([]);
    await send(c, 'What is a knowledge graph?');
    expect(keyCalls(calls)).toEqual(['POST /api/marketplace/keys']);
    expect(localStorage.getItem(PLAYGROUND_KEY_STORAGE)).toBe(FIXTURE_SECRET.slice(0, 14));
    const stored = Array.from({ length: localStorage.length }, (_, i) => localStorage.getItem(localStorage.key(i)!) ?? '');
    expect(stored.some((v) => v.includes(FIXTURE_SECRET))).toBe(false);
  });

  it('revokes the key an earlier page made before it makes a new one', async () => {
    localStorage.setItem(PLAYGROUND_KEY_STORAGE, 'dkgmk_1a2b3c4d');
    forgetPlaygroundKey();
    const calls = recordCalls();
    const c = await openPlayground();
    await send(c, 'hello');
    expect(keyCalls(calls)).toEqual(['POST /api/marketplace/keys/dkgmk_1a2b3c4d/revoke', 'POST /api/marketplace/keys']);
    expect(calls.indexOf('POST /api/marketplace/v1/chat/completions')).toBeGreaterThan(calls.indexOf('POST /api/marketplace/keys'));
    expect(localStorage.getItem(PLAYGROUND_KEY_STORAGE)).toBe(FIXTURE_SECRET.slice(0, 14));
  });

  it('still makes a key and answers when that revoke fails', async () => {
    // The node knows no such key: it expired, or was revoked elsewhere.
    localStorage.setItem(PLAYGROUND_KEY_STORAGE, 'dkgmk_deadbeef');
    forgetPlaygroundKey();
    const calls = recordCalls();
    const c = await openPlayground();
    await send(c, 'hello');
    expect(keyCalls(calls)).toEqual(['POST /api/marketplace/keys/dkgmk_deadbeef/revoke', 'POST /api/marketplace/keys']);
    expect(byTestId(c, 'mkt-served')?.textContent).toContain('via seller 12');
    expect(localStorage.getItem(PLAYGROUND_KEY_STORAGE)).toBe(FIXTURE_SECRET.slice(0, 14));
  });

  /** A gateway refusal as the node sends it. */
  const refused = (status: number, code: string) => () => new Response(JSON.stringify({ error: { code, message: code, type: 'marketplace' } }), { status });
  /** The answer comes from the node, which served and charged the call, but stops partway through its body. */
  const cutOff = async (served: () => Promise<Response>) => { const text = await (await served()).text(); return new Response(text.slice(0, Math.floor(text.length / 2)), { status: 200 }); };
  const unreachable = () => Promise.reject(new TypeError('Failed to fetch'));
  /** The gateway too busy to take the call, as it answers before calling anyone: with Retry-After. */
  const busy = (status: number, code: string) => () => new Response(JSON.stringify({ error: { code, message: code, type: 'marketplace' } }), { status, headers: { 'Retry-After': '5' } });
  const outcomes: Array<[string, { chat?: (served: () => Promise<Response>) => Response | Promise<Response>; keys?: () => Promise<Response> }, string, 'uncharged' | 'unknown' | 'busy']> = [
    ['an answer that cannot be read', { chat: cutOff }, 'UnreadableAnswer', 'unknown'],
    ['no answer to the call', { chat: unreachable }, 'Offline', 'unknown'],
    ['a seller that did not answer', { chat: refused(503, 'seller_unreachable') }, 'seller_unreachable', 'unknown'],
    ['a receipt that failed its check', { chat: refused(502, 'bad_receipt') }, 'bad_receipt', 'unknown'],
    ['a refusal before any seller is called', { chat: refused(503, 'no_seller') }, 'no_seller', 'uncharged'],
    ['no answer while the key is made, before any call', { keys: unreachable }, 'Offline', 'uncharged'],
    ['too many calls waiting on the service', { chat: busy(429, 'budget_busy') }, 'budget_busy', 'busy'],
    ['a gateway taking as many calls as it can', { chat: busy(503, 'gateway_busy') }, 'gateway_busy', 'busy'],
  ];
  for (const [what, node, code, outcome] of outcomes) {
    it(`says ${{ uncharged: 'nothing was charged', unknown: 'the charge is not known', busy: 'to try again' }[outcome]} after ${what}`, async () => {
      const fixture = fixtureFetch('active');
      vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (node.chat && url.endsWith('/v1/chat/completions')) return node.chat(() => fixture(input, init));
        if (node.keys && url === '/api/marketplace/keys') return node.keys();
        return fixture(input, init);
      });
      const c = await openPlayground();
      await type(byTestId(c, 'mkt-play-input'), 'hello');
      await click(byTestId(c, 'mkt-play-send'));
      await waitForText(c, { uncharged: 'nothing was charged', unknown: 'is not known', busy: 'try again in a moment' }[outcome]);
      const bubble = byTestId(c, 'mkt-error-bubble');
      expect(bubble?.getAttribute('data-code')).toBe(code);
      expect(bubble?.getAttribute('data-outcome')).toBe(outcome);
      if (outcome === 'unknown') {
        expect(bubble?.textContent).not.toContain('nothing was charged');
        expect(bubble?.textContent).toContain('check Recent calls in Plans before sending it again');
      }
      if (outcome === 'busy') {
        expect(bubble?.textContent).not.toContain('nothing was charged');
        expect(bubble?.textContent).toContain('Try again in 5 s');
      }
    });
  }

  it('makes a new key from the topped-up subscription once the old key\'s budget ran out, so the chat goes on', async () => {
    const node = keyBudgetNode();
    const c = await openPlayground();
    await send(c, 'first');
    expect(node.calls.filter((x) => x.startsWith('POST /api/marketplace/keys '))).toEqual(['POST /api/marketplace/keys 5000000000000000000']);
    // The key's own budget runs out: the gateway refuses the next call before it calls anyone.
    node.exhaust();
    await type(byTestId(c, 'mkt-play-input'), 'second');
    await click(byTestId(c, 'mkt-play-send'));
    await waitForText(c, 'The key\'s budget is spent — nothing was charged');
    expect(byTestId(c, 'mkt-error-bubble')?.getAttribute('data-code')).toBe('key_budget');
    expect(byTestId(c, 'mkt-play-key')?.textContent).toContain('your next message makes a new key');
    // This epoch's subscription is topped up; the next message makes a key from it, revoking the spent one.
    node.topUp(500_000_000_000_000_000n);
    await flush(50);
    await type(byTestId(c, 'mkt-play-input'), 'third');
    await click(byTestId(c, 'mkt-play-send'));
    await waitUntilAnswers(c, 2);
    expect(node.calls.filter((x) => x.startsWith('POST /api/marketplace/keys'))).toEqual([
      'POST /api/marketplace/keys 5000000000000000000',
      'POST /api/marketplace/keys/dkgmk_00000000/revoke',
      'POST /api/marketplace/keys 5500000000000000000',
    ]);
    expect(byTestId(c, 'mkt-play-key')?.textContent).toContain('dkgmk_00000000');
  });

  it('makes a new key once the subscription funds more than the key was made with', async () => {
    const node = keyBudgetNode();
    const c = await openPlayground();
    await send(c, 'first');
    node.topUp(500_000_000_000_000_000n);
    // Opened again, the playground reads the subscription as it is now.
    await click(Array.from(c.querySelectorAll('[role="tab"]')).find((t) => t.textContent === 'Models'));
    await click(Array.from(c.querySelectorAll('[role="tab"]')).find((t) => t.textContent === 'Playground'));
    await waitForText(c, 'qwen2.5-14b-instruct ·');
    await type(byTestId(c, 'mkt-play-input'), 'second');
    await click(byTestId(c, 'mkt-play-send'));
    await waitUntilAnswers(c, 1);
    expect(node.calls.filter((x) => x.startsWith('POST /api/marketplace/keys'))).toEqual([
      'POST /api/marketplace/keys 5000000000000000000',
      'POST /api/marketplace/keys/dkgmk_00000000/revoke',
      'POST /api/marketplace/keys 5500000000000000000',
    ]);
  });

  it('keeps one key for the page: a second send makes no new key', async () => {
    const calls = recordCalls();
    const c = await openPlayground();
    await send(c, 'first');
    await type(byTestId(c, 'mkt-play-input'), 'second');
    await click(byTestId(c, 'mkt-play-send'));
    await flush(50);
    expect(keyCalls(calls)).toEqual(['POST /api/marketplace/keys']);
    expect(calls.filter((x) => x === 'POST /api/marketplace/v1/chat/completions')).toHaveLength(2);
  });
});
