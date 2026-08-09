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
// @ts-expect-error — ownership types are not on the public barrel either
import type { ManagedOxigraphOwnershipLeaseV1 } from '@origintrail-official/dkg-storage';

const witness: [typeof ManagedOxigraphBackendUnownedError, ManagedOxigraphSupervisorHandoffV1 | null] = [
  ManagedOxigraphBackendUnownedError,
  null,
];
export default witness;
