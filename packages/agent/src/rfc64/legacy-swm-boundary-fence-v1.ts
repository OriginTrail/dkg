// SPDX-License-Identifier: Apache-2.0

import { RFC64_LEGACY_SWM_BOUNDARY_RETIREMENT_IN_PROGRESS_CODE } from '@origintrail-official/dkg-core';

import { Rfc64SerializedScopeRuntimeV1 } from './serialized-scope-runtime-v1.js';

/** Who raised a fence. Named in every refusal and in every fence event. */
export type Rfc64LegacySwmFenceSourceV1 =
  | 'finalized-vm-retirement'
  | 'republish-retirement'
  | 'receiver-lease';

export type Rfc64LegacySwmFenceScopeV1 = 'graph' | 'asset';

/**
 * A fence that is worth a log line: one that gave up waiting for its turn
 * (`wait-exceeded`, the retirement did not run), one that ran but was up for
 * longer than {@link RFC64_LEGACY_SWM_FENCE_LONG_MS} (`long-fence`), or a
 * promote that waited for a fence for longer than that, or stopped waiting
 * while the fence was still up (`admission-wait`).
 */
export interface Rfc64LegacySwmFenceEventV1 {
  readonly kind: 'wait-exceeded' | 'long-fence' | 'admission-wait';
  /**
   * For an `admission-wait`, the fence the promote waited for: the one in front when it began
   * to wait if it was admitted, else the longest-standing one in front when it stopped.
   */
  readonly source: Rfc64LegacySwmFenceSourceV1;
  readonly scope: Rfc64LegacySwmFenceScopeV1;
  readonly contextGraphId: string;
  /** For an `admission-wait`, the asset of the promote, whatever the scope of the fence. */
  readonly kaUal?: string;
  readonly elapsedMs: number;
  /** What a `wait-exceeded` fence was still waiting for. */
  readonly waitingOn?: 'mutation-chain' | 'preparations';
  /** In-flight preparations of the scope when a `wait-exceeded` fence gave up. */
  readonly activePreparations?: number;
  /** How an `admission-wait` ended. */
  readonly waitEnd?: Rfc64LegacySwmAdmissionWaitEndV1;
}

/** How loud a fence event is: a promote that waited and was then admitted is only information. */
export function rfc64LegacySwmFenceEventLogLevelV1(
  event: Readonly<Rfc64LegacySwmFenceEventV1>,
): 'info' | 'warn' {
  return event.kind === 'admission-wait' && event.waitEnd === 'unfenced' ? 'info' : 'warn';
}

/** The fence-event observer that writes each event to a log, at the event's level. */
export function rfc64LegacySwmFenceEventLoggerV1<Context>(
  log: Readonly<Record<'info' | 'warn', (ctx: Context, message: string) => void>>,
  ctx: Context,
): (event: Readonly<Rfc64LegacySwmFenceEventV1>) => void {
  return (event) => log[rfc64LegacySwmFenceEventLogLevelV1(event)](ctx, describeRfc64LegacySwmFenceEventV1(event));
}

/** One log line for a fence event. */
export function describeRfc64LegacySwmFenceEventV1(
  event: Readonly<Rfc64LegacySwmFenceEventV1>,
): string {
  if (event.kind === 'admission-wait') {
    const fence = `the RFC-64 legacy SWM fence raised by ${event.source} on the ${event.scope} `
      + `of ${event.contextGraphId}`;
    return event.waitEnd === 'unfenced'
      ? `A promote of ${event.kaUal} waited ${event.elapsedMs} ms for ${fence}`
      : `A promote of ${event.kaUal} stopped waiting after ${event.elapsedMs} ms for ${fence} `
        + `(${event.waitEnd}); the promote is refused, and a queued share is retried later`;
  }
  const where = `${event.source} on the ${event.scope} of ${event.contextGraphId}`
    + (event.kaUal === undefined ? '' : ` (${event.kaUal})`);
  return event.kind === 'wait-exceeded'
    ? `RFC-64 legacy SWM fence raised by ${where} gave up after ${event.elapsedMs} ms waiting on `
      + `${event.waitingOn} (${event.activePreparations} preparation(s) in flight); nothing was retired`
    : `RFC-64 legacy SWM fence raised by ${where} was up for ${event.elapsedMs} ms`;
}

