import type { Rfc64CatalogReplayPeerReservationV1, Rfc64CatalogReplayPeerDemandHandleV1 } from './catalog-replay-types-v1.js';
import type { Rfc64CatalogConnectionReplayResultV1 } from './catalog-replay-types-v1.js';
import type { CatalogReplayRolesV1 } from './catalog-replay-selection-v1.js';
import type { CatalogReplayTransportV1 } from './catalog-replay-transport-v1.js';
// SPDX-License-Identifier: Apache-2.0
import type { AcceptedRfc64CatalogAccessSnapshotV1 } from './catalog-access-policy-v1.js';
import { Rfc64CatalogReplayConnectionRuntimeV1, type Rfc64CatalogReplayConnectionRuntimePortsV1 } from './catalog-replay-connection-runtime-v1.js';
import { RFC64_PUBLIC_CATALOG_HEAD_REPLAY_KIND_V1 } from './public-catalog-transport-v1.js';

interface Rfc64CatalogReplayConnectionCapabilitiesV1 {
  resolveRfc64CatalogReplayRolesV1(contextGraphId: string): CatalogReplayRolesV1;
  listServingRfc64CatalogReplayContextGraphIdsV1(): readonly string[];
  listActiveRfc64CatalogReplayContextGraphIdsV1(): readonly string[];
  readAcceptedRfc64CatalogAccessSnapshotV1(contextGraphId: string): AcceptedRfc64CatalogAccessSnapshotV1 | null;
}

/** Bind current accepted policy at fence reservation and compatibility announcement. */
export function createRfc64CatalogReplayConnectionRuntimeV1(input:
  Readonly<{
    reserveDeferred: Rfc64CatalogReplayConnectionRuntimePortsV1['reserveDeferredFence'];
    capabilities: Rfc64CatalogReplayConnectionCapabilitiesV1;
    reservePeer(contextGraphId: string, policyDigest: string, peerId: string): Rfc64CatalogReplayPeerReservationV1 | null;
    replay(contextGraphId: string, demand: Rfc64CatalogReplayPeerDemandHandleV1,
      signal: AbortSignal): Promise<Rfc64CatalogConnectionReplayResultV1>;
  }>
    & Pick<CatalogReplayTransportV1<never>, 'reannounce'>
    & Pick<Rfc64CatalogReplayConnectionRuntimePortsV1, 'admittedConnectedPeerIds' | 'schedule' | 'wait' | 'warn' | 'reportRun'>,
): Rfc64CatalogReplayConnectionRuntimeV1 {
  const receives = (contextGraphId: string): boolean => input.capabilities.resolveRfc64CatalogReplayRolesV1(contextGraphId).receiving;
  return new Rfc64CatalogReplayConnectionRuntimeV1({
    admittedConnectedPeerIds: input.admittedConnectedPeerIds,
    selectContextGraphIds: () => [...new Set([...input.capabilities.listActiveRfc64CatalogReplayContextGraphIdsV1(),
      ...input.capabilities.listServingRfc64CatalogReplayContextGraphIdsV1()])],
    reserveDeferredFence: contextGraphId => receives(contextGraphId)
      ? input.reserveDeferred(contextGraphId) : null,
    reserveFence: (contextGraphId, peerId) => {
      if (!receives(contextGraphId)) return Object.freeze({
        isCurrent: () => !receives(contextGraphId), release: () => {},
        replay: async () => Object.freeze({ failed: 0 }),
      });
      const accepted = input.capabilities.readAcceptedRfc64CatalogAccessSnapshotV1(contextGraphId);
      if (accepted === null) return null;
      const lease = input.reservePeer(contextGraphId, accepted.policyDigest, peerId);
      return lease === null ? null : Object.freeze({ release: () => lease.release(),
        replay: (signal: AbortSignal) => { lease.admit(); return input.replay(contextGraphId, lease, signal); },
        isCurrent: () => lease.isCurrent()
        && receives(contextGraphId)
        && input.capabilities.readAcceptedRfc64CatalogAccessSnapshotV1(contextGraphId)?.policyDigest === accepted.policyDigest });
    },
    reannounce: (peerId, id, signal) => {
      const accepted = input.capabilities.readAcceptedRfc64CatalogAccessSnapshotV1(id);
      return accepted === null ? Promise.resolve(Object.freeze({ failed: 0 }))
        : input.reannounce(peerId, {
          kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_KIND_V1,
          networkId: accepted.policy.networkId, contextGraphId: accepted.policy.contextGraphId,
          policyDigest: accepted.policyDigest,
        }, signal);
    },
    schedule: input.schedule, wait: input.wait, warn: input.warn,
    reportRun: input.reportRun,
  });
}
