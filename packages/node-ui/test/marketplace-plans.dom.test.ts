// @vitest-environment happy-dom
// The Plans page's states: this epoch's budgets, an ended plan, a plan that
// cannot be read, the marketplace off, and an account list the node is still reading.
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMarketplaceDraftStore } from '../src/ui/marketplace/draftStore.js';
import { FIXTURE_IDS, fixtureFetch } from '../src/ui/marketplace/api/fixtures.js';
import type { Funding } from '../src/ui/marketplace/api/types.js';
import { MISSING_COPY, buttonWithText, byTestId, click, flush, render, unmountAll, useFixtureNode, waitForText } from './helpers/marketplace-render.js';
import { failingPlanNode, json, plans, topUpLlama, waitUntil } from './helpers/marketplace-nodes.js';

describe('marketplace Plans', () => {
  afterEach(async () => {
    await unmountAll();
    useMarketplaceDraftStore.setState({ ask: null });
  });

  it('shows this epoch\'s budgets as landed, held and left, with the soft ceiling\'s fork', async () => {
    useFixtureNode('active');
    const c = await render(plans());
    await waitForText(c, 'Epoch 664: 27% of its value landed, 3% held');
    expect(byTestId(c, 'mkt-plans')?.getAttribute('data-state')).toBe('active');
    const qwen = byTestId(c, `mkt-meter-${FIXTURE_IDS.qwen14b}`);
    expect(qwen?.textContent).toContain('0.72 landed · 0.12 held · 2.16 left of 3 TRAC');
    expect(qwen?.querySelectorAll('.mkt-bar i').length).toBe(2);
    expect(byTestId(c, `mkt-meter-${FIXTURE_IDS.llama8b}`)?.getAttribute('data-state')).toBe('ceiling');
    expect(byTestId(c, `mkt-topup-${FIXTURE_IDS.llama8b}`)).toBeTruthy();
    expect(byTestId(c, 'mkt-next-epoch')?.textContent).toContain('Epoch 665 is funded');
    expect(byTestId(c, `mkt-addon-row-${FIXTURE_IDS.mistral24b}`)).toBeTruthy();
    await waitForText(c, 'So far: this node holds 19 receipts · 200 landed, 199 matched');
    await click(byTestId(c, 'mkt-recon-663'));
    await waitForText(c, 'Final: 200 receipts landed, 199 matched this node\'s · 0 held');
    expect(byTestId(c, 'mkt-reconciliation')?.getAttribute('data-epoch')).toBe('663');
    expect(byTestId(c, 'mkt-activity')?.textContent).toContain('dkgmk_1a2b3c4d');
    expect(byTestId(c, 'mkt-treasury')?.textContent).toContain('This node may spend up to 20 TRAC per epoch');
    expect(c.textContent).not.toContain(MISSING_COPY);
  });


  it('offers to fund this epoch when the plan stopped renewing, with last epoch\'s final reconciliation', async () => {
    useFixtureNode('ended');
    const c = await render(plans());
    await waitForText(c, 'No subscription funds epoch 664');
    expect(c.textContent).toContain('The plan does not renew');
    await waitForText(c, 'Final: 200 receipts landed, 199 matched this node\'s · 0 held');
    await click(byTestId(c, 'mkt-new-period'));
    expect(byTestId(c, 'mkt-composer')).toBeTruthy();
    expect(c.querySelectorAll('[data-testid^="mkt-value-"]').length).toBe(3);
  });

  for (const [scenario, after] of [['none', 'never-subscribed'], ['ended', 'period-ended']] as const) {
    it(`shows a failed plan read with a retry, not what a plan or its absence would offer (${scenario})`, async () => {
      let fail = true;
      const writes = failingPlanNode(scenario, () => fail);
      const c = await render(plans());
      await waitForText(c, 'The plan could not be read: nothing that saves a plan is offered until it is.');
      expect(byTestId(c, 'mkt-plans')?.getAttribute('data-state')).toBe('plan-unread');
      expect(byTestId(c, 'mkt-error-card')?.getAttribute('data-code')).toBe('Error');
      for (const id of ['mkt-composer', 'mkt-fund-flow', 'mkt-new-period', 'mkt-treasury']) expect(byTestId(c, id)).toBeNull();
      expect(c.textContent).not.toContain('Three steps to your first answer');
      // The node says the plan is not retryable; a read is safe to ask for again all the same.
      fail = false;
      await click(byTestId(c, 'mkt-plan-reload'));
      await waitUntil(() => byTestId(c, 'mkt-plans')?.getAttribute('data-state') === after, after);
      expect(byTestId(c, 'mkt-plan-unread')).toBeNull();
      expect(writes).toEqual([]);
      expect(c.textContent).not.toContain(MISSING_COPY);
    });
  }

  it('keeps this epoch\'s page but offers nothing that saves a plan while the plan cannot be read, and holds a compose ask until it can', async () => {
    let fail = true;
    const writes = failingPlanNode('active', () => fail);
    useMarketplaceDraftStore.getState().askPlans({ kind: 'compose' });
    const c = await render(plans());
    await waitForText(c, 'The plan could not be read');
    expect(byTestId(c, 'mkt-plans')?.getAttribute('data-state')).toBe('active');
    expect(byTestId(c, 'mkt-next-epoch')?.textContent).toContain('The plan is unknown until the node reads it');
    expect(byTestId(c, 'mkt-change-plan')).toBeNull();
    expect(byTestId(c, 'mkt-fund-flow')).toBeNull();
    expect(useMarketplaceDraftStore.getState().ask).toEqual({ kind: 'compose' });
    // A top-up saves no plan: it stays on offer.
    expect(byTestId(c, `mkt-topup-${FIXTURE_IDS.llama8b}`)).toBeTruthy();
    fail = false;
    await click(byTestId(c, 'mkt-plan-reload'));
    await waitForText(c, 'Compose your plan');
    expect(useMarketplaceDraftStore.getState().ask).toBeNull();
    // The plan as the node read it: its three services.
    expect(c.querySelectorAll('[data-testid^="mkt-value-"]').length).toBe(3);
    expect(writes).toEqual([]);
  });

  it('offers no plan change once a reload of the plan fails, though an earlier read succeeded', async () => {
    let fail = false;
    failingPlanNode('active', () => fail);
    const c = await topUpLlama();
    await click(byTestId(c, 'mkt-topup-confirm'));
    await waitForText(c, 'llama-3.1-8b-instruct topped up · tx');
    expect(byTestId(c, 'mkt-change-plan')).toBeTruthy();
    // Done, the page reads everything again, and this time the plan read fails.
    fail = true;
    await click(buttonWithText(c, 'Done'));
    await waitForText(c, 'The plan could not be read');
    expect(byTestId(c, 'mkt-change-plan')).toBeNull();
    expect(byTestId(c, 'mkt-next-epoch')?.textContent).toContain('The plan renews each epoch until epoch 670');
    fail = false;
    await click(byTestId(c, 'mkt-plan-reload'));
    await waitUntil(() => !!byTestId(c, 'mkt-change-plan'), 'Change plan');
  });

  it('says when the marketplace is off', async () => {
    useFixtureNode('off');
    const c = await render(plans());
    await waitForText(c, 'The NS Marketplace is off on this node');
    expect(byTestId(c, 'mkt-plans')?.getAttribute('data-state')).toBe('off');
  });

  it('reads the funding again while the node is still reading the account list, past a failed read, until the list is in', async () => {
    // The funding reads answer: still pending, then a failure, then the full list.
    const answers: Array<'pending' | 'fail' | 'list'> = ['pending', 'fail', 'list'];
    let reads = 0;
    const node = fixtureFetch('active');
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') !== 'GET' || String(input) !== '/api/marketplace/funding') return node(input, init);
      const answer = answers[Math.min(reads, answers.length - 1)];
      reads += 1;
      if (answer === 'fail') return json({ error: 'upstream timeout', code: 'Error', retryable: true }, 503);
      const funding = await (await node(input, init)).json() as Funding;
      return json(answer === 'pending' ? { ...funding, accounts: [], accountsPending: true } : { ...funding, accountsPending: false });
    });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const c = await render(plans());
      const treasury = () => byTestId(c, 'mkt-treasury');
      await waitUntil(() => !!treasury()?.querySelector('[data-copy="treasury.accounts.pending"]'), 'the pending note');
      expect(treasury()?.querySelector('[data-copy="treasury.accounts.none"]')).toBeNull();
      expect(reads).toBe(1);

      // The read after the first interval fails; the page keeps the pending answer and reads again.
      await act(async () => { vi.advanceTimersByTime(10_000); });
      await waitUntil(() => reads === 2, 'the failed read');
      await flush();
      expect(treasury()?.querySelector('[data-copy="treasury.accounts.pending"]')).not.toBeNull();

      await act(async () => { vi.advanceTimersByTime(10_000); });
      await waitUntil(() => reads === 3, 'the read that brings the list');
      await waitUntil(() => !!byTestId(c, 'mkt-account-7'), 'the account the node owns');
      expect(treasury()?.querySelector('[data-copy="treasury.accounts.pending"]')).toBeNull();

      // With the list in, the page stops reading the funding on its own.
      await act(async () => { vi.advanceTimersByTime(60_000); });
      await flush();
      expect(reads).toBe(3);
      expect(c.textContent).not.toContain(MISSING_COPY);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts no funding read while one is running, so a read slower than the interval still brings the list', async () => {
    let reads = 0;
    let answerSlowRead!: () => void;
    const slowRead = new Promise<void>((resolve) => { answerSlowRead = resolve; });
    const node = fixtureFetch('active');
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') !== 'GET' || String(input) !== '/api/marketplace/funding') return node(input, init);
      reads += 1;
      const funding = await (await node(input, init)).json() as Funding;
      if (reads === 1) return json({ ...funding, accounts: [], accountsPending: true });
      // The second read brings the list, but only once it is answered, three intervals later.
      await slowRead;
      return json({ ...funding, accountsPending: false });
    });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const c = await render(plans());
      await waitUntil(() => !!byTestId(c, 'mkt-treasury')?.querySelector('[data-copy="treasury.accounts.pending"]'), 'the pending note');

      await act(async () => { vi.advanceTimersByTime(10_000); });
      await waitUntil(() => reads === 2, 'the slow read');
      // Two more intervals pass while it runs: neither starts a read of its own.
      await act(async () => { vi.advanceTimersByTime(10_000); });
      await act(async () => { vi.advanceTimersByTime(10_000); });
      await flush();
      expect(reads).toBe(2);

      answerSlowRead();
      await waitUntil(() => !!byTestId(c, 'mkt-account-7'), 'the account the node owns');
      await act(async () => { vi.advanceTimersByTime(60_000); });
      await flush();
      expect(reads).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