/**
 * How long a retirement or a lease waits for its turn on the mutation chain
 * and for the in-flight preparations of its scope before it gives up and drops
 * its fence. Below the promote queue's first retry (48 to 72 s), so a share
 * refused by a fence that never gets its turn is admitted on that retry.
 */
export const RFC64_LEGACY_SWM_FENCE_WAIT_LIMIT_MS = 30_000;

/** A fence that was up for longer than this is reported when it drops. */
export const RFC64_LEGACY_SWM_FENCE_LONG_MS = 5_000;

export interface Rfc64LegacySwmFenceOptionsV1 {
  readonly waitLimitMs?: number;
  readonly longFenceMs?: number;
  readonly now?: () => number;
  readonly onFenceEvent?: (event: Readonly<Rfc64LegacySwmFenceEventV1>) => void;
}

interface Rfc64LegacySwmFenceHolderV1 {
  readonly source: Rfc64LegacySwmFenceSourceV1;
  readonly raisedAt: number;
}

interface Rfc64LegacySwmFenceScopeStateV1 {
  activePreparations: number;
  preparationsDrained: Promise<void>;
  resolvePreparationsDrained: (() => void) | undefined;
  /** The retirements and leases that fence this scope, oldest first. */
  readonly holders: Rfc64LegacySwmFenceHolderV1[];
  /**
   * When the fence of this scope last went up: its holders may hand it on to one another, and it
   * counts as up from the first of them until none is left.
   */
  fencedSince: number;
  fenceDropped: Promise<void>;
  resolveFenceDropped: (() => void) | undefined;
}

/**
 * The preparation fences of one legacy SWM boundary and the chains that
 * serialize its retirements. A preparation registers under its context graph
 * id and under its asset key; a retirement fences one of the two.
 *
 * Everything that retires in one graph takes turns on that graph's chain: its
 * leases, its retirements and the retirements of its assets. They read and
 * change the same markers. A lease or a retirement of a whole graph first
 * takes a turn on the node-wide chain as well, so one of them runs at a time
 * on the node, as before. The retirement of one asset does not: it waits for
 * the work of its own graph and for nothing else.
 */
export interface Rfc64LegacySwmFenceCoordinatorV1 {
  readonly scopes: Map<string, Rfc64LegacySwmFenceScopeStateV1>;
  /** The node-wide chain of the leases and retirements that fence a whole graph. */
  mutationTail: Promise<void>;
  /** How many of them hold or await the node-wide turn. */
  nodeWideTurnsPending: number;
  /** The turns of each graph that has a lease or a retirement waiting or at work. */
  readonly graphTurns: Rfc64SerializedScopeRuntimeV1;
  readonly waitLimitMs: number;
  readonly longFenceMs: number;
  readonly now: () => number;
  readonly onFenceEvent: ((event: Readonly<Rfc64LegacySwmFenceEventV1>) => void) | undefined;
  /** False once {@link endRfc64LegacySwmAdmissionWaitsV1} ran: admission waits end at once. */
  admissionWaitsOpen: boolean;
  /** How to wake each admission wait that is asleep now; a wait removes its own when it wakes. */
  readonly admissionWakers: Set<() => void>;
  /** Promotes in their full-length admission wait now (see {@link waitForRfc64LegacySwmPromoteAdmissionV1}). */
  promoteAdmissionWaiters: number;
}

