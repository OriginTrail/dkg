import type { StorageAckRequestOrigin } from '@origintrail-official/dkg-publisher';
import { STORAGE_ACK_PROTOCOLS, storageACKProtocolKind, type StorageACKProtocol } from './storage-ack-protocols.js';

export interface StorageACKEndpoint {
  /** This node's own request: the publishing core ACKing itself. */
  dispatch(protocol: StorageACKProtocol, data: Uint8Array, peerId: string, signal?: AbortSignal): Promise<Uint8Array>;
  dispose(): void;
}

interface StorageACKEndpointPorts {
  registerGroup(entries: readonly {
    protocolId: string;
    handler: (data: Uint8Array, peerId: string) => Promise<Uint8Array>;
  }[]): () => void;
  publish(data: Uint8Array, peerId: string, signal: AbortSignal | undefined, origin: StorageAckRequestOrigin): Promise<Uint8Array>;
  update(data: Uint8Array, peerId: string, signal: AbortSignal | undefined, origin: StorageAckRequestOrigin): Promise<Uint8Array>;
}

/**
 * One lifetime owns all four remote routes and the matching local dispatch.
 * Streams from peers reach the handler as `remote` requests and the local
 * dispatch as a `local` one, which lets a self-ACK keep the publisher's own
 * SWM head.
 */
export function registerStorageACKEndpoint(ports: StorageACKEndpointPorts): StorageACKEndpoint {
  let active = true;
  const route = (
    protocol: StorageACKProtocol,
    data: Uint8Array,
    peerId: string,
    signal: AbortSignal | undefined,
    origin: StorageAckRequestOrigin,
  ): Promise<Uint8Array> => {
    if (!active) throw new Error('StorageACK handler is not registered');
    return storageACKProtocolKind(protocol) === 'publish'
      ? ports.publish(data, peerId, signal, origin)
      : ports.update(data, peerId, signal, origin);
  };
  const dispatch: StorageACKEndpoint['dispatch'] = (protocol, data, peerId, signal) =>
    route(protocol, data, peerId, signal, 'local');
  let removeRoutes: () => void;
  try {
    removeRoutes = ports.registerGroup(STORAGE_ACK_PROTOCOLS.map(([protocol]) => ({
      protocolId: protocol,
      handler: (data, peerId) => route(protocol, data, peerId, undefined, 'remote'),
    })));
  } catch (error) {
    active = false;
    throw error;
  }
  return Object.freeze({
    dispatch,
    dispose: () => {
      if (!active) return;
      active = false;
      removeRoutes();
    },
  });
}
