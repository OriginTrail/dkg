import { STORAGE_ACK_PROTOCOLS, storageACKProtocolKind, type StorageACKProtocol } from './storage-ack-protocols.js';

export interface StorageACKEndpoint {
  dispatch(protocol: StorageACKProtocol, data: Uint8Array, peerId: string, signal?: AbortSignal): Promise<Uint8Array>;
  dispose(): void;
}

interface StorageACKEndpointPorts {
  registerGroup(entries: readonly {
    protocolId: string;
    handler: (data: Uint8Array, peerId: string) => Promise<Uint8Array>;
  }[]): () => void;
  publish(data: Uint8Array, peerId: string, signal?: AbortSignal): Promise<Uint8Array>;
  update(data: Uint8Array, peerId: string, signal?: AbortSignal): Promise<Uint8Array>;
}

/** One lifetime owns all four remote routes and the matching local dispatch. */
export function registerStorageACKEndpoint(ports: StorageACKEndpointPorts): StorageACKEndpoint {
  let active = true;
  const dispatch: StorageACKEndpoint['dispatch'] = (protocol, data, peerId, signal) => {
    if (!active) throw new Error('StorageACK handler is not registered');
    return storageACKProtocolKind(protocol) === 'publish'
      ? ports.publish(data, peerId, signal)
      : ports.update(data, peerId, signal);
  };
  let removeRoutes: () => void;
  try {
    removeRoutes = ports.registerGroup(STORAGE_ACK_PROTOCOLS.map(([protocol]) => ({
      protocolId: protocol,
      handler: (data, peerId) => dispatch(protocol, data, peerId),
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
