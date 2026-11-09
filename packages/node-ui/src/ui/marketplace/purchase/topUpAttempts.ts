// Top-ups that outlive their form. A top-up adds to a budget, so each
// confirmed one carries a key of its own, which the node carries out once: a
// repeat of the request gets the first answer and adds nothing. This store is
// the one owner of each confirmed top-up, by subscription and service: it
// reserves the request and its key when Confirm is pressed, keeps them in the
// tab's session storage (and in the page, where the browser refuses that),
// reads the budget before the first send, sends, and, while no answer settles
// the outcome, reads the budget again for the operator to see. Forms show the
// top-up their budget holds, and own only their draft.
//
// When the outcome is unknown (no answer, or a failure the node does not
// explain), only Retry goes on: the same request with the same key, until the
// node answers it, the top-up went through, or the node refused it. A form
// closed before the first send sends nothing; the top-up waits, with its key,
// for a Retry. What the budget holds is never leave to send another: a
// budget that does not show the top-up yet may still receive it.
import { isMarketplaceError, marketplaceApi } from '../api/client.js';
import type { FundedAnswer, ServiceRequest, TopUpRequest } from '../api/types.js';
import { randomUUID } from '../../lib/randomUUID.js';

/**
 * A confirmed top-up: the request as sent, with its key, its subscription's
 * epoch, and the budget's value before the first send, in wei: as the form
 * showed it at Confirm, until the read just before the first send replaces it.
 */
export interface Attempt { subscriptionId: string; epoch: number; request: TopUpRequest; before: string }

/** What the budget holds after an unknown outcome: for the operator to see beside Retry. */
export type BudgetRead = { state: 'checking' } | { state: 'read'; now: bigint } | { state: 'unread'; err: unknown };

/** A top-up the store holds, until the node settles it. */
export type Held =
  /** Confirmed: the budget is read before the first send. */
  | { kind: 'reserving'; attempt: Attempt }
  /** On its way: the first send, or a retry of one whose outcome is unknown. */
  | { kind: 'sending'; attempt: Attempt; retry: boolean }
  /** No conclusive answer yet (`err`, if one came): Retry alone, with the same request and key. */
  | { kind: 'unknown'; attempt: Attempt; err: unknown; read: BudgetRead };

/**
 * How a send a form asked for ended: the top-up went through; the node
 * refused it, so nothing was added; it was not sent, as the budget could not
 * be read first; or it is still held, as above.
 */
export type Outcome =
  | { kind: 'sent'; answer: FundedAnswer }
  | { kind: 'refused'; err: unknown }
  | { kind: 'unsent'; err: unknown }
  | { kind: 'held' };

const HELD: Outcome = { kind: 'held' };

const idOf = (subscriptionId: string, serviceId: string) => `${subscriptionId}:${serviceId}`;
const storageKey = (id: string) => `dkg-marketplace-topup:${id}`;
const attemptId = (a: Attempt) => idOf(a.subscriptionId, a.request.services[0].serviceId);

const attempts = new Map<string, Held>();
/** The budgets whose stored top-up was looked for. */
const looked = new Set<string>();
/** The read of the budget each held top-up waits for, by number: a later read replaces an earlier one. */
const reads = new Map<string, number>();
let readCount = 0;
/** Bumped when the page forgets everything: work begun before then changes nothing. */
let generation = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function store(a: Attempt): void {
  try { window.sessionStorage.setItem(storageKey(attemptId(a)), JSON.stringify(a)); } catch { /* kept in the page alone */ }
}

function unstore(a: Attempt): void {
  try { window.sessionStorage.removeItem(storageKey(attemptId(a))); } catch { /* storage unavailable */ }
}

