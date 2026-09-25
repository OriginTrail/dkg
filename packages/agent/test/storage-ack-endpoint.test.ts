import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_STORAGE_ACK,
  PROTOCOL_STORAGE_ACK_V2,
  PROTOCOL_STORAGE_UPDATE_ACK,
  PROTOCOL_STORAGE_UPDATE_ACK_V2,
} from '@origintrail-official/dkg-core';
import { registerStorageACKEndpoint } from '../src/p2p/storage-ack-endpoint.js';

const PROTOCOLS = [
  PROTOCOL_STORAGE_ACK,
  PROTOCOL_STORAGE_ACK_V2,
  PROTOCOL_STORAGE_UPDATE_ACK,
  PROTOCOL_STORAGE_UPDATE_ACK_V2,
] as const;

describe('StorageACK endpoint request origin', () => {
  it('hands peer streams to the handler as remote and the local dispatch as local', async () => {
    const routes = new Map<string, (data: Uint8Array, peerId: string) => Promise<Uint8Array>>();
    const calls: Array<{
      kind: 'publish' | 'update';
      peerId: string;
      signal: AbortSignal | undefined;
      origin: 'remote' | 'local';
    }> = [];
    const endpoint = registerStorageACKEndpoint({
      registerGroup: (entries) => {
        for (const entry of entries) routes.set(entry.protocolId, entry.handler);
        return () => routes.clear();
      },
      publish: async (_data, peerId) => {
        calls.push({ kind: 'publish', peerId, signal: undefined, origin: 'remote' });
        return new Uint8Array([1]);
      },
      update: async (_data, peerId) => {
        calls.push({ kind: 'update', peerId, signal: undefined, origin: 'remote' });
        return new Uint8Array([2]);
      },
      publishLocal: async (_data, peerId, signal) => {
        calls.push({ kind: 'publish', peerId, signal, origin: 'local' });
        return new Uint8Array([1]);
      },
      updateLocal: async (_data, peerId, signal) => {
        calls.push({ kind: 'update', peerId, signal, origin: 'local' });
        return new Uint8Array([2]);
      },
    });
    const request = new Uint8Array([7]);
    const signal = new AbortController().signal;

    for (const protocol of PROTOCOLS) await routes.get(protocol)!(request, 'remote-core');
    for (const protocol of PROTOCOLS) await endpoint.dispatch(protocol, request, 'this-core', signal);

    const kinds = ['publish', 'publish', 'update', 'update'] as const;
    expect(calls).toEqual([
      ...kinds.map((kind) => ({ kind, peerId: 'remote-core', signal: undefined, origin: 'remote' })),
      ...kinds.map((kind) => ({ kind, peerId: 'this-core', signal, origin: 'local' })),
    ]);

    endpoint.dispose();
    expect(routes.size).toBe(0);
    expect(() => endpoint.dispatch(PROTOCOL_STORAGE_ACK, request, 'this-core'))
      .toThrow(/StorageACK handler is not registered/);
  });
});
