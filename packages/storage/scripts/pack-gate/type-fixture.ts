// Static consumer TYPE fixture for the packed-artifact export gate (#2165).
// Compiled (noEmit, NodeNext) against the packed d.ts in the scratch install.
// Self-discriminating both ways: dropping an allowed export is a compile
// error; a forbidden symbol returning to the barrel turns its suppression
// into an unused directive (TS2578). The directive token must never begin a
// wrapped comment line — tsc parses such a comment as a real directive.
import { ManagedOxigraphBackendUnownedError } from '@origintrail-official/dkg-storage';
import type { ManagedOxigraphSupervisorHandoffV1 } from '@origintrail-official/dkg-storage/internal/managed-oxigraph-ownership-v1';
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
export default witness;
