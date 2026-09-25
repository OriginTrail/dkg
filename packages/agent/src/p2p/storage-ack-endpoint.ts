import { STORAGE_ACK_PROTOCOLS, storageACKProtocolKind, type StorageACKProtocol } from '@origintrail-official/dkg-core';

export interface LocalStorageACKDispatch {
  protocol: StorageACKProtocol;
  data: Uint8Array;
  peerId: string;
  signal?: AbortSignal;
  /** Opaque local request context, interpreted only by the agent's handler adapter. */
  context?: unknown;
  trackPhysicalWork?: (work: Promise<Uint8Array>) => void;
}

export interface StorageACKEndpoint {
  /** This node's own request: the publishing core ACKing itself. */
  dispatch(request: LocalStorageACKDispatch): Promise<Uint8Array>;
  dispose(): void;
}

interface StorageACKEndpointPorts {
  registerGroup(entries: readonly {
    protocolId: string;
    handler: (data: Uint8Array, peerId: string) => Promise<Uint8Array>;
  }[]): () => void;
  publish(data: Uint8Array, peerId: string): Promise<Uint8Array>;
  update(data: Uint8Array, peerId: string): Promise<Uint8Array>;
  publishLocal(data: Uint8Array, peerId: string, signal: AbortSignal | undefined, context?: unknown, trackPhysicalWork?: (work: Promise<Uint8Array>) => void): Promise<Uint8Array>;
  updateLocal(data: Uint8Array, peerId: string, signal: AbortSignal | undefined, context?: unknown, trackPhysicalWork?: (work: Promise<Uint8Array>) => void): Promise<Uint8Array>;
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
    local: false | Pick<LocalStorageACKDispatch, 'signal' | 'context' | 'trackPhysicalWork'>,
  ): Promise<Uint8Array> => {
    if (!active) throw new Error('StorageACK handler is not registered');
    return storageACKProtocolKind(protocol) === 'publish'
      ? local ? ports.publishLocal(data, peerId, local.signal, local.context, local.trackPhysicalWork) : ports.publish(data, peerId)
      : local ? ports.updateLocal(data, peerId, local.signal, local.context, local.trackPhysicalWork) : ports.update(data, peerId);
  };
  const dispatch: StorageACKEndpoint['dispatch'] = (request) =>
    route(request.protocol, request.data, request.peerId, request);
  let removeRoutes: () => void;
  try {
    removeRoutes = ports.registerGroup(STORAGE_ACK_PROTOCOLS.map(([protocol]) => ({
      protocolId: protocol,
      handler: (data, peerId) => route(protocol, data, peerId, false),
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