export function createRfc64LegacySwmFenceCoordinatorV1(
  options: Rfc64LegacySwmFenceOptionsV1 = {},
): Rfc64LegacySwmFenceCoordinatorV1 {
  return {
    scopes: new Map(),
    mutationTail: Promise.resolve(),
    nodeWideTurnsPending: 0,
    graphTurns: new Rfc64SerializedScopeRuntimeV1('RFC-64 legacy SWM graph turn'),
    waitLimitMs: options.waitLimitMs ?? RFC64_LEGACY_SWM_FENCE_WAIT_LIMIT_MS,
    longFenceMs: options.longFenceMs ?? RFC64_LEGACY_SWM_FENCE_LONG_MS,
    now: options.now ?? (() => performance.now()),
    onFenceEvent: options.onFenceEvent,
    admissionWaitsOpen: true,
    admissionWakers: new Set(),
    promoteAdmissionWaiters: 0,
  };
}

/**
 * End every admission wait of this coordinator, now and from now on: a wait
 * that meets a fence returns `closed` at once, and the prepare then refuses
 * the root write as it would without a wait. The node calls it when it begins
 * to stop, so a promote held back by a fence is refused, recorded and retried
 * after the restart instead of being cut off by the shutdown deadline. A new
 * run starts with a new coordinator, whose waits are open.
 */
export function endRfc64LegacySwmAdmissionWaitsV1(fence: Rfc64LegacySwmFenceCoordinatorV1): void {
  fence.admissionWaitsOpen = false;
  const wakers = [...fence.admissionWakers];
  fence.admissionWakers.clear();
  for (const wake of wakers) wake();
}

/**
 * The finalized-VM retirement reads and deletes the markers of ONE asset, so it fences and drains that
 * asset's scope, not the graph's: a share of another asset is neither refused by it nor waited for.
 * '#' is outside the context graph id grammar, so an asset key can never alias a graph key. The receiver
 * lease and the republish retirement keep the graph key.
 */
function rfc64LegacySwmAssetScopeKeyV1(contextGraphId: string, kaUal: string): string {
  return `${contextGraphId}#${kaUal}`;
}

/**
 * Refuse a preparation that meets a fence, the graph's or its asset's. The
 * refusal names the oldest holder, so a log line that carries the message
 * says which caller raised the fence and for how long it has been up.
 */
export function assertRfc64LegacySwmPreparationAdmittedV1(
  fence: Rfc64LegacySwmFenceCoordinatorV1,
  contextGraphId: string,
  kaUal: string,
): void {
  const graphHolder = fence.scopes.get(contextGraphId)?.holders[0];
  const holder = graphHolder
    ?? fence.scopes.get(rfc64LegacySwmAssetScopeKeyV1(contextGraphId, kaUal))?.holders[0];
  if (holder === undefined) return;
  const scope: Rfc64LegacySwmFenceScopeV1 = graphHolder === undefined ? 'asset' : 'graph';
  const ageMs = Math.max(0, Math.round(fence.now() - holder.raisedAt));
  throw Object.assign(
    new Error(
      'RFC-64 legacy SWM boundary retirement is in progress; retry promotion '
        + `(fence raised by ${holder.source} on the ${scope}, up ${ageMs} ms)`,
    ),
    {
      code: RFC64_LEGACY_SWM_BOUNDARY_RETIREMENT_IN_PROGRESS_CODE,
      fenceSource: holder.source,
      fenceScope: scope,
      fenceAgeMs: ageMs,
    },
  );
}

/**
 * Register one in-flight preparation on both of its scopes. The returned
 * function releases both and must be called exactly once.
 */
