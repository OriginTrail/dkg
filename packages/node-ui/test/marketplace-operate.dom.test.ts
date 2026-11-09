// @vitest-environment happy-dom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperateView } from '../src/ui/marketplace/views/OperateView.js';
import { FIXTURE_IDS, fixtureFetch } from '../src/ui/marketplace/api/fixtures.js';
import { MISSING_COPY, byTestId, click, render, type, unmountAll, useFixtureNode, waitForText } from './helpers/marketplace-render.js';

const operate = () => React.createElement(OperateView);

describe('marketplace Operate', () => {
  afterEach(unmountAll);

  it('shows the gate, each offering\'s backend and prices, this epoch\'s ledger, batches and ended epochs', async () => {
    useFixtureNode('active');
    const c = await render(operate());
    await waitForText(c, 'Your prices — the next epoch\'s takes effect when it starts');
    await waitForText(c, 'Epoch 664, ends in 15 h · a new price takes effect from epoch 665');
    expect(byTestId(c, `mkt-ask-${FIXTURE_IDS.qwen7b}`)?.textContent).toContain('next epoch: 0.32 µTRAC');
    expect(byTestId(c, `mkt-ask-${FIXTURE_IDS.mistral24b}`)?.getAttribute('data-connector')).toBe('down');
    expect(byTestId(c, 'mkt-ledger-counts')?.textContent).toBe('412 served · 380 sent · 360 landed · 2 refused · 0 missed');
    expect(byTestId(c, 'mkt-ledger')?.textContent).toContain('proved this epoch ✓');
    expect(byTestId(c, 'mkt-ledger')?.textContent).toContain('the epoch\'s pool so far 12.5 TRAC');
    expect(byTestId(c, 'mkt-batches')?.textContent).toContain('120 receipts');
    expect(byTestId(c, 'mkt-ended')?.textContent).toContain('gross 1.8 TRAC');
    expect(byTestId(c, 'mkt-ops-wallet')?.textContent).toContain('0.042 ETH');
    expect(c.textContent).not.toContain(MISSING_COPY);
  });

  it('sets the next epoch\'s price in wei per token and lands now', async () => {
    const writes: Array<{ url: string; body: unknown }> = [];
    const node = fixtureFetch('active');
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method && init.method !== 'GET') writes.push({ url: String(input), body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
      return node(input, init);
    });
    const c = await render(operate());
    await waitForText(c, 'Epoch 664');
    await type(byTestId(c, `mkt-ask-input-${FIXTURE_IDS.qwen14b}`), '0.55');
    await click(byTestId(c, `mkt-ask-queue-${FIXTURE_IDS.qwen14b}`));
    await waitForText(c, 'next epoch: 0.55 µTRAC');
    await click(byTestId(c, 'mkt-land-now'));
    await waitForText(c, 'Batches landed: 1 · 32 receipts · 0 refused');
    expect(writes).toEqual([
      { url: `/api/marketplace/seller/offerings/${FIXTURE_IDS.qwen14b}/price`, body: { price: '550000000000' } },
      { url: '/api/marketplace/seller/land', body: {} },
    ]);
  });

  const tx = `0x${'b1'.repeat(32)}`;
  const reports: Array<[string, unknown, string]> = [
    ['stopped', { stopped: 'end-margin' }, 'Nothing landed: too close to the epoch\'s end'],
    ['waiting', { sent: [], refused: 2, waiting: true }, 'Nothing landed yet: receipts are waiting to be ready · 2 refused'],
    ['empty', { sent: [], refused: 1, waiting: false }, 'Nothing landed · 1 refused'],
    ['sent', { sent: [{ txHash: tx, items: 120, value: '1', valueTrac: '0.0', counted: '1', countedTrac: '0.0' }, { txHash: tx, items: 30, value: '1', valueTrac: '0.0', counted: '1', countedTrac: '0.0' }], refused: 3, waiting: false },
      'Batches landed: 2 · 150 receipts · 3 refused'],
  ];
  for (const [what, lastLanding, text] of reports) {
    it(`words the last landing when it ${what === 'sent' ? 'sent batches' : `was ${what}`}`, async () => {
      const node = fixtureFetch('active');
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await node(input, init);
        if (String(input) !== '/api/marketplace/seller') return res;
        return new Response(JSON.stringify({ ...(await res.json()), lastLanding }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });
      const c = await render(operate());
      await waitForText(c, 'Epoch 664');
      expect(byTestId(c, 'mkt-land-result')?.textContent).toBe(text);
    });
  }

  const answers: Array<[string, unknown, string]> = [
    ['stopped', { batches: [], stopped: 'not-due' }, 'Nothing landed: no landing is due yet'],
    ['waiting', { batches: [], refused: 0, waiting: true }, 'Nothing landed yet: receipts are waiting to be ready · 0 refused'],
    ['empty', { batches: [], refused: 4, waiting: false }, 'Nothing landed · 4 refused'],
  ];
  for (const [what, answer, text] of answers) {
    it(`words a Land now that was ${what}`, async () => {
      const node = fixtureFetch('active');
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/marketplace/seller/land') return new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
        return node(input, init);
      });
      const c = await render(operate());
      await waitForText(c, 'Batches landed: 1 · 120 receipts · 0 refused');
      await click(byTestId(c, 'mkt-land-now'));
      await waitForText(c, text);
      expect(byTestId(c, 'mkt-land-result')?.textContent).toBe(text);
    });
  }

  it('shows no landing line before the first landing', async () => {
    const node = fixtureFetch('active');
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await node(input, init);
      if (String(input) !== '/api/marketplace/seller') return res;
      return new Response(JSON.stringify({ ...(await res.json()), lastLanding: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const c = await render(operate());
    await waitForText(c, 'Epoch 664');
    expect(byTestId(c, 'mkt-land-result')).toBeNull();
  });

  it('says what selling needs when it is off', async () => {
    useFixtureNode('off');
    const c = await render(operate());
    await waitForText(c, 'Selling is off on this node');
    expect(byTestId(c, 'mkt-operate-inactive')).toBeTruthy();
  });
});
