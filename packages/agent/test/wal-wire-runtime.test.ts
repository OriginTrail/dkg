import { peerIdFromString } from '@libp2p/peer-id';
import { describe, expect, it } from 'vitest';
import type { ProtocolRouter } from '@origintrail-official/dkg-core';
import { WAL_WIRE_PROTOCOL_IDS } from '@origintrail-official/dkg-wal/protocol';
import { createDkgWalWireRuntime } from '../src/wal/wire-runtime.js';

const PEER_A = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
const PEER_B = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';

type Handler = (
  data: Uint8Array,
  peerId: ReturnType<typeof peerIdFromString>,
  options?: { signal?: AbortSignal },
) => Promise<Uint8Array>;

class LinkedRouter {
  readonly handlers = new Map<string, Handler>();
  remote!: LinkedRouter;

  constructor(readonly peerId: string) {}

  register(protocolId: string, handler: Handler): void {
    this.handlers.set(protocolId, handler);
  }

  unregister(protocolId: string): void {
    this.handlers.delete(protocolId);
  }

  async send(
    _peerId: string,
    protocolId: string,
    data: Uint8Array,
    options?: { signal?: AbortSignal },
  ): Promise<Uint8Array> {
    const handler = this.remote.handlers.get(protocolId);
    if (handler === undefined) throw new Error(`unsupported protocol ${protocolId}`);
    return handler(data, peerIdFromString(this.peerId), options);
  }
}

function pair(): readonly [LinkedRouter, LinkedRouter] {
  const left = new LinkedRouter(PEER_A);
  const right = new LinkedRouter(PEER_B);
  left.remote = right;
  right.remote = left;
  return [left, right];
}

describe('DkgWalWireRuntime', () => {
  it('registers all frozen families and performs a real authenticated capability round trip', async () => {
    const [leftRouter, rightRouter] = pair();
    let request = 0;
    const left = createDkgWalWireRuntime({
      router: leftRouter as unknown as ProtocolRouter,
      localPeerId: peerIdFromString(PEER_A).toMultihash().bytes,
      authorizePeer: peerId => peerId === PEER_B,
      now: () => 1_000,
      randomRequestId: () => {
        request += 1;
        const id = new Uint8Array(16);
        id[15] = request;
        return id;
      },
    });
    const right = createDkgWalWireRuntime({
      router: rightRouter as unknown as ProtocolRouter,
      localPeerId: peerIdFromString(PEER_B).toMultihash().bytes,
      authorizePeer: peerId => peerId === PEER_A,
      now: () => 1_000,
    });
    const stopLeft = left.start();
    right.start();
    expect([...leftRouter.handlers.keys()].sort()).toEqual(Object.values(WAL_WIRE_PROTOCOL_IDS).sort());
    expect(left.started).toBe(true);
    expect(await left.getCapabilities(PEER_B)).toEqual([
      [1n], [1n], 1_048_576n, 4_096n, 4_096n, 1_048_576n,
      8_589_934_592n, 16n,
    ]);
    expect(() => left.start()).toThrow('already started');
    stopLeft();
    stopLeft();
    expect(left.started).toBe(false);
    await expect(left.getCapabilities(PEER_B)).rejects.toThrow('not started');
    right.stop();
    right.stop();
    expect(rightRouter.handlers.size).toBe(0);
  });

  it('fails capability probing closed when transport identity is not authorized', async () => {
    const [leftRouter, rightRouter] = pair();
    const left = createDkgWalWireRuntime({
      router: leftRouter as unknown as ProtocolRouter,
      localPeerId: peerIdFromString(PEER_A).toMultihash().bytes,
      authorizePeer: () => true,
      now: () => 1_000,
      randomRequestId: () => Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
    });
    const right = createDkgWalWireRuntime({
      router: rightRouter as unknown as ProtocolRouter,
      localPeerId: peerIdFromString(PEER_B).toMultihash().bytes,
      authorizePeer: () => false,
      now: () => 1_000,
    });
    left.start();
    right.start();
    await expect(left.getCapabilities(PEER_B)).rejects.toMatchObject({ code: 1 });
    left.stop();
    right.stop();
  });
});
