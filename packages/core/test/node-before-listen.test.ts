import { afterEach, describe, expect, it } from 'vitest';
import { DKGNode } from '../src/node.js';
import { ProtocolRouter } from '../src/protocol-router.js';

const nodes: DKGNode[] = [];
function node() {
  const n = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
  nodes.push(n);
  return n;
}
afterEach(async () => { for (const n of nodes.splice(0)) await n.stop(); });

describe('node network-ready boundary', () => {
  it('awaits mandatory protocol registration before listening or discovery starts', async () => {
    const n = node();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const starting = n.start({ beforeListen: async () => {
      await new ProtocolRouter(n).register('/test/required/1', async data => data);
      entered.resolve();
      await release.promise;
    } });
    try {
      await entered.promise;
      expect(n.libp2p.status).toBe('stopped');
      expect(n.multiaddrs).toEqual([]);
      expect(n.libp2p.getProtocols()).toContain('/test/required/1');
    } finally {
      release.resolve();
      await starting;
    }
    expect(n.libp2p.status).toBe('started');
    expect(n.multiaddrs.length).toBeGreaterThan(0);
  });

  it('cleans up a failed readiness hook and can start again', async () => {
    const n = node();
    const failure = new Error('mandatory protocol registration failed');
    let stopSignal: AbortSignal | undefined;
    await expect(n.start({ beforeListen: async () => {
      stopSignal = n.stopSignal;
      throw failure;
    } })).rejects.toBe(failure);
    expect(stopSignal?.aborted).toBe(true);
    expect(n.stopSignal).toBeUndefined();
    expect(() => n.libp2p).toThrow();
    await n.start();
    expect(n.libp2p.status).toBe('started');
  });
});
