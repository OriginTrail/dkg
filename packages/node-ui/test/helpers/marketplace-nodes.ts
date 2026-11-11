// The stateful fixture nodes the Plans suites run on: one that keeps each
// write, holds dry runs, edits its answers, moves an epoch boundary, fails
// plan reads, or carries out top-ups once per key as the node's contract
// has them; and the steps that open a top-up.
import React from 'react';
import { vi } from 'vitest';
import { PlansView } from '../../src/ui/marketplace/views/PlansView.js';
import { FIXTURE_IDS, fixtureFetch } from '../../src/ui/marketplace/api/fixtures.js';
import { byTestId, click, flush, render, type, waitForText } from './marketplace-render.js';

export const plans = () => React.createElement(PlansView);

export async function waitUntil(check: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await flush(10);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** The fixture node, keeping what each write sent. */
export function recordWrites(scenario: 'active' | 'none'): Array<{ method: string; url: string; body: unknown }> {
  const writes: Array<{ method: string; url: string; body: unknown }> = [];
  const node = fixtureFetch(scenario);
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') writes.push({ method: init.method, url: String(input), body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    return node(input, init);
  });
  return writes;
}

/** The fixture node, keeping each write, with dry runs held back while `hold` is on until `release()`. */
export function holdDryRuns(scenario: 'active' | 'none') {
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

export const fundings = (writes: Array<{ method: string; url: string }>) => writes.filter((w) => w.method === 'POST' && w.url === '/api/marketplace/subscriptions');

export type Json = Record<string, unknown>;

/** The fixture node with each answer passed through `edit` first, keeping each write. */
export function editedNode(scenario: 'active' | 'none', edit: (method: string, url: string, body: Json) => void): Array<{ method: string; url: string; body: unknown }> {
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
export function boundaryNode() {
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
export function failingPlanNode(scenario: 'active' | 'none' | 'ended', failing: () => boolean): Array<{ method: string; url: string }> {
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

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
/** A refusal as the node's marketplace routes send it. */
export const refusal = (status: number, code: string, args: string[] = []) => json({ error: `${code}(${args.join(', ')})`, code, ...(args.length ? { args } : {}), retryable: false }, status);

/** How the first send of a top-up's key goes. */
export type FirstSend =
  /** The node takes the key, the transaction lands, and the answer comes back. */
  | 'answer'
  /** The node takes the key, but its answer never comes back; the transaction lands at `land()`. */
  | 'lose'
  /** The node takes the key, and its answer comes back once the transaction lands at `land()`. */
  | 'hold'
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
 * wait for `release()`, and with `holdReads` on, every one does.
 */
export function topUpNode() {
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  const node = fixtureFetch('active');
  let landed: Json | null = null;
  let landings = 0;
  let toppedUp = false;
  const keys = new Map<string, { body: string; answer: Promise<string> }>();
  const onTheirWay: Array<() => Promise<void>> = [];
  const held: Array<() => void> = [];
  const control = {
    requests,
    first: [] as FirstSend[],
    refuseCaller: null as (() => Response) | null,
    /** A repeat of a key whose first answer was lost names no transaction, as a node that settles it by the budgets does. */
    untracked: false,
    holdChecks: false,
    holdReads: false,
    /** The subscriptions read once fails, as a node error. */
    failNextRead: false,
    /** The transactions whose answers were lost land; awaited, once they have. */
    land() { return Promise.all(onTheirWay.splice(0).map((l) => l())).then(() => undefined); },
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
      if (taken && taken.body !== raw) return refusal(409, 'IdempotencyKeyReused');
      if (taken) {
        const first = await taken.answer;
        return new Response(control.untracked ? JSON.stringify({ ...JSON.parse(first) as Json, txHash: null, blockNumber: null }) : first, { status: 200 });
      }
      const how = control.first.shift() ?? 'answer';
      if (typeof how === 'function') return how();
      const answer = how === 'lose' || how === 'hold' ? new Promise<string>((resolve) => { onTheirWay.push(() => commit(input, init).then(resolve)); }) : commit(input, init);
      keys.set(key, { body: raw, answer });
      if (how === 'lose') throw new TypeError('Failed to fetch');
      const text = await answer;
      return new Response(how === 'cut' ? text.slice(0, Math.floor(text.length / 2)) : text, { status: 200 });
    }
    if (method === 'GET' && url.startsWith('/api/marketplace/subscriptions')) {
      if (control.holdReads || (control.holdChecks && toppedUp)) await new Promise<void>((resolve) => held.push(resolve));
      return read(input, init);
    }
    return node(input, init);
  });
  return control;
}

export const topUps = (requests: Array<{ method: string; url: string; body?: unknown }>) => requests.filter((r) => r.method === 'POST' && r.url.endsWith('/top-up'));
export const keyOf = (r: { body?: unknown }) => (r.body as { idempotencyKey: string }).idempotencyKey;
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Open the top-up of the budget at its soft ceiling, for 0.5 TRAC, once its dry run is in. */
export async function topUpLlama(): Promise<HTMLElement> {
  const c = await render(plans());
  await waitForText(c, 'This budget is at its soft ceiling');
  await click(byTestId(c, `mkt-topup-${FIXTURE_IDS.llama8b}`));
  await type(byTestId(c, 'mkt-topup-amount'), '0.5');
  await flush(300);
  await waitForText(c, 'Costs 0.5 TRAC from the buyer wallet for epoch 664');
  return c;
}

/** Caps in wei per unit, by service, on this node's subscriptions and plan. */
export function withCaps(caps: Record<string, string>) {
  const cap = (x: Json) => { if (typeof x.serviceId === 'string' && caps[x.serviceId]) { x.maxPricePerUnit = caps[x.serviceId]; x.maxPricePerUnitTrac = '0.0'; } };
  return (method: string, url: string, body: Json) => {
    if (method !== 'GET') return;
    if (url.startsWith('/api/marketplace/subscriptions')) for (const s of (body.subscriptions as Json[]) ?? []) for (const b of s.budgets as Json[]) cap(b);
    if (url === '/api/marketplace/plan') for (const s of (body.services as Json[]) ?? []) cap(s);
  };
}
