// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureFetch, fixtureWorld } from '../src/ui/marketplace/api/fixtures.js';
import { forgetTopUpAttempts, topUpAttempts } from '../src/ui/marketplace/purchase/topUpAttempts.js';

/** The fixture node, with each top-up's answer held until `answer()`. */
function heldTopUps() {
  const node = fixtureFetch('active');
  const posts: string[] = [];
  const held: Array<() => void> = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST' && String(input).endsWith('/top-up')) {
      posts.push(String(init.body));
      return new Promise<Response>((resolve) => { held.push(() => resolve(node(input, init))); });
    }
    return node(input, init);
  });
  return { posts, answer: () => { for (const a of held.splice(0)) a(); }, get waiting() { return held.length; } };
}

/** Half a TRAC more for this epoch's third budget, as its dry run would answer it. */
function topUpTerms() {
  const s = fixtureWorld().current;
  const b = s.budgets[2];
  const services = [{ serviceId: b.serviceId, serviceClass: b.serviceClass, value: '500000000000000000', maxPricePerUnit: b.maxPricePerUnit }];
  return { s, b, t: { subscriptionId: s.subscriptionId, epoch: s.epoch, services, before: b.value } };
}

describe('marketplace top-up attempts', () => {
  afterEach(() => {
    forgetTopUpAttempts();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it('settles a top-up on its way after the form that confirmed it closed, and tells everyone who listens', async () => {
    const node = heldTopUps();
    const { s, b, t } = topUpTerms();
    const seen: Array<string | null> = [];
    const unsubscribe = topUpAttempts.subscribe(() => { seen.push(topUpAttempts.held(s.subscriptionId, b.serviceId)?.kind ?? null); });
    const form = new AbortController();
    const outcome = topUpAttempts.confirm(t, form.signal);
    expect(topUpAttempts.held(s.subscriptionId, b.serviceId)?.kind).toBe('reserving');
    expect(sessionStorage.length).toBe(1);
    await vi.waitFor(() => expect(node.waiting).toBe(1));
    expect(topUpAttempts.held(s.subscriptionId, b.serviceId)?.kind).toBe('sending');
    // The form closes with the top-up on its way: the store, not the form, takes the answer.
    form.abort();
    node.answer();
    expect((await outcome).kind).toBe('sent');
    expect(topUpAttempts.held(s.subscriptionId, b.serviceId)).toBeNull();
    expect(sessionStorage.length).toBe(0);
    expect(node.posts).toHaveLength(1);
    expect(seen).toEqual(['reserving', 'sending', null]);
    unsubscribe();
  });

  it('takes no second top-up for a budget that holds one, whoever confirms it', async () => {
    const node = heldTopUps();
    const { s, b, t } = topUpTerms();
    const first = topUpAttempts.confirm(t, new AbortController().signal);
    const second = await topUpAttempts.confirm({ ...t, services: [{ ...t.services[0], value: '700000000000000000' }] }, new AbortController().signal);
    expect(second).toEqual({ kind: 'held' });
    await vi.waitFor(() => expect(node.waiting).toBe(1));
    node.answer();
    expect((await first).kind).toBe('sent');
    expect(node.posts.map((p) => (JSON.parse(p) as { services: Array<{ value: string }> }).services[0].value)).toEqual(['500000000000000000']);
    expect(topUpAttempts.held(s.subscriptionId, b.serviceId)).toBeNull();
  });
});
