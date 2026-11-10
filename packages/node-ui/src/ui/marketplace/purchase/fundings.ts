// Confirmations that outlive their form: a funding and the plan that renews
// it, or the plan alone. From Confirm on this coordinator owns each one, by
// its place in line (planSaves.ts): it sends the funding, settles a funding
// whose answer was lost by what the epoch's subscription shows, and saves
// the plan in confirmation order. A form shows the confirmation it made and
// keeps only its draft; what a replaced form leaves waiting (a funding of
// unknown outcome, a plan not saved) stays here for Plans to show.
//
// The contracts fund one subscription per buyer and epoch, so a funding whose
// answer is lost is never simply sent again: a repeat would be refused as
// already funded, and the plan would not be saved. Funded as confirmed, the
// plan is saved and nothing is funded again; not funded, Retry sends the same
// funding; funded on other terms, nothing more is sent and no plan is saved.
import { isMarketplaceError, marketplaceApi } from '../api/client.js';
import type { Subscription, Tx } from '../api/types.js';
import type { Confirming, FundConfirming } from './model.js';
import { confirmationTicket, savePlanFor } from './planSaves.js';

/** An epoch funded: its subscription, once the node shows it, and the transaction, when the funding's answer came. */
export interface Funded { subscription: Subscription | null; tx: Tx | null }

/** What the epoch's subscription shows of a funding whose outcome is unknown. Funded as confirmed, it moves on to the plan. */
export type FundingRead =
  | { state: 'checking' }
  /** No subscription funds the epoch: the funding has not landed. */
  | { state: 'absent' }
  /** One does, on other terms than the confirmation's. */
  | { state: 'other'; subscription: Subscription }
  | { state: 'unread'; err: unknown };

/** A confirmation, from Confirm until the user is done with it. */
export type Confirmed =
  /** The funding is on its way: the first send, or, on `retry`, one after the epoch showed the first had not landed. */
  | { kind: 'funding'; confirming: FundConfirming; retry: boolean }
  /** Refused before anything was done (`err`): the confirmation may be sent again as it is. */
  | { kind: 'refused'; confirming: Confirming; err: unknown }
  /** The funding went out, but no answer says whether it landed (`err`): the epoch's subscription is read to tell. */
  | { kind: 'unknown'; confirming: FundConfirming; err: unknown; read: FundingRead }
  /** The epoch is funded (or, `funded` null, the plan alone confirmed): its plan is saving, saved, or not saved (`err`). */
  | { kind: 'plan'; confirming: Confirming; funded: Funded | null; save: 'saving' | 'saved' | 'failed'; err: unknown };

/** The refusals the node gives with a 5xx before it sends anything; any other 5xx may come after the funding went out. */
const REFUSED_BEFORE_SENDING = new Set(['MarketplaceOff', 'QueryInferencePaused', 'QueryInferenceNotActive']);

/**
 * Whether a funding that failed may have landed all the same: no answer, a
 * success whose answer cannot be read, or a failure the node does not explain.
 * A refusal (a 4xx, or one of the 5xx above) comes before anything is sent.
 */
function mayHaveLanded(e: unknown): boolean {
  if (!isMarketplaceError(e)) return true;
  if (e.status === 0 || e.code === 'UnreadableAnswer') return true;
  return e.status >= 500 && !REFUSED_BEFORE_SENDING.has(e.code);
}

/**
 * Whether `s` is the subscription `request` funds: its epoch and source, and
 * each budget's service, class, value and cap. A budget whose class the node
 * does not name matches on the rest.
 */
function fundedAsConfirmed(s: Subscription, request: FundConfirming['request']): boolean {
  const asked = request.source;
  if (s.epoch !== request.epoch || s.source.kind !== asked.kind) return false;
  if (s.source.kind === 'account' && asked.kind === 'account' && s.source.accountId !== asked.accountId) return false;
  return s.budgets.length === request.services.length && request.services.every((r) => {
    const b = s.budgets.find((x) => x.serviceId.toLowerCase() === r.serviceId.toLowerCase());
    return !!b && (b.serviceClass === undefined || b.serviceClass === r.serviceClass)
      && BigInt(b.value) === BigInt(r.value) && BigInt(b.maxPricePerUnit) === BigInt(r.maxPricePerUnit);
  });
}

/** Whether a confirmation waits for the user: a funding of unknown outcome, or a plan that was not saved. */
const waitsForUser = (c: Confirmed): boolean => c.kind === 'unknown' || (c.kind === 'plan' && c.save === 'failed');

const held = new Map<number, Confirmed>();
let waiting: readonly number[] = [];
/** The confirmations whose plan the node took, in the order it took them. */
let completed: readonly number[] = [];
/** Bumped when the page forgets everything: work begun before then changes nothing. */
let generation = 0;
const listeners = new Set<() => void>();

