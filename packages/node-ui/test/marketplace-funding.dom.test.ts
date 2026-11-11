// @vitest-environment happy-dom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlansView } from '../src/ui/marketplace/views/PlansView.js';
import { useMarketplaceDraftStore } from '../src/ui/marketplace/draftStore.js';
import { FIXTURE_IDS, fixtureFetch } from '../src/ui/marketplace/api/fixtures.js';
import { byTestId, click, flush, render, type, unmount, unmountAll, waitForText } from './helpers/marketplace-render.js';

type Json = Record<string, unknown>;
type Write = { method: string; url: string; body: unknown };

async function waitUntil(check: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await flush(10);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

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
    /** Reads name no class for the budgets, as a node before classes on budgets does. */
    classless: false,
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
      const shown = [...onChain.values()].filter((s) => asked === null || s.epoch === Number(asked));
      const classless = (s: Json) => ({ ...s, budgets: (s.budgets as Json[]).map(({ serviceClass: _class, ...b }) => b) });
      return json({ subscriptions: control.classless ? shown.map(classless) : shown });
    }
    return node(input, init);
  });
  return control;
}

/**
 * The fixture node with this epoch funded and the next one not, keeping each
 * write. A funding of the next epoch lands at once, but its answer waits for
 * `release()`. A plan saved is the plan read after it; with `cutPlanAnswers`,
 * a save lands but its answer stops partway; `failPlanReads` reads of the
 * plan, and `failPlanSaves` saves, fail first, as a node error; with
 * `holdPlanSaves`, saves wait for `releasePlans()`; `refusePlanSaves` saves
 * are refused outright; `holdPlanReads` reads of the plan answer with the
 * plan as it was when they came, at `releasePlanReads()`.
 */
function heldNextNode() {
  const writes: Write[] = [];
  const node = fixtureFetch('active');
  let next: Json | null = null;
  let plan: Json | null = null;
  const held: Array<() => void> = [];
  const control = { cutPlanAnswers: false, failPlanReads: 0, failPlanSaves: 0, refusePlanSaves: 0, holdPlanSaves: false, holdPlanReads: 0, planReads: 0 };
  const heldPlans: Array<() => void> = [];
  const heldReads: Array<() => void> = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    if (method !== 'GET') writes.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    if (method === 'POST' && url === '/api/marketplace/subscriptions') {
      const text = await (await node(input, init)).text();
      next = (JSON.parse(text) as { subscription: Json }).subscription;
      await new Promise<void>((resolve) => { held.push(resolve); });
      return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (method === 'GET' && url.startsWith('/api/marketplace/subscriptions')) {
      const asked = new URL(url, 'http://fixture.localhost').searchParams.get('epoch');
      const { subscriptions } = await (await node(input, init)).json() as { subscriptions: Json[] };
      const landed = next && (asked === null || Number(asked) === next.epoch) ? [next] : [];
      return json({ subscriptions: [...subscriptions.filter((s) => s.epoch !== 665), ...landed] });
    }
    if (method === 'GET' && url === '/api/marketplace/plan') control.planReads += 1;
    if (method === 'PUT' && url === '/api/marketplace/plan' && control.holdPlanSaves) await new Promise<void>((resolve) => { heldPlans.push(resolve); });
    if (method === 'PUT' && url === '/api/marketplace/plan' && control.refusePlanSaves > 0) {
      control.refusePlanSaves -= 1;
      return json({ error: 'PlanLocked()', code: 'PlanLocked', retryable: false }, 409);
    }
    if (method === 'GET' && url === '/api/marketplace/plan' && control.holdPlanReads > 0) {
      control.holdPlanReads -= 1;
      // The plan as it is now, answered later.
      const now = plan ? json(plan) : await node(input, init);
      const text = await now.text();
      await new Promise<void>((resolve) => { heldReads.push(resolve); });
      return new Response(text, { status: now.status, headers: { 'Content-Type': 'application/json' } });
    }
    if (method === 'PUT' && url === '/api/marketplace/plan' && control.failPlanSaves > 0) {
      control.failPlanSaves -= 1;
      return json({ error: 'disk full', code: 'Error', retryable: false }, 500);
    }
    if (method === 'PUT' && url === '/api/marketplace/plan') {
      plan = await (await node(input, init)).json() as Json;
      return control.cutPlanAnswers ? new Response(JSON.stringify(plan).slice(0, 12), { status: 200 }) : json(plan);
    }
    if (method === 'GET' && url === '/api/marketplace/plan' && control.failPlanReads > 0) {
      control.failPlanReads -= 1;
      return json({ error: 'database is locked', code: 'Error', retryable: false }, 500);
    }
    if (method === 'GET' && url === '/api/marketplace/plan' && plan) return json(plan);
    return node(input, init);
  });
  return {
    writes,
    control,
    release() { for (const r of held.splice(0)) r(); },
    /** Let the plan saves held so far go to the node. */
    releasePlans() { for (const r of heldPlans.splice(0)) r(); },
    /** Answer the plan reads held so far, with the plan each found. */
    releasePlanReads() { for (const r of heldReads.splice(0)) r(); },
    get heldPlanReads() { return heldReads.length; },
    get waiting() { return held.length; },
    /** Whether the plan the node holds now renews. */
    get planRenews() { return plan?.renew; },
    /** The plan the node holds now, by service: each budget's value. */
    get planValues() { return plan && Object.fromEntries((plan.services as Json[]).map((s) => [s.serviceId, s.value])); },
  };
}

