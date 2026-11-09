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
  const service = { serviceId: b.serviceId, serviceClass: b.serviceClass ?? 'inference', value: '500000000000000000', maxPricePerUnit: b.maxPricePerUnit };
  return { s, b, t: { subscriptionId: s.subscriptionId, epoch: s.epoch, service, before: b.value } };
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
    // Listed as carried out, by its key, for a page to read what it added.
    expect(topUpAttempts.completed()).toEqual([(JSON.parse(node.posts[0]) as { idempotencyKey: string }).idempotencyKey]);
    unsubscribe();
  });

  it('takes no second top-up for a budget that holds one, whoever confirms it', async () => {
    const node = heldTopUps();
    const { s, b, t } = topUpTerms();
    const first = topUpAttempts.confirm(t, new AbortController().signal);
    const second = await topUpAttempts.confirm({ ...t, service: { ...t.service, value: '700000000000000000' } }, new AbortController().signal);
    expect(second).toEqual({ kind: 'held' });
    await vi.waitFor(() => expect(node.waiting).toBe(1));
    node.answer();
    expect((await first).kind).toBe('sent');
    expect(node.posts.map((p) => (JSON.parse(p) as { services: Array<{ value: string }> }).services[0].value)).toEqual(['500000000000000000']);
    expect(topUpAttempts.held(s.subscriptionId, b.serviceId)).toBeNull();
  });

  it('brings back from storage only a top-up of exactly one whole service', () => {
    const { s: sub, b, t } = topUpTerms();
    const key = `dkg-marketplace-topup:${sub.subscriptionId}:${b.serviceId}`;
    const kept = (services: unknown[]) => JSON.stringify({ subscriptionId: sub.subscriptionId, epoch: sub.epoch, before: b.value, request: { services, idempotencyKey: 'k-1' } });
    const other = `0x${'52'.repeat(32)}`;
    for (const services of [[], [t.service, { ...t.service, serviceId: other }], [{ ...t.service, value: '0.5' }], [{ ...t.service, serviceClass: 'other' }]]) {
      sessionStorage.setItem(key, kept(services));
      forgetTopUpAttempts();
      expect(topUpAttempts.held(sub.subscriptionId, b.serviceId)).toBeNull();
    }
    sessionStorage.setItem(key, kept([t.service]));
    forgetTopUpAttempts();
    expect(topUpAttempts.held(sub.subscriptionId, b.serviceId)).toMatchObject({ kind: 'unknown', attempt: { service: t.service, idempotencyKey: 'k-1' } });
  });
});
