import { describe, expect, it, vi } from 'vitest';
import type { ProtocolRouter } from '@origintrail-official/dkg-core';
import type { WalWireProtocolServer } from '@origintrail-official/dkg-wal/protocol';
import { registerWalWireProtocols } from '../src/wal/wire-protocol.js';

describe('registerWalWireProtocols', () => {
  it('adapts libp2p PeerId bytes and delegates only to the raw ProtocolRouter boundary', async () => {
    const unregister = vi.fn();
    const rawRegister = vi.fn();
    const rawUnregister = vi.fn();
    const rawSend = vi.fn(async () => Uint8Array.of(9));
    const router = {
      register: rawRegister,
      unregister: rawUnregister,
      send: rawSend,
    } as unknown as ProtocolRouter;
    let adapted: Parameters<WalWireProtocolServer['register']>[0] | undefined;
    const server = {
      register: vi.fn((received) => { adapted = received; return unregister; }),
    } as unknown as WalWireProtocolServer;
    expect(registerWalWireProtocols(router, server)).toBe(unregister);
    expect(server.register).toHaveBeenCalledTimes(1);
    const handler = vi.fn(async () => Uint8Array.of(7));
    adapted!.register('/wal', handler, { maxReadBytes: 10, readTimeoutMs: 20 });
    const registered = rawRegister.mock.calls[0]![1];
    const peerText = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
    const peerBytes = (await import('@libp2p/peer-id')).peerIdFromString(peerText).toMultihash().bytes;
    expect(await registered(Uint8Array.of(4), {
      toString: () => peerText,
    }, {})).toEqual(Uint8Array.of(7));
    expect(handler).toHaveBeenCalledWith(
      Uint8Array.of(4),
      expect.objectContaining({ toString: expect.any(Function), toBytes: expect.any(Function) }),
      {},
    );
    expect(handler.mock.calls[0]![1].toString()).toBe(peerText);
    expect(handler.mock.calls[0]![1].toBytes()).toEqual(peerBytes);
    adapted!.unregister('/wal');
    expect(rawUnregister).toHaveBeenCalledWith('/wal');
    await expect(adapted!.send('peer-b', '/wal', Uint8Array.of(5), { timeoutMs: 6 }))
      .resolves.toEqual(Uint8Array.of(9));
    expect(rawSend).toHaveBeenCalled();
  });
});
