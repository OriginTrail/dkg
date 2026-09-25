import {
  CATCHUP_BACKPRESSURE_MAX_WAIT_MS,
  DKGAgent,
  runCatchupPlaneWithPolicy,
  type CatchupPlanePolicyClock,
  type CatchupPlanePolicyOptions,
  type CatchupPlanePolicyRunOptions,
  type CatchupPlaneResult,
  type CatchupPlaneRetryMerge,
} from '@origintrail-official/dkg-agent';
// @ts-expect-error CATCHUP_BACKPRESSURE_RETRY_DELAYS_MS is REMOVED from the
// package root. It named the fixed [100, 250, 500] ladder, which no longer
// exists — re-exporting it would hand a consumer a schedule the node does not
// follow. A stale caller must fail to resolve it, not compile against a lie.
import { CATCHUP_BACKPRESSURE_RETRY_DELAYS_MS } from '@origintrail-official/dkg-agent';
// @ts-expect-error the low-level continuation executor is intentionally internal;
// CLI orchestration consumes its existing explicit dist subpath instead.
import { runSwmCatchupContinuations } from '@origintrail-official/dkg-agent';

// `retryDelaysMs` configured the fixed `[100, 250, 500]` ladder that issue #2006
// replaced with a wall-clock budget. It is retained as `never` rather than
// deleted so that setting it is a COMPILE error instead of a silent no-op: an
// ignored `retryDelaysMs: [10]` would turn an intended 10 ms schedule into a
// wait of up to `CATCHUP_BACKPRESSURE_MAX_WAIT_MS`, which is a far worse way to
// discover the change than a type error.
//
// That guarantee is a property of the PUBLISHED type, so it is pinned here
// rather than in a runtime test — no runtime assertion can observe it.
//
// Object literals alone CANNOT carry it. Excess-property checking rejects
// `{ retryDelaysMs: [...] }` against an annotated target whether the member is
// declared `never` or absent entirely, so a literal-only test passes in both
// worlds and proves nothing about the difference. Deleting the member is
// precisely the stale-caller silent-ignore case the `never` exists to prevent,
// so it is pinned two ways that a deletion breaks: an indexed access on the
// member itself, and a stale options object flowing through a VARIABLE, where
// excess properties are permitted and only a declared `never` can refuse them.

// Fails to compile (TS2339) if the member is deleted rather than kept `never`.
declare const removedLadder: CatchupPlanePolicyClock['retryDelaysMs'];
// …and `undefined` is the only value it can hold.
const ladderIsUninhabited: undefined = removedLadder;

declare const staleCallerOptions: {
  retry: { maxWaitMs: number };
  retryDelaysMs: number[];
};
// @ts-expect-error a stale options VARIABLE carrying the removed ladder must not
// flow in structurally — this is the case excess-property checking would let by,
// and the one that silently reverted to a full-budget wait before the `never`.
const stale: CatchupPlanePolicyClock = staleCallerOptions;

// @ts-expect-error retryDelaysMs was removed with the fixed ladder it configured.
const clock: CatchupPlanePolicyClock = { retryDelaysMs: [10, 20] };

const planes: CatchupPlanePolicyOptions<CatchupPlaneResult, CatchupPlaneResult> = {
  mode: 'foreground',
  includeSharedMemory: false,
  syncDurable: async () => ({}),
  syncSharedMemory: async () => ({}),
  // @ts-expect-error the same option is equally rejected on the two-plane options.
  retryDelaysMs: [10],
};

// `mergeRetryResults` is the SINGLE-plane fold option. The two-plane runner has
// two planes and therefore two folds (`mergeDurableRetryResults` /
// `mergeSharedMemoryRetryResults`), and it spreads its options into each plane's
// run options before assigning `mergeRetryResults` itself — so a caller that set
// it on the two-plane options would have it overwritten with `undefined` and
// lose every retry diagnostic, with no diagnostic of its own. That is the same
// silently-ignored-option shape as the removed ladder, and the name is an easy
// mistake to make because the single-plane API takes exactly it. Pinned the same
// two ways, for the same reason: the literal form proves nothing on its own.