function put(id: number, c: Confirmed): void {
  held.set(id, c);
  // The same list while the same confirmations wait, so a change of it means a change of them.
  const next = [...held].filter(([, x]) => waitsForUser(x)).map(([i]) => i);
  if (next.length !== waiting.length || next.some((i, k) => i !== waiting[k])) waiting = next;
  for (const l of listeners) l();
}

/** The epoch is funded, or the plan alone confirmed: save the plan, unless one confirmed later stands. */
async function savePlan(id: number, confirming: Confirming, funded: Funded | null): Promise<void> {
  const gen = generation;
  put(id, { kind: 'plan', confirming, funded, save: 'saving', err: null });
  try {
    await savePlanFor(id, confirming.plan);
  } catch (e) {
    if (gen === generation) put(id, { kind: 'plan', confirming, funded, save: 'failed', err: e });
    return;
  }
  if (gen !== generation) return;
  completed = [...completed, id];
  put(id, { kind: 'plan', confirming, funded, save: 'saved', err: null });
}

/** Read the epoch's subscription after a funding whose outcome is unknown, and go on as it says. */
async function settle(id: number, confirming: FundConfirming, err: unknown): Promise<void> {
  const gen = generation;
  put(id, { kind: 'unknown', confirming, err, read: { state: 'checking' } });
  const { epoch } = confirming.request;
  let read: FundingRead;
  try {
    const subscription = (await marketplaceApi.subscriptions(epoch)).subscriptions.find((s) => s.epoch === epoch) ?? null;
    if (gen !== generation) return;
    if (subscription && fundedAsConfirmed(subscription, confirming.request)) {
      // It landed as confirmed: nothing is funded again, and the plan follows.
      await savePlan(id, confirming, { subscription, tx: null });
      return;
    }
    read = subscription ? { state: 'other', subscription } : { state: 'absent' };
  } catch (e) {
    read = { state: 'unread', err: e };
  }
  if (gen === generation) put(id, { kind: 'unknown', confirming, err, read });
}

/** Send the confirmed funding, or, on `retry`, send it again once the epoch's subscription showed it had not landed. */
async function fund(id: number, confirming: FundConfirming, retry: boolean): Promise<void> {
  const gen = generation;
  put(id, { kind: 'funding', confirming, retry });
  let answer;
  try {
    answer = await marketplaceApi.fund(confirming.request);
  } catch (e) {
    if (gen !== generation) return;
    // A lost answer, or a repeat refused because the epoch is funded now: whether the funding landed is read, not assumed.
    if (mayHaveLanded(e) || (retry && isMarketplaceError(e) && e.code === 'SubscriptionAlreadyFunded')) await settle(id, confirming, e);
    else put(id, { kind: 'refused', confirming, err: e });
    return;
  }
  if (gen === generation) await savePlan(id, confirming, { subscription: answer.subscription, tx: { txHash: answer.txHash, blockNumber: answer.blockNumber } });
}

export const fundings = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },

  /** A confirmation the coordinator holds, by its id. */
  held: (id: number | null): Confirmed | null => (id === null ? null : held.get(id) ?? null),

  /** The confirmations that wait for the user, oldest first: a funding of unknown outcome, or a plan not saved. */
  waiting: (): readonly number[] => waiting,

  /** The confirmations whose plan the node took, in the order it took them: a page read after the last one shows it. */
  completed: (): readonly number[] => completed,

  /** Take a confirmation over: its funding and then its plan, or the plan alone. Returns its id. */
  confirm(confirming: Confirming): number {
    const id = confirmationTicket();
    if (confirming.kind === 'fund') void fund(id, confirming, false);
    else void savePlan(id, confirming, null);
    return id;
  },

  /** Send a funding again that the epoch showed had not landed: the same request. */
  retryFunding(id: number): void {
    const c = held.get(id);
    if (c?.kind === 'unknown' && c.read.state === 'absent') void fund(id, c.confirming, true);
  },

  /** Read the epoch's subscription again for a funding of unknown outcome. */
  readAgain(id: number): void {
    const c = held.get(id);
    if (c?.kind === 'unknown' && c.read.state !== 'checking') void settle(id, c.confirming, c.err);
  },

  /** Save the plan again that was not saved: the funding went out, so only the plan is sent. */
  retryPlan(id: number): void {
    const c = held.get(id);
    if (c?.kind === 'plan' && c.save === 'failed') void savePlan(id, c.confirming, c.funded);
  },

  /** The user is done with a confirmation: it goes. */
  dismiss(id: number): void {
    if (!held.has(id)) return;
    held.delete(id);
    waiting = waiting.filter((i) => i !== id);
    for (const l of listeners) l();
  },
};

/** Forget every confirmation, as a new page does (tests). */
export function forgetFundings(): void {
  generation += 1;
  held.clear();
  waiting = [];
  completed = [];
}
