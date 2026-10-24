// SPDX-License-Identifier: Apache-2.0
/**
 * Review coverage gap (PR #1317): the ACK metric must reflect REAL ACK outcomes
 * — a non-decline response is counted as a successful `result:'ack'` only AFTER
 * signature + merkle + identity validation passes, and a response that fails
 * validation is counted `result:'rejected'`, never `'ack'`. This drives the real
 * ACKCollector through an in-memory meter and asserts those semantics (the bug
 * fixed: ACKs were counted at decode time, before validation).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { metrics } from '@opentelemetry/api';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  InMemoryMetricExporter,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics';
import { ACKCollector, quorumOutcomeFromError, type ACKCollectorDeps } from '../src/ack-collector.js';
import { QuorumUnmetError } from '../src/ack-errors.js';
import { encodeStorageACK, computePublishACKDigest, rebuildMetrics } from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10, computeFlatKCMerkleLeafCountV10 } from '../src/merkle.js';
import { ethers } from 'ethers';

const TEST_CHAIN_ID = 31337n;
const TEST_KAV10_ADDR = '0x000000000000000000000000000000000000c10a';
const quads = [{ subject: 'urn:a', predicate: 'urn:p', object: 'urn:o1', graph: 'urn:test' }];
const merkleRoot = computeFlatKCRootV10(quads, []);
const merkleLeafCount = computeFlatKCMerkleLeafCountV10(quads, []);
const coreWallets = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom(), ethers.Wallet.createRandom(), ethers.Wallet.createRandom()];

async function signACK(wallet: ethers.Wallet, idx: number) {
  const digest = computePublishACKDigest(
    TEST_CHAIN_ID, TEST_KAV10_ADDR, 42n, merkleRoot, 1n, 100n, 1n, 0n, BigInt(merkleLeafCount),
  );
  const sig = ethers.Signature.from(await wallet.signMessage(digest));
  return encodeStorageACK({
    merkleRoot,
    coreNodeSignatureR: ethers.getBytes(sig.r),
    coreNodeSignatureVS: ethers.getBytes(sig.yParityAndS),
    contextGraphId: 'test-cg',
    nodeIdentityId: idx + 1,
  });
}

function makeDeps(verifyIdentity: () => Promise<boolean>): ACKCollectorDeps {
  return {
    gossipPublish: async () => {},
    sendP2P: async (peerId) => {
      const idx = parseInt(peerId.replace('peer-', ''), 10);
      return signACK(coreWallets[idx], idx);
    },
    getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2', 'peer-3'],
    verifyIdentity,
    log: () => {},
  };
}

const collectParams = {
  merkleRoot,
  contextGraphId: 42n,
  contextGraphIdStr: 'test-cg',
  publisherPeerId: 'publisher-0',
  publicByteSize: 100n,
  isPrivate: false,
  kaCount: 1,
  rootEntities: ['urn:a'],
  chainId: TEST_CHAIN_ID,
  kav10Address: TEST_KAV10_ADDR,
  merkleLeafCount,
  ackMode: { kind: 'public' },
};

describe('quorumOutcomeFromError — classify on the structured prefix, not peer text', () => {
  const mk = (legacyMessage: string) =>
    new QuorumUnmetError({ collected: 1, required: 3, dialled: 4, peerOutcomes: [], legacyMessage });

  it('a real timeout message → outcome:timeout', () => {
    expect(quorumOutcomeFromError(mk('storage_ack_timeout: only 1/3 ACKs received within 120000ms.'))).toBe('timeout');
  });

  it('insufficient quorum whose DECLINE text contains "storage_ack_timeout" → impossible (not timeout)', () => {
    // A peer that writes "storage_ack_timeout" into its decline message must NOT
    // flip an insufficient/impossible quorum to the timeout bucket.
    const msg = 'storage_ack_insufficient: got 1/3 valid ACKs after 4/4 peers settled. Declines: ab12→NO_DATA_IN_SWM (storage_ack_timeout while waiting)';
    expect(quorumOutcomeFromError(mk(msg))).toBe('impossible');
  });
});

describe('ACK metrics — result:ack only after validation', () => {
  let mp: MeterProvider | null = null;
  let exporter: InMemoryMetricExporter;

  function installMeter() {
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    mp = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })] });
    metrics.setGlobalMeterProvider(mp);
    rebuildMetrics();
  }

  async function ackPeerCounts(): Promise<Record<string, number>> {
    await mp!.forceFlush();
    const out: Record<string, number> = {};
    for (const rm of exporter.getMetrics())
      for (const sm of rm.scopeMetrics)
        for (const m of sm.metrics)
          if (m.descriptor.name === 'dkg.ack.peer.total')
            for (const dp of m.dataPoints as Array<{ attributes: Record<string, unknown>; value: number }>) {
              const r = String(dp.attributes.result);
              out[r] = (out[r] ?? 0) + dp.value;
            }
    return out;
  }

  afterEach(async () => {
    if (mp) { await mp.forceFlush().catch(() => {}); await mp.shutdown().catch(() => {}); mp = null; }
    metrics.disable();
    rebuildMetrics();
  });

  it('counts validated ACKs as result:ack and never as a premature decode-time ack', async () => {
    installMeter();
    const result = await new ACKCollector(makeDeps(async () => true)).collect(collectParams);
    expect(result.acks.length).toBeGreaterThanOrEqual(3);
    const counts = await ackPeerCounts();
    // Every counted ACK is a VALIDATED ACK (>= quorum); none rejected.
    expect(counts['ack'] ?? 0).toBeGreaterThanOrEqual(3);
    expect(counts['rejected'] ?? 0).toBe(0);
  });

  it('an ACK that FAILS identity validation is counted rejected, NEVER ack', async () => {
    installMeter();
    // verifyIdentity rejects every peer → quorum can never be met.
    await expect(new ACKCollector(makeDeps(async () => false)).collect(collectParams)).rejects.toBeTruthy();
    const counts = await ackPeerCounts();
    // The key regression guard: responses rejected at the identity gate must NOT
    // be counted as successful ACKs (the pre-fix bug counted them at decode time).
    expect(counts['ack'] ?? 0).toBe(0);
    expect(counts['rejected'] ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('counts one protocol_unsupported outcome for every non-negotiating peer', async () => {
    installMeter();
    const dials = new Map<string, number>();
    const deps = makeDeps(async () => true);
    deps.sendP2P = async (peerId) => {
      dials.set(peerId, (dials.get(peerId) ?? 0) + 1);
      throw new Error('Protocol selection failed - could not negotiate storage ACK protocol');
    };

    await expect(new ACKCollector(deps).collect(collectParams)).rejects.toBeTruthy();
    const counts = await ackPeerCounts();
    expect(dials.size).toBe(4);
    expect([...dials.values()]).toEqual([1, 1, 1, 1]);
    expect(counts['protocol_unsupported'] ?? 0).toBe(4);
    expect(counts['transport_error'] ?? 0).toBe(0);
  });
});
