// SPDX-License-Identifier: Apache-2.0
import type { PlacementLaneV1 } from './catalog-lane-types.js';

/** Workspace content must retain its public/private catalog policy at transfer. */
export function rfc64CatalogLaneAcceptsWorkspaceHeadV1(
  lane: Pick<PlacementLaneV1, 'kind'>,
  accessPolicy: 'public' | 'ownerOnly' | 'allowList' | undefined,
): boolean {
  return lane.kind === 'public'
    ? accessPolicy === 'public'
    : accessPolicy === 'ownerOnly' || accessPolicy === 'allowList';
}
