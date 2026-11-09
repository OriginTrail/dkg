// @vitest-environment happy-dom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlansView } from '../src/ui/marketplace/views/PlansView.js';
import { TopUp } from '../src/ui/marketplace/purchase/TopUp.js';
import { useMarketplaceDraftStore } from '../src/ui/marketplace/draftStore.js';
import { FIXTURE_IDS, fixtureFetch, fixtureWorld } from '../src/ui/marketplace/api/fixtures.js';
import { MISSING_COPY, buttonWithText, byTestId, click, flush, reloadPage, render, type, unmountAll, useFixtureNode, waitForText } from './helpers/marketplace-render.js';

const plans = () => React.createElement(PlansView);

async function waitUntil(check: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await flush(10);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** The fixture node, keeping what each write sent. */
function recordWrites(scenario: 'active' | 'none'): Array<{ method: string; url: string; body: unknown }> {
  const writes: Array<{ method: string; url: string; body: unknown }> = [];
  const node = fixtureFetch(scenario);
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') writes.push({ method: init.method, url: String(input), body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    return node(input, init);
  });
  return writes;
}

/** The fixture node, keeping each write, with dry runs held back while `hold` is on until `release()`. */
function holdDryRuns(scenario: 'active' | 'none') {
  const writes: Array<{ method: string; url: string; body: unknown }> = [];
  const held: Array<{ body: unknown; answer: () => void }> = [];
  const node = fixtureFetch(scenario);
  const control = {
    writes,
    hold: false,
    /** How many dry runs are waiting. */
    get waiting() { return held.length; },
    /** Answer the held dry runs, newest first when `newestFirst`. */
    release(newestFirst = false) {
      const out = held.splice(0);
      for (const h of newestFirst ? out.reverse() : out) h.answer();
    },
  };
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if (method !== 'GET') writes.push({ method, url: String(input), body });
    if (control.hold && String(input).endsWith('/subscriptions/preview')) {
      return new Promise<Response>((resolve) => { held.push({ body, answer: () => resolve(node(input, init)) }); });
    }
    return node(input, init);
  });
  return control;
}

const fundings = (writes: Array<{ method: string; url: string }>) => writes.filter((w) => w.method === 'POST' && w.url === '/api/marketplace/subscriptions');

type Json = Record<string, unknown>;

/** The fixture node with each answer passed through `edit` first, keeping each write. */
function editedNode(scenario: 'active' | 'none', edit: (method: string, url: string, body: Json) => void): Array<{ method: string; url: string; body: unknown }> {
  const writes: Array<{ method: string; url: string; body: unknown }> = [];
  const node = fixtureFetch(scenario);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') writes.push({ method, url: String(input), body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const res = await node(input, init);
    const body = await res.json() as Json;
    edit(method, String(input), body);
    return new Response(JSON.stringify(body), { status: res.status, headers: { 'Content-Type': 'application/json' } });
  });
  return writes;
}

/**
 * The fixture node of a buyer that never subscribed, in epoch 664 until
 * `pass()` moves it to 665, keeping each write. Dry runs and fundings name
 * their epoch as the node's route reads it, 'current', 'next' or a number,
 * and a funding of an epoch that is neither the current nor the next one is
 * refused with InvalidFundingRequest(epoch), as the node refuses it.
 */
function boundaryNode() {
  const writes: Array<{ method: string; url: string; body: unknown }> = [];
  const node = fixtureFetch('none');
  let epoch = 664;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Json : undefined;
    if (method !== 'GET') writes.push({ method, url, body });
    if (method !== 'POST' || (url !== '/api/marketplace/subscriptions' && url !== '/api/marketplace/subscriptions/preview')) return node(input, init);
    const asked = body!.epoch === 'current' ? epoch : body!.epoch === 'next' ? epoch + 1 : body!.epoch as number;
    if (asked !== epoch && asked !== epoch + 1 && !url.endsWith('/preview')) return refusal(400, 'InvalidFundingRequest', ['epoch']);
    const answer = await (await node(input, { ...init, body: JSON.stringify({ ...body, epoch: asked }) })).json() as Json;
    // What it funded: the epoch it was asked for, as the node reads it now.
    if (answer.subscription) (answer.subscription as Json).epoch = asked;
    return json(answer);
  });
  return { writes, pass: () => { epoch += 1; } };
}

/** The fixture node in `scenario`, keeping each write, whose plan reads fail as a node error while `failing()` holds. */
function failingPlanNode(scenario: 'active' | 'none' | 'ended', failing: () => boolean): Array<{ method: string; url: string }> {
  const writes: Array<{ method: string; url: string }> = [];
  const node = fixtureFetch(scenario);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') writes.push({ method, url: String(input) });
    if (method === 'GET' && String(input) === '/api/marketplace/plan' && failing()) return json({ error: 'database is locked', code: 'Error', retryable: false }, 500);
    return node(input, init);
  });
  return writes;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
/** A refusal as the node's marketplace routes send it. */
const refusal = (status: number, code: string, args: string[] = []) => json({ error: `${code}(${args.join(', ')})`, code, ...(args.length ? { args } : {}), retryable: false }, status);

/** How the first send of a top-up's key goes. */
type FirstSend =
  /** The node takes the key, the transaction lands, and the answer comes back. */
  | 'answer'
  /** The node takes the key, but its answer never comes back; the transaction lands at `land()`. */
  | 'lose'
  /** The node takes the key and the transaction lands, but the answer stops partway through its body. */
  | 'cut'
  /** This answer comes back instead, from in front of the node or as its refusal, and the key is not taken. */
  | (() => Response);

