// Static consumer TYPE fixture for the packed-artifact export gate (#2165).
// Compiled (noEmit, NodeNext) against the packed d.ts in the scratch install.
// Self-discriminating both ways: dropping an allowed export is a compile
// error; a forbidden symbol returning to the barrel turns its suppression
// into an unused directive (TS2578). The directive token must never begin a
// wrapped comment line — tsc parses such a comment as a real directive.
import {
  ManagedOxigraphBackendUnownedError,
  captureStructuredMutationSnapshot,
  type StructuredMutationSnapshot,
} from '@origintrail-official/dkg-storage';
import type { ManagedOxigraphSupervisorHandoffV1 } from '@origintrail-official/dkg-storage/internal/managed-oxigraph-ownership-v1';
// #2052 D-8 — the gate-read subpath's DECLARATIONS, compiled against the packed d.ts.
// The agent adapter imports exactly these names; a packed artifact that resolves but
// ships no declarations for them breaks the only consumer while passing a
// resolution-only check.
import {
  readLegacyAgentProfileAppliedRootsV1,
  readLegacyAgentProfileProjectionV1,
  systemRecordProjectionGraphV1,
  type SystemRecordMaterializationModeV1,
} from '@origintrail-official/dkg-storage/internal/system-record-legacy-gate-read-v1';
// @ts-expect-error — final mutation materialization has no supported package subpath
import { materializeStructuredMutation } from '@origintrail-official/dkg-storage/structured-mutation-materialization-internal';
// @ts-expect-error — the ownership mint is not on the public barrel
import { createManagedOxigraphOwnershipControllerV1 } from '@origintrail-official/dkg-storage';
// Every removed ownership type is pinned individually — runtime namespace
// checks cannot see type-only exports, so the compiler is the only witness.
// @ts-expect-error — ownership types are not on the public barrel
import type { ManagedOxigraphOwnershipLeaseV1 } from '@origintrail-official/dkg-storage';
// @ts-expect-error — ownership types are not on the public barrel
import type { ManagedOxigraphOwnershipControllerV1 } from '@origintrail-official/dkg-storage';
// @ts-expect-error — ownership types are not on the public barrel
import type { ManagedOxigraphOwnershipSnapshotV1 } from '@origintrail-official/dkg-storage';
// @ts-expect-error — ownership types are not on the public barrel
import type { ManagedOxigraphOwnershipInvalidationV1 } from '@origintrail-official/dkg-storage';
// @ts-expect-error — ownership types are not on the public barrel
import type { ManagedOxigraphSupervisorHandoffV1 as ForbiddenHandoff } from '@origintrail-official/dkg-storage';

const witness: [typeof ManagedOxigraphBackendUnownedError, ManagedOxigraphSupervisorHandoffV1 | null] = [
  ManagedOxigraphBackendUnownedError,
  null,
];
const snapshotWitness: StructuredMutationSnapshot = captureStructuredMutationSnapshot({
  kind: 'delete-subjects',
  input: { graphUri: 'urn:test:pack-gate', subjects: [] },
});
void materializeStructuredMutation;
void snapshotWitness;
// The gate-read surface as the adapter actually uses it: the mode type names the union,
// and the graph function is applied to it. Referencing the values (not just importing
// them) is what makes a missing declaration a compile error rather than an unused import.
const gateReadMode: SystemRecordMaterializationModeV1 = 'shadow';
const gateReadWitness: string = systemRecordProjectionGraphV1(gateReadMode);
void readLegacyAgentProfileAppliedRootsV1;
void readLegacyAgentProfileProjectionV1;
void gateReadWitness;
export default witness;
