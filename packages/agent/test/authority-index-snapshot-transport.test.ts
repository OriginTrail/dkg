import { describe, expect, it, vi } from 'vitest';
import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import { PROTOCOL_CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT } from '../src/authority-index-snapshot-service.js';
import { createAuthorityIndexSnapshotTransport } from '../src/authority-index-snapshot-transport.js';

const PEER = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
const address = `/ip4/127.0.0.1/tcp/9200/p2p/${PEER}`;
const bytes = new Uint8Array([1]);
const reply = new Uint8Array([2]);
const options = () => ({
  signal: new AbortController().signal,
  timeoutMs: 1_000,
  maxReadBytes: 1_024,
  payloadReuse: 'single-use' as const,
});

function context(connected: boolean) {
  const libp2p = {
    getConnections: vi.fn(() => (connected ? [{}] : [])),
    peerStore: { merge: vi.fn(async () => {}) },
    dial: vi.fn(async () => ({})),
  };
  const router = { send: vi.fn(async () => reply) };
  return { libp2p, router, current: { started: true, node: { libp2p }, router } as any };
}

describe('authority index snapshot transport', () => {
  it('sends to a discovered core over its existing connection without dialing', async () => {
    const { libp2p, router, current } = context(true);
    const request = createAuthorityIndexSnapshotTransport(() => current);
    const sendOptions = options();
    await expect(request({ peerId: PEER }, bytes, sendOptions)).resolves.toBe(reply);
    expect(libp2p.getConnections).toHaveBeenCalledExactlyOnceWith(peerIdFromString(PEER));
    expect(libp2p.peerStore.merge).not.toHaveBeenCalled();
    expect(libp2p.dial).not.toHaveBeenCalled();
    expect(router.send).toHaveBeenCalledExactlyOnceWith(
      PEER, PROTOCOL_CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT, bytes, sendOptions,
    );
  });

  it('refuses a discovered core that is not connected rather than dialing a phonebook address', async () => {
    const { libp2p, router, current } = context(false);
    const request = createAuthorityIndexSnapshotTransport(() => current);
    await expect(request({ peerId: PEER }, bytes, options())).rejects.toThrow(
      `Authority index core ${PEER} is not connected`,
    );
    expect(libp2p.dial).not.toHaveBeenCalled();
    expect(router.send).not.toHaveBeenCalled();
  });

  it('still primes and dials an explicitly configured address', async () => {
    const { libp2p, router, current } = context(false);
    const request = createAuthorityIndexSnapshotTransport(() => current);
    const sendOptions = options();
    await expect(request({ peerId: PEER, multiaddr: address }, bytes, sendOptions)).resolves.toBe(reply);
    expect(libp2p.peerStore.merge).toHaveBeenCalledExactlyOnceWith(peerIdFromString(PEER), {
      multiaddrs: [multiaddr(address)],
    });
    expect(libp2p.dial).toHaveBeenCalledExactlyOnceWith(multiaddr(address), { signal: sendOptions.signal });
    expect(libp2p.getConnections).not.toHaveBeenCalled();
    expect(router.send).toHaveBeenCalledOnce();
  });

  it('stays fenced until the agent transport has started', async () => {
    const { libp2p, current } = context(true);
    const request = createAuthorityIndexSnapshotTransport(() => ({ ...current, started: false }));
    await expect(request({ peerId: PEER }, bytes, options())).rejects.toThrow('transport is not started');
    expect(libp2p.getConnections).not.toHaveBeenCalled();
  });
});