/**
 * The fixture node, keeping every request, with top-ups as its contract has
 * them: each idempotency key is carried out once, a repeat of a key gets the
 * first answer (and waits for it while the transaction is on its way), and a
 * key sent with another body is refused with IdempotencyKeyReused. `first`
 * says how each key's first send goes, in turn (then 'answer'); with
 * `refuseCaller` set, every top-up gets that answer before its key is looked
 * at, as a token that is not the node admin's does. Reads of the
 * subscriptions show what landed; with `holdChecks` on, those after a top-up
 * wait for `release()`.
 */
function topUpNode() {
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  const node = fixtureFetch('active');
  let landed: Json | null = null;
  let landings = 0;
  let toppedUp = false;
  const keys = new Map<string, { body: string; answer: Promise<string> }>();
  const onTheirWay: Array<() => void> = [];
  const held: Array<() => void> = [];
  const control = {
    requests,
    first: [] as FirstSend[],
    refuseCaller: null as (() => Response) | null,
    holdChecks: false,
    /** The subscriptions read once fails, as a node error. */
    failNextRead: false,
    /** The transactions whose answers were lost land. */
    land() { for (const l of onTheirWay.splice(0)) l(); },
    release() { for (const r of held.splice(0)) r(); },
    get waiting() { return held.length; },
    /** How many top-ups landed on chain. */
    get landings() { return landings; },
  };
  const commit = async (input: RequestInfo | URL, init?: RequestInit): Promise<string> => {
    const answer = await (await node(input, init)).text();
    landed = (JSON.parse(answer) as { subscription: Json }).subscription;
    landings += 1;
    return answer;
  };
  const read = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (control.failNextRead) {
      control.failNextRead = false;
      return json({ error: 'store unavailable' }, 500);
    }
    const res = await node(input, init);
    if (!landed) return res;
    const body = await res.json() as { subscriptions: Json[] };
    body.subscriptions = body.subscriptions.map((s) => (s.subscriptionId === landed!.subscriptionId ? landed! : s));
    return json(body);
  };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    requests.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    if (method === 'POST' && url.endsWith('/top-up')) {
      toppedUp = true;
      if (control.refuseCaller) return control.refuseCaller();
      const raw = String(init?.body);
      const key = (JSON.parse(raw) as { idempotencyKey?: string }).idempotencyKey ?? '';
      const taken = keys.get(key);
      if (taken) return taken.body === raw ? new Response(await taken.answer, { status: 200 }) : refusal(409, 'IdempotencyKeyReused');
      const how = control.first.shift() ?? 'answer';
      if (typeof how === 'function') return how();
      const answer = how === 'lose' ? new Promise<string>((resolve) => { onTheirWay.push(() => { void commit(input, init).then(resolve); }); }) : commit(input, init);
      keys.set(key, { body: raw, answer });
      if (how === 'lose') throw new TypeError('Failed to fetch');
      const text = await answer;
      return new Response(how === 'cut' ? text.slice(0, Math.floor(text.length / 2)) : text, { status: 200 });
    }
    if (method === 'GET' && url.startsWith('/api/marketplace/subscriptions')) {
      if (control.holdChecks && toppedUp) await new Promise<void>((resolve) => held.push(resolve));
      return read(input, init);
    }
    return node(input, init);
  });
  return control;
}

const topUps = (requests: Array<{ method: string; url: string; body?: unknown }>) => requests.filter((r) => r.method === 'POST' && r.url.endsWith('/top-up'));
const keyOf = (r: { body?: unknown }) => (r.body as { idempotencyKey: string }).idempotencyKey;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Open the top-up of the budget at its soft ceiling, for 0.5 TRAC, once its dry run is in. */
async function topUpLlama(): Promise<HTMLElement> {
  const c = await render(plans());
  await waitForText(c, 'This budget is at its soft ceiling');
  await click(byTestId(c, `mkt-topup-${FIXTURE_IDS.llama8b}`));
  await type(byTestId(c, 'mkt-topup-amount'), '0.5');
  await flush(300);
  await waitForText(c, 'Costs 0.5 TRAC from the buyer wallet for epoch 664');
  return c;
}

