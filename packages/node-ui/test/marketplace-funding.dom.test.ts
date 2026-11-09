// @vitest-environment happy-dom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlansView } from '../src/ui/marketplace/views/PlansView.js';
import { useMarketplaceDraftStore } from '../src/ui/marketplace/draftStore.js';
import { FIXTURE_IDS, fixtureFetch } from '../src/ui/marketplace/api/fixtures.js';
import { byTestId, click, flush, render, unmountAll, waitForText } from './helpers/marketplace-render.js';

type Json = Record<string, unknown>;
type Write = { method: string; url: string; body: unknown };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const refusal = (status: number, code: string, args: string[] = []) => json({ error: `${code}(${args.join(', ')})`, code, ...(args.length ? { args } : {}), retryable: false }, status);

/** How a funding goes on the node, and how its answer comes back. */
type Landing =
  /** It lands, and the answer comes back. */
  | 'answer'
  /** It lands, and its answer never comes back. */
  | 'lose'
  /** It lands, and its answer stops partway through its body. */
  | 'cut'
  /** It lands, and the node answers with a failure it does not explain. */
  | 'fail'
  /** It lands on other terms than those sent (another flow's, say), and the answer never comes back. */
  | 'other'
  /** It does not land yet, and its answer never comes back; `land()` lands it. */
  | 'later'
  /** It never reaches the node. */
  | 'drop';

/**
 * The fixture node of a buyer that never subscribed, keeping each write, with
 * fundings as the contracts have them: one per epoch, a repeat refused with
 * SubscriptionAlreadyFunded. `landings` says how each funding goes, in turn
 * (then 'answer'). Reads of the subscriptions show what landed; with
 * `failEpochReads`, that many reads of one epoch fail first, as a node error.
 */
function fundingNode() {
  const writes: Write[] = [];
  const node = fixtureFetch('none');
  const onChain = new Map<number, Json>();
  let waiting: Json | null = null;
  const control = {
    writes,
    landings: [] as Landing[],
    failEpochReads: 0,
    /** The funding that did not land yet lands. */
    land() { if (waiting) onChain.set(waiting.epoch as number, waiting); waiting = null; },
  };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Json : undefined;
    if (method !== 'GET') writes.push({ method, url, body });
    if (method === 'POST' && url === '/api/marketplace/subscriptions') {
      const epoch = body!.epoch as number;
      if (onChain.has(epoch)) return refusal(409, 'SubscriptionAlreadyFunded', [String(epoch)]);
      const how = control.landings.shift() ?? 'answer';
      if (how === 'drop') throw new TypeError('Failed to fetch');
      const text = await (await node(input, init)).text();
      const subscription = (JSON.parse(text) as { subscription: Json }).subscription;
      if (how === 'other') {
        const [first] = subscription.budgets as Json[];
        Object.assign(first, { value: '2000000000000000000', valueTrac: '2.0' });
        Object.assign(subscription, { value: '2000000000000000000', valueTrac: '2.0' });
      }
      if (how === 'later') waiting = subscription;
      else onChain.set(epoch, subscription);
      if (how === 'lose' || how === 'other' || how === 'later') throw new TypeError('Failed to fetch');
      if (how === 'cut') return new Response(text.slice(0, Math.floor(text.length / 2)), { status: 200 });
      if (how === 'fail') return json({ error: 'the transaction receipt did not come in time', code: 'Error', retryable: false }, 500);
      return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (method === 'GET' && url.startsWith('/api/marketplace/subscriptions')) {
      const asked = new URL(url, 'http://fixture.localhost').searchParams.get('epoch');
      if (asked !== null && control.failEpochReads > 0) {
        control.failEpochReads -= 1;
        return json({ error: 'database is locked', code: 'Error', retryable: false }, 500);
      }
      return json({ subscriptions: [...onChain.values()].filter((s) => asked === null || s.epoch === Number(asked)) });
    }
    return node(input, init);
  });
  return control;
}

const fundings = (writes: Write[]) => writes.filter((w) => w.method === 'POST' && w.url === '/api/marketplace/subscriptions');
const planSaves = (writes: Write[]) => writes.filter((w) => w.method === 'PUT' && w.url === '/api/marketplace/plan');

/** Compose a first plan of one service at 1 TRAC from the buyer wallet, and confirm its funding. */
async function composeAndConfirm(): Promise<HTMLElement> {
  const c = await render(React.createElement(PlansView));
  await waitForText(c, 'Compose your plan');
  await click(byTestId(c, `mkt-pick-${FIXTURE_IDS.qwen14b}`));
  await flush(300);
  await waitForText(c, 'Costs 1 TRAC from the buyer wallet for epoch 664');
  await click(byTestId(c, 'mkt-compose-continue'));
  await click(byTestId(c, 'mkt-gate-confirm'));
  return c;
}

