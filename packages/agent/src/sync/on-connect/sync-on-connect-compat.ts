import { PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2 } from '@origintrail-official/dkg-core';
import type {
  PeerCapabilitySink,
  RegistrySyncOnConnectContext,
  SyncOnConnectBaseContext,
} from './sync-on-connect.js';

/** Extendable legacy context retained for existing integrations. */
export interface SyncOnConnectContext extends SyncOnConnectBaseContext {
  peerCapabilities?: never;
  knownCorePeerIds: Set<string>;
  knownCorePeerIdsV2?: Set<string>;
}

/** Alias retained for callers that adopted the explicit legacy name. */
export interface LegacySyncOnConnectContext extends SyncOnConnectContext {}

/** The public boundary rejects two simultaneous capability owners. */
export type SyncOnConnectInput = SyncOnConnectContext
  | (RegistrySyncOnConnectContext & {
      knownCorePeerIds?: never;
      knownCorePeerIdsV2?: never;
    });

/** Convert legacy sets to the canonical observation sink. */
export function peerCapabilitySink(context: SyncOnConnectInput): PeerCapabilitySink {
  if (context.peerCapabilities) return context.peerCapabilities;
  const { knownCorePeerIds, knownCorePeerIdsV2 } = context;
  if (!knownCorePeerIds) throw new TypeError('Sync-on-connect requires peerCapabilities or knownCorePeerIds');
  return {
    observe(peerId, observation) {
      // Legacy sets cannot retain evidence provenance; keep their historical
      // populated-list behavior while the registry uses the typed source.
      if (observation.source === 'negotiation') return;
      const { protocols } = observation;
      if (protocols.length === 0) return;
      if (protocols.includes(PROTOCOL_STORAGE_ACK)) knownCorePeerIds.add(peerId);
      else knownCorePeerIds.delete(peerId);
      if (protocols.includes(PROTOCOL_STORAGE_ACK) && protocols.includes(PROTOCOL_STORAGE_ACK_V2)) {
        knownCorePeerIdsV2?.add(peerId);
      } else {
        knownCorePeerIdsV2?.delete(peerId);
      }
    },
  };
}