/** Caps in wei per unit, by service, on this node's subscriptions and plan. */
function withCaps(caps: Record<string, string>) {
  const cap = (x: Json) => { if (typeof x.serviceId === 'string' && caps[x.serviceId]) { x.maxPricePerUnit = caps[x.serviceId]; x.maxPricePerUnitTrac = '0.0'; } };
  return (method: string, url: string, body: Json) => {
    if (method !== 'GET') return;
    if (url.startsWith('/api/marketplace/subscriptions')) for (const s of (body.subscriptions as Json[]) ?? []) for (const b of s.budgets as Json[]) cap(b);
    if (url === '/api/marketplace/plan') for (const s of (body.services as Json[]) ?? []) cap(s);
  };
}

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

  it('tops up a budget from the subscription\'s own source after the node\'s dry run', async () => {
    const writes = recordWrites('active');
    const c = await render(plans());
    await waitForText(c, 'This budget is at its soft ceiling');
    await click(byTestId(c, `mkt-topup-${FIXTURE_IDS.llama8b}`));
    expect(byTestId(c, 'mkt-topup')?.textContent).toContain('Top up llama-3.1-8b-instruct for epoch 664');
    await type(byTestId(c, 'mkt-topup-amount'), '50');
    await flush(300);
    await waitForText(c, 'The buyer wallet does not hold enough TRAC');
    expect((byTestId(c, 'mkt-topup-confirm') as HTMLButtonElement).disabled).toBe(true);
    await type(byTestId(c, 'mkt-topup-amount'), '0.5');
    await flush(300);
    await waitForText(c, 'Costs 0.5 TRAC from the buyer wallet for epoch 664');
    await click(byTestId(c, 'mkt-topup-confirm'));
    await waitForText(c, 'llama-3.1-8b-instruct topped up');
    const subscription = `/api/marketplace/subscriptions/${'0x' + '98'.repeat(32)}`;
    const services = [{ serviceId: FIXTURE_IDS.llama8b, serviceClass: 'inference', value: '500000000000000000', maxPricePerUnit: '1200000000000' }];
    expect(writes.filter((w) => w.url === `${subscription}/top-up`)).toEqual([{ method: 'POST', url: `${subscription}/top-up`, body: { services, idempotencyKey: expect.stringMatching(UUID_V4) } }]);
    const dryRuns = writes.filter((w) => w.url === `${subscription}/top-up/preview`);
    expect(dryRuns.at(-1)).toEqual({ method: 'POST', url: `${subscription}/top-up/preview`, body: { services } });
    expect(writes.findIndex((w) => w.url === `${subscription}/top-up`)).toBeGreaterThan(writes.lastIndexOf(dryRuns.at(-1)!));
  });

  for (const cap of ['123456000000', '10']) {
    it(`tops up a budget with its own cap to the wei (${cap} wei per token)`, async () => {
      const writes = editedNode('active', withCaps({ [FIXTURE_IDS.llama8b]: cap }));
      const c = await render(plans());
      await waitForText(c, 'This budget is at its soft ceiling');
      await click(byTestId(c, `mkt-topup-${FIXTURE_IDS.llama8b}`));
      const capInput = byTestId(c, 'mkt-topup-cap') as HTMLInputElement;
      expect(capInput.disabled).toBe(true);
      expect(capInput.value).toBe(cap === '10' ? '0.00000000001' : '0.123456');
      await type(byTestId(c, 'mkt-topup-amount'), '0.5');
      await flush(300);
      await waitForText(c, 'Costs 0.5 TRAC from the buyer wallet for epoch 664');
      await click(byTestId(c, 'mkt-topup-confirm'));
      await waitForText(c, 'llama-3.1-8b-instruct topped up');
      const sentCaps = writes.filter((w) => w.url.includes('/top-up')).map((w) => (w.body as { services: Array<{ maxPricePerUnit: string }> }).services[0].maxPricePerUnit);
      expect(sentCaps.length).toBeGreaterThanOrEqual(2);
      expect(new Set(sentCaps)).toEqual(new Set([cap]));
    });
  }

  it('offers only Retry of the same top-up when its answer is lost and it lands later, and the node adds it once', async () => {
    const node = topUpNode();
    node.first.push('lose');
    const c = await topUpLlama();
    await click(byTestId(c, 'mkt-topup-confirm'));
    // The answer is lost and the transaction is still on its way: the budget holds what it did.
    await waitForText(c, 'The budget holds 0.5 TRAC: it does not show the top-up, which may still land.');
    expect(byTestId(c, 'mkt-topup')?.getAttribute('data-phase')).toBe('unknown');
    expect(byTestId(c, 'mkt-topup-unsure')?.getAttribute('data-state')).toBe('missing');
    expect(byTestId(c, 'mkt-topup-confirm')).toBeNull();
    expect(byTestId(c, 'mkt-preview')).toBeNull();
    expect((byTestId(c, 'mkt-topup-amount') as HTMLInputElement).disabled).toBe(true);

    // Closed and opened again, the form brings back the same top-up, with Retry alone.
    await click(buttonWithText(c, 'Cancel'));
    expect(byTestId(c, 'mkt-topup')).toBeNull();
    await click(byTestId(c, `mkt-topup-${FIXTURE_IDS.llama8b}`));
    await waitForText(c, 'The budget holds 0.5 TRAC: it does not show the top-up');
    expect(byTestId(c, 'mkt-topup-confirm')).toBeNull();
    expect((byTestId(c, 'mkt-topup-amount') as HTMLInputElement).value).toBe('0.5');
    expect(topUps(node.requests)).toHaveLength(1);

    // The transaction lands: the budget shows it, but only the node's answer ends the top-up.
    node.land();
    await click(byTestId(c, 'mkt-topup-check'));
    await waitForText(c, 'The budget holds 1 TRAC, up from 0.5: it shows the top-up.');
    expect(byTestId(c, 'mkt-topup-sent')).toBeNull();
    expect(byTestId(c, 'mkt-topup-confirm')).toBeNull();

    await click(byTestId(c, 'mkt-topup-retry'));
    await waitForText(c, 'llama-3.1-8b-instruct topped up · tx 0xc2c2…c2c2');
    const sent = topUps(node.requests);
    expect(sent).toHaveLength(2);
    expect(keyOf(sent[0])).toMatch(UUID_V4);
    expect(sent[1].body).toEqual(sent[0].body);
    expect(node.landings).toBe(1);
    expect(sessionStorage.length).toBe(0);
  });

  it('keeps a top-up whose answer was lost across a reload of the page, and Retry sends it again as it was', async () => {
    const node = topUpNode();
    node.first.push('lose');
    let c = await topUpLlama();
    await click(byTestId(c, 'mkt-topup-confirm'));
    await waitForText(c, 'it does not show the top-up');
    await reloadPage();

    c = await render(plans());
    await waitForText(c, 'This budget is at its soft ceiling');
    await click(byTestId(c, `mkt-topup-${FIXTURE_IDS.llama8b}`));
    await waitForText(c, 'The budget holds 0.5 TRAC: it does not show the top-up');
    expect(byTestId(c, 'mkt-topup-confirm')).toBeNull();
    // A Retry sent before the transaction lands waits for the node's first answer.
    await click(byTestId(c, 'mkt-topup-retry'));
    expect((byTestId(c, 'mkt-topup-retry') as HTMLButtonElement).disabled).toBe(true);
    node.land();
    await waitForText(c, 'llama-3.1-8b-instruct topped up · tx');
    const sent = topUps(node.requests);
    expect(sent).toHaveLength(2);
    expect(sent[1].body).toEqual(sent[0].body);
    expect(node.landings).toBe(1);
    expect(sessionStorage.length).toBe(0);
  });

  it('reads the budget again on request after a lost answer, with Retry alone while it cannot be read', async () => {
    const node = topUpNode();
    node.first.push('lose');
    const c = await topUpLlama();
    node.holdChecks = true;
    await click(byTestId(c, 'mkt-topup-confirm'));
    await waitForText(c, 'Reading the budget…');
    expect(node.waiting).toBe(1);
    node.failNextRead = true;
    node.release();
    await waitForText(c, 'The budget could not be read.');
    expect(byTestId(c, 'mkt-topup-unsure')?.getAttribute('data-state')).toBe('unread');
    expect(byTestId(c, 'mkt-topup-confirm')).toBeNull();
    node.holdChecks = false;
    node.land();
    await click(byTestId(c, 'mkt-topup-check'));
    await waitForText(c, 'The budget holds 1 TRAC, up from 0.5');
    await click(byTestId(c, 'mkt-topup-retry'));
    await waitForText(c, 'llama-3.1-8b-instruct topped up · tx');
    expect(topUps(node.requests).map(keyOf)).toEqual([keyOf(topUps(node.requests)[0]), keyOf(topUps(node.requests)[0])]);
    expect(node.landings).toBe(1);
  });

  it('sends the same top-up again on Retry after a failure the node does not explain, never a new one', async () => {
    const node = topUpNode();
    node.first.push(() => json({ error: 'upstream timed out' }, 504));
    const c = await topUpLlama();
    await click(byTestId(c, 'mkt-topup-confirm'));
    await waitForText(c, 'The budget holds 0.5 TRAC: it does not show the top-up');
    expect(byTestId(c, 'mkt-error-card')?.getAttribute('data-code')).toBe('HTTP_504');
    await flush(300);
    expect(byTestId(c, 'mkt-topup-confirm')).toBeNull();
    // No dry run opens another top-up meanwhile.
    const sentAt = node.requests.indexOf(topUps(node.requests)[0]);
    expect(node.requests.slice(sentAt + 1).some((r) => r.url.endsWith('/top-up/preview'))).toBe(false);
    await click(byTestId(c, 'mkt-topup-retry'));
    await waitForText(c, 'llama-3.1-8b-instruct topped up · tx');
    const sent = topUps(node.requests);
    expect(sent).toHaveLength(2);
    expect(sent[1].body).toEqual(sent[0].body);
    expect(node.landings).toBe(1);
  });

  it('keeps a top-up whose answer is cut off waiting for the node, and Retry sends it again with its key', async () => {
    const node = topUpNode();
    node.first.push('cut');
    const c = await topUpLlama();
    await click(byTestId(c, 'mkt-topup-confirm'));
    // The transaction landed, but an answer that cannot be read says nothing: the outcome stays unknown.
    await waitForText(c, 'The budget holds 1 TRAC, up from 0.5: it shows the top-up.');
    expect(byTestId(c, 'mkt-topup')?.getAttribute('data-phase')).toBe('unknown');
    expect(byTestId(c, 'mkt-topup-sent')).toBeNull();
    expect(byTestId(c, 'mkt-topup-confirm')).toBeNull();
    expect(byTestId(c, 'mkt-topup-unsure')?.querySelector('[data-code="UnreadableAnswer"]')).toBeTruthy();
    expect(sessionStorage.length).toBe(1);
    await click(byTestId(c, 'mkt-topup-retry'));
    await waitForText(c, 'llama-3.1-8b-instruct topped up · tx 0xc2c2…c2c2');
    const sent = topUps(node.requests);
    expect(sent).toHaveLength(2);
    expect(keyOf(sent[0])).toMatch(UUID_V4);
    expect(sent[1].body).toEqual(sent[0].body);
    expect(node.landings).toBe(1);
    expect(sessionStorage.length).toBe(0);
  });

  const silentOnTheKey: Array<[string, () => Response]> = [
    ['NodeAdminRequired', () => refusal(403, 'NodeAdminRequired')],
    ['IdempotencyKeyReused', () => refusal(409, 'IdempotencyKeyReused')],
    ['Unauthorized', () => json({ error: 'Unauthorized' }, 401)],
    ['HTTP_429', () => json({ error: 'Too many requests' }, 429)],
  ];
  for (const [code, answer] of silentOnTheKey) {
    it(`keeps the top-up unknown when a Retry meets a refusal that says nothing of its key (${code})`, async () => {
      const node = topUpNode();
      node.first.push('lose');
      const c = await topUpLlama();
      await click(byTestId(c, 'mkt-topup-confirm'));
      await waitForText(c, 'it does not show the top-up');
      node.refuseCaller = answer;
      await click(byTestId(c, 'mkt-topup-retry'));
      await waitUntil(() => !!byTestId(c, 'mkt-topup-unsure')?.querySelector(`[data-code="${code}"]`), `the ${code} refusal beside Retry`);
      expect(byTestId(c, 'mkt-topup')?.getAttribute('data-phase')).toBe('unknown');
      expect(byTestId(c, 'mkt-topup-confirm')).toBeNull();
      expect(sessionStorage.length).toBe(1);
      node.refuseCaller = null;
      node.land();
      await click(byTestId(c, 'mkt-topup-retry'));
      await waitForText(c, 'llama-3.1-8b-instruct topped up · tx');
      expect(new Set(topUps(node.requests).map(keyOf)).size).toBe(1);
      expect(node.landings).toBe(1);
    });
  }

  it('ends a top-up the node refuses outright on Retry: the next one is new, with a new key, after a fresh dry run', async () => {
    const node = topUpNode();
    node.first.push(() => json({ error: 'upstream timed out' }, 504), () => refusal(409, 'LimitExceeded', ['maxCostPerEpoch', '1', '2']));
    const c = await topUpLlama();
    await click(byTestId(c, 'mkt-topup-confirm'));
    await waitForText(c, 'it does not show the top-up');
    await click(byTestId(c, 'mkt-topup-retry'));
    await waitForText(c, 'This costs more than the account\'s limit per epoch');
    expect(byTestId(c, 'mkt-topup')?.getAttribute('data-phase')).toBe('compose');
    expect(sessionStorage.length).toBe(0);
    await flush(300);
    await waitForText(c, 'Costs 0.5 TRAC from the buyer wallet for epoch 664');
    await click(byTestId(c, 'mkt-topup-confirm'));
    await waitForText(c, 'llama-3.1-8b-instruct topped up · tx');
    const keys = topUps(node.requests).map(keyOf);
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[2]).toMatch(UUID_V4);
  });

  it('keeps a top-up of unknown outcome in the page when the browser refuses session storage', async () => {
    const refuse = () => { throw new DOMException('denied', 'SecurityError'); };
    const spies = (['getItem', 'setItem', 'removeItem'] as const).map((m) => vi.spyOn(Storage.prototype, m).mockImplementation(refuse));
    try {
      const node = topUpNode();
      node.first.push('lose');
      const c = await topUpLlama();
      await click(byTestId(c, 'mkt-topup-confirm'));
      await waitForText(c, 'it does not show the top-up');
      await click(buttonWithText(c, 'Cancel'));
      await click(byTestId(c, `mkt-topup-${FIXTURE_IDS.llama8b}`));
      await waitForText(c, 'it does not show the top-up');
      expect(byTestId(c, 'mkt-topup-confirm')).toBeNull();
      node.land();
      await click(byTestId(c, 'mkt-topup-retry'));
      await waitForText(c, 'llama-3.1-8b-instruct topped up · tx');
      expect(node.landings).toBe(1);
      // Answered, it is gone from the page: a form for the same budget opens on a new top-up.
      const world = fixtureWorld();
      const fresh = await render(React.createElement(TopUp, {
        catalog: world.catalog(true), subscription: world.current, serviceId: FIXTURE_IDS.llama8b, onDone: () => undefined, onCancel: () => undefined,
      }));
      expect(byTestId(fresh, 'mkt-topup')?.getAttribute('data-phase')).toBe('compose');
      expect(byTestId(fresh, 'mkt-topup-confirm')).toBeTruthy();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it('asks for a fresh dry run after a refusal, without looking the top-up up', async () => {
    const node = topUpNode();
    node.first.push(() => refusal(409, 'LimitExceeded', ['maxCostPerEpoch', '1', '2']));
    const c = await topUpLlama();
    await click(byTestId(c, 'mkt-topup-confirm'));
    await waitForText(c, 'LimitExceeded');
    expect(byTestId(c, 'mkt-error-card')?.getAttribute('data-code')).toBe('LimitExceeded');
    expect(byTestId(c, 'mkt-topup-unsure')).toBeNull();
    const sentAt = node.requests.indexOf(topUps(node.requests)[0]);
    expect(node.requests.slice(sentAt + 1).some((r) => r.method === 'GET' && r.url.startsWith('/api/marketplace/subscriptions'))).toBe(false);
    await flush(300);
    await waitForText(c, 'Costs 0.5 TRAC from the buyer wallet for epoch 664');
    expect((byTestId(c, 'mkt-topup-confirm') as HTMLButtonElement).disabled).toBe(false);
  });

  it('adds a budget at the dearest seller\'s price to the wei', async () => {
    const price = '3123456789012';
    const writes = editedNode('active', (method, url, body) => {
      if (method !== 'GET' || url !== '/api/marketplace/catalog') return;
      for (const s of body.services as Json[]) {
        if (s.serviceId !== FIXTURE_IDS.mistral24b) continue;
        for (const o of s.offers as Json[]) o.pricePerUnit = price;
        s.priceMin = price; s.priceMax = price;
      }
    });
    const c = await render(plans());
    await waitForText(c, 'Not on your plan yet');
    await click(byTestId(c, `mkt-addon-${FIXTURE_IDS.mistral24b}`));
    expect((byTestId(c, 'mkt-topup-cap') as HTMLInputElement).value).toBe('3.123456789012');
    await flush(300);
    await waitForText(c, 'Costs 1 TRAC from the buyer wallet for epoch 664');
    await click(byTestId(c, 'mkt-topup-confirm'));
    await waitForText(c, 'topped up');
    expect(writes.filter((w) => w.url.endsWith('/top-up')).map((w) => (w.body as { services: Array<{ maxPricePerUnit: string }> }).services[0].maxPricePerUnit)).toEqual([price]);
  });

  it('saves an edit to one line of the plan with every other cap unchanged to the wei', async () => {
    const writes = editedNode('active', withCaps({ [FIXTURE_IDS.qwen14b]: '123456000000', [FIXTURE_IDS.qwen7b]: '10' }));
    const c = await render(plans());
    await waitForText(c, 'Epoch 665 is funded');
    await click(byTestId(c, 'mkt-change-plan'));
    expect((byTestId(c, `mkt-cap-${FIXTURE_IDS.qwen14b}`) as HTMLInputElement).value).toBe('0.123456');
    expect((byTestId(c, `mkt-cap-${FIXTURE_IDS.qwen7b}`) as HTMLInputElement).value).toBe('0.00000000001');
    await type(byTestId(c, `mkt-value-${FIXTURE_IDS.llama8b}`), '0.75');
    await click(byTestId(c, 'mkt-compose-continue'));
    await click(byTestId(c, 'mkt-gate-confirm'));
    await flush(50);
    const saved = writes.filter((w) => w.method === 'PUT' && w.url === '/api/marketplace/plan');
    expect(saved).toHaveLength(1);
    const services = (saved[0].body as { services: Array<{ serviceId: string; value: string; maxPricePerUnit: string }> }).services;
    expect(Object.fromEntries(services.map((s) => [s.serviceId, s.maxPricePerUnit]))).toEqual({
      [FIXTURE_IDS.qwen14b]: '123456000000', [FIXTURE_IDS.qwen7b]: '10', [FIXTURE_IDS.llama8b]: '1200000000000',
    });
    expect(services.find((s) => s.serviceId === FIXTURE_IDS.llama8b)?.value).toBe('750000000000000000');
  });

  it('walks a node that never subscribed through compose, one confirmation and a key', async () => {
    const writes = recordWrites('none');
    const c = await render(plans());
    await waitForText(c, 'Three steps to your first answer');
    expect(byTestId(c, 'mkt-treasury')).toBeTruthy();
    expect(byTestId(c, 'mkt-progress-steps')?.getAttribute('data-step')).toBe('2');
    await click(byTestId(c, `mkt-pick-${FIXTURE_IDS.qwen14b}`));
    expect(byTestId(c, `mkt-units-${FIXTURE_IDS.qwen14b}`)?.textContent).toBe('≈ 1.7M tokens at 0.6 µTRAC, the best price under the cap');
    await type(byTestId(c, `mkt-value-${FIXTURE_IDS.qwen14b}`), '2');
    await click(byTestId(c, 'mkt-source-7'));
    await flush(300);
    await waitForText(c, 'Costs 1.8 TRAC from account 7 for epoch 664: 2 TRAC of service, 10% off');
    await click(byTestId(c, 'mkt-compose-continue'));
    expect(byTestId(c, 'mkt-confirm-gate')?.textContent).toContain('2 TRAC of service · costs 1.8 TRAC ~$0.50');
    await click(byTestId(c, 'mkt-gate-confirm'));
    await waitForText(c, 'Epoch 664 is funded with 2 TRAC');
    expect(byTestId(c, 'mkt-progress-steps')?.getAttribute('data-step')).toBe('3');
    await click(byTestId(c, 'mkt-mint'));
    await waitForText(c, '/api/marketplace/v1');
    expect(byTestId(c, 'mkt-key-plaintext')?.textContent).toContain('dkgmk_0123456789abcdef');
    expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual([
      'POST /api/marketplace/subscriptions/preview', 'POST /api/marketplace/subscriptions', 'PUT /api/marketplace/plan', 'POST /api/marketplace/keys',
    ]);
    expect(writes[1].body).toEqual({ epoch: 664, source: { kind: 'account', accountId: '7' }, services: [{ serviceId: FIXTURE_IDS.qwen14b, serviceClass: 'inference', value: '2000000000000000000', maxPricePerUnit: '700000000000' }] });
    expect(writes[2].body).toMatchObject({ renew: true, renewUntilEpoch: 670 });
    expect(c.textContent).not.toContain(MISSING_COPY);
  });

  it('sends a funding once: when the plan fails to save, a retry saves the plan alone', async () => {
    const sent: string[] = [];
    const node = fixtureFetch('none');
    let failPlan = true;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') sent.push(`${method} ${String(input)}`);
      if (method === 'PUT' && failPlan) {
        failPlan = false;
        return new Response(JSON.stringify({ error: 'disk full', code: 'Error', retryable: false }), { status: 500 });
      }
      return node(input, init);
    });
    const c = await render(plans());
    await waitForText(c, 'Compose your plan');
    await click(byTestId(c, `mkt-pick-${FIXTURE_IDS.qwen14b}`));
    await flush(300);
    await waitForText(c, 'Costs 1 TRAC from the buyer wallet for epoch 664');
    await click(byTestId(c, 'mkt-compose-continue'));
    await click(byTestId(c, 'mkt-gate-confirm'));
    await waitForText(c, 'The epoch is funded, but the plan was not saved');
    expect(byTestId(c, 'mkt-key-step')).toBeTruthy();
    await click(byTestId(c, 'mkt-plan-retry'));
    await flush(50);
    expect(byTestId(c, 'mkt-plan-unsaved')).toBeNull();
    expect(sent.filter((x) => x === 'POST /api/marketplace/subscriptions')).toHaveLength(1);
    expect(sent.filter((x) => x === 'PUT /api/marketplace/plan')).toHaveLength(2);
  });

  it('saves a changed plan alone: a failed save stays on the confirmation, and nothing is funded', async () => {
    const sent: string[] = [];
    const node = fixtureFetch('active');
    let failPlan = true;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') sent.push(`${method} ${String(input)}`);
      if (method === 'PUT' && failPlan) {
        failPlan = false;
        return json({ error: 'disk full', code: 'Error', retryable: false }, 500);
      }
      return node(input, init);
    });
    const c = await render(plans());
    await waitForText(c, 'Epoch 665 is funded');
    await click(byTestId(c, 'mkt-change-plan'));
    await click(byTestId(c, 'mkt-compose-continue'));
    expect(byTestId(c, 'mkt-confirm-gate')?.textContent).toContain('One confirmation — the plan');
    await click(byTestId(c, 'mkt-gate-confirm'));
    await waitForText(c, 'Something went wrong');
    expect(byTestId(c, 'mkt-fund-flow')?.getAttribute('data-phase')).toBe('confirm');
    await click(byTestId(c, 'mkt-gate-confirm'));
    await waitUntil(() => byTestId(c, 'mkt-fund-flow') === null, 'the plan flow to close');
    expect(sent).toEqual(['PUT /api/marketplace/plan', 'PUT /api/marketplace/plan']);
  });

  it('funds the epoch its dry run answered for when the next epoch starts before Confirm', async () => {
    const node = boundaryNode();
    const c = await render(plans());
    await waitForText(c, 'Compose your plan');
    await click(byTestId(c, `mkt-pick-${FIXTURE_IDS.qwen14b}`));
    await click(byTestId(c, 'mkt-epoch-next'));
    await flush(300);
    await waitForText(c, 'Costs 1 TRAC from the buyer wallet for epoch 665');
    await click(byTestId(c, 'mkt-compose-continue'));
    expect(byTestId(c, 'mkt-gate-source')?.textContent).toContain('Epoch 665, paid from the buyer wallet');
    // Epoch 665 starts: 'next' would now be 666.
    node.pass();
    await click(byTestId(c, 'mkt-gate-confirm'));
    await waitForText(c, 'Epoch 665 is funded with 1 TRAC');
    expect(fundings(node.writes).map((w) => (w.body as { epoch: unknown }).epoch)).toEqual([665]);
    expect(node.writes.filter((w) => w.method === 'PUT' && w.url === '/api/marketplace/plan')).toHaveLength(1);
  });

  it('sends nothing more when the epoch a confirmation shows has ended, and funds the open one after a fresh dry run', async () => {
    const node = boundaryNode();
    const c = await render(plans());
    await waitForText(c, 'Compose your plan');
    await click(byTestId(c, `mkt-pick-${FIXTURE_IDS.qwen14b}`));
    await flush(300);
    await waitForText(c, 'Costs 1 TRAC from the buyer wallet for epoch 664');
    await click(byTestId(c, 'mkt-compose-continue'));
    expect(byTestId(c, 'mkt-gate-source')?.textContent).toContain('Epoch 664');
    // Epoch 664 ends: 'current' would now be 665, which the confirmation does not show.
    node.pass();
    await click(byTestId(c, 'mkt-gate-confirm'));
    await waitForText(c, 'That epoch can no longer be funded — go back for a fresh dry run');
    expect(byTestId(c, 'mkt-error-card')?.getAttribute('data-code')).toBe('InvalidFundingRequest');
    expect(byTestId(c, 'mkt-funded')).toBeNull();
    expect(fundings(node.writes).map((w) => (w.body as { epoch: unknown }).epoch)).toEqual([664]);
    expect(node.writes.some((w) => w.method === 'PUT')).toBe(false);

    await click(byTestId(c, 'mkt-gate-cancel'));
    await flush(300);
    await waitForText(c, 'Costs 1 TRAC from the buyer wallet for epoch 665');
    await click(byTestId(c, 'mkt-compose-continue'));
    await click(byTestId(c, 'mkt-gate-confirm'));
    await waitForText(c, 'Epoch 665 is funded with 1 TRAC');
    expect(fundings(node.writes).map((w) => (w.body as { epoch: unknown }).epoch)).toEqual([664, 665]);
  });

  it('holds Continue while a changed budget\'s dry run is pending, and funds only what the shown dry run answered', async () => {
    const node = holdDryRuns('none');
    const c = await render(plans());
    await waitForText(c, 'Compose your plan');
    await click(byTestId(c, `mkt-pick-${FIXTURE_IDS.qwen14b}`));
    await click(byTestId(c, 'mkt-source-7'));
    await flush(300);
    await waitForText(c, 'Costs 0.9 TRAC from account 7 for epoch 664: 1 TRAC of service, 10% off');
    const continueBtn = () => byTestId(c, 'mkt-compose-continue') as HTMLButtonElement;
    expect(continueBtn().disabled).toBe(false);

    // The budget changes to 50 TRAC; its dry run stays pending.
    node.hold = true;
    await type(byTestId(c, `mkt-value-${FIXTURE_IDS.qwen14b}`), '50');
    await flush(300);
    expect(node.waiting).toBe(1);
    expect(byTestId(c, 'mkt-preview')?.textContent).toContain('1 TRAC of service');
    expect(continueBtn().disabled).toBe(true);
    await click(continueBtn());
    expect(byTestId(c, 'mkt-fund-flow')?.getAttribute('data-phase')).toBe('compose');
    expect(byTestId(c, 'mkt-confirm-gate')).toBeNull();
    expect(byTestId(c, 'mkt-gate-confirm')).toBeNull();
    expect(fundings(node.writes)).toEqual([]);

    // The matching dry run comes back: it is shown, and only now can it be accepted.
    node.hold = false;
    node.release();
    await waitForText(c, 'Costs 45 TRAC from account 7 for epoch 664: 50 TRAC of service, 10% off');
    expect(fundings(node.writes)).toEqual([]);
    await click(continueBtn());
    expect(byTestId(c, 'mkt-gate-total')?.textContent).toContain('50 TRAC of service · costs 45 TRAC');
    expect(byTestId(c, 'mkt-gate-lines')?.textContent).toContain('50 TRAC');
    await click(byTestId(c, 'mkt-gate-confirm'));
    await waitForText(c, 'Epoch 664 is funded with 50 TRAC');
    const sent = fundings(node.writes);
    expect(sent.map((w) => w.body)).toEqual([{ epoch: 664, source: { kind: 'account', accountId: '7' }, services: [{ serviceId: FIXTURE_IDS.qwen14b, serviceClass: 'inference', value: '50000000000000000000', maxPricePerUnit: '700000000000' }] }]);
    const lastDryRun = node.writes.map((w) => w.url).lastIndexOf('/api/marketplace/subscriptions/preview');
    expect((node.writes[lastDryRun].body as { services: Array<{ value: string }> }).services[0].value).toBe('50000000000000000000');
    expect(node.writes.indexOf(sent[0])).toBeGreaterThan(lastDryRun);
  });

  it('holds Continue while a changed source\'s dry run is pending, and confirms that source', async () => {
    const node = holdDryRuns('none');
    const c = await render(plans());
    await waitForText(c, 'Compose your plan');
    await click(byTestId(c, `mkt-pick-${FIXTURE_IDS.qwen14b}`));
    await flush(300);
    await waitForText(c, 'Costs 1 TRAC from the buyer wallet for epoch 664');
    node.hold = true;
    await click(byTestId(c, 'mkt-source-7'));
    await flush(300);
    expect(node.waiting).toBe(1);
    expect(byTestId(c, 'mkt-preview')?.textContent).toContain('from the buyer wallet');
    expect((byTestId(c, 'mkt-compose-continue') as HTMLButtonElement).disabled).toBe(true);
    await click(byTestId(c, 'mkt-compose-continue'));
    expect(byTestId(c, 'mkt-confirm-gate')).toBeNull();
    node.hold = false;
    node.release();
    await waitForText(c, 'Costs 0.9 TRAC from account 7 for epoch 664');
    await click(byTestId(c, 'mkt-compose-continue'));
    expect(byTestId(c, 'mkt-gate-source')?.textContent).toContain('account 7');
    expect(byTestId(c, 'mkt-gate-total')?.textContent).toContain('costs 0.9 TRAC');
    await click(byTestId(c, 'mkt-gate-confirm'));
    await waitForText(c, 'Epoch 664 is funded with 1 TRAC');
    expect(fundings(node.writes).map((w) => (w.body as { source: unknown }).source)).toEqual([{ kind: 'account', accountId: '7' }]);
  });

  it('drops a late dry run of an earlier budget', async () => {
    const node = holdDryRuns('none');
    const c = await render(plans());
    await waitForText(c, 'Compose your plan');
    node.hold = true;
    await click(byTestId(c, `mkt-pick-${FIXTURE_IDS.qwen14b}`));
    await flush(300);
    await type(byTestId(c, `mkt-value-${FIXTURE_IDS.qwen14b}`), '2');
    await flush(300);
    expect(node.waiting).toBe(2);
    // The 2 TRAC answer arrives first, then the 1 TRAC one, late.
    node.hold = false;
    node.release(true);
    await waitForText(c, 'Costs 2 TRAC from the buyer wallet for epoch 664');
    await flush(50);
    expect(byTestId(c, 'mkt-preview')?.textContent).toContain('Costs 2 TRAC');
    await click(byTestId(c, 'mkt-compose-continue'));
    expect(byTestId(c, 'mkt-gate-total')?.textContent).toContain('2 TRAC of service · costs 2 TRAC');
    await click(byTestId(c, 'mkt-gate-confirm'));
    await waitForText(c, 'Epoch 664 is funded with 2 TRAC');
    expect(fundings(node.writes).map((w) => (w.body as { services: Array<{ value: string }> }).services[0].value)).toEqual(['2000000000000000000']);
  });

  it('shows the dry run\'s refusal and holds the confirmation back', async () => {
    useFixtureNode('none');
    const c = await render(plans());
    await waitForText(c, 'Compose your plan');
    await click(byTestId(c, `mkt-pick-${FIXTURE_IDS.qwen7b}`));
    await type(byTestId(c, `mkt-value-${FIXTURE_IDS.qwen7b}`), '50');
    await flush(300);
    await waitForText(c, 'The buyer wallet does not hold enough TRAC');
    expect(byTestId(c, 'mkt-preview')?.getAttribute('data-refusal')).toBe('ERC20InsufficientBalance');
    expect((byTestId(c, 'mkt-compose-continue') as HTMLButtonElement).disabled).toBe(true);
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
    await waitForText(c, 'The marketplace is off on this node');
    expect(byTestId(c, 'mkt-plans')?.getAttribute('data-state')).toBe('off');
  });
});