const CONFIRMED = { epoch: 664, source: { kind: 'wallet' }, services: [{ serviceId: FIXTURE_IDS.qwen14b, serviceClass: 'inference', value: '1000000000000000000', maxPricePerUnit: '700000000000' }] };

describe('marketplace funding whose answer is lost', () => {
  afterEach(async () => {
    await unmountAll();
    useMarketplaceDraftStore.setState({ ask: null });
  });

  for (const [how, code] of [['lose', 'Offline'], ['cut', 'UnreadableAnswer'], ['fail', 'Error']] as const) {
    it(`saves the plan of a funding that landed though its answer did not come back (${code}), and funds nothing again`, async () => {
      const node = fundingNode();
      node.landings.push(how);
      const c = await composeAndConfirm();
      await waitForText(c, 'Epoch 664 is funded with 1 TRAC');
      expect(byTestId(c, 'mkt-key-step')).toBeTruthy();
      expect(fundings(node.writes).map((w) => w.body)).toEqual([CONFIRMED]);
      expect(planSaves(node.writes).map((w) => w.body)).toEqual([{ services: CONFIRMED.services, source: { kind: 'wallet' }, renew: true, renewUntilEpoch: 670 }]);
      // The transaction is not shown: the answer that named it was lost.
      expect(byTestId(c, 'mkt-funded')?.querySelector('[data-copy="flow.tx"]')).toBeNull();
    });
  }

  it('sends the same funding again on Retry when the epoch shows it did not land, and then saves the plan', async () => {
    const node = fundingNode();
    node.landings.push('drop');
    const c = await composeAndConfirm();
    await waitForText(c, 'No subscription funds epoch 664 yet');
    expect(byTestId(c, 'mkt-fund-flow')?.getAttribute('data-phase')).toBe('unknown');
    expect(byTestId(c, 'mkt-funding-unknown')?.getAttribute('data-state')).toBe('absent');
    expect(byTestId(c, 'mkt-error-card')?.getAttribute('data-code')).toBe('Offline');
    expect(byTestId(c, 'mkt-gate-confirm')).toBeNull();
    expect(planSaves(node.writes)).toEqual([]);
    await click(byTestId(c, 'mkt-funding-retry'));
    await waitForText(c, 'Epoch 664 is funded with 1 TRAC');
    expect(fundings(node.writes).map((w) => w.body)).toEqual([CONFIRMED, CONFIRMED]);
    expect(planSaves(node.writes)).toHaveLength(1);
  });

  it('takes a Retry refused as already funded for the first funding landing late, and saves the plan without funding again', async () => {
    const node = fundingNode();
    node.landings.push('later');
    const c = await composeAndConfirm();
    await waitForText(c, 'No subscription funds epoch 664 yet');
    node.land();
    await click(byTestId(c, 'mkt-funding-retry'));
    await waitForText(c, 'Epoch 664 is funded with 1 TRAC');
    expect(fundings(node.writes)).toHaveLength(2);
    expect(planSaves(node.writes)).toHaveLength(1);
  });

  it('says when the epoch is funded on other terms, and saves no plan', async () => {
    const node = fundingNode();
    node.landings.push('other');
    const c = await composeAndConfirm();
    await waitForText(c, 'Epoch 664 is funded with 2 TRAC from the buyer wallet, but not on the terms confirmed here, so the plan was not saved.');
    expect(byTestId(c, 'mkt-funding-unknown')?.getAttribute('data-state')).toBe('other');
    expect(byTestId(c, 'mkt-funding-retry')).toBeNull();
    await flush(50);
    expect(planSaves(node.writes)).toEqual([]);
    expect(fundings(node.writes)).toHaveLength(1);
    // Done closes the flow; the page reads the node again and shows the subscription there is.
    await click(byTestId(c, 'mkt-funding-done'));
    await waitForText(c, 'Epoch 664: 0% of its value landed');
    expect(byTestId(c, 'mkt-plans')?.getAttribute('data-state')).toBe('active');
  });

  it('reads the epoch again on request when it cannot be read, offering nothing that sends meanwhile', async () => {
    const node = fundingNode();
    node.landings.push('lose');
    node.failEpochReads = 1;
    const c = await composeAndConfirm();
    await waitForText(c, 'Epoch 664\'s subscription could not be read.');
    expect(byTestId(c, 'mkt-funding-unknown')?.getAttribute('data-state')).toBe('unread');
    expect(byTestId(c, 'mkt-funding-retry')).toBeNull();
    expect(byTestId(c, 'mkt-gate-confirm')).toBeNull();
    await click(byTestId(c, 'mkt-funding-check'));
    await waitForText(c, 'Epoch 664 is funded with 1 TRAC');
    expect(fundings(node.writes)).toHaveLength(1);
    expect(planSaves(node.writes)).toHaveLength(1);
  });
});