/** Fund epoch 665 from the plan with the llama budget at 0.6 TRAC, and confirm it; its answer is held. */
async function fundNextHeld(node: ReturnType<typeof heldNextNode>): Promise<HTMLElement> {
  const c = await render(React.createElement(PlansView));
  await waitForText(c, 'Epoch 665 is not funded');
  await click(byTestId(c, 'mkt-fund-next'));
  await type(byTestId(c, `mkt-value-${FIXTURE_IDS.llama8b}`), '0.6');
  await flush(300);
  await waitForText(c, 'Costs 5.1 TRAC from the buyer wallet for epoch 665');
  await click(byTestId(c, 'mkt-compose-continue'));
  await click(byTestId(c, 'mkt-gate-confirm'));
  await flush(20);
  expect(node.waiting).toBe(1);
  return c;
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

describe('marketplace funding whose answer is lost or comes late', () => {
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

  it('saves the plan of a funding that landed as confirmed though the node names no class for its budgets', async () => {
    const node = fundingNode();
    node.landings.push('lose');
    node.classless = true;
    const c = await composeAndConfirm();
    await waitForText(c, 'Epoch 664 is funded with 1 TRAC');
    expect(fundings(node.writes)).toHaveLength(1);
    expect(planSaves(node.writes)).toHaveLength(1);
  });

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

  it('keeps a funding whose answer comes after a later plan was saved, and does not save its own plan over that one', async () => {
    const node = heldNextNode();
    const c = await fundNextHeld(node);
    // While that answer is on its way, the plan is changed and saved from another flow.
    await click(byTestId(c, 'mkt-change-plan'));
    await type(byTestId(c, `mkt-value-${FIXTURE_IDS.llama8b}`), '0.75');
    await click(byTestId(c, 'mkt-compose-continue'));
    await click(byTestId(c, 'mkt-gate-confirm'));
    await waitUntil(() => planSaves(node.writes).length === 1 && byTestId(c, 'mkt-fund-flow') === null, 'the changed plan to be saved');
    expect(node.planValues?.[FIXTURE_IDS.llama8b]).toBe('750000000000000000');
    // The first funding's answer comes back: the epoch stays funded, and the plan confirmed later stays.
    node.release();
    await flush(50);
    await flush(50);
    expect(fundings(node.writes).map((w) => (w.body as { epoch: number }).epoch)).toEqual([665]);
    expect(planSaves(node.writes)).toHaveLength(1);
    expect(node.planValues?.[FIXTURE_IDS.llama8b]).toBe('750000000000000000');
  });

  for (const [readBack, failPlanReads] of [['at once', 0], ['only once a read succeeds', 1]] as const) {
    it(`keeps a plan whose save answer was cut off, read back ${readBack}, over an older funding's plan`, async () => {
      const node = heldNextNode();
      const c = await fundNextHeld(node);
      // While the funding's answer is on its way, a plan that does not renew is saved; its answer stops partway.
      await click(byTestId(c, 'mkt-change-plan'));
      await click(byTestId(c, 'mkt-renew')?.querySelector('input'));
      await click(byTestId(c, 'mkt-compose-continue'));
      node.control.cutPlanAnswers = true;
      node.control.failPlanReads = failPlanReads;
      await click(byTestId(c, 'mkt-gate-confirm'));
      await waitUntil(() => planSaves(node.writes).length === 1 && node.control.failPlanReads === 0, 'the plan save and its read back');
      await flush(50);
      expect(node.planRenews).toBe(false);
      // The older funding's answer comes back: its plan, which renews, does not go over the one the node holds.
      node.control.cutPlanAnswers = false;
      node.release();
      await flush(50);
      await flush(50);
      expect(fundings(node.writes)).toHaveLength(1);
      expect(planSaves(node.writes)).toHaveLength(1);
      expect(node.planRenews).toBe(false);
    });
  }

  it('still saves the plan of a funding whose answer comes after a top-up replaced its form, and leaves that form open', async () => {
    const node = heldNextNode();
    const c = await fundNextHeld(node);
    await click(byTestId(c, `mkt-addon-${FIXTURE_IDS.mistral24b}`));
    expect(byTestId(c, 'mkt-fund-flow')).toBeNull();
    node.release();
    await waitUntil(() => planSaves(node.writes).length === 1, 'the funding\'s plan to be saved');
    expect(node.planValues?.[FIXTURE_IDS.llama8b]).toBe('600000000000000000');
    await flush(50);
    // The top-up stays on show: the flow that funded the epoch was replaced, so it closes nothing.
    expect(byTestId(c, 'mkt-topup')?.textContent).toContain('Add mistral-small-24b-instruct to epoch 664');
  });

  const goneBeforeTheAnswer: Array<[string, (c: HTMLElement) => Promise<HTMLElement>]> = [
    ['another flow replaces the form', async (c) => { await click(byTestId(c, `mkt-addon-${FIXTURE_IDS.mistral24b}`)); return c; }],
    ['Plans goes and comes back', async (c) => {
      await unmount(c);
      return render(React.createElement(PlansView));
    }],
  ];
  for (const [how, leave] of goneBeforeTheAnswer) {
    it(`shows a plan left unsaved when ${how} before the funding's answer, with a retry that saves the plan alone`, async () => {
      const node = heldNextNode();
      let c = await fundNextHeld(node);
      c = await leave(c);
      expect(byTestId(c, 'mkt-fund-flow')).toBeNull();
      // The funding's answer comes back with no form for it, and its plan fails to save.
      node.control.failPlanSaves = 1;
      node.release();
      await waitForText(c, 'The epoch is funded, but the plan was not saved');
      const waiting = byTestId(c, 'mkt-plan-waiting');
      expect(waiting?.textContent).toContain('Epoch 665 is funded with 5.1 TRAC');
      await click(byTestId(waiting!, 'mkt-plan-retry'));
      await waitUntil(() => byTestId(c, 'mkt-plan-waiting') === null, 'the plan to be saved');
      expect(fundings(node.writes)).toHaveLength(1);
      expect(planSaves(node.writes)).toHaveLength(2);
      expect(node.planValues?.[FIXTURE_IDS.llama8b]).toBe('600000000000000000');
    });
  }

  it('reads the plan again once a Retry of it has landed, and keeps no read that answers from before it', async () => {
    const node = heldNextNode();
    const c = await fundNextHeld(node);
    await click(byTestId(c, `mkt-addon-${FIXTURE_IDS.mistral24b}`));
    // The funding's plan is refused once. The page's read of the plan that follows is slow, and holds the plan from
    // before, whose llama budget is 0.5 TRAC.
    node.control.refusePlanSaves = 1;
    node.control.holdPlanReads = 1;
    node.release();
    await waitForText(c, 'The epoch is funded, but the plan was not saved');
    await waitUntil(() => node.heldPlanReads === 1, 'the page\'s read of the plan to be held');
    // The Retry's save is slow to land: nothing is read meanwhile that it has not written.
    node.control.holdPlanSaves = true;
    await click(byTestId(c, 'mkt-plan-retry'));
    await flush(50);
    expect(node.planValues?.[FIXTURE_IDS.llama8b]).toBeUndefined();
    const readsBefore = node.control.planReads;
    node.control.holdPlanSaves = false;
    node.releasePlans();
    await waitUntil(() => node.planValues?.[FIXTURE_IDS.llama8b] === '600000000000000000', 'the plan to be saved at 0.6 TRAC');
    await waitUntil(() => node.control.planReads > readsBefore, 'the plan to be read again after the save');
    await flush(50);
    // The read from before the save answers last, with 0.5 TRAC: it is not the one kept.
    node.releasePlanReads();
    await flush(50);
    await click(byTestId(c, 'mkt-change-plan'));
    expect((byTestId(c, `mkt-value-${FIXTURE_IDS.llama8b}`) as HTMLInputElement).value).toBe('0.6');
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
