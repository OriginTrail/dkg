/**
 * Compile-only negative type contracts for typed control-barrier keys (#2179).
 *
 * NEVER EXECUTED: this file is compiled by `typecheck:type-contracts`
 * (tsconfig.typetests.json) and is not matched by the vitest include glob, so
 * intentionally-invalid expressions prove type-level properties without
 * enqueueing real barriers or floating promises. Each `@ts-expect-error` here
 * is a live assertion — if the error it suppresses stops existing, the lane
 * fails with TS2578 (unused directive). All values are `declare`d: there is
 * no runtime, only shapes.
 */
import type { ManagedSystemRecordCoordinatorOptionsV1 } from '../src/adapters/system-record-managed-coordinator-v1-internal.js';
import type { SystemRecordLaneControllerTypedDepsV1 } from '../src/system-record-lane-controller-contract-v1.js';
import type { StoreControlBarrierKeyV1 } from '../src/store-control-barrier-key-v1.js';
import type { StorePriorityScheduler } from '../src/store-priority-scheduler.js';

declare const scheduler: StorePriorityScheduler;
declare const epochKey: StoreControlBarrierKeyV1<{ epoch: string }>;
declare const takeOptions: (options: ManagedSystemRecordCoordinatorOptionsV1) => void;

// A transition cannot smuggle a different result type past its key.
// @ts-expect-error — the epoch key demands { epoch: string }, not number
void scheduler.runTypedControlBarrier({}, epochKey, async () => 7);

// A key cannot be forged from a plain literal: the module-private brand is a
// required member no caller outside the factory can produce.
// @ts-expect-error — structural literal lacks the private brand
void scheduler.runTypedControlBarrier({}, { purpose: 'forged' }, async () => 7);

// The managed coordinator is typed-only STRUCTURALLY: its options carry no
// string-barrier member, so first-party composition cannot regress onto the
// purpose-string contract without editing that interface. The literal below is
// COMPLETE apart from `barrier`, deliberately: with every required member
// present, the excess `barrier` property is the ONLY error, so re-adding the
// member to the interface turns the suppression below into an unused
// directive (TS2578) and fails the typecheck lane. (An incomplete literal
// could not discriminate — missing-member errors would keep the suppression
// alive either way.) NOTE: never let the directive token itself start a
// wrapped comment line here — tsc parses any comment line beginning with the
// expect-error token as a REAL directive, and a phantom directive on a prose
// line reads as unused and fails this lane. That exact wrap bug shipped in
// this file's first version.
void takeOptions({
  lease: null as never,
  handoff: null as never,
  storeId: {},
  queryEndpoint: '',
  updateEndpoint: '',
  resolveClient: () => null,
  applyLegacy: null as never,
  typedBarrier: null as never,
  setAdmissionActive: () => {},
  // @ts-expect-error — a string `barrier` member does not exist on the
  // managed coordinator's options
  barrier: null as never,
});


// The EXPORTED typed-only factory input carries the same structural pin as
// the coordinator options: a complete literal, excess `barrier` as the only
// error. If SystemRecordLaneControllerTypedDepsV1 ever grows a string
// `barrier` member (even optional), the suppression below turns into an
// unused directive (TS2578) and this lane fails.
declare const takeTypedDeps: (deps: SystemRecordLaneControllerTypedDepsV1) => void;
void takeTypedDeps({
  lease: null as never,
  handoff: null as never,
  executor: null as never,
  typedBarrier: null as never,
  setAdmissionActive: () => {},
  // @ts-expect-error — no string `barrier` member exists on the typed-only deps
  barrier: null as never,
});

export {};
