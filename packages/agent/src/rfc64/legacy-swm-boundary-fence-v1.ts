// SPDX-License-Identifier: Apache-2.0

import { RFC64_LEGACY_SWM_BOUNDARY_RETIREMENT_IN_PROGRESS_CODE } from '@origintrail-official/dkg-core';

/** Who raised a fence. Named in every refusal and in every fence event. */
export type Rfc64LegacySwmFenceSourceV1 =
  | 'finalized-vm-retirement'
  | 'republish-retirement'
  | 'receiver-lease';

export type Rfc64LegacySwmFenceScopeV1 = 'graph' | 'asset';

/**
 * A fence that is worth a log line: one that gave up waiting for its turn
 * (`wait-exceeded`, the retirement did not run) or one that ran but was up for
 * longer than {@link RFC64_LEGACY_SWM_FENCE_LONG_MS} (`long-fence`).
 */
export interface Rfc64LegacySwmFenceEventV1 {
  readonly kind: 'wait-exceeded' | 'long-fence';
  readonly source: Rfc64LegacySwmFenceSourceV1;
  readonly scope: Rfc64LegacySwmFenceScopeV1;
  readonly contextGraphId: string;
  readonly kaUal?: string;
  readonly elapsedMs: number;
  /** What a `wait-exceeded` fence was still waiting for. */
  readonly waitingOn?: 'mutation-chain' | 'preparations';
  /** In-flight preparations of the scope when a `wait-exceeded` fence gave up. */
  readonly activePreparations?: number;
}

/** One log line for a fence event. */
export function describeRfc64LegacySwmFenceEventV1(
  event: Readonly<Rfc64LegacySwmFenceEventV1>,
): string {
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
  fenceDropped: Promise<void>;
  resolveFenceDropped: (() => void) | undefined;
}

/**
 * The preparation fences of one legacy SWM boundary and the chain that
 * serializes its retirements. A preparation registers under its context graph
 * id and under its asset key; a retirement fences one of the two.
 */
export interface Rfc64LegacySwmFenceCoordinatorV1 {
  readonly scopes: Map<string, Rfc64LegacySwmFenceScopeStateV1>;
  mutationTail: Promise<void>;
  readonly waitLimitMs: number;
  readonly longFenceMs: number;
  readonly now: () => number;
  readonly onFenceEvent: ((event: Readonly<Rfc64LegacySwmFenceEventV1>) => void) | undefined;
}

export function createRfc64LegacySwmFenceCoordinatorV1(
  options: Rfc64LegacySwmFenceOptionsV1 = {},
): Rfc64LegacySwmFenceCoordinatorV1 {
  return {
    scopes: new Map(),
    mutationTail: Promise.resolve(),
    waitLimitMs: options.waitLimitMs ?? RFC64_LEGACY_SWM_FENCE_WAIT_LIMIT_MS,
    longFenceMs: options.longFenceMs ?? RFC64_LEGACY_SWM_FENCE_LONG_MS,
    now: options.now ?? (() => performance.now()),
    onFenceEvent: options.onFenceEvent,
  };
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
 * Resolve once neither the graph nor the asset is fenced, or after `limitMs`.
 * It registers nothing and promises nothing: a fence raised after it resolves
 * still refuses the preparation. A seam that can wait calls it right before
 * the synchronous prepare, so a fence that is up for milliseconds costs those
 * milliseconds instead of a refused attempt and its retry delay.
 */
export async function waitForRfc64LegacySwmPreparationAdmissionV1(
  fence: Rfc64LegacySwmFenceCoordinatorV1,
  contextGraphId: string,
  kaUal: string,
  limitMs: number,
): Promise<void> {
  const keys = [contextGraphId, rfc64LegacySwmAssetScopeKeyV1(contextGraphId, kaUal)];
  const deadline = fence.now() + limitMs;
  for (;;) {
    const fenced = keys
      .map((key) => fence.scopes.get(key))
      .filter((scope) => scope !== undefined && scope.holders.length > 0);
    const remainingMs = deadline - fence.now();
    if (fenced.length === 0 || remainingMs <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve) => { timer = setTimeout(resolve, remainingMs); }),
        ...fenced.map((scope) => scope!.fenceDropped),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export type Rfc64LegacySwmRetirementOutcomeV1<T> =
  | { readonly ran: true; readonly value: T }
  | { readonly ran: false };

/**
 * Run `work` behind a fence: raise it, take a turn on the mutation chain, wait
 * for the scope's in-flight preparations, then run. The fence drops when the
 * work settles, or earlier when the work calls `dropFence`.
 *
 * The two waits share one bound. A retirement that does not get to run within
 * it drops its fence, reports `wait-exceeded` and answers `ran: false`; when
 * its turn on the chain comes later it does nothing. Leaving the markers in
 * place is the conservative state, and the next pass retires them. Without the
 * bound one preparation that never settles would hold the chain, and through
 * it the fence of every graph that tries to retire, for as long as it hangs.
 */
export async function runRfc64LegacySwmRetirementV1<T>(
  fence: Rfc64LegacySwmFenceCoordinatorV1,
  target: Readonly<{
    source: Rfc64LegacySwmFenceSourceV1;
    contextGraphId: string;
    /** Present for an asset fence; absent for the graph's. */
    kaUal?: string;
  }>,
  work: (dropFence: () => void) => Promise<T>,
): Promise<Rfc64LegacySwmRetirementOutcomeV1<T>> {
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
  const notRun = { ran: false } as const;

  const turn = fence.mutationTail.then(async (): Promise<Rfc64LegacySwmRetirementOutcomeV1<T>> => {
    if (gaveUp) return notRun;
    waitingOn = 'preparations';
    await Promise.race([scope.preparationsDrained, abandoned]);
    if (gaveUp) return notRun;
    workStarted = true;
    clearTimeout(timer);
    return { ran: true, value: await work(dropFence) };
  });
  fence.mutationTail = turn.then(() => undefined, () => undefined);
  try {
    return await Promise.race([turn, abandoned.then(() => notRun)]);
  } finally {
    clearTimeout(timer);
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
