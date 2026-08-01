import {
  runCatchupPlaneWithPolicy,
  type CatchupPlanePolicyClock,
  type CatchupPlanePolicyOptions,
  type CatchupPlaneResult,
} from '@origintrail-official/dkg-agent';

// `retryDelaysMs` configured the fixed `[100, 250, 500]` ladder that issue #2006
// replaced with a wall-clock budget. It is retained as `never` rather than
// deleted so that setting it is a COMPILE error instead of a silent no-op: an
// ignored `retryDelaysMs: [10]` would turn an intended 10 ms schedule into a
// wait of up to `CATCHUP_BACKPRESSURE_MAX_WAIT_MS`, which is a far worse way to
// discover the change than a type error.
//
// That guarantee is a property of the PUBLISHED type, so it is pinned here
// rather than in a runtime test — no runtime assertion can observe it. Each
// `@ts-expect-error` below fails the build in BOTH directions: it errors today
// if the option were quietly made assignable again, and it errors as an unused
// suppression if the option were deleted outright (which would make a stale
// caller compile against a field that no longer exists at all).

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

// The replacement is `retry.maxWaitMs`, and it must stay assignable.
const supported: CatchupPlanePolicyClock = { retry: { maxWaitMs: 5_000 } };

export declare const pinned: [typeof clock, typeof planes, typeof supported, typeof runCatchupPlaneWithPolicy];
