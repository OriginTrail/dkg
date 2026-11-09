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
import type { ServiceRequest, TopUpAnswer, TopUpRequest } from '../api/types.js';
import { randomUUID } from '../../lib/randomUUID.js';

/**
 * A confirmed top-up of one service: what it adds, with its key, its
 * subscription's epoch, and the budget's value before the first send, in wei:
 * as the form showed it at Confirm, until the read just before the first send
 * replaces it. The node's route takes a list of services; the list is made
 * only where the request is sent, and kept so in storage.
 */
export interface Attempt { subscriptionId: string; epoch: number; service: ServiceRequest; idempotencyKey: string; before: string }

/** An attempt as the top-up route takes it, and as session storage keeps it. */
interface Kept { subscriptionId: string; epoch: number; request: TopUpRequest; before: string }

const requestOf = (a: Attempt): TopUpRequest => ({ services: [a.service], idempotencyKey: a.idempotencyKey });

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
  | { kind: 'sent'; answer: TopUpAnswer }
  | { kind: 'refused'; err: unknown }
  | { kind: 'unsent'; err: unknown }
  | { kind: 'held' };

const HELD: Outcome = { kind: 'held' };

const idOf = (subscriptionId: string, serviceId: string) => `${subscriptionId}:${serviceId}`;
const storageKey = (id: string) => `dkg-marketplace-topup:${id}`;
const attemptId = (a: Attempt) => idOf(a.subscriptionId, a.service.serviceId);

const attempts = new Map<string, Held>();
/** The budgets whose stored top-up was looked for. */
const looked = new Set<string>();
/** The subscriptions whose stored top-ups were all looked for. */
const scanned = new Set<string>();
/** The last list of held services `pending` answered, by subscription: the same list while they are the same. */
const listed = new Map<string, readonly string[]>();
const NONE: readonly string[] = [];
/** The read of the budget each held top-up waits for, by number: a later read replaces an earlier one. */
const reads = new Map<string, number>();
let readCount = 0;
/** The keys of the top-ups the node carried out, in the order it answered them. */
let completed: readonly string[] = [];
/** Bumped when the page forgets everything: work begun before then changes nothing. */
let generation = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function store(a: Attempt): void {
  const kept: Kept = { subscriptionId: a.subscriptionId, epoch: a.epoch, request: requestOf(a), before: a.before };
  try { window.sessionStorage.setItem(storageKey(attemptId(a)), JSON.stringify(kept)); } catch { /* kept in the page alone */ }
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
    const k = JSON.parse(raw) as Partial<Kept> | null;
    const services: unknown = k?.request?.services;
    // One service, and a whole one: a top-up names exactly one.
    if (!k || k.subscriptionId !== subscriptionId || !Number.isInteger(k.epoch) || typeof k.before !== 'string'
      || typeof k.request?.idempotencyKey !== 'string' || !Array.isArray(services) || services.length !== 1) return null;
    const [service] = services as unknown[];
    if (!isServiceOf(service, serviceId)) return null;
    return { subscriptionId, epoch: k.epoch as number, service, idempotencyKey: k.request.idempotencyKey, before: k.before };
  } catch { /* not a top-up this store wrote */ }
  return null;
}

/** Whether `s` is a service request of `serviceId`: its class, its value and cap in wei, and a pinned seller, if any. */
function isServiceOf(s: unknown, serviceId: string): s is ServiceRequest {
  const r = s as Partial<ServiceRequest> | null;
  const wei = (v: unknown) => typeof v === 'string' && /^\d+$/.test(v);
  return !!r && r.serviceId === serviceId && (r.serviceClass === 'inference' || r.serviceClass === 'query')
    && wei(r.value) && wei(r.maxPricePerUnit) && (r.pinnedSeller === undefined || Number.isSafeInteger(r.pinnedSeller));
}