/** The top-up of a budget that session storage keeps from before a reload, if there is one. */
function stored(subscriptionId: string, serviceId: string): Attempt | null {
  let raw: string | null = null;
  try { raw = window.sessionStorage.getItem(storageKey(idOf(subscriptionId, serviceId))); } catch { /* storage unavailable */ }
  if (raw === null) return null;
  try {
    const a = JSON.parse(raw) as Attempt;
    if (a.subscriptionId === subscriptionId && Number.isInteger(a.epoch) && typeof a.before === 'string'
      && typeof a.request?.idempotencyKey === 'string' && a.request.services?.[0]?.serviceId === serviceId) return a;
  } catch { /* not a top-up this store wrote */ }
  return null;
}

/** Whether `id` still holds `attempt`, in one of `kinds`. */
function holds(id: string, attempt: Attempt, ...kinds: Held['kind'][]): boolean {
  const h = attempts.get(id);
  return !!h && h.attempt.request.idempotencyKey === attempt.request.idempotencyKey && kinds.includes(h.kind);
}

function put(id: string, h: Held): void {
  attempts.set(id, h);
  emit();
}

/** The node settled `attempt`: it goes from the page and from storage. */
function drop(id: string, attempt: Attempt): void {
  if (!holds(id, attempt, 'reserving', 'sending', 'unknown')) return;
  unstore(attempt);
  attempts.delete(id);
  reads.delete(id);
  emit();
}

/**
 * Whether the node refused the top-up itself (a 4xx), so nothing was added
 * under its key. No answer, a 5xx, or a refusal that says nothing of the key
 * leaves the outcome unknown: those given before the top-up is looked at (no
 * valid token, too many requests, a token that is not the node admin's, a
 * node without these routes), and the key held for another request.
 */
function refusedOutright(e: unknown): boolean {
  if (!isMarketplaceError(e) || e.status < 400 || e.status >= 500) return false;
  return e.status !== 401 && e.status !== 429 && !['NodeAdminRequired', 'MarketplaceAbsent', 'IdempotencyKeyReused'].includes(e.code);
}

/** The value of the subscription's budget for `serviceId` as the node shows it now; 0 while it has none. */
async function budgetValueOf(subscriptionId: string, epoch: number, serviceId: string): Promise<bigint> {
  const { subscriptions } = await marketplaceApi.subscriptions(epoch);
  const s = subscriptions.find((x) => x.subscriptionId === subscriptionId);
  if (!s) throw new Error(`subscription ${subscriptionId} is not on the node`);
  const b = s.budgets.find((x) => x.serviceId === serviceId);
  return b ? BigInt(b.value) : 0n;
}

/** Read what the budget of a top-up of unknown outcome holds; only the latest read counts. */
function readBudget(id: string): void {
  const h = attempts.get(id);
  if (h?.kind !== 'unknown') return;
  const { attempt } = h;
  const n = ++readCount;
  const gen = generation;
  reads.set(id, n);
  const settle = (read: BudgetRead) => {
    if (gen !== generation || reads.get(id) !== n) return;
    reads.delete(id);
    const now = attempts.get(id);
    if (now?.kind === 'unknown' && holds(id, attempt, 'unknown')) put(id, { ...now, read });
  };
  budgetValueOf(attempt.subscriptionId, attempt.epoch, attempt.request.services[0].serviceId)
    .then((now) => settle({ state: 'read', now }), (err: unknown) => settle({ state: 'unread', err }));
}

function toUnknown(id: string, attempt: Attempt, err: unknown): void {
  put(id, { kind: 'unknown', attempt, err, read: { state: 'checking' } });
  readBudget(id);
}

/** Send `attempt` and take the node's answer: the top-up went through, the node refused it, or the outcome is unknown. */
async function deliver(id: string, attempt: Attempt, retry: boolean): Promise<Outcome> {
  const gen = generation;
  store(attempt);
  put(id, { kind: 'sending', attempt, retry });
  try {
    const answer = await marketplaceApi.topUp(attempt.subscriptionId, attempt.request);
    if (gen === generation) drop(id, attempt);
    return { kind: 'sent', answer };
  } catch (e) {
    if (gen !== generation) return HELD;
    if (!refusedOutright(e)) {
      toUnknown(id, attempt, e);
      return HELD;
    }
    // Nothing was added under this key: the next top-up is a new one.
    drop(id, attempt);
    return { kind: 'refused', err: e };
  }
}