export function beginRfc64LegacySwmPreparationV1(
  fence: Rfc64LegacySwmFenceCoordinatorV1,
  contextGraphId: string,
  kaUal: string,
): () => void {
  const keys = [contextGraphId, rfc64LegacySwmAssetScopeKeyV1(contextGraphId, kaUal)];
  const scopes = keys.map((key) => {
    const scope = fenceScope(fence, key);
    if (scope.activePreparations === 0) {
      scope.preparationsDrained = new Promise<void>((resolve) => {
        scope.resolvePreparationsDrained = resolve;
      });
    }
    scope.activePreparations += 1;
    return scope;
  });
  return () => {
    if (scopes.some((scope) => scope.activePreparations < 1)) {
      throw new Error('RFC-64 legacy SWM boundary preparation settlement is unbalanced');
    }
    scopes.forEach((scope, index) => {
      scope.activePreparations -= 1;
      if (scope.activePreparations !== 0) return;
      const resolve = scope.resolvePreparationsDrained;
      scope.resolvePreparationsDrained = undefined;
      resolve?.();
      cleanFenceScope(fence, keys[index]!, scope);
    });
  };
}

/**
 * Why an admission wait returned:
 * - `unfenced`: neither the graph nor the asset is fenced;
 * - `wait-limit`: the wait reached its own bound while a fence was still up;
 * - `fence-age-limit`: the oldest fence in front had been up for the age the
 *   caller does not wait past;
 * - `closed`: the admission waits were ended (the node is stopping) while a
 *   fence was still up;
 * - `waiters-limit`: a promote only. As many promotes were waiting already, so
 *   this one waited the short bound, and a fence was still up at its end.
 */
export type Rfc64LegacySwmAdmissionWaitEndV1 =
  | 'unfenced' | 'wait-limit' | 'fence-age-limit' | 'closed' | 'waiters-limit';

export interface Rfc64LegacySwmAdmissionWaitOptionsV1 {
  /**
   * Do not wait for a fence that has been up for this long without a break, whether one holder
   * held it all along or several handed it on to one another.
   */
  readonly maxFenceAgeMs?: number;
}

/**
 * Resolve once neither the graph nor the asset is fenced, or after `limitMs`,
 * or once a fence in front has been up for `maxFenceAgeMs` without a break, or
 * once the admission waits are ended ({@link endRfc64LegacySwmAdmissionWaitsV1}).
 * It wakes whenever a scope's last holder drops and looks again, so it follows
 * a fence handed from one holder to the next. It registers nothing and
 * promises nothing: a fence raised after it resolves still refuses the
 * preparation. A seam that can wait calls it right before the synchronous
 * prepare, so a fence that is up for milliseconds costs those milliseconds
 * instead of a refused attempt and its retry delay.
 */
export async function waitForRfc64LegacySwmPreparationAdmissionV1(
  fence: Rfc64LegacySwmFenceCoordinatorV1,
  contextGraphId: string,
  kaUal: string,
  limitMs: number,
  options: Rfc64LegacySwmAdmissionWaitOptionsV1 = {},
): Promise<Rfc64LegacySwmAdmissionWaitEndV1> {
  const keys = [contextGraphId, rfc64LegacySwmAssetScopeKeyV1(contextGraphId, kaUal)];
  const deadline = fence.now() + limitMs;
  for (;;) {
    const fenced = fencedScopes(fence, keys);
    if (fenced.length === 0) return 'unfenced';
    if (!fence.admissionWaitsOpen) return 'closed';
    const now = fence.now();
    let sleepMs = deadline - now;
    if (sleepMs <= 0) return 'wait-limit';
    if (options.maxFenceAgeMs !== undefined) {
      const fencedSince = Math.min(...fenced.map((scope) => scope.fencedSince));
      const ageLeftMs = fencedSince + options.maxFenceAgeMs - now;
      if (ageLeftMs <= 0) return 'fence-age-limit';
      sleepMs = Math.min(sleepMs, ageLeftMs);
    }
    let wake!: () => void;
    const woken = new Promise<void>((resolve) => { wake = resolve; });
    const timer = setTimeout(wake, sleepMs);
    fence.admissionWakers.add(wake);
    try {
      await Promise.race([woken, ...fenced.map((scope) => scope.fenceDropped)]);
    } finally {
      clearTimeout(timer);
      fence.admissionWakers.delete(wake);
    }
  }
}

