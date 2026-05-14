import { describe, it, expect, vi } from 'vitest';
import { Messenger } from '../src/p2p/messenger.js';
import type { ProtocolRouter } from '@origintrail-official/dkg-core';

const PEER_A = '12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PEER_B = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';

interface MockSetup {
  routerSendMock: ReturnType<typeof vi.fn>;
}

function makeMessenger(overrides: Partial<MockSetup> = {}): {
  messenger: Messenger;
  mocks: MockSetup;
} {
  const mocks: MockSetup = {
    routerSendMock:
      overrides.routerSendMock ??
      vi.fn(async () => new Uint8Array([0x01, 0x02])),
  };

  const messenger = new Messenger({
    router: { send: mocks.routerSendMock } as unknown as ProtocolRouter,
  });

  return { messenger, mocks };
}

describe('Messenger.sendToPeer', () => {
  it('delegates to router.send with peerId / protocol / data', async () => {
    const { messenger, mocks } = makeMessenger();

    const out = await messenger.sendToPeer(
      PEER_B,
      '/dkg/test/1.0.0',
      new Uint8Array([0xff]),
    );

    expect(mocks.routerSendMock).toHaveBeenCalledWith(
      PEER_B,
      '/dkg/test/1.0.0',
      expect.any(Uint8Array),
      undefined,
    );
    expect(out).toEqual(new Uint8Array([0x01, 0x02]));
  });

  it('forwards timeoutMs to router.send', async () => {
    const { messenger, mocks } = makeMessenger();

    await messenger.sendToPeer(PEER_A, '/dkg/test/1.0.0', new Uint8Array([0xff]), {
      timeoutMs: 5000,
    });

    expect(mocks.routerSendMock).toHaveBeenCalledWith(
      PEER_A,
      '/dkg/test/1.0.0',
      expect.any(Uint8Array),
      5000,
    );
  });

  it('propagates router.send errors to the caller', async () => {
    const { messenger } = makeMessenger({
      routerSendMock: vi.fn(async () => {
        throw new Error('transport boom');
      }),
    });

    await expect(
      messenger.sendToPeer(PEER_B, '/dkg/test/1.0.0', new Uint8Array([0xff])),
    ).rejects.toThrow('transport boom');
  });

  // Note: Messenger no longer holds a PeerResolver — the resolver is
  // owned by ProtocolRouter (RFC 07 PR-3) so resolution happens once
  // per send rather than twice. The structural property "resolver
  // primes peerStore before dialProtocol" still holds; it's just
  // verified at the router layer now (see protocol-router-resolver.test.ts).
});
