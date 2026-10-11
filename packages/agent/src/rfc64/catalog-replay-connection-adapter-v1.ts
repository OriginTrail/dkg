// SPDX-License-Identifier: Apache-2.0
import type { DKGAgent } from '../dkg-agent.js';
import { Rfc64CatalogReplayConnectionRuntimeV1, type Rfc64CatalogReplayConnectionRuntimePortsV1 } from './catalog-replay-connection-runtime-v1.js';
import { RFC64_PUBLIC_CATALOG_HEAD_REPLAY_KIND_V1 } from './public-catalog-transport-v1.js';

/** Bind current accepted policy at fence reservation and compatibility announcement. */
export function createRfc64CatalogReplayConnectionRuntimeV1(input:
  Readonly<{ agent: DKGAgent; reservePeer(contextGraphId: string, policyDigest: string, peerId: string): ReturnType<Rfc64CatalogReplayConnectionRuntimePortsV1['reserveFence']> }>
    & Pick<Rfc64CatalogReplayConnectionRuntimePortsV1, 'schedule' | 'wait' | 'warn' | 'replay'>,
): Rfc64CatalogReplayConnectionRuntimeV1 {
  const agent = input.agent;
  return new Rfc64CatalogReplayConnectionRuntimeV1({
    selectContextGraphIds: () => agent.listActiveRfc64CatalogReplayContextGraphIdsV1(),
    reserveFence: (contextGraphId, peerId) => {
      const accepted = agent.readAcceptedRfc64CatalogAccessSnapshotV1(contextGraphId);
      return accepted === null ? null : input.reservePeer(contextGraphId, accepted.policyDigest, peerId);
    },
    reannounce: (peerId, id, signal) => {
      const accepted = agent.readAcceptedRfc64CatalogAccessSnapshotV1(id);
      return accepted === null ? Promise.resolve(Object.freeze({ failed: 0 }))
        : agent.reannounceRfc64CatalogHeadsToPeerV1(peerId, {
          kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_KIND_V1,
          networkId: accepted.policy.networkId, contextGraphId: accepted.policy.contextGraphId,
          policyDigest: accepted.policyDigest,
        }, signal);
    },
    schedule: input.schedule, wait: input.wait, warn: input.warn,
    replay: input.replay,
  });
}
