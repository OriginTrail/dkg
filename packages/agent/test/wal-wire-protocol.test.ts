import { describe, expect, it, vi } from 'vitest';
import type { ProtocolRouter } from '@origintrail-official/dkg-core';
import type { WalWireProtocolServer } from '@origintrail-official/dkg-wal/protocol';
import { registerWalWireProtocols } from '../src/wal/wire-protocol.js';

describe('registerWalWireProtocols', () => {
  it('delegates only to the raw ProtocolRouter registration boundary', () => {
    const unregister = vi.fn();
    const register = vi.fn(() => unregister);
    const router = {} as ProtocolRouter;
    const server = { register } as unknown as WalWireProtocolServer;
    expect(registerWalWireProtocols(router, server)).toBe(unregister);
    expect(register).toHaveBeenCalledWith(router);
  });
});
