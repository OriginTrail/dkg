import { describe, it, expect, vi } from 'vitest';
import { Messenger } from '../src/p2p/messenger.js';
import type { ProtocolRouter, PeerResolver } from '@origintrail-official/dkg-core';

const PEER_A = '12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PEER_B = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';

interface MockSetup {
  resolveMock: ReturnType<typeof vi.fn>;
  routerSendMock: ReturnType<typeof vi.fn>;
}

function makeMessenger(overrides: Partial<MockSetup> = {}): {
  messenger: Messenger;
  mocks: MockSetup;
  callOrder: string[];
} {
  const callOrder: string[] = [];

  const mocks: MockSetup = {
    resolveMock:
      overrides.resolveMock ??
      vi.fn(async () => {
        callOrder.push('resolver.resolve');
        return [];
      }),
    routerSendMock:
      overrides.routerSendMock ??
      vi.fn(async () => {
        callOrder.push('router.send');
        return new Uint8Array([0x01, 0x02]);
      }),
  };

  const messenger = new Messenger({
    resolver: { resolve: mocks.resolveMock } as unknown as PeerResolver,
    router: { send: mocks.routerSendMock } as unknown as ProtocolRouter,
  });

  return { messenger, mocks, callOrder };
}

describe('Messenger.sendToPeer', () => {
  it('calls resolver.resolve before router.send', async () => {
    const { messenger, mocks, callOrder } = makeMessenger();

    await messenger.sendToPeer(PEER_B, '/dkg/test/1.0.0', new Uint8Array([0xff]));

    expect(mocks.resolveMock).toHaveBeenCalledWith(PEER_B);
    expect(mocks.routerSendMock).toHaveBeenCalledOnce();
    expect(callOrder.indexOf('resolver.resolve')).toBeLessThan(callOrder.indexOf('router.send'));
  });

  it('regression: resolver fires BEFORE router.send (the Laptop B bug)', async () => {
    // The bug fixed by this primitive: forwardJoinRequest used to call
    // router.send directly without first priming peer-address resolution,
    // causing "no reachable curator" failures for NAT'd peers. The fix
    // is structural — every send through Messenger primes first. The
    // priming mechanism moved from inline SPARQL patching to the
    // PeerResolver in RFC 07 PR-2, but the structural property remains.
    const { messenger, callOrder } = makeMessenger();

    await messenger.sendToPeer(PEER_B, '/dkg/test/1.0.0', new Uint8Array([0xff]));

    const resolveIdx = callOrder.indexOf('resolver.resolve');
    const sendIdx = callOrder.indexOf('router.send');
    expect(resolveIdx).toBeGreaterThanOrEqual(0);
    expect(sendIdx).toBeGreaterThanOrEqual(0);
    expect(resolveIdx).toBeLessThan(sendIdx);
  });

  it('tolerates resolver throwing — proceeds to router.send anyway', async () => {
    const { messenger, mocks } = makeMessenger({
      resolveMock: vi.fn(async () => {
        throw new Error('resolver boom');
      }),
    });

    await messenger.sendToPeer(PEER_B, '/dkg/test/1.0.0', new Uint8Array([0xff]));

    expect(mocks.routerSendMock).toHaveBeenCalledOnce();
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
});