// Fails to compile (TS2339) if the member is dropped rather than kept `never`.
declare const planeFoldOnPlanes: CatchupPlanePolicyOptions<
  CatchupPlaneResult,
  CatchupPlaneResult
>['mergeRetryResults'];
// …and `undefined` is the only value it can hold.
const planeFoldIsUninhabited: undefined = planeFoldOnPlanes;

declare const singlePlaneFoldOptions: {
  mode: 'foreground';
  includeSharedMemory: false;
  syncDurable: () => Promise<CatchupPlaneResult>;
  syncSharedMemory: () => Promise<CatchupPlaneResult>;
  mergeRetryResults: (
    previous: CatchupPlaneResult,
    current: CatchupPlaneResult,
  ) => CatchupPlaneResult;
};
// @ts-expect-error a VARIABLE carrying the single-plane fold name must not flow
// into the two-plane options — the case excess-property checking would let by.
const staleFold: CatchupPlanePolicyOptions<CatchupPlaneResult, CatchupPlaneResult> =
  singlePlaneFoldOptions;

// The replacements must stay importable and assignable, so this file cannot
// pass merely because the whole surface decayed.
const supported: CatchupPlanePolicyClock = { retry: { maxWaitMs: 5_000 } };
const replacementBudget: number = CATCHUP_BACKPRESSURE_MAX_WAIT_MS;
const planeFolds: CatchupPlanePolicyOptions<CatchupPlaneResult, CatchupPlaneResult> = {
  mode: 'foreground',
  includeSharedMemory: true,
  syncDurable: async () => ({}),
  syncSharedMemory: async () => ({}),
  mergeDurableRetryResults: (previous, current) => ({
    deferredBackpressure:
      (previous.deferredBackpressure ?? 0) + (current.deferredBackpressure ?? 0),
  }),
  mergeSharedMemoryRetryResults: (_previous, current) => current,
};
// …and the single-plane API must keep taking the fold under its own name.
declare const singlePlaneRunOptions: CatchupPlanePolicyRunOptions<CatchupPlaneResult>;
const singlePlaneFold: CatchupPlaneRetryMerge<CatchupPlaneResult> = singlePlaneRunOptions;

export declare const pinned: [
  typeof clock,
  typeof planes,
  typeof supported,
  typeof stale,
  typeof ladderIsUninhabited,
  typeof replacementBudget,
  typeof planeFoldIsUninhabited,
  typeof staleFold,
  typeof planeFolds,
  typeof singlePlaneFold,
  typeof CATCHUP_BACKPRESSURE_RETRY_DELAYS_MS,
  typeof runSwmCatchupContinuations,
  typeof runCatchupPlaneWithPolicy,
];

// The admission parameters of `runContextGraphSyncWithBackpressure` collapsed from
// positional `(priorityOverride?: number, operationSignal?: AbortSignal)` into a single
// object, so the new `source` dimension did not become a fourth positional argument.
//
// The runtime guard rejects the old shape (see durable-sync-lifecycle-binding.test.ts).
// This pins the COMPILE-TIME half, and specifically the seventh-argument case: without
// the `...legacyPositionalArgs: never[]` rest parameter a stale caller passing a
// trailing AbortSignal type-checks, and TypeScript would say nothing about a caller
// that is quietly losing its cancellation.
declare const staleAdmissionCaller: DKGAgent;
declare const staleSignal: AbortSignal;

const staleAdmissionCall = () => staleAdmissionCaller.runContextGraphSyncWithBackpressure(
  {} as never,
  'cg',
  'durable' as never,
  'label',
  async () => 1,
  {},
  // @ts-expect-error nothing may follow `admission`; this is the pre-#2006 positional signal.
  staleSignal,
);

export declare const pinnedAdmission: typeof staleAdmissionCall;
