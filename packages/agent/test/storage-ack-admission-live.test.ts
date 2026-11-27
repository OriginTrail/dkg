import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { multiaddr } from '@multiformats/multiaddr';
import { ethers } from 'ethers';
import {
  DKGNode, ProtocolRouter, InMemoryMessageIdempotencyStore, InMemoryProtocolOutboxStore,
  PROTOCOL_STORAGE_ACK, decodePublishIntent, encodeStorageACK, computePublishACKDigest,
} from '@origintrail-official/dkg-core';
import { ACKCollector } from '@origintrail-official/dkg-publisher';
import { Messenger } from '../src/p2p/messenger.js';
import { StorageACKAdmission } from '../src/storage-ack-admission.js';
import { AgentWorkLifetime } from '../src/agent-work-lifetime.js';
import { runStorageACKOperation } from '../src/storage-ack-diagnostics.js';

const CHAIN = 31337n;
const CONTRACT = '0x000000000000000000000000000000000000c10a';
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const nodes: DKGNode[] = [];
const peers: { node: DKGNode; messenger: Messenger; wallet: ethers.HDNodeWallet }[] = [];
let sender: Messenger;
let caller: DKGNode;
let receiverActive = 0;
let receiverPeak = 0;
const attempts = new Map<string, number>();

async function createNode() {
  const node = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
  nodes.push(node); await node.start();
  const messenger = new Messenger({ router: new ProtocolRouter(node),
    idempotencyStore: new InMemoryMessageIdempotencyStore(), outboxStore: new InMemoryProtocolOutboxStore() });
  return { node, messenger };
}

function params(root: Uint8Array) {
  return { merkleRoot: root, contextGraphId: 42n, contextGraphIdStr: '42', publisherPeerId: caller.peerId,
    publicByteSize: 100n, isPrivate: false, kaCount: 1, rootEntities: ['urn:fixture'],
    chainId: CHAIN, kav10Address: CONTRACT, requiredACKs: 3, merkleLeafCount: 2, ackMode: { kind: 'public' as const } };
}

async function cohort(limit: number, offset: number) {
  receiverPeak = 0;
  const gate = new StorageACKAdmission(() => limit); const lifetime = new AgentWorkLifetime();
  const summaries: Record<string, number>[] = []; let sending = 0; let peakSending = 0;
  const collector = new ACKCollector({
    gossipPublish: async () => {}, getConnectedCorePeers: () => peers.map(p => p.node.peerId), log: () => {},
    verifyIdentity: async (address, id) => peers[Number(id) - 1]?.wallet.address.toLowerCase() === address.toLowerCase(),
    sendP2P: async (peer, protocol, payload) => {
      peakSending = Math.max(peakSending, ++sending);
      try {
        const sent = await sender.sendRequestOwned(peer, protocol, payload, { timeoutMs: 5000 });
        if (!sent.delivered) throw new Error('unexpected in-flight dedup');
        return sent.response;
      } finally { sending--; }
    },
  });
  const started = performance.now();
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => runStorageACKOperation(
    lifetime, gate, 'publish', text => summaries.push(JSON.parse(text.slice('[StorageACKAdmission] '.length))),
    async admit => { await pause(5); return admit(onDiagnostic => collector.collect({ ...params(new Uint8Array(32).fill(offset + i)), onDiagnostic })); },
  )));
  const durationMs = performance.now() - started;
  for (const result of results) {
    expect(result.acks).toHaveLength(3); expect(new Set(result.acks.map(a => a.nodeIdentityId)).size).toBe(3);
  }
  await lifetime.drain(); expect(sending).toBe(0); expect(receiverActive).toBe(0);
  const waits = summaries.map(s => s.gateWaitMs).sort((a, b) => a - b);
  const measurement = { limit, jobs: results.length, failures: 0, durationMs: Math.round(durationMs),
    throughputPerSecond: Math.round(results.length * 100000 / durationMs) / 100,
    gateWaitP50Ms: waits[Math.ceil(waits.length * 0.5) - 1], gateWaitP95Ms: waits[Math.ceil(waits.length * 0.95) - 1],
    maxGateWaitMs: waits.at(-1), peakSending, receiverPeak,
    retryBackoffs: summaries.reduce((sum, s) => sum + s.backoffs, 0),
    backoffMs: summaries.reduce((sum, s) => sum + s.backoffMs, 0) };
  console.log('ACK_ADMISSION_MEASUREMENT', JSON.stringify(measurement));
  return measurement;
}

describe('ACK admission under a transient core decline on owned local peers', () => {
  beforeAll(async () => {
    const client = await createNode(); caller = client.node; sender = client.messenger;
    for (let i = 0; i < 3; i++) {
      const peer = { ...await createNode(), wallet: ethers.Wallet.createRandom() }; peers.push(peer);
      peer.messenger.register(PROTOCOL_STORAGE_ACK, async payload => {
        const intent = decodePublishIntent(payload); const key = `${i}:${intent.merkleRoot[0]}`;
        const attempt = (attempts.get(key) ?? 0) + 1; attempts.set(key, attempt);
        receiverPeak = Math.max(receiverPeak, ++receiverActive);
        try {
          const slow = i === 0 && intent.merkleRoot[0] % 32 === 0 && attempt === 1;
          await pause(slow ? 100 : 20);
          if (slow) return encodeStorageACK({ merkleRoot: new Uint8Array(), coreNodeSignatureR: new Uint8Array(),
            coreNodeSignatureVS: new Uint8Array(), contextGraphId: '42', nodeIdentityId: 0,
            declineCode: 'CORE_TEMPORARILY_UNAVAILABLE', declineMessage: 'controlled fixture saturation' });
          const digest = computePublishACKDigest(CHAIN, CONTRACT, 42n, intent.merkleRoot,
            1n, 100n, 1n, 0n, 2n);
          const signature = ethers.Signature.from(await peer.wallet.signMessage(digest));
          return encodeStorageACK({ merkleRoot: intent.merkleRoot, coreNodeSignatureR: ethers.getBytes(signature.r),
            coreNodeSignatureVS: ethers.getBytes(signature.yParityAndS), contextGraphId: '42', nodeIdentityId: i + 1 });
        } finally { receiverActive--; }
      });
      await caller.libp2p.dial(multiaddr(peer.node.multiaddrs[0]));
    }
  }, 30_000);
  afterAll(async () => { for (const node of nodes.reverse()) await node.stop(); }, 30_000);

  it('measures local waiting separately from the same remote retry without changing quorum', async () => {
    const serial = await cohort(1, 0); const parallel = await cohort(2, 32);
    expect(serial.retryBackoffs).toBe(1); expect(parallel.retryBackoffs).toBe(1);
    expect(serial.backoffMs).toBeGreaterThanOrEqual(900);
    expect(serial.maxGateWaitMs).toBeGreaterThan(800);
    expect(parallel.gateWaitP95Ms).toBeLessThan(serial.gateWaitP95Ms);
    expect(serial.peakSending).toBeLessThanOrEqual(3);
    expect(parallel.peakSending).toBeGreaterThan(serial.peakSending);
    expect(parallel.receiverPeak).toBeGreaterThan(serial.receiverPeak);
  }, 20_000);
});
