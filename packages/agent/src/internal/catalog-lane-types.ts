// SPDX-License-Identifier: Apache-2.0
import type { SwmAuthorInventoryScopeV1 } from '@origintrail-official/dkg-core';

/** Public lanes never own finalized-private placement; dependencies enrich each variant. */
export type CatalogLaneV1<Public = object, Private = object> = Readonly<{
  scopeBase: Readonly<Omit<SwmAuthorInventoryScopeV1, 'authorAddress'>>;
}> & (
  | Readonly<{ kind: 'public'; acceptsFinalizedVmRepair: false } & Public>
  | Readonly<{ kind: 'private'; acceptsFinalizedVmRepair: boolean } & Private>
);
export type PlacementLaneV1 = CatalogLaneV1;
export type CatalogAuthoringLaneDecisionV1<Lane> =
  | Readonly<{ status: 'inactive' }>
  | Readonly<{ status: 'unavailable'; error: Error }>
  | Readonly<{ status: 'active'; lane: Lane }>;