/** The top-up the budget holds, if any: one confirmed in this page, or one session storage kept across a reload. */
function heldBy(subscriptionId: string, serviceId: string): Held | null {
  const id = idOf(subscriptionId, serviceId);
  if (!looked.has(id)) {
    looked.add(id);
    const a = attempts.has(id) ? null : stored(subscriptionId, serviceId);
    // Whether it was sent before the reload is not known: it waits for Retry.
    if (a) attempts.set(id, { kind: 'unknown', attempt: a, err: null, read: { state: 'checking' } });
  }
  return attempts.get(id) ?? null;
}

export const topUpAttempts = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },

  held: heldBy,

  /** Read the budget of a top-up brought back from storage, unless a read is on its way. A form asks this when it opens. */
  check(subscriptionId: string, serviceId: string): void {
    const id = idOf(subscriptionId, serviceId);
    const h = heldBy(subscriptionId, serviceId);
    if (h?.kind === 'unknown' && h.read.state === 'checking' && !reads.has(id)) readBudget(id);
  },

  /**
   * Confirm a top-up of `services` (one service), as its dry run answered it.
   * It and a new key are kept from here on, before anything is awaited; the
   * budget is read, and the top-up sent, unless the form was `closed`
   * meanwhile: then it waits, with its key, for a Retry. A budget that holds a
   * top-up already takes no other.
   */
  async confirm(t: { subscriptionId: string; epoch: number; services: ServiceRequest[]; before: string }, closed: AbortSignal): Promise<Outcome> {
    const serviceId = t.services[0].serviceId;
    const id = idOf(t.subscriptionId, serviceId);
    if (heldBy(t.subscriptionId, serviceId)) return HELD;
    const gen = generation;
    const reserved: Attempt = { subscriptionId: t.subscriptionId, epoch: t.epoch, request: { services: t.services, idempotencyKey: randomUUID() }, before: t.before };
    store(reserved);
    put(id, { kind: 'reserving', attempt: reserved });
    const onClose = () => { if (gen === generation && holds(id, reserved, 'reserving')) toUnknown(id, reserved, null); };
    closed.addEventListener('abort', onClose, { once: true });
    let before: bigint;
    try {
      // The budget as it stands, to show beside Retry should the answer be lost.
      before = await budgetValueOf(reserved.subscriptionId, reserved.epoch, serviceId);
    } catch (e) {
      closed.removeEventListener('abort', onClose);
      if (gen !== generation || !holds(id, reserved, 'reserving')) return HELD;
      // Nothing was sent, so nothing waits for an answer.
      drop(id, reserved);
      return { kind: 'unsent', err: e };
    }
    closed.removeEventListener('abort', onClose);
    if (gen !== generation || !holds(id, reserved, 'reserving')) return HELD;
    return deliver(id, { ...reserved, before: before.toString() }, false);
  },

  /** Send a top-up of unknown outcome again: the same request, with the same key. */
  retry(subscriptionId: string, serviceId: string): Promise<Outcome> {
    const id = idOf(subscriptionId, serviceId);
    const h = attempts.get(id);
    return h?.kind === 'unknown' ? deliver(id, h.attempt, true) : Promise.resolve(HELD);
  },

  /** Read the budget of a top-up of unknown outcome again. */
  readAgain(subscriptionId: string, serviceId: string): void {
    const id = idOf(subscriptionId, serviceId);
    const h = attempts.get(id);
    if (h?.kind !== 'unknown') return;
    put(id, { ...h, read: { state: 'checking' } });
    readBudget(id);
  },
};

/** Forget every top-up the page holds, as a reload does; session storage keeps what it kept (tests). */
export function forgetTopUpAttempts(): void {
  generation += 1;
  attempts.clear();
  looked.clear();
  reads.clear();
}
