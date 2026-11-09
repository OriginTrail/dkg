// SPDX-License-Identifier: Apache-2.0
import { CatalogReplayPeerLaneV1 } from './catalog-replay-peer-lane-v1.js';
import type { Rfc64CatalogReplayRecoveryPortsV1 } from './catalog-replay-recovery-runtime-v1.js';
import type { Rfc64PublicCatalogHeadReplayRequestV1 } from './public-catalog-transport-v1.js';

export interface CatalogReplayTransportV1<Target> {
  requestPeer: Rfc64CatalogReplayRecoveryPortsV1<Target>['requestPeer'];
  reannounce(peerId: string, scope: Readonly<Rfc64PublicCatalogHeadReplayRequestV1>, signal: AbortSignal): Promise<Readonly<{ failed: number }>>;
}
/** Bind both physical operations to one node-wide lane at composition time. */
export function createCatalogReplayTransportV1<Target>(operations: CatalogReplayTransportV1<Target>): CatalogReplayTransportV1<Target> {
  const lane = new CatalogReplayPeerLaneV1();
  return {
    requestPeer: (cg, peer, signal) => lane.run(peer, signal, () => operations.requestPeer(cg, peer, signal)),
    reannounce: (peer, scope, signal) => lane.run(peer, signal, () => operations.reannounce(peer, scope, signal)),
  };
}
