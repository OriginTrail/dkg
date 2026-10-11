import { STORAGE_ACK_PROTOCOLS, storageACKProtocolKind, type StorageACKProtocol } from '@origintrail-official/dkg-core';
import type { LocalStorageAckHeadExpectation } from '@origintrail-official/dkg-publisher';

export interface LocalStorageACKDispatch {
  protocol: StorageACKProtocol;
  data: Uint8Array;
  peerId: string;
  signal?: AbortSignal;
  /** The queued publisher head this local ACK is allowed to preserve. */
  context?: LocalStorageAckHeadExpectation;
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
  publish(data: Uint8Array, peerId: string): LocalStorageACKExecution;
  update(data: Uint8Array, peerId: string): LocalStorageACKExecution;
  /** The generation retains physical work after a deadline response. */
  trackRemoteCompletion(completion: Promise<unknown>): void;
  publishLocal(data: Uint8Array, peerId: string, signal: AbortSignal | undefined, context?: LocalStorageAckHeadExpectation): LocalStorageACKExecution;
  updateLocal(data: Uint8Array, peerId: string, signal: AbortSignal | undefined, context?: LocalStorageAckHeadExpectation): LocalStorageACKExecution;
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
    const execution = storageACKProtocolKind(protocol) === 'publish'
      ? ports.publish(data, peerId) : ports.update(data, peerId);
    ports.trackRemoteCompletion(execution.completion);
    return execution.response;
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