/** The bounds of a promote's admission wait. */
export interface Rfc64LegacySwmPromoteAdmissionBoundsV1 {
  /** How long one promote waits at most. */
  readonly waitLimitMs: number;
  /** Do not wait for a fence that has been up for this long without a break. */
  readonly maxFenceAgeMs: number;
  /** How many promotes may wait the full time at once on the node; one more gets `overflowWaitLimitMs`. */
  readonly maxWaiters: number;
  readonly overflowWaitLimitMs: number;
}

/**
 * The admission wait of a promote: {@link waitForRfc64LegacySwmPreparationAdmissionV1}
 * with the promote's bounds, reporting an `admission-wait` event when the
 * promote waited for longer than {@link RFC64_LEGACY_SWM_FENCE_LONG_MS} or
 * stopped waiting while a fence was still up. A wait that met no fence
 * reports nothing. While `maxWaiters` promotes wait the full time, another one
 * waits for `overflowWaitLimitMs` only and, if a fence is still up then, ends
 * with `waiters-limit`, so a burst of requests cannot all be held.
 */
export async function waitForRfc64LegacySwmPromoteAdmissionV1(
  fence: Rfc64LegacySwmFenceCoordinatorV1,
  contextGraphId: string,
  kaUal: string,
  bounds: Readonly<Rfc64LegacySwmPromoteAdmissionBoundsV1>,
): Promise<Rfc64LegacySwmAdmissionWaitEndV1> {
  const keys = [contextGraphId, rfc64LegacySwmAssetScopeKeyV1(contextGraphId, kaUal)] as const;
  const startedAt = fence.now();
  const front = longestStandingFence(fence, keys);
  if (front === undefined) return 'unfenced';
  const full = fence.promoteAdmissionWaiters < bounds.maxWaiters;
  if (full) fence.promoteAdmissionWaiters += 1;
  let end: Rfc64LegacySwmAdmissionWaitEndV1;
  try {
    end = await waitForRfc64LegacySwmPreparationAdmissionV1(
      fence,
      contextGraphId,
      kaUal,
      full ? bounds.waitLimitMs : bounds.overflowWaitLimitMs,
      { maxFenceAgeMs: bounds.maxFenceAgeMs },
    );
  } finally {
    if (full) fence.promoteAdmissionWaiters -= 1;
  }
  if (!full && end === 'wait-limit') end = 'waiters-limit';
  const elapsedMs = Math.max(0, Math.round(fence.now() - startedAt));
  if (end !== 'unfenced' || elapsedMs > fence.longFenceMs) {
    const named = end === 'unfenced' ? front : longestStandingFence(fence, keys) ?? front;
    reportFenceEvent(fence, {
      kind: 'admission-wait',
      source: named.holder.source,
      scope: named.scope,
      contextGraphId,
      kaUal,
      elapsedMs,
      waitEnd: end,
    });
  }
  return end;
}

/** The fence in front of a root write that has been up the longest, and its oldest holder. */
function longestStandingFence(
  fence: Rfc64LegacySwmFenceCoordinatorV1,
  keys: readonly [string, string],
): { holder: Rfc64LegacySwmFenceHolderV1; scope: Rfc64LegacySwmFenceScopeV1 } | undefined {
  let found: { holder: Rfc64LegacySwmFenceHolderV1; scope: Rfc64LegacySwmFenceScopeV1; since: number } | undefined;
  keys.forEach((key, index) => {
    const state = fence.scopes.get(key);
    const holder = state?.holders[0];
    if (state === undefined || holder === undefined) return;
    if (found === undefined || state.fencedSince < found.since) {
      found = { holder, scope: index === 0 ? 'graph' : 'asset', since: state.fencedSince };
    }
  });
  return found === undefined ? undefined : { holder: found.holder, scope: found.scope };
}

