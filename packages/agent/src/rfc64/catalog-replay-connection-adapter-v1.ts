import type { CatalogReplayTransportV1 } from './catalog-replay-transport-v1.js';
// SPDX-License-Identifier: Apache-2.0
import type { AcceptedRfc64CatalogAccessSnapshotV1 } from './catalog-access-policy-v1.js';
import { Rfc64CatalogReplayConnectionRuntimeV1, type Rfc64CatalogReplayConnectionRuntimePortsV1 } from './catalog-replay-connection-runtime-v1.js';
import { RFC64_PUBLIC_CATALOG_HEAD_REPLAY_KIND_V1 } from './public-catalog-transport-v1.js';

interface Rfc64CatalogReplayConnectionCapabilitiesV1 {
  listServingRfc64CatalogReplayContextGraphIdsV1(): readonly string[];
  listActiveRfc64CatalogReplayContextGraphIdsV1(): readonly string[];
  readAcceptedRfc64CatalogAccessSnapshotV1(contextGraphId: string): AcceptedRfc64CatalogAccessSnapshotV1 | null;
}

/** Bind current accepted policy at fence reservation and compatibility announcement. */
export function createRfc64CatalogReplayConnectionRuntimeV1(input:
  Readonly<{ reserveDeferred: Rfc64CatalogReplayConnectionRuntimePortsV1['reserveDeferredFence']; capabilities: Rfc64CatalogReplayConnectionCapabilitiesV1; reservePeer(contextGraphId: string, policyDigest: string, peerId: string): ReturnType<Rfc64CatalogReplayConnectionRuntimePortsV1['reserveFence']> }>
    & Pick<CatalogReplayTransportV1<never>, 'reannounce'>
    & Pick<Rfc64CatalogReplayConnectionRuntimePortsV1, 'admittedConnectedPeerIds' | 'schedule' | 'wait' | 'warn' | 'replay' | 'reportRun'>,
): Rfc64CatalogReplayConnectionRuntimeV1 {
  return new Rfc64CatalogReplayConnectionRuntimeV1({
    admittedConnectedPeerIds: input.admittedConnectedPeerIds,
    selectContextGraphIds: () => [...new Set([...input.capabilities.listActiveRfc64CatalogReplayContextGraphIdsV1(),
      ...input.capabilities.listServingRfc64CatalogReplayContextGraphIdsV1()])],
    reserveDeferredFence: contextGraphId => input.capabilities.listActiveRfc64CatalogReplayContextGraphIdsV1().includes(contextGraphId)
      ? input.reserveDeferred(contextGraphId) : null,
    reserveFence: (contextGraphId, peerId) => {
      if (!input.capabilities.listActiveRfc64CatalogReplayContextGraphIdsV1().includes(contextGraphId)) return 'announcement-only';
      const accepted = input.capabilities.readAcceptedRfc64CatalogAccessSnapshotV1(contextGraphId);
      return accepted === null ? null : input.reservePeer(contextGraphId, accepted.policyDigest, peerId);
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
    replay: input.replay, reportRun: input.reportRun,
  });
}
