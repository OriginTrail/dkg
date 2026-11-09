// Plan saves, in the order of their confirmations. A flow's plan save can
// outlive its form: a funding's answer may come back after another flow has
// replaced the one that sent it, and the epoch it funded still wants its plan.
// So saves go out one at a time, and a save from a confirmation older than one
// whose plan the node took is dropped: a late answer never writes an older
// plan over a newer one.
//
// A save whose answer is lost (none came, it cannot be read, or the node
// failed without saying why) may have landed all the same. The plan is read
// back at once: the node holding that plan means it was saved. While it
// cannot be read, the save stays unsettled, and no older save goes until a
// read settles it.
import { isMarketplaceError, marketplaceApi } from '../api/client.js';
import type { Plan, PlanRequest } from '../api/types.js';

let confirmations = 0;
/** The newest confirmation whose plan the node took. */
let newestSaved = 0;
/** Saves whose answer was lost and whose plan could not be read back since: by confirmation, the plan each sent. */
const unsettled = new Map<number, PlanRequest>();
/** The saves asked for so far, each after the one before. */
let line: Promise<unknown> = Promise.resolve();

/** Whether a failed save may have landed: no answer, one that cannot be read, or a failure the node does not explain. */
function mayHaveLanded(e: unknown): boolean {
  return !isMarketplaceError(e) || e.status === 0 || e.code === 'UnreadableAnswer' || e.status >= 500;
}

/** A plan's terms, as the node keeps them: each service by id with its class, value, cap and pinned seller; the source; the renewal. */
function termsOf(p: PlanRequest | Plan): string {
  const services = p.services
    .map((s) => ({
      serviceId: s.serviceId.toLowerCase(), serviceClass: s.serviceClass, value: BigInt(s.value).toString(),
      maxPricePerUnit: BigInt(s.maxPricePerUnit).toString(), pinnedSeller: s.pinnedSeller ?? null,
    }))
    .sort((a, b) => (a.serviceId < b.serviceId ? -1 : 1));
  const source = p.source.kind === 'account' ? { kind: 'account', accountId: p.source.accountId } : { kind: 'wallet' };
  return JSON.stringify({ services, source, renew: p.renew, renewUntilEpoch: p.renewUntilEpoch ?? null });
}

/** The node took the plan of confirmation `ticket`: no older save may go, and no older unsettled one matters. */
function settled(ticket: number): void {
  newestSaved = Math.max(newestSaved, ticket);
  for (const t of unsettled.keys()) if (t <= ticket) unsettled.delete(t);
}

/**
 * Whether a newer save whose answer was lost stands, so that `ticket` would
 * write over it: the plan on the node says. A newer one it shows is settled
 * as saved; those it does not show did not land. Throws when the plan cannot
 * be read: a newer save may stand, so an older one does not go.
 */
async function newerStands(ticket: number): Promise<boolean> {
  const newer = [...unsettled].filter(([t]) => t > ticket).sort(([a], [b]) => b - a);
  if (newer.length === 0) return false;
  const now = await marketplaceApi.plan();
  const shown = now === null ? null : termsOf(now);
  const stands = newer.find(([, plan]) => termsOf(plan) === shown);
  if (stands) {
    settled(stands[0]);
    return true;
  }
  for (const [t] of newer) unsettled.delete(t);
  return false;
}

/** A confirmation's place in line, taken when Confirm is pressed. */
export function confirmationTicket(): number {
  confirmations += 1;
  return confirmations;
}

/**
 * Save `plan` for the confirmation `ticket`, after every save asked for
 * before it: 'saved', or 'superseded' when a later confirmation's plan stands
 * on the node, which this one would write over. A save the node refused, or
 * one whose answer was lost and whose plan the node does not show, rejects
 * and leaves the line free for the next; so does an older save while a newer
 * one cannot be settled.
 */
export function savePlanFor(ticket: number, plan: PlanRequest): Promise<'saved' | 'superseded'> {
  const save = line.then(async () => {
    if (ticket < newestSaved || (await newerStands(ticket))) return 'superseded' as const;
    try {
      await marketplaceApi.savePlan(plan);
    } catch (e) {
      if (!mayHaveLanded(e)) throw e;
      let shown: Plan | null;
      try {
        shown = await marketplaceApi.plan();
      } catch {
        // Neither the answer nor the plan says: this save may stand.
        unsettled.set(ticket, plan);
        throw e;
      }
      if (shown === null || termsOf(shown) !== termsOf(plan)) throw e;
    }
    settled(ticket);
    return 'saved' as const;
  });
  line = save.catch(() => undefined);
  return save;
}

/** Forget every confirmation and save, as a new page does (tests). */
export function forgetPlanSaves(): void {
  confirmations = 0;
  newestSaved = 0;
  unsettled.clear();
  line = Promise.resolve();
}
