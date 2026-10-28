// SPDX-License-Identifier: Apache-2.0
import type { AcceptedRfc64CatalogAccessSnapshotV1 } from './catalog-access-policy-v1.js';
import { Rfc64CatalogReplayConnectionRuntimeV1, type Rfc64CatalogReplayConnectionRuntimePortsV1 } from './catalog-replay-connection-runtime-v1.js';
import { RFC64_PUBLIC_CATALOG_HEAD_REPLAY_KIND_V1, type Rfc64PublicCatalogHeadReplayRequestV1 } from './public-catalog-transport-v1.js';

interface Rfc64CatalogReplayConnectionCapabilitiesV1 {
  listActiveRfc64CatalogReplayContextGraphIdsV1(): readonly string[];
  readAcceptedRfc64CatalogAccessSnapshotV1(contextGraphId: string): AcceptedRfc64CatalogAccessSnapshotV1 | null;
  reannounceRfc64CatalogHeadsToPeerV1(peerId: string, scope: Readonly<Rfc64PublicCatalogHeadReplayRequestV1>, signal: AbortSignal): Promise<Readonly<{ failed: number }>>;
}

/** Bind current accepted policy at fence reservation and compatibility announcement. */
export function createRfc64CatalogReplayConnectionRuntimeV1(input:
  Readonly<{ capabilities: Rfc64CatalogReplayConnectionCapabilitiesV1; reservePeer(contextGraphId: string, policyDigest: string, peerId: string): ReturnType<Rfc64CatalogReplayConnectionRuntimePortsV1['reserveFence']> }>
    & { runPeerTransport<T>(peer: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> }
    & Pick<Rfc64CatalogReplayConnectionRuntimePortsV1, 'connectedPeerIds' | 'schedule' | 'wait' | 'warn' | 'replay' | 'reportRun'>,
): Rfc64CatalogReplayConnectionRuntimeV1 {
  return new Rfc64CatalogReplayConnectionRuntimeV1({
    connectedPeerIds: input.connectedPeerIds,
    selectContextGraphIds: () => input.capabilities.listActiveRfc64CatalogReplayContextGraphIdsV1(),
    reserveFence: (contextGraphId, peerId) => {
      const accepted = input.capabilities.readAcceptedRfc64CatalogAccessSnapshotV1(contextGraphId);
      return accepted === null ? null : input.reservePeer(contextGraphId, accepted.policyDigest, peerId);
    },
    reannounce: (peerId, id, signal) => {
      const accepted = input.capabilities.readAcceptedRfc64CatalogAccessSnapshotV1(id);
      return accepted === null ? Promise.resolve(Object.freeze({ failed: 0 }))
        : input.runPeerTransport(peerId, signal, () => input.capabilities.reannounceRfc64CatalogHeadsToPeerV1(peerId, {
          kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_KIND_V1,
          networkId: accepted.policy.networkId, contextGraphId: accepted.policy.contextGraphId,
          policyDigest: accepted.policyDigest,
        }, signal));
    },
    schedule: input.schedule, wait: input.wait, warn: input.warn,
    replay: input.replay, reportRun: input.reportRun,
  });
}
