import { STORAGE_ACK_PROTOCOLS, storageACKProtocolKind, type StorageACKProtocol } from '@origintrail-official/dkg-core';

export interface LocalStorageACKDispatch {
  protocol: StorageACKProtocol;
  data: Uint8Array;
  peerId: string;
  signal?: AbortSignal;
  /** Opaque local request context, interpreted only by the agent's handler adapter. */
  context?: unknown;
}

export interface LocalStorageACKExecution {
  response: Promise<Uint8Array>;
  completion: Promise<unknown>;
}

export interface StorageACKEndpoint {
  /** This node's own request: the publishing core ACKing itself. */
  dispatch(request: LocalStorageACKDispatch): LocalStorageACKExecution;
  dispose(): void;
}

interface StorageACKEndpointPorts {
  registerGroup(entries: readonly {
    protocolId: string;
    handler: (data: Uint8Array, peerId: string) => Promise<Uint8Array>;
  }[]): () => void;
  publish(data: Uint8Array, peerId: string): Promise<Uint8Array>;
  update(data: Uint8Array, peerId: string): Promise<Uint8Array>;
  publishLocal(data: Uint8Array, peerId: string, signal: AbortSignal | undefined, context?: unknown): LocalStorageACKExecution;
  updateLocal(data: Uint8Array, peerId: string, signal: AbortSignal | undefined, context?: unknown): LocalStorageACKExecution;
}

/**
 * One lifetime owns all four remote routes and the matching local dispatch.
 * Streams from peers reach the handler as `remote` requests and the local
 * dispatch as a `local` one, which lets a self-ACK keep the publisher's own
 * SWM head.
 */
export function registerStorageACKEndpoint(ports: StorageACKEndpointPorts): StorageACKEndpoint {
  let active = true;
  const routeRemote = (protocol: StorageACKProtocol, data: Uint8Array, peerId: string): Promise<Uint8Array> => {
    if (!active) throw new Error('StorageACK handler is not registered');
    return storageACKProtocolKind(protocol) === 'publish'
      ? ports.publish(data, peerId) : ports.update(data, peerId);
  };
  const dispatch: StorageACKEndpoint['dispatch'] = (request) => {
    if (!active) throw new Error('StorageACK handler is not registered');
    return storageACKProtocolKind(request.protocol) === 'publish'
      ? ports.publishLocal(request.data, request.peerId, request.signal, request.context)
      : ports.updateLocal(request.data, request.peerId, request.signal, request.context);
  };
  let removeRoutes: () => void;
  try {
    removeRoutes = ports.registerGroup(STORAGE_ACK_PROTOCOLS.map(([protocol]) => ({
      protocolId: protocol,
      handler: (data, peerId) => routeRemote(protocol, data, peerId),
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
