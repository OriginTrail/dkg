import { describe, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import type { ChainAdapter, EventFilter } from '@origintrail-official/dkg-chain';
import { FinalizationHandler } from '../src/finalization-handler.js';
import { FinalizationRecovery } from '../src/finalization-recovery.js';

const BLOCK = 17;
const TX_HASH = `0x${'ab'.repeat(32)}`;
const PUBLISHER = '0x2222222222222222222222222222222222222222';
const ROOT = new Uint8Array(32).fill(7);
const KA_ID = 23n;

function readinessChain(outcome: boolean | Error) {
  const scans: string[][] = [];
  const legacy = vi.fn(() => outcome !== false);
  const readiness = vi.fn(async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const chain = {
    chainId: 'legacy:1',
    isV10Ready: legacy,
    resolveV10FinalizationReadiness: readiness,
    getBlockNumber: async () => BLOCK,
    listenForEvents: async function* (filter: EventFilter) {
      scans.push([...filter.eventTypes]);
      if (filter.eventTypes.includes('KCCreated')) {
        yield {
          type: 'KCCreated',
          blockNumber: BLOCK,
          data: {
            txHash: TX_HASH,
            merkleRoot: ROOT,
            publisherAddress: PUBLISHER,
            startKAId: KA_ID.toString(),
            endKAId: KA_ID.toString(),
            batchId: KA_ID.toString(),
          },
        };
      }
    },
  } as unknown as ChainAdapter;
  return { chain, scans, legacy, readiness };
}

describe('finalization readiness consumers', () => {
  it.each([
    { name: 'ready', outcome: true, verified: true, scanCount: 1 },
    { name: 'not ready', outcome: false, verified: false, scanCount: 2 },
    { name: 'resolver failure', outcome: new Error('readiness unavailable'), verified: false, scanCount: 1 },
  ])('FinalizationHandler awaits the async readiness result when $name', async scenario => {
    const { chain, scans, legacy, readiness } = readinessChain(scenario.outcome);
    const handler = new FinalizationHandler(new OxigraphStore(), chain);
    const result = await (handler as any).verifyOnChain(
      TX_HASH, BLOCK, ROOT, PUBLISHER, KA_ID, KA_ID,
      createOperationContext('finalization-readiness-test'), '42', KA_ID,
    );
    expect(result.verified).toBe(scenario.verified);
    expect(scans).toHaveLength(scenario.scanCount);
    expect(readiness).toHaveBeenCalledOnce();
    expect(legacy).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'ready', outcome: true, verified: true, scanCount: 1 },
    { name: 'not ready', outcome: false, verified: false, scanCount: 2 },
    { name: 'resolver failure', outcome: new Error('readiness unavailable'), verified: false, scanCount: 1 },
  ])('FinalizationRecovery awaits the async readiness result when $name', async scenario => {
    const { chain, scans, legacy, readiness } = readinessChain(scenario.outcome);
    const recovery = new FinalizationRecovery(
      undefined,
      chain,
      { info: vi.fn(), warn: vi.fn() },
      { prepare: vi.fn() } as never,
    );
    const candidate = {
      blockNumber: BLOCK,
      startKAId: KA_ID,
      endKAId: KA_ID,
      batchId: KA_ID,
      msg: { txHash: TX_HASH, kcMerkleRoot: ROOT, publisherAddress: PUBLISHER },
      scope: { ual: 'did:dkg:test:finalization-readiness' },
    };
    const result = await (recovery as any).verifyLegacy(candidate, '42');
    expect(result.verified).toBe(scenario.verified);
    expect(scans).toHaveLength(scenario.scanCount);
    expect(readiness).toHaveBeenCalledOnce();
    expect(legacy).not.toHaveBeenCalled();
  });
});
