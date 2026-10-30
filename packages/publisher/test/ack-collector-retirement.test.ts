import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { computePublishACKDigest, computeUpdateACKDigest, encodeStorageACK } from '@origintrail-official/dkg-core';
import { ACKCollector, type ACKCollectorDeps } from '../src/ack-collector.js';

const contract = '0x000000000000000000000000000000000000c10a';
const root = new Uint8Array(32).fill(7);
const wallets = Array.from({ length: 4 }, () => ethers.Wallet.createRandom());
const peers = wallets.map((_, i) => `peer-${i}`);
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

async function fixture(operation: 'publish' | 'update', options: {
  ignoresAbort?: boolean; verify?: ACKCollectorDeps['verifyIdentity'];
} = {}) {
  const releases = new Map<string, () => void>();
  const signals = new Map<string, AbortSignal | undefined>();
  let active = 0;
  const verify = options.verify ?? vi.fn(async () => true);
  const digest = operation === 'publish'
    ? computePublishACKDigest(31337n, contract, 42n, root, 1n, 100n, 1n, 0n, 2n)
    : computeUpdateACKDigest(31337n, contract, 42n, 1n, 1n, root, 100n, 1n, 0n, [], 2n);
  const responses = await Promise.all(wallets.map(async (wallet, i) => {
    const sig = ethers.Signature.from(await wallet.signMessage(digest));
    return encodeStorageACK({ merkleRoot: root, contextGraphId: '42', nodeIdentityId: i + 1,
      coreNodeSignatureR: ethers.getBytes(sig.r), coreNodeSignatureVS: ethers.getBytes(sig.yParityAndS) });
  }));
  const collector = new ACKCollector({
    gossipPublish: async () => {}, getConnectedCorePeers: () => peers, verifyIdentity: verify,
    sendP2P: async (peer, _protocol, _data, opts?: { signal?: AbortSignal }) => {
      signals.set(peer, opts?.signal);
      active++;
      try {
        await new Promise<void>((resolve, reject) => {
          releases.set(peer, resolve);
          if (!options.ignoresAbort) opts?.signal?.addEventListener('abort', () => reject(opts.signal!.reason), { once: true });
        });
        return responses[peers.indexOf(peer)];
      } finally { active--; }
    },
  });
  return {
    releases, signals, verify, active: () => active,
    collect: (signal?: AbortSignal) => operation === 'publish'
      ? collector.collect({ merkleRoot: root, contextGraphId: 42n, contextGraphIdStr: '42',
          publisherPeerId: 'publisher', publicByteSize: 100n, isPrivate: false, kaCount: 1,
          rootEntities: ['urn:a'], chainId: 31337n, kav10Address: contract, merkleLeafCount: 2,
          requiredACKs: 3, ackMode: { kind: 'public' }, signal })
      : collector.collectUpdate({ kaId: 1n, contextGraphId: 42n, preUpdateMerkleRootCount: 1n,
          newMerkleRoot: root, newByteSize: 100n, newTokenAmount: 1n, mintAmount: 0n,
          burnTokenIds: [], newMerkleLeafCount: 2, chainId: 31337n, kav10Address: contract,
          publisherPeerId: 'publisher', requiredACKs: 3, signal }),
  };
}

afterEach(() => vi.useRealTimers());
describe.each(['publish', 'update'] as const)('%s ACK round retirement', operation => {
  it('aborts losing sends after three independently valid ACKs and clears its deadline', async () => {
    const f = await fixture(operation);
    vi.useFakeTimers();
    const run = f.collect(); await flush();
    expect(f.active()).toBe(4);
    for (const peer of peers.slice(0, 3)) f.releases.get(peer)!();
    const result = await run; await flush();
    expect(result.acks).toHaveLength(3);
    expect(new Set(result.acks.map(a => a.nodeIdentityId)).size).toBe(3);
    expect(f.signals.get(peers[3])?.aborted).toBe(true);
    expect(f.active()).toBe(0);
    expect(f.verify).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    f.releases.get(peers[3])!();
  });

  it('does not verify or accept a late reply from a transport that ignores cancellation', async () => {
    const f = await fixture(operation, { ignoresAbort: true });
    const run = f.collect(); await flush();
    for (const peer of peers.slice(0, 3)) f.releases.get(peer)!();
    const result = await run;
    expect(f.active()).toBe(1);
    f.releases.get(peers[3])!(); await flush();
    expect(f.verify).toHaveBeenCalledTimes(3);
    expect(result.acks.map(a => a.nodeIdentityId)).toEqual([1n, 2n, 3n]);
    expect(f.active()).toBe(0);
  });

  it('retires every pending send on the unchanged 120-second quorum deadline', async () => {
    const f = await fixture(operation);
    vi.useFakeTimers();
    const result = f.collect().catch(error => error); await flush();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await result).toMatchObject({ collected: 0, required: 3, dialled: 4 });
    await flush();
    expect([...f.signals.values()].every(s => s?.aborted)).toBe(true);
    expect(f.active()).toBe(0);
    expect(f.verify).not.toHaveBeenCalled();
    for (const release of f.releases.values()) release();
  });

  it('propagates caller cancellation without waiting for the quorum deadline', async () => {
    const f = await fixture(operation);
    vi.useFakeTimers();
    const controller = new AbortController();
    const result = f.collect(controller.signal).catch(error => error); await flush();
    const reason = new Error('owned test caller stopped');
    controller.abort(reason); await flush();
    // A sentinel makes the failure immediate on the baseline rather than hanging.
    expect(await Promise.race([result, Promise.resolve('still pending')])).toBe(reason);
    expect(f.active()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    for (const release of f.releases.values()) release();
  });

  it('retires remaining work as soon as quorum becomes impossible', async () => {
    const verify = vi.fn(async () => false);
    const f = await fixture(operation, { verify });
    vi.useFakeTimers();
    const result = f.collect().catch(error => error); await flush();
    f.releases.get(peers[0])!(); f.releases.get(peers[1])!();
    expect(await result).toMatchObject({ collected: 0, required: 3, dialled: 4 });
    await flush();
    expect(f.active()).toBe(0);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fences an identity read already in flight when quorum settles', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const verify = vi.fn(async (_address: string, id: bigint) => {
      if (id === 4n) await pending;
      return true;
    });
    const f = await fixture(operation, { verify });
    const run = f.collect(); await flush();
    f.releases.get(peers[3])!(); await flush();
    expect(verify).toHaveBeenCalledTimes(1);
    for (const peer of peers.slice(0, 3)) f.releases.get(peer)!();
    const result = await run;
    release(); await flush();
    expect(result.acks.map(a => a.nodeIdentityId)).toEqual([1n, 2n, 3n]);
    expect(f.active()).toBe(0);
  });

});
