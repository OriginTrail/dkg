import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { computePublishACKDigest, computeUpdateACKDigest, encodeStorageACK } from '@origintrail-official/dkg-core';
import { ACKCollector, type ACKCollectorDeps } from '../src/ack-collector.js';
import { ACKRoundDiagnostics } from '../src/ack-diagnostics.js';

const contract = '0x000000000000000000000000000000000000c10a';
const root = new Uint8Array(32).fill(7);
const wallets = Array.from({ length: 4 }, () => ethers.Wallet.createRandom());
const peers = wallets.map((_, i) => `peer-${i}`);
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

async function fixture(operation: 'publish' | 'update', options: {
  ignoresAbort?: boolean; verify?: ACKCollectorDeps['verifyIdentity'];
  detailedVerify?: ACKCollectorDeps['verifyIdentityDetailed'];
  declineLast?: boolean; sleep?: ACKCollectorDeps['sleep'];
} = {}) {
  const releases = new Map<string, () => void>();
  const logs: string[] = [];
  const signals = new Map<string, AbortSignal | undefined>();
  let active = 0, sends = 0;
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
    verifyIdentityDetailed: options.detailedVerify, log: message => logs.push(message), sleep: options.sleep,
    sendP2P: async (peer, _protocol, _data, opts?: { signal?: AbortSignal }) => {
      signals.set(peer, opts?.signal); sends++;
      active++;
      try {
        await new Promise<void>((resolve, reject) => {
          releases.set(peer, resolve);
          if (!options.ignoresAbort) opts?.signal?.addEventListener('abort', () => reject(opts.signal!.reason), { once: true });
        });
        if (options.declineLast && peer === peers[3]) return encodeStorageACK({
          merkleRoot: new Uint8Array(), coreNodeSignatureR: new Uint8Array(), coreNodeSignatureVS: new Uint8Array(),
          contextGraphId: '42', nodeIdentityId: 0, declineCode: 'NO_DATA_IN_SWM',
        });
        return responses[peers.indexOf(peer)];
      } finally { active--; }
    },
  });
  return {
    releases, signals, verify, logs, active: () => active, sendCount: () => sends,
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

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
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

  it.each(['legacy', 'detailed'] as const)('fences an in-flight %s identity result after quorum', async verifier => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const verify = vi.fn(async (_address: string, id: bigint) => {
      if (id === 4n) await pending;
      return true;
    });
    const f = await fixture(operation, { verify,
      ...(verifier === 'detailed' ? { detailedVerify: async (address, id) => ({ valid: await verify(address, id) }) } : {}),
    });
    const run = f.collect(); await flush();
    f.releases.get(peers[3])!(); await flush();
    expect(verify).toHaveBeenCalledTimes(1);
    for (const peer of peers.slice(0, 3)) f.releases.get(peer)!();
    const result = await run;
    const settledLogs = [...f.logs];
    expect(settledLogs.filter(message => message.includes('Valid ACK from'))).toHaveLength(3);
    release(); await flush();
    expect(f.logs).toEqual(settledLogs);
    expect(result.acks.map(a => a.nodeIdentityId)).toEqual([1n, 2n, 3n]);
    expect(f.active()).toBe(0);
  });


  it.each(['legacy', 'detailed'] as const)('cancels obsolete %s identity work through the round signal', async verifier => {
    let active = 0;
    let signal: AbortSignal | undefined;
    const verify = vi.fn(async (_address: string, id: bigint, options?: { signal?: AbortSignal }) => {
      if (id !== 4n) return true;
      signal = options?.signal; active++;
      try {
        await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal!.reason), { once: true }));
        return true;
      } finally { active--; }
    });
    const f = await fixture(operation, { verify,
      ...(verifier === 'detailed' ? { detailedVerify: async (address, id, options) => ({ valid: await verify(address, id, options) }) } : {}),
    });
    const run = f.collect(); await flush();
    f.releases.get(peers[3])!(); await flush();
    expect(active).toBe(1);
    for (const peer of peers.slice(0, 3)) f.releases.get(peer)!();
    expect((await run).acks).toHaveLength(3); await flush();
    expect(signal?.aborted).toBe(true);
    expect(active).toBe(0);
  });

  it.each(['default', 'custom'] as const)('retires a pending %s retry sleep when other peers reach quorum', async kind => {
    let release!: () => void;
    const custom = new Promise<void>(resolve => { release = resolve; });
    const measured = vi.spyOn(ACKRoundDiagnostics.prototype, 'measureBackoff');
    const f = await fixture(operation, { declineLast: true, ...(kind === 'custom' ? { sleep: () => custom } : {}) });
    const run = f.collect(); await flush();
    try {
      f.releases.get(peers[3])!(); await flush();
      expect(measured).toHaveBeenCalledTimes(1);
      let retired = false;
      void (measured.mock.results[0].value as Promise<unknown>).then(() => { retired = true; }, () => { retired = true; });
      expect(retired).toBe(false);
      for (const peer of peers.slice(0, 3)) f.releases.get(peer)!();
      expect((await run).acks).toHaveLength(3);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(retired).toBe(true);
      expect(f.sendCount()).toBe(4);
    } finally {
      // The custom dependency itself may ignore cancellation; only the round-owned wait retires.
      release(); for (const resolve of f.releases.values()) resolve(); await run;
    }
  });

});
