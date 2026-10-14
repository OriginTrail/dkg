// daemon/context-graph-readiness-repeat.ts
//
// Repeats the catch-up job of a public Context Graph that is not registered on
// chain, while a subscription has left it unproven.
//
// A subscription reports `synced` only once a catch-up job has proven its
// requested planes, and the subscribe route runs exactly one job per call. For
// such a graph the durable plane does not apply, so only shared memory can be
// proven, and for an empty graph the only proof is a round in which every
// asked peer answered empty. A single peer whose round did not complete voids
// it: a transport failure, or this node revoking its own recovery lease while
// the round ran (a receiver selection change of the graph does that). Nothing
// ran the job again, so such a subscription stayed unsynced for good. Shares
// that arrive later do not change that: root-scope shares of a
// catalog-authoritative graph come on the catalog lane, and neither that lane
// nor gossip writes readiness.
//
// So a job that ends with such a graph still unsynced arms one repeat for it.
// The repeat runs the same job, with a fresh admission read and the same proof
// rules, after a growing delay, and arms the next one while the graph stays
// unproven, up to a fixed number of repeats. Each subscribe call's job starts
// a chain of its own: a newer call ends the older chain, wherever it is.

import type { ContextGraphReadAuthorityDecision } from '@origintrail-official/dkg-agent';
import type { CatchupJob } from './types.js';

/**
 * Delay before each repeat, in order. Its length is the number of repeats one
 * subscribe call gets: about an hour in all, the first a few seconds after the
 * job, while a transient cause (a revoked lease, a reset stream) has passed but
 * little has had time to change.
 */
export const CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS: readonly number[] = Object.freeze([
  15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000,
]);

/** The repeats that follow one subscribe call's job for one graph. */
export interface ContextGraphReadinessRepeatChain {
  readonly contextGraphId: string;
}

/** Test seam: the timers repeats are armed with. They never hold the process open. */
export const readinessRepeatTimers = {
  set(callback: () => void, delayMs: number): unknown {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clear(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** The current chain of each graph that has one; a superseded chain arms and starts nothing. */
const chains = new Map<string, ContextGraphReadinessRepeatChain>();
/** At most one armed repeat per graph; the token tells a replaced timer apart. */
const armed = new Map<string, { readonly token: object; readonly handle: unknown }>();

/**
 * Whether a settled catch-up job left an actively subscribed public graph that
 * is not registered on chain unsynced, with shared memory requested. Only those
 * repeat: a registered graph has its durable plane and its curator's word, a
 * private graph has proofs of its own (the member catalog, the empty-VM proof),
 * a denial is not cleared by asking again, and without shared memory nothing
 * could prove an unregistered graph.
 */
export function needsContextGraphReadinessRepeat(input: {
  readonly job: Pick<CatchupJob, 'status'>;
  readonly includeSharedMemory: boolean;
  readonly admissionAuthority: ContextGraphReadAuthorityDecision;
  readonly subscription: { readonly subscribed?: boolean; readonly synced?: boolean } | undefined;
}): boolean {
  return input.includeSharedMemory
    && admitsContextGraphReadinessRepeat(input.admissionAuthority)
    && input.job.status !== 'denied'
    && input.subscription?.subscribed === true
    && input.subscription.synced !== true;
}

/** Admission of a public graph that is not registered on chain, the only kind that repeats. */
export function admitsContextGraphReadinessRepeat(authority: ContextGraphReadAuthorityDecision): boolean {
  return authority.outcome === 'allowed'
    && authority.grantScope === 'public'
    && authority.registration === 'unregistered';
}

/** Start the chain of a subscribe call's job, ending any older chain of the graph. */
export function startContextGraphReadinessRepeatChain(
  contextGraphId: string,
): ContextGraphReadinessRepeatChain {
  disarm(contextGraphId);
  const chain: ContextGraphReadinessRepeatChain = Object.freeze({ contextGraphId });
  chains.set(contextGraphId, chain);
  return chain;
}

export function isCurrentContextGraphReadinessRepeatChain(
  chain: ContextGraphReadinessRepeatChain,
): boolean {
  return chains.get(chain.contextGraphId) === chain;
}

/** End `chain` if it is still the graph's current one. */
export function endContextGraphReadinessRepeatChain(chain: ContextGraphReadinessRepeatChain): void {
  if (!isCurrentContextGraphReadinessRepeatChain(chain)) return;
  disarm(chain.contextGraphId);
  chains.delete(chain.contextGraphId);
}

/**
 * Arm the next repeat of `chain`, which has had `repeatsRun` repeats (0 after
 * the subscribe call's job). The timer calls `repeat` with the number of the
 * repeat it starts. A superseded chain arms nothing; a chain whose repeats
 * have all run ends.
 */
export function armContextGraphReadinessRepeat(
  chain: ContextGraphReadinessRepeatChain,
  repeatsRun: number,
  repeat: (repeatNumber: number) => void,
): 'armed' | 'spent' | 'superseded' {
  if (!isCurrentContextGraphReadinessRepeatChain(chain)) return 'superseded';
  const { contextGraphId } = chain;
  disarm(contextGraphId);
  const delayMs = CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS[repeatsRun];
  if (delayMs === undefined) {
    chains.delete(contextGraphId);
    return 'spent';
  }
  const token = {};
  const handle = readinessRepeatTimers.set(() => {
    if (armed.get(contextGraphId)?.token !== token) return;
    armed.delete(contextGraphId);
    repeat(repeatsRun + 1);
  }, delayMs);
  armed.set(contextGraphId, { token, handle });
  return 'armed';
}

function disarm(contextGraphId: string): void {
  const current = armed.get(contextGraphId);
  if (current === undefined) return;
  armed.delete(contextGraphId);
  readinessRepeatTimers.clear(current.handle);
}

/** Test seam: drop every chain and armed repeat. */
export function resetContextGraphReadinessRepeats(): void {
  for (const { handle } of armed.values()) readinessRepeatTimers.clear(handle);
  armed.clear();
  chains.clear();
}
