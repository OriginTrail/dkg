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

async function send(c: HTMLElement, text: string): Promise<void> {
  await type(byTestId(c, 'mkt-play-input'), text);
  await click(byTestId(c, 'mkt-play-send'));
  await waitForText(c, 'A knowledge graph links facts');
}

const keyCalls = (calls: string[]) => calls.filter((x) => x.includes('/api/marketplace/keys'));

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
  const outcomes: Array<[string, { chat?: (served: () => Promise<Response>) => Response | Promise<Response>; keys?: () => Promise<Response> }, string, 'uncharged' | 'unknown']> = [
    ['an answer that cannot be read', { chat: cutOff }, 'UnreadableAnswer', 'unknown'],
    ['no answer to the call', { chat: unreachable }, 'Offline', 'unknown'],
    ['a seller that did not answer', { chat: refused(503, 'seller_unreachable') }, 'seller_unreachable', 'unknown'],
    ['a receipt that failed its check', { chat: refused(502, 'bad_receipt') }, 'bad_receipt', 'unknown'],
    ['a refusal before any seller is called', { chat: refused(503, 'no_seller') }, 'no_seller', 'uncharged'],
    ['no answer while the key is made, before any call', { keys: unreachable }, 'Offline', 'uncharged'],
  ];
  for (const [what, node, code, outcome] of outcomes) {
    it(`says ${outcome === 'uncharged' ? 'nothing was charged' : 'the charge is not known'} after ${what}`, async () => {
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
      await waitForText(c, outcome === 'uncharged' ? 'nothing was charged' : 'is not known');
      const bubble = byTestId(c, 'mkt-error-bubble');
      expect(bubble?.getAttribute('data-code')).toBe(code);
      expect(bubble?.getAttribute('data-outcome')).toBe(outcome);
      if (outcome === 'unknown') {
        expect(bubble?.textContent).not.toContain('nothing was charged');
        expect(bubble?.textContent).toContain('check Recent calls in Plans before sending it again');
      }
    });
  }

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
