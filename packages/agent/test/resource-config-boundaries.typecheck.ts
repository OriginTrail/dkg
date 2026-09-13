import type { SchedulerPressureCapacity } from '@origintrail-official/dkg-core';
import type { DKGAgentConfig } from '../src/dkg-agent-types.js';
import type {
  AgentResourceSnapshots, CatchupResourceSnapshot, OwnedResourceEnvName, VmResourceSnapshot,
} from '../src/resource-limits.js';
import type { resolveStartupResourcePolicy } from '../src/resource-policy.js';
import type { RawResourceResolutionInput, ResolvedDKGAgentConfig } from '../src/resolved-agent-config.js';
import type { PriorityAdmissionObservability } from '../src/sync/priority-admission-queue.js';

type AssertNever<T extends never> = T;
type ConsumedResourceKey = Extract<keyof Parameters<typeof resolveStartupResourcePolicy>[0], keyof DKGAgentConfig>;
export type ResourceInputsStayOutsideRuntime = AssertNever<Extract<ConsumedResourceKey, keyof ResolvedDKGAgentConfig>>;
export type AllConsumedInputsAreModeled = AssertNever<Exclude<ConsumedResourceKey, keyof RawResourceResolutionInput>>;
export type LegacyAckAliasesStayOutsideRuntime = AssertNever<Extract<'ackHandlerDeadlineMs' | 'ackSendTimeoutMs', keyof ResolvedDKGAgentConfig>>;

// Resource ownership is encoded once, in the descriptor: a setting belongs to
// exactly one owner, and each owner's snapshot is a distinct slice.
export type OwnersPartitionEverySetting = AssertNever<Extract<OwnedResourceEnvName<'vm'>, OwnedResourceEnvName<'catchup'>>>;
declare const snapshots: AgentResourceSnapshots;
const vmSlice: VmResourceSnapshot = snapshots.vm;
const catchupSlice: CatchupResourceSnapshot = snapshots.catchup;
const batchSize: number = snapshots.vm.values.DKG_VM_RECONCILE_BATCH_SIZE;
// @ts-expect-error A catch-up setting is not resolved by the VM owner.
void snapshots.vm.values.DKG_CATCHUP_MAX_CONCURRENT_PEERS;
// @ts-expect-error The composed bundle is not the VM owner's slice.
const bundleAsVm: VmResourceSnapshot = snapshots;
// @ts-expect-error A catch-up slice cannot stand in for the VM owner.
const catchupAsVm: VmResourceSnapshot = snapshots.catchup;
// @ts-expect-error A VM slice cannot stand in for the catch-up owner.
const vmAsCatchup: CatchupResourceSnapshot = snapshots.vm;
declare const merged: {
  values: VmResourceSnapshot['values'] & CatchupResourceSnapshot['values'];
  startupMaxDelayMs: number;
  rejected: readonly string[];
};
// @ts-expect-error A merge of every owner's settings carries no owner and is not a VM slice.
const mergedAsVm: VmResourceSnapshot = merged;
declare const resolvePolicy: typeof resolveStartupResourcePolicy;
resolvePolicy({}, {}, snapshots);
// @ts-expect-error The startup policy takes the explicit { vm, catchup } bundle, not one owner's slice.
resolvePolicy({}, {}, snapshots.vm);
// @ts-expect-error Neither owner is resolved implicitly from the environment.
resolvePolicy({}, {});
void [vmSlice, catchupSlice, batchSize, bundleAsVm, catchupAsVm, vmAsCatchup, mergedAsVm];

const capacity: SchedulerPressureCapacity = { capacityModel: 'shared', inflightLimit: 2, queueLimit: 4 };
const common = { scheduler: 'capacity-contract', operation: () => 'work' };
const fixed: PriorityAdmissionObservability<string> = { ...common, kind: 'fixed', capacity };
const inferred: PriorityAdmissionObservability<string> = { ...common, kind: 'inferred', inflightLimit: () => 2 };
const legacyInference: PriorityAdmissionObservability<string> = { ...common, inflightLimit: () => 2 };
const perEntry: PriorityAdmissionObservability<string> = { ...common, kind: 'per-entry', capacityFor: () => capacity };

// @ts-expect-error A fixed queue cannot also infer a different ceiling from an entry.
const fixedAndInferred: PriorityAdmissionObservability<string> = { ...common, kind: 'fixed', capacity, inflightLimit: () => 3 };
// @ts-expect-error A fixed queue cannot also obtain per-entry capacity snapshots.
const fixedAndPerEntry: PriorityAdmissionObservability<string> = { ...common, kind: 'fixed', capacity, capacityFor: () => capacity };
// @ts-expect-error A per-entry queue cannot accept a competing fixed capacity.
const perEntryAndFixed: PriorityAdmissionObservability<string> = { ...common, kind: 'per-entry', capacityFor: () => capacity, capacity };
// @ts-expect-error A per-entry queue cannot also infer an inflight ceiling.
const perEntryAndInferred: PriorityAdmissionObservability<string> = { ...common, kind: 'per-entry', capacityFor: () => capacity, inflightLimit: () => 2 };
// @ts-expect-error Omitting the tag selects legacy inference, which has no fixed capacity.
const untaggedFixed: PriorityAdmissionObservability<string> = { ...common, capacity };
// @ts-expect-error A fixed strategy requires its capacity.
const missingFixedCapacity: PriorityAdmissionObservability<string> = { ...common, kind: 'fixed' };
const contradictorySource = { ...common, kind: 'fixed' as const, capacity, capacityFor: () => capacity };
// @ts-expect-error Contradictory strategies remain invalid after object-literal freshness is lost.
const indirectContradiction: PriorityAdmissionObservability<string> = contradictorySource;

void [fixed, inferred, legacyInference, perEntry, fixedAndInferred, fixedAndPerEntry,
  perEntryAndFixed, perEntryAndInferred, untaggedFixed, missingFixedCapacity, indirectContradiction];
