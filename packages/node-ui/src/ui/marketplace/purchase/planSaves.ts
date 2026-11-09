// Plan saves, in the order of their confirmations. A flow's plan save can
// outlive its form: a funding's answer may come back after another flow has
// replaced the one that sent it, and the epoch it funded still wants its plan.
// So saves go out one at a time, and a save from a confirmation older than one
// whose plan the node has already taken is dropped: a late answer never
// writes an older plan over a newer one.
import { marketplaceApi } from '../api/client.js';
import type { PlanRequest } from '../api/types.js';

let confirmations = 0;
/** The newest confirmation whose plan the node took. */
let newestSaved = 0;
/** The saves asked for so far, each after the one before. */
let line: Promise<unknown> = Promise.resolve();

/** A confirmation's place in line, taken when Confirm is pressed. */
export function confirmationTicket(): number {
  confirmations += 1;
  return confirmations;
}

/**
 * Save `plan` for the confirmation `ticket`, after every save asked for
 * before it: 'saved', or 'superseded' when a later confirmation's plan was
 * saved first, which this one would write over. A failed save rejects, and
 * leaves the line free for the next.
 */
export function savePlanFor(ticket: number, plan: PlanRequest): Promise<'saved' | 'superseded'> {
  const save = line.then(async () => {
    if (ticket < newestSaved) return 'superseded' as const;
    await marketplaceApi.savePlan(plan);
    newestSaved = Math.max(newestSaved, ticket);
    return 'saved' as const;
  });
  line = save.catch(() => undefined);
  return save;
}

/** Forget every confirmation and save, as a new page does (tests). */
export function forgetPlanSaves(): void {
  confirmations = 0;
  newestSaved = 0;
  line = Promise.resolve();
}