function fencedScopes(
  fence: Rfc64LegacySwmFenceCoordinatorV1,
  keys: readonly string[],
): Rfc64LegacySwmFenceScopeStateV1[] {
  return keys
    .map((key) => fence.scopes.get(key))
    .filter((scope): scope is Rfc64LegacySwmFenceScopeStateV1 => (
      scope !== undefined && scope.holders.length > 0
    ));
}

export type Rfc64LegacySwmRetirementOutcomeV1<T> =
  | { readonly ran: true; readonly value: T }
  | { readonly ran: false };

/**
 * Run `work` behind a fence: raise it, take a turn on the mutation chain, wait
 * for the scope's in-flight preparations, then run. The fence drops when the
 * work settles, or earlier when the work calls `dropFence`.
 *
 * The turn is the graph's (see {@link Rfc64LegacySwmFenceCoordinatorV1}). Work
 * that fences the whole graph takes the node-wide turn first and joins its
 * graph's chain only then, so the retirement of an asset never waits behind
 * work that is itself still waiting for another graph. When the node-wide turn
 * is free, that work joins its graph's chain inside the call, in the order it
 * asked.
 *
 * The waits share one bound. A retirement that does not get to run within
 * it drops its fence, reports `wait-exceeded` and answers `ran: false`; when
 * its turn on a chain comes later it does nothing. Leaving the markers in
 * place is the conservative state, and the next pass retires them. Without the
 * bound one preparation that never settles would hold its chain, and through
 * it the fence of everything that waits there, for as long as it hangs.
 *
 * `signal` ends the waits early, in silence: a retirement that has not
 * started its work when the signal aborts drops its fence and answers
 * `ran: false`. Work that has started runs to its end.
 */
