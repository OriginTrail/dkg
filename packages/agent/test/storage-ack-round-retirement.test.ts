import { expect, it } from 'vitest';
import { multiaddr } from '@multiformats/multiaddr';
import { ethers } from 'ethers';
import {
  DKGNode, ProtocolRouter, InMemoryMessageIdempotencyStore, InMemoryProtocolOutboxStore,
  PROTOCOL_STORAGE_ACK, decodePublishIntent, encodeStorageACK, computePublishACKDigest,
} from '@origintrail-official/dkg-core';
import { ACKCollector } from '@origintrail-official/dkg-publisher';
import { Messenger } from '../src/p2p/messenger.js';
import { createACKSendP2P } from '../src/internal/storage-ack-owned-request.js';
import { LocalStorageACKTransport } from '../src/p2p/local-storage-ack-transport.js';

it('retires an obsolete real P2P send at quorum without claiming the remote handler stopped', async () => {
  const nodes: DKGNode[] = [];
  const releases: (() => void)[] = [];
  const wallets = Array.from({ length: 4 }, () => ethers.Wallet.createRandom());
  const contract = '0x000000000000000000000000000000000000c10a';
  let entered = 0, sends = 0, physicalHandlers = 0;
  let allEntered!: () => void;
  const ready = new Promise<void>(resolve => { allEntered = resolve; });
  const create = async () => {
    const node = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
    nodes.push(node); await node.start();
    const outbox = new InMemoryProtocolOutboxStore();
    const messenger = new Messenger({ router: new ProtocolRouter(node),
      idempotencyStore: new InMemoryMessageIdempotencyStore(), outboxStore: outbox });
    return { node, messenger, outbox };
  };
  try {
    const caller = await create();
    const peers: string[] = [];
    for (let i = 0; i < 4; i++) {
      const peer = await create(); peers.push(peer.node.peerId);
      peer.messenger.register(PROTOCOL_STORAGE_ACK, async data => {
        const intent = decodePublishIntent(data);
        physicalHandlers++;
        try {
          await new Promise<void>(resolve => {
            releases[i] = resolve;
            if (++entered === 4) allEntered();
          });
          const digest = computePublishACKDigest(31337n, contract, 42n, intent.merkleRoot, 1n, 100n, 1n, 0n, 2n);
          const sig = ethers.Signature.from(await wallets[i].signMessage(digest));
          return encodeStorageACK({ merkleRoot: intent.merkleRoot, contextGraphId: '42', nodeIdentityId: i + 1,
            coreNodeSignatureR: ethers.getBytes(sig.r), coreNodeSignatureVS: ethers.getBytes(sig.yParityAndS) });
        } finally { physicalHandlers--; }
      });
      await caller.node.libp2p.dial(multiaddr(peer.node.multiaddrs[0]));
    }
    const sendP2P = createACKSendP2P({ timeoutMs: 5_000, messenger: {
      sendRequestOwned: async (...args) => {
        sends++;
        try { return await caller.messenger.sendRequestOwned(...args); }
        finally { sends--; }
      },
    } });
    const collector = new ACKCollector({ gossipPublish: async () => {}, sendP2P,
      getConnectedCorePeers: () => peers,
      verifyIdentity: async (address, id) => wallets[Number(id) - 1]?.address.toLowerCase() === address.toLowerCase(),
    });
    const run = collector.collect({ merkleRoot: new Uint8Array(32).fill(4), contextGraphId: 42n,
      contextGraphIdStr: '42', publisherPeerId: caller.node.peerId, publicByteSize: 100n,
      isPrivate: false, kaCount: 1, rootEntities: ['urn:fixture'], chainId: 31337n,
      kav10Address: contract, requiredACKs: 3, merkleLeafCount: 2, ackMode: { kind: 'public' } });
    await ready;
    for (const release of releases.slice(0, 3)) release();
    const result = await run;
    expect(result.acks).toHaveLength(3);
    expect(new Set(result.acks.map(ack => ack.nodeIdentityId)).size).toBe(3);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(sends).toBe(0);
    expect(caller.outbox.size()).toBe(0);
    // Old responders and non-cooperative application work may continue after stream cancellation.
    expect(physicalHandlers).toBe(1);
  } finally {
    for (const release of releases) release();
    for (const node of nodes.reverse()) await node.stop();
  }
}, 20_000);

it('forwards caller cancellation to self-ACK work while retaining its physical drain', async () => {
  const transport = new LocalStorageACKTransport();
  const controller = new AbortController();
  let signal: AbortSignal | undefined;
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const completion = new Promise<void>(resolve => { release = resolve; });
  const send = transport.send(requestSignal => {
    signal = requestSignal; entered();
    return { response: completion.then(() => new Uint8Array()), completion };
  }, 5_000, controller.signal).catch(error => error);
  await ready;
  controller.abort(new Error('quorum elsewhere'));
  expect(await send).toBeInstanceOf(Error);
  expect(signal?.aborted).toBe(true);
  await expect(transport.drain(5)).rejects.toThrow(/did not retire/);
  release();
  await transport.drain();
});