/** Whether `id` still holds `attempt`, in one of `kinds`. */
function holds(id: string, attempt: Attempt, ...kinds: Held['kind'][]): boolean {
  const h = attempts.get(id);
  return !!h && h.attempt.idempotencyKey === attempt.idempotencyKey && kinds.includes(h.kind);
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

/** Answers that a key's top-up was, or may yet be, carried out: its key held for another request, still pending, or of unknown outcome. */
const KEY_OPEN = new Set(['IdempotencyKeyReused', 'TopUpOutcomeUnknown', 'TopUpPending']);

/** Refusals given before the node looks at a top-up's key: they say nothing of a send under it before this one. */
const BEFORE_THE_KEY = new Set(['NodeAdminRequired', 'MarketplaceAbsent', 'Unauthorized', 'InvalidRequest']);

/**
 * Whether the node refused the top-up so that nothing was added under its
 * key, and nothing will be: a 4xx of its checks of the request, or of the
 * contract (`TopUpNotSent` and `TopUpReverted` among them). The key is then
 * free, and the next top-up is a new one. An answer that the top-up is
 * pending, of unknown outcome, or that its key is held for another request
 * leaves the outcome unknown, whatever its status; so do no answer, a 5xx,
 * and a refusal given before the key is looked at (no valid token, too many
 * requests, a token that is not the node admin's, a node without these
 * routes, a request it cannot read), which says nothing of an earlier send.
 * Only a first send, with nothing sent under its key before, is refused
 * outright for a request the node cannot read.
 */
function refusedOutright(e: unknown, retry: boolean): boolean {
  if (!isMarketplaceError(e) || KEY_OPEN.has(e.code)) return false;
  if (e.status < 400 || e.status >= 500 || e.status === 401 || e.status === 429) return false;
  if (BEFORE_THE_KEY.has(e.code)) return !retry && e.code === 'InvalidRequest';
  return true;
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
  budgetValueOf(attempt.subscriptionId, attempt.epoch, attempt.service.serviceId)
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
    const answer = await marketplaceApi.topUp(attempt.subscriptionId, requestOf(attempt));
    if (gen === generation) {
      // Listed for the page whatever became of the form that sent it: on show, replaced or closed.
      completed = [...completed, attempt.idempotencyKey];
      drop(id, attempt);
    }
    return { kind: 'sent', answer };
  } catch (e) {
    if (gen !== generation) return HELD;
    if (!refusedOutright(e, retry)) {
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

/**
 * The services of `subscriptionId` with a top-up held, whatever their budgets
 * show: confirmed in this page, or kept in session storage from before a
 * reload. A page can then show each one, with its key, though no form for it
 * can be opened from its budget any more.
 */
function pendingOf(subscriptionId: string | null): readonly string[] {
  if (subscriptionId === null) return NONE;
  if (!scanned.has(subscriptionId)) {
    scanned.add(subscriptionId);
    const prefix = storageKey(idOf(subscriptionId, ''));
    try {
      for (let i = 0; i < window.sessionStorage.length; i += 1) {
        const k = window.sessionStorage.key(i);
        if (k?.startsWith(prefix)) heldBy(subscriptionId, k.slice(prefix.length));
      }
    } catch { /* storage unavailable: those confirmed in this page are all there are */ }
  }
  const at = idOf(subscriptionId, '');
  const now = [...attempts.keys()].filter((id) => id.startsWith(at)).map((id) => id.slice(at.length)).sort();
  const before = listed.get(subscriptionId);
  if (before && before.length === now.length && before.every((x, i) => x === now[i])) return before;
  listed.set(subscriptionId, now);
  return now;
}

export const topUpAttempts = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },

  held: heldBy,

  pending: pendingOf,

  /** The top-ups the node carried out, by key, in the order it answered them: a page read after the last one shows what they added. */
  completed: (): readonly string[] => completed,

  /** Read the budget of a top-up brought back from storage, unless a read is on its way. A form asks this when it opens. */
  check(subscriptionId: string, serviceId: string): void {
    const id = idOf(subscriptionId, serviceId);
    const h = heldBy(subscriptionId, serviceId);
    if (h?.kind === 'unknown' && h.read.state === 'checking' && !reads.has(id)) readBudget(id);
  },

  /**
   * Confirm a top-up of `service`, as its dry run answered it.
   * It and a new key are kept from here on, before anything is awaited; the
   * budget is read, and the top-up sent, unless the form was `closed`
   * meanwhile: then it waits, with its key, for a Retry. A budget that holds a
   * top-up already takes no other.
   */
  async confirm(t: { subscriptionId: string; epoch: number; service: ServiceRequest; before: string }, closed: AbortSignal): Promise<Outcome> {
    const { serviceId } = t.service;
    const id = idOf(t.subscriptionId, serviceId);
    if (heldBy(t.subscriptionId, serviceId)) return HELD;
    const gen = generation;
    const reserved: Attempt = { subscriptionId: t.subscriptionId, epoch: t.epoch, service: t.service, idempotencyKey: randomUUID(), before: t.before };
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
  scanned.clear();
  listed.clear();
  reads.clear();
  completed = [];
}