export async function runRfc64LegacySwmRetirementV1<T>(
  fence: Rfc64LegacySwmFenceCoordinatorV1,
  target: Readonly<{
    source: Rfc64LegacySwmFenceSourceV1;
    contextGraphId: string;
    /** Present for an asset fence; absent for the graph's. */
    kaUal?: string;
    /** The owner's lifetime: an abort ends a retirement that is still waiting. */
    signal?: AbortSignal;
  }>,
  work: (dropFence: () => void) => Promise<T>,
): Promise<Rfc64LegacySwmRetirementOutcomeV1<T>> {
  if (target.signal?.aborted) return { ran: false };
  const scopeKey = target.kaUal === undefined
    ? target.contextGraphId
    : rfc64LegacySwmAssetScopeKeyV1(target.contextGraphId, target.kaUal);
  const scope = fenceScope(fence, scopeKey);
  const holder: Rfc64LegacySwmFenceHolderV1 = { source: target.source, raisedAt: fence.now() };
  const describe = (kind: Rfc64LegacySwmFenceEventV1['kind']) => ({
    kind,
    source: target.source,
    scope: target.kaUal === undefined ? 'graph' as const : 'asset' as const,
    contextGraphId: target.contextGraphId,
    ...(target.kaUal === undefined ? {} : { kaUal: target.kaUal }),
    elapsedMs: Math.max(0, Math.round(fence.now() - holder.raisedAt)),
  });
  if (scope.holders.length === 0) {
    scope.fenceDropped = new Promise<void>((resolve) => { scope.resolveFenceDropped = resolve; });
    scope.fencedSince = holder.raisedAt;
  }
  scope.holders.push(holder);

  let waitingOn: 'mutation-chain' | 'preparations' = 'mutation-chain';
  let workStarted = false;
  let gaveUp = false;
  let dropped = false;
  const dropFence = (): void => {
    if (dropped) return;
    dropped = true;
    scope.holders.splice(scope.holders.indexOf(holder), 1);
    if (scope.holders.length === 0) {
      const resolve = scope.resolveFenceDropped;
      scope.resolveFenceDropped = undefined;
      resolve?.();
    }
    cleanFenceScope(fence, scopeKey, scope);
    const event = describe('long-fence');
    if (!gaveUp && event.elapsedMs > fence.longFenceMs) reportFenceEvent(fence, event);
  };
  let resolveAbandoned!: () => void;
  const abandoned = new Promise<void>((resolve) => { resolveAbandoned = resolve; });
  const timer = setTimeout(() => {
    if (workStarted) return;
    gaveUp = true;
    reportFenceEvent(fence, {
      ...describe('wait-exceeded'),
      waitingOn,
      activePreparations: scope.activePreparations,
    });
    dropFence();
    resolveAbandoned();
  }, fence.waitLimitMs);
  timer.unref?.();
  const stopWaiting = (): void => {
    if (workStarted || gaveUp) return;
    gaveUp = true;
    dropFence();
    resolveAbandoned();
  };
  target.signal?.addEventListener('abort', stopWaiting, { once: true });
  const notRun = { ran: false } as const;

  const run = async (): Promise<Rfc64LegacySwmRetirementOutcomeV1<T>> => {
    if (gaveUp) return notRun;
    waitingOn = 'preparations';
    await Promise.race([scope.preparationsDrained, abandoned]);
    if (gaveUp) return notRun;
    workStarted = true;
    clearTimeout(timer);
    return { ran: true, value: await work(dropFence) };
  };
  // Joins the graph's queue inside the call. The turn lasts as long as the work, whatever
  // became of the caller in the meantime.
  const takeGraphTurn = (): Promise<Rfc64LegacySwmRetirementOutcomeV1<T>> => (
    fence.graphTurns.run(target.contextGraphId, run)
  );
  let turn: Promise<Rfc64LegacySwmRetirementOutcomeV1<T>>;
  if (target.kaUal !== undefined) {
    turn = takeGraphTurn();
  } else {
    turn = fence.nodeWideTurnsPending === 0
      ? takeGraphTurn()
      : fence.mutationTail.then(() => (gaveUp ? notRun : takeGraphTurn()));
    fence.nodeWideTurnsPending += 1;
    fence.mutationTail = turn.then(() => undefined, () => undefined)
      .then(() => { fence.nodeWideTurnsPending -= 1; });
  }
  try {
    return await Promise.race([turn, abandoned.then(() => notRun)]);
  } finally {
    clearTimeout(timer);
    target.signal?.removeEventListener('abort', stopWaiting);
    dropFence();
  }
}

function reportFenceEvent(
  fence: Rfc64LegacySwmFenceCoordinatorV1,
  event: Readonly<Rfc64LegacySwmFenceEventV1>,
): void {
  try {
    fence.onFenceEvent?.(Object.freeze(event));
  } catch {
    // A failing observer must not change what the fence does.
  }
}

function fenceScope(
  fence: Rfc64LegacySwmFenceCoordinatorV1,
  scopeKey: string,
): Rfc64LegacySwmFenceScopeStateV1 {
  const existing = fence.scopes.get(scopeKey);
  if (existing !== undefined) return existing;
  const created: Rfc64LegacySwmFenceScopeStateV1 = {
    activePreparations: 0,
    preparationsDrained: Promise.resolve(),
    resolvePreparationsDrained: undefined,
    holders: [],
    fencedSince: 0,
    fenceDropped: Promise.resolve(),
    resolveFenceDropped: undefined,
  };
  fence.scopes.set(scopeKey, created);
  return created;
}

function cleanFenceScope(
  fence: Rfc64LegacySwmFenceCoordinatorV1,
  scopeKey: string,
  scope: Rfc64LegacySwmFenceScopeStateV1,
): void {
  if (
    scope.activePreparations === 0
    && scope.holders.length === 0
    && fence.scopes.get(scopeKey) === scope
  ) {
    fence.scopes.delete(scopeKey);
  }
}
